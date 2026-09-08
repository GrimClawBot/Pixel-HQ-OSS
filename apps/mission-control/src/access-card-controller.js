import {
  isValidAccessDecisionView,
  renderAccessCard,
  renderAccessChecking,
  renderAccessUnavailable,
} from './access-card-view.js';

const INTENT = Object.freeze({ app_id: 'pixel-bench', capability: 'launch' });
const ACTIVE_LOADS = new WeakMap();
const ACCESS_REQUEST_TIMEOUT_MS = 5_000;

export async function loadAccessCard(root, {
  fetchImpl = fetch,
  timeoutMs = ACCESS_REQUEST_TIMEOUT_MS,
} = {}) {
  const loadToken = Object.freeze({});
  const controller = new AbortController();
  let timeoutId;
  ACTIVE_LOADS.set(root, loadToken);
  root.setAttribute('aria-busy', 'true');
  root.innerHTML = renderAccessChecking();
  try {
    const response = await Promise.race([
      fetchImpl('/api/v1/access/decisions', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(INTENT),
        signal: controller.signal,
      }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error('Access request timed out'));
        }, timeoutMs);
      }),
    ]);
    const body = await response.json();
    if (!isValidAccessDecisionView(body?.data)) throw new TypeError('Invalid access decision');
    if (body.data.decision === 'ALLOW' && response.status !== 200) throw new TypeError('Invalid allow status');
    if (body.data.decision === 'DENY' && response.status !== 403) throw new TypeError('Invalid deny status');
    if (ACTIVE_LOADS.get(root) !== loadToken) return;
    root.innerHTML = renderAccessCard(body.data);
  } catch {
    if (ACTIVE_LOADS.get(root) !== loadToken) return;
    root.innerHTML = renderAccessUnavailable();
  } finally {
    clearTimeout(timeoutId);
    if (ACTIVE_LOADS.get(root) === loadToken) root.setAttribute('aria-busy', 'false');
  }
}
