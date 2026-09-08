import { createServer } from 'node:http';

import { evaluateDataAccess } from '../../policy/src/data-boundary-policy.js';

const FINANCE_RESOURCE = Object.freeze({
  domain: 'Finance & Opportunity',
  data_classification: 'RESTRICTED',
});

const TRACE_ID = /^[0-9a-f]{32}$/;

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

function spanIdForStage(evidence, traceId, eventName) {
  return evidence.forTrace(traceId).find((record) => record.event_name === eventName)?.span_id ?? null;
}

function recordApiResponse({ evidence, ids, traceId, parentSpanId, method, route, statusCode, outcome }) {
  return evidence.append({
    traceId,
    spanId: ids.nextSpanId(),
    parentSpanId,
    serviceName: 'pixel.device-state-api',
    eventName: outcome === 'denied' ? 'api.request.denied' : 'api.response.sent',
    outcome,
    severity: statusCode >= 400 ? 'warning' : 'info',
    attributes: {
      'http.request.method': method,
      'http.route': route,
      'http.response.status_code': statusCode,
    },
  });
}

export function createPixelHttpServer({ projector, evidence, requesterContext, ids, fallbackHandler = null }) {
  if (!projector || !evidence || !requesterContext || !ids) {
    throw new TypeError('Pixel HTTP API requires projector, evidence, requesterContext, and ids');
  }
  const trustedRequester = Object.freeze({
    ...structuredClone(requesterContext),
    grants: Object.freeze([...(requesterContext.grants ?? [])]),
  });

  return createServer((request, response) => {
    const url = new URL(request.url, 'http://pixel.local');

    if (request.method === 'GET' && url.pathname === '/api/v1/devices/PIXEL-STORAGE-01') {
      const view = projector.getDevice('PIXEL-STORAGE-01');
      if (!view) {
        sendJson(response, 404, {
          error: 'not_found',
          message: 'Storage state is not available.',
        });
        return;
      }
      recordApiResponse({
        evidence,
        ids,
        traceId: view.trace_id,
        parentSpanId: spanIdForStage(evidence, view.trace_id, 'state.device.projected'),
        method: request.method,
        route: '/api/v1/devices/{role_id}',
        statusCode: 200,
        outcome: 'success',
      });
      sendJson(response, 200, { data: view });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/attention') {
      const items = projector.getActiveAttention();
      const traceId = items[0]?.trace_id;
      if (traceId) {
        recordApiResponse({
          evidence,
          ids,
          traceId,
          parentSpanId: spanIdForStage(evidence, traceId, 'attention.item.upserted'),
          method: request.method,
          route: '/api/v1/attention',
          statusCode: 200,
          outcome: 'success',
        });
      }
      sendJson(response, 200, { items });
      return;
    }

    const evidencePrefix = '/api/v1/evidence/';
    if (request.method === 'GET' && url.pathname.startsWith(evidencePrefix)) {
      const traceId = url.pathname.slice(evidencePrefix.length);
      if (!TRACE_ID.test(traceId)) {
        sendJson(response, 400, {
          error: 'invalid_trace_id',
          message: 'The trace identifier is invalid.',
        });
        return;
      }
      const records = evidence.forTrace(traceId);
      if (records.length === 0) {
        sendJson(response, 404, {
          error: 'not_found',
          message: 'No evidence was found for that trace.',
        });
        return;
      }
      sendJson(response, 200, { trace_id: traceId, records });
      return;
    }

    if (
      (request.method === 'GET' || request.method === 'POST')
      && url.pathname === '/api/v1/finance/raw'
    ) {
      request.resume();
      const traceId = ids.nextTraceId();
      const policySpanId = ids.nextSpanId();
      const policyDecision = evaluateDataAccess({
        requester: trustedRequester,
        action: 'finance.raw:read',
        resource: FINANCE_RESOURCE,
      });
      evidence.append({
        traceId,
        spanId: policySpanId,
        serviceName: 'pixel.policy',
        eventName: 'policy.data_boundary.evaluated',
        outcome: policyDecision.decision === 'ALLOW' ? 'success' : 'denied',
        severity: policyDecision.decision === 'ALLOW' ? 'info' : 'warning',
        attributes: {
          'pixel.identity.subject_id': trustedRequester.subject_id,
          'pixel.identity.department': trustedRequester.department,
          'pixel.policy.id': policyDecision.policy_id,
          'pixel.policy.decision': policyDecision.decision,
          'pixel.policy.action': 'finance.raw:read',
          'pixel.data.domain': FINANCE_RESOURCE.domain,
          'pixel.data.classification': FINANCE_RESOURCE.data_classification,
        },
      });

      if (policyDecision.decision !== 'ALLOW') {
        recordApiResponse({
          evidence,
          ids,
          traceId,
          parentSpanId: policySpanId,
          method: request.method,
          route: '/api/v1/finance/raw',
          statusCode: 403,
          outcome: 'denied',
        });
        sendJson(response, 403, {
          error: 'permission_denied',
          state: 'permission_denied',
          message: 'Pixel protected restricted Finance data. Nothing was shared.',
          trace_id: traceId,
        });
        return;
      }

      sendJson(response, 501, {
        error: 'not_implemented',
        message: 'Raw Finance retrieval is outside this milestone.',
        trace_id: traceId,
      });
      return;
    }

    if (fallbackHandler?.(request, response, url) === true) {
      return;
    }

    sendJson(response, 404, {
      error: 'not_found',
      message: 'The requested Pixel resource was not found.',
    });
  });
}
