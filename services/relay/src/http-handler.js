const JOBS_PATH = '/api/v1/jobs';
const JOB_PATH = /^\/api\/v1\/jobs\/([^/]+)$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const JSON_CONTENT_TYPE = /^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i;
const MAX_BODY_BYTES = 8_192;
const INTERNAL_ERROR = Object.freeze({ error: { code: 'INTERNAL_ERROR' } });

function sendJson(response, statusCode, body) {
  const json = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (typeof response.off !== 'function') return;
      response.off('finish', onFinish);
      response.off('error', onError);
      response.off('close', onClose);
    };
    const settle = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onFinish = () => settle();
    const onError = (error) => settle(error);
    const onClose = () => {
      if (!response.writableFinished) settle(new Error('Response closed before completion'));
    };
    if (typeof response.once === 'function') {
      response.once('finish', onFinish);
      response.once('error', onError);
      response.once('close', onClose);
    }
    try {
      response.writeHead(statusCode, {
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(json),
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
      });
      response.end(json, onFinish);
    } catch (error) {
      settle(error);
    }
  });
}

async function containFailure(response) {
  try {
    if (!response.headersSent && !response.writableEnded && !response.destroyed) {
      await sendJson(response, 500, INTERNAL_ERROR);
      return;
    }
  } catch {
    // Close below when a bounded response can no longer be written safely.
  }
  if (!response.destroyed) {
    try {
      response.destroy();
    } catch {
      // No safe response operation remains at this boundary.
    }
  }
}

function runDetached(operation, response) {
  void operation.catch(() => containFailure(response)).catch(() => {
    if (!response.destroyed) {
      try {
        response.destroy();
      } catch {
        // No safe response operation remains at this boundary.
      }
    }
  });
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let body = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        body = '';
        tooLarge = true;
      }
    });
    request.on('end', () => {
      if (tooLarge || body.length === 0) return resolve(null);
      try {
        return resolve(JSON.parse(body));
      } catch {
        return resolve(null);
      }
    });
    request.on('error', () => resolve(null));
  });
}

function parentFor({ evidence, traceId, job }) {
  if (job?.transitions?.length > 0) return job.transitions.at(-1).span_id;
  if (job?.envelope?.span_id) return job.envelope.span_id;
  return evidence.forTrace(traceId).at(-1)?.span_id ?? null;
}

function appendResponseEvidence({ evidence, ids, traceId, parentSpanId, method, route, statusCode, disposition }) {
  evidence.append({
    traceId,
    spanId: ids.nextSpanId(),
    parentSpanId,
    serviceName: 'pixel.relay-api',
    eventName: 'api.job.response',
    outcome: statusCode < 400 ? 'success' : 'denied',
    severity: statusCode < 400 ? 'info' : 'warning',
    attributes: {
      'http.request.method': method,
      'http.route': route,
      'http.response.status_code': statusCode,
      'pixel.job.disposition': disposition,
    },
  });
}

function appendResponsePreparedEvidence({ evidence, ids, traceId, parentSpanId, method, route, statusCode, disposition }) {
  return evidence.append({
    traceId,
    spanId: ids.nextSpanId(),
    parentSpanId,
    serviceName: 'pixel.relay-api',
    eventName: 'api.job.response.prepared',
    attributes: {
      'http.request.method': method,
      'http.route': route,
      'http.response.status_code': statusCode,
      'pixel.job.disposition': disposition,
    },
  });
}

function appendResponseFailureEvidence({ evidence, ids, traceId, parentSpanId, method, route, statusCode, disposition }) {
  evidence.append({
    traceId,
    spanId: ids.nextSpanId(),
    parentSpanId,
    serviceName: 'pixel.relay-api',
    eventName: 'api.job.response.failed',
    outcome: 'failure',
    severity: 'error',
    attributes: {
      'http.request.method': method,
      'http.route': route,
      'http.response.status_code': statusCode,
      'pixel.job.disposition': disposition,
    },
  });
}

