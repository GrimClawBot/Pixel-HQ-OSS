import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { SimulatorStorageAdapter } from '../../adapters/simulator/src/storage-simulator-adapter.js';
import { SimulatorDeviceTrustProvider } from '../../adapters/simulator/src/device-trust-simulator-provider.js';
import { renderAccessCard } from '../../apps/mission-control/src/access-card-view.js';
import { createMilestoneRuntime } from '../../apps/mission-control/src/server.js';

const NOW = '2026-09-06T14:00:00.000Z';
const INTENT = Object.freeze({ app_id: 'pixel-bench', capability: 'launch' });

function createIds(seed) {
  let event = seed;
  let span = seed;
  let trace = seed;
  return {
    nextEventId: () => `access-vertical-${String(++event).padStart(6, '0')}`,
    nextSpanId: () => (++span).toString(16).padStart(16, '0'),
    nextTraceId: () => (++trace).toString(16).padStart(32, '0'),
  };
}

async function startRuntime(options = {}) {
  const runtime = await createMilestoneRuntime({
    adapterFactory: (dependencies) => new SimulatorStorageAdapter(dependencies),
    clock: () => NOW,
    ids: createIds(options.seed ?? 4000),
    ...options,
  });
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const address = runtime.server.address();
  return {
    ...runtime,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => runtime.server.close((error) => error ? reject(error) : resolve())),
  };
}

async function accessDecision(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/access/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(INTENT),
  });
  return { response, decision: (await response.json()).data };
}

test('trusted and untrusted paths use one API and one Mission Control renderer', async (t) => {
  const trusted = await startRuntime({ seed: 4000 });
  const untrusted = await startRuntime({
    seed: 5000,
    accessDeviceTrustProvider: new SimulatorDeviceTrustProvider({ trustStatus: 'untrusted' }),
  });
  t.after(trusted.close);
  t.after(untrusted.close);

  const allowed = await accessDecision(trusted.baseUrl);
  const denied = await accessDecision(untrusted.baseUrl);
  const allowedCard = renderAccessCard(allowed.decision);
  const deniedCard = renderAccessCard(denied.decision);

  assert.equal(new URL(allowed.response.url).pathname, '/api/v1/access/decisions');
  assert.equal(new URL(denied.response.url).pathname, '/api/v1/access/decisions');
  assert.match(allowedCard, /data-launch-state="authorized"/);
  assert.doesNotMatch(deniedCard, /data-launch-state="authorized"/);
});

test('Mission Control page loads protected-app access separately from storage', async (t) => {
  const runtime = await startRuntime({ seed: 6000 });
  t.after(runtime.close);

  const page = await fetch(`${runtime.baseUrl}/`).then((response) => response.text());
  const controller = await fetch(`${runtime.baseUrl}/access-card.js`).then((response) => response.text());

  assert.match(page, /id="storage-card-root"/);
  assert.match(page, /id="access-card-root"/);
  assert.match(controller, /loadAccessCard/);
  assert.doesNotMatch(controller, /trust_status|certificate_status|risk_posture|Simulator/);
});

test('server-side revocation reaches the same renderer on the next evaluation', async (t) => {
  const runtime = await startRuntime({ seed: 7000 });
  t.after(runtime.close);

  const before = await accessDecision(runtime.baseUrl);
  runtime.accessDeviceTrustProvider.revoke();
  const after = await accessDecision(runtime.baseUrl);

  assert.match(renderAccessCard(before.decision), /data-launch-state="authorized"/);
  assert.doesNotMatch(renderAccessCard(after.decision), /data-launch-state="authorized"/);
  assert.match(renderAccessCard(after.decision), /Protected/);
});

test('live-shaped provider replacement reaches the same API and renderer in shadow', async (t) => {
  const identityProvider = {
    source: 'live',
    async resolveIdentity() {
      return {
        subject_id: 'PIXEL-PRINCIPAL', identity_class: 'human', role: 'Principal',
        verification_status: 'verified', provider_contract: 'pixel.identity-context-provider.v1', source: 'live',
      };
    },
  };
  const deviceTrustProvider = {
    source: 'live',
    async resolveDeviceTrust() {
      return {
        device_id: 'qualified-device-test-01', enrollment_status: 'enrolled', trust_status: 'trusted',
        certificate_status: 'valid', risk_posture: 'acceptable',
        provider_contract: 'pixel.device-trust-provider.v1', source: 'live',
      };
    },
  };
  const runtime = await startRuntime({
    seed: 8000,
    accessEnvironment: 'shadow',
    accessIdentityProvider: identityProvider,
    accessDeviceTrustProvider: deviceTrustProvider,
  });
  t.after(runtime.close);

  const result = await accessDecision(runtime.baseUrl);

  assert.equal(result.decision.environment, 'shadow');
  assert.match(renderAccessCard(result.decision), /data-launch-state="authorized"/);
});

test('Mission Control access modules do not import simulator or trust providers', async () => {
  const files = [
    '../../apps/mission-control/src/access-card-view.js',
    '../../apps/mission-control/src/access-card-controller.js',
    '../../apps/mission-control/public/access-card.js',
  ];
  const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));

  assert.equal(sources.some((source) => /adapters\/simulator|SimulatorIdentity|SimulatorDeviceTrust/.test(source)), false);
});
