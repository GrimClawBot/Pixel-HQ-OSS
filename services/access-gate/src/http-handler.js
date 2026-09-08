const ACCESS_PATH = '/api/v1/access/decisions';
const MAX_BODY_BYTES = 8_192;
const JSON_CONTENT_TYPE = /^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i;
const INTERNAL_ERROR_BODY = Object.freeze({ error: 'internal_error' });

const AUTHORITY_TERMS = Object.freeze([
  ['subject', 'identity'],
  ['principal', 'identity'],
  ['verification', 'verification_state'],
  ['verified', 'verification_state'],
  ['identity', 'identity'],
  ['role', 'role'],
  ['grant', 'permissions'],
  ['grants', 'permissions'],
  ['permission', 'permissions'],
  ['permissions', 'permissions'],
  ['enrollment', 'enrollment'],
  ['enroll', 'enrollment'],
  ['enrolled', 'enrollment'],
  ['trust', 'device_trust'],
  ['trusted', 'device_trust'],
  ['untrusted', 'device_trust'],
  ['revoked', 'device_trust'],
  ['device', 'device_identity'],
  ['certificate', 'certificate_status'],
  ['credential', 'certificate_status'],
  ['risk', 'risk_posture'],
  ['environment', 'environment'],
  ['authorization', 'authorization_decision'],
  ['authorized', 'authorization_decision'],
  ['decision', 'authorization_decision'],
]);

function sendJson(response, statusCode, body) {
  const json = JSON.stringify(body);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(json);
}

function containDetachedFailure(response) {
  try {
    if (!response.headersSent && !response.writableEnded && !response.destroyed) {
      sendJson(response, 500, INTERNAL_ERROR_BODY);
      return;
    }
  } catch {
    // Fall through to closing a response that can no longer be written safely.
  }

  if (!response.destroyed) {
    try {
      response.destroy();
    } catch {
      // There is no remaining safe response operation at this boundary.
    }
  }
}

function runDetached(operation, response) {
  void operation.catch(() => containDetachedFailure(response));
}

function hasApprovedJsonContentType(value) {
  return typeof value === 'string' && JSON_CONTENT_TYPE.test(value.trim());
}

function keyTokens(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function authorityCategory(key) {
  const tokens = keyTokens(key);
  for (const [term, category] of AUTHORITY_TERMS) {
    if (tokens.includes(term)) return category;
  }
  return null;
}

function bodyAuthorityCategories(value, categories = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) bodyAuthorityCategories(item, categories);
    return categories;
  }
  if (value === null || typeof value !== 'object') return categories;
  for (const [key, child] of Object.entries(value)) {
    const category = authorityCategory(key);
    if (category) categories.add(category);
    bodyAuthorityCategories(child, categories);
  }
  return categories;
}

function headerAuthorityCategories(headers) {
  const categories = new Set();
  let invalidPixelHeader = false;
  for (const name of Object.keys(headers)) {
    const category = authorityCategory(name);
    if (category) categories.add(category);
    if (name.toLowerCase().startsWith('x-pixel-') && !category) invalidPixelHeader = true;
  }
  return { categories, invalidPixelHeader };
}

function queryAssessment(url) {
  const categories = new Set();
  let hasUnknown = false;
  for (const key of url.searchParams.keys()) {
    const category = authorityCategory(key);
    if (category) categories.add(category);
    else hasUnknown = true;
  }
  return { categories, hasUnknown };
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
        tooLarge = true;
        body = '';
      }
    });
    request.on('end', () => {
      if (tooLarge || body.length === 0) {
        resolve({ ok: false, value: null });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(body) });
      } catch {
        resolve({ ok: false, value: null });
      }
    });
    request.on('error', () => resolve({ ok: false, value: null }));
  });
}

function appendApiEvidence({ evidence, ids, decision, statusCode }) {
  evidence.append({
    traceId: decision.trace_id,
    spanId: ids.nextSpanId(),
    parentSpanId: decision.span_id,
    serviceName: 'pixel.access-gate-api',
    eventName: decision.decision === 'ALLOW' ? 'api.response.sent' : 'api.request.denied',
    outcome: decision.decision === 'ALLOW' ? 'success' : 'denied',
    severity: decision.decision === 'ALLOW' ? 'info' : 'warning',
    attributes: {
      'http.request.method': 'POST',
      'http.route': ACCESS_PATH,
      'http.response.status_code': statusCode,
    },
  });
}

async function evaluateAndSend({ accessGate, evidence, ids, response, intent, authorityClaimAttempt = null }) {
  const decision = await accessGate.evaluate({ intent, authorityClaimAttempt });
  const statusCode = decision.decision === 'ALLOW' ? 200 : 403;
  appendApiEvidence({ evidence, ids, decision, statusCode });
  sendJson(response, statusCode, { data: decision });
}

export function createAccessHttpHandler({ accessGate, evidence, ids }) {
  if (!accessGate || typeof accessGate.evaluate !== 'function' || !evidence || !ids) {
    throw new TypeError('Access HTTP handler requires AccessGate, evidence, and IDs');
  }

  return (request, response, url) => {
    if (request.method !== 'POST' || url.pathname !== ACCESS_PATH) return false;

    if (!hasApprovedJsonContentType(request.headers['content-type'])) {
      request.resume();
      runDetached(evaluateAndSend({ accessGate, evidence, ids, response, intent: null }), response);
      return true;
    }

    const header = headerAuthorityCategories(request.headers);
    if (header.categories.size > 0) {
      request.resume();
      runDetached(evaluateAndSend({
        accessGate,
        evidence,
        ids,
        response,
        intent: null,
        authorityClaimAttempt: {
          categories: [...header.categories],
          locations: ['header'],
        },
      }), response);
      return true;
    }

    const query = queryAssessment(url);
    if (query.categories.size > 0) {
      request.resume();
      runDetached(evaluateAndSend({
        accessGate,
        evidence,
        ids,
        response,
        intent: null,
        authorityClaimAttempt: {
          categories: [...query.categories],
          locations: ['query'],
        },
      }), response);
      return true;
    }

    runDetached(readJsonBody(request).then(({ ok, value }) => {
      const bodyCategories = ok ? bodyAuthorityCategories(value) : new Set();
      if (bodyCategories.size > 0) {
        return evaluateAndSend({
          accessGate,
          evidence,
          ids,
          response,
          intent: null,
          authorityClaimAttempt: {
            categories: [...bodyCategories],
            locations: ['body'],
          },
        });
      }
      const intent = ok && !query.hasUnknown && !header.invalidPixelHeader ? value : null;
      return evaluateAndSend({ accessGate, evidence, ids, response, intent });
    }), response);
    return true;
  };
}
