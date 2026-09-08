import assert from 'node:assert/strict';
import test from 'node:test';

import { loadAccessCard } from '../../apps/mission-control/src/access-card-controller.js';
import {
  renderAccessCard,
  renderAccessUnavailable,
} from '../../apps/mission-control/src/access-card-view.js';

const ALLOW = Object.freeze({
  decision_id: 'access-decision-0001',
  event_name: 'pixel.access.decision.v1',
  schema_version: '1.0.0',
  decided_at: '2026-09-06T14:00:00.000Z',
  environment: 'simulation',
  trace_id: '11111111111111111111111111111111',
  span_id: '1111111111111111',
  request_id: 'access-request-0001',
  decision: 'ALLOW',
  reason_code: 'ACCESS_ALLOWED',
  target: { app_id: 'pixel-bench', capability: 'launch' },
  owner: {
    state: 'Ready',
    summary: 'Pixel Bench is ready to open.',
    impact: 'Your current identity and device meet Pixel access requirements.',
  },
  policy_id: 'pixel.protected-app-access.v1',
  provenance: { access_gate_contract: 'pixel.access-gate.v1' },
});
const DENY = Object.freeze({
  ...ALLOW,
  decision_id: 'access-decision-0002',
  span_id: '2222222222222222',
  decision: 'DENY',
  reason_code: 'DEVICE_UNTRUSTED',
  owner: {
    state: 'Protected',
    summary: 'This Pixel app is unavailable on this device.',
    impact: 'Pixel requires a trusted device before opening protected apps.',
  },
});

function response(status, data) {
  return {
    status,
    async json() { return { data }; },
  };
}

function rootWithOldAllow() {
  return {
    innerHTML: '<button data-launch-state="authorized">Old ALLOW</button>',
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
  };
}

test('renders ALLOW through Simple, Details, and Expert without building Pixel Bench', () => {
  const html = renderAccessCard(ALLOW);

  assert.match(html, /<h2[^>]*>Pixel Bench<\/h2>/);
  assert.match(html, />Ready<\/span>/);
  assert.match(html, /data-launch-state="authorized"/);
  assert.match(html, /Authorized launch boundary/);
  assert.match(html, /<summary>Details<\/summary>/);
  assert.match(html, /<summary>Expert<\/summary>/);
  assert.match(html, /ACCESS_ALLOWED/);
  assert.match(html, /11111111111111111111111111111111/);
  assert.doesNotMatch(html, /iframe|canvas|webgl/i);
});

test('renders DENY as Protected with no enabled or authorized launch boundary', () => {
  const html = renderAccessCard(DENY);

  assert.match(html, />Protected<\/span>/);
  assert.match(html, /requires a trusted device/);
  assert.doesNotMatch(html, /data-launch-state="authorized"/);
  assert.doesNotMatch(html, /<button|href="[^\"]*pixel-bench/);
});

test('Expert stays source-neutral and escapes backend text', () => {
  const html = renderAccessCard({
    ...DENY,
    owner: {
      ...DENY.owner,
      summary: '<script>unsafe()</script>',
    },
  });

  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>unsafe/);
  assert.doesNotMatch(html, /SimulatorIdentityProvider|SimulatorDeviceTrustProvider|Authentik|YubiKey/i);
});

test('unavailable presentation is fail-closed and non-launchable', () => {
  const html = renderAccessUnavailable();

  assert.match(html, />Protected<\/span>/);
  assert.match(html, /could not verify protected-app access/);
  assert.doesNotMatch(html, /data-launch-state="authorized"|<button/);
});

test('controller clears a previous ALLOW before starting a fresh evaluation', async () => {
  const root = rootWithOldAllow();
  let resolveFetch;
  const pending = new Promise((resolve) => { resolveFetch = resolve; });

  const loading = loadAccessCard(root, { fetchImpl: () => pending });

  assert.doesNotMatch(root.innerHTML, /Old ALLOW|data-launch-state="authorized"/);
  assert.match(root.innerHTML, /Checking protected-app access/);
  resolveFetch(response(200, ALLOW));
  await loading;
  assert.match(root.innerHTML, /data-launch-state="authorized"/);
});

test('an older concurrent ALLOW cannot overwrite a newer DENY', async () => {
  const root = rootWithOldAllow();
  const pending = [];
  const fetchImpl = () => new Promise((resolve) => pending.push(resolve));

  const older = loadAccessCard(root, { fetchImpl });
  const newer = loadAccessCard(root, { fetchImpl });
  pending[1](response(403, DENY));
  await newer;
  pending[0](response(200, ALLOW));
  await older;

  assert.match(root.innerHTML, /Protected/);
  assert.doesNotMatch(root.innerHTML, /data-launch-state="authorized"/);
});

test('a hung access request times out into the fail-closed unavailable state', async () => {
  const root = rootWithOldAllow();
  let requestSignal;

  await loadAccessCard(root, {
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return new Promise(() => {});
    },
    timeoutMs: 5,
  });

  assert.equal(requestSignal.aborted, true);
  assert.equal(root.attributes.get('aria-busy'), 'false');
  assert.match(root.innerHTML, /Protected/);
  assert.match(root.innerHTML, /could not verify protected-app access/);
  assert.doesNotMatch(root.innerHTML, /Old ALLOW|data-launch-state="authorized"/);
});

test('malformed backend decision cannot leave an old launch boundary enabled', async () => {
  const root = rootWithOldAllow();

  await loadAccessCard(root, {
    fetchImpl: async () => response(200, { decision: 'ALLOW' }),
  });

  assert.doesNotMatch(root.innerHTML, /Old ALLOW|data-launch-state="authorized"/);
  assert.match(root.innerHTML, /could not verify protected-app access/);
});

test('ALLOW requires a complete current-shaped backend decision before rendering a launch boundary', async (t) => {
  const malformedAllows = [
    ['invalid decided_at', { ...ALLOW, decided_at: 'not-a-timestamp' }],
    ['zero trace_id', { ...ALLOW, trace_id: '00000000000000000000000000000000' }],
    ['zero span_id', { ...ALLOW, span_id: '0000000000000000' }],
    ['missing request_id', { ...ALLOW, request_id: null }],
    ['missing policy_id', { ...ALLOW, policy_id: null }],
  ];

  for (const [label, data] of malformedAllows) {
    await t.test(label, async () => {
      const root = rootWithOldAllow();
      await loadAccessCard(root, { fetchImpl: async () => response(200, data) });

      assert.doesNotMatch(root.innerHTML, /Old ALLOW|data-launch-state="authorized"/);
      assert.match(root.innerHTML, /could not verify protected-app access/);
    });
  }
});

test('access-service failure after ALLOW leaves Mission Control fail-closed', async () => {
  const root = rootWithOldAllow();

  await loadAccessCard(root, {
    fetchImpl: async () => { throw new Error('service unavailable'); },
  });

  assert.doesNotMatch(root.innerHTML, /Old ALLOW|data-launch-state="authorized"/);
  assert.match(root.innerHTML, /Protected/);
});

test('controller sends only the fixed non-authoritative launch intent', async () => {
  const root = rootWithOldAllow();
  let request;

  await loadAccessCard(root, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(403, DENY);
    },
  });

  assert.equal(request.url, '/api/v1/access/decisions');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {
    app_id: 'pixel-bench',
    capability: 'launch',
  });
  assert.equal(/identity|role|grant|device|trust|certificate|risk|environment/i.test(request.options.body), false);
  assert.match(root.innerHTML, /Protected/);
});
