import { failure, serializeOverview } from './overview-contract.js';
const PATH = '/api/v1/mission-control/overview';
function send(response, status, value) {
  const body = serializeOverview(value);
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body), 'x-content-type-options': 'nosniff',
    ...(status === 405 ? { allow: 'GET' } : {}) });
  response.end(body);
}
export function createOverviewHttpHandler(projector) {
  return (request, response, url) => {
    if (url.pathname !== PATH) return false;
    request.resume();
    if (request.method !== 'GET') { send(response, 405, failure('METHOD_NOT_ALLOWED')); return true; }
    if (url.search || request.headers['transfer-encoding'] !== undefined
      || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
      send(response, 400, failure('REQUEST_INVALID')); return true;
    }
    void projector.project().then(view => {
      if (!response.destroyed) send(response, view.availability === 'FAILED' ? 503 : 200, view);
    }).catch(() => { if (!response.headersSent && !response.destroyed) send(response, 503, failure('SOURCE_INVALID')); });
    return true;
  };
}