async function sendJobResponse({ evidence, ids, traceId, parentSpanId, response, method, route, statusCode, disposition, body }) {
  const prepared = appendResponsePreparedEvidence({
    evidence, ids, traceId, parentSpanId, method, route, statusCode, disposition,
  });
  try {
    await sendJson(response, statusCode, body);
  } catch (error) {
    try {
      appendResponseFailureEvidence({
        evidence, ids, traceId, parentSpanId: prepared.span_id, method, route, statusCode, disposition,
      });
    } catch {
      // The transport failure remains contained even when evidence storage is unavailable.
    }
    throw error;
  }
  try {
    appendResponseEvidence({
      evidence, ids, traceId, parentSpanId: prepared.span_id, method, route, statusCode, disposition,
    });
  } catch {
    // Delivery already completed; the unmatched prepared span preserves incomplete evidence truthfully.
  }
}

function appendStandaloneResponse({ evidence, ids, statusCode, disposition }) {
  const traceId = ids.nextTraceId();
  evidence.append({
    traceId,
    spanId: ids.nextSpanId(),
    serviceName: 'pixel.relay-api',
    eventName: 'api.job.lookup.rejected',
    outcome: 'denied',
    severity: 'warning',
    attributes: {
      'http.request.method': 'GET',
      'http.route': '/api/v1/jobs/{job_id}',
      'http.response.status_code': statusCode,
      'pixel.job.disposition': disposition,
    },
  });
}

async function rejectLookupAndSend({ evidence, ids, response, statusCode, disposition, code }) {
  appendStandaloneResponse({ evidence, ids, statusCode, disposition });
  await sendJson(response, statusCode, { error: { code } });
}

function statusFor(result) {
  if (result.disposition === 'CREATED') return 201;
  if (result.disposition === 'EXISTING') return 200;
  if (result.disposition === 'CONFLICT') return 409;
  if (result.disposition === 'UNAVAILABLE') return 503;
  return 400;
}

async function submitAndSend({ relay, evidence, ids, response, intent }) {
  const result = await relay.submit(intent);
  const statusCode = statusFor(result);
  const body = result.job
    ? { data: result.job }
    : { error: { code: result.reason_code, trace_id: result.trace_id } };
  await sendJobResponse({
    evidence,
    ids,
    traceId: result.trace_id,
    parentSpanId: parentFor({ evidence, traceId: result.trace_id, job: result.job }),
    response,
    method: 'POST',
    route: JOBS_PATH,
    statusCode,
    disposition: result.disposition,
    body,
  });
}

async function readAndSend({ relay, evidence, ids, response, jobId }) {
  const job = await relay.getJob(jobId);
  if (!job) {
    await rejectLookupAndSend({
      evidence, ids, response, statusCode: 404, disposition: 'NOT_FOUND', code: 'JOB_NOT_FOUND',
    });
    return;
  }
  await sendJobResponse({
    evidence,
    ids,
    traceId: job.envelope.trace_id,
    parentSpanId: parentFor({ evidence, traceId: job.envelope.trace_id, job }),
    response,
    method: 'GET',
    route: '/api/v1/jobs/{job_id}',
    statusCode: 200,
    disposition: 'READ',
    body: { data: job },
  });
}

export function createRelayHttpHandler({ relay, evidence, ids }) {
  if (
    !relay
    || typeof relay.submit !== 'function'
    || typeof relay.getJob !== 'function'
    || !evidence
    || typeof evidence.append !== 'function'
    || typeof evidence.forTrace !== 'function'
    || !ids
    || typeof ids.nextSpanId !== 'function'
    || typeof ids.nextTraceId !== 'function'
  ) throw new TypeError('Relay HTTP handler requires Relay, evidence, and ID sources');

  return (request, response, url) => {
    if (request.method === 'POST' && url.pathname === JOBS_PATH) {
      const contentType = request.headers['content-type'];
      if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType.trim())) {
        request.resume();
        runDetached(submitAndSend({ relay, evidence, ids, response, intent: null }), response);
        return true;
      }
      runDetached(
        readJsonBody(request).then((intent) => submitAndSend({ relay, evidence, ids, response, intent })),
        response,
      );
      return true;
    }

    const match = request.method === 'GET' ? JOB_PATH.exec(url.pathname) : null;
    if (!match) return false;
    let jobId;
    try {
      jobId = decodeURIComponent(match[1]);
    } catch {
      jobId = '';
    }
    if (!IDENTIFIER.test(jobId)) {
      runDetached(rejectLookupAndSend({
        evidence, ids, response, statusCode: 400, disposition: 'INVALID_ID', code: 'JOB_ID_INVALID',
      }), response);
      return true;
    }
    runDetached(readAndSend({ relay, evidence, ids, response, jobId }), response);
    return true;
  };
}
