import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { SimulatorStorageAdapter } from '../../adapters/simulator/src/storage-simulator-adapter.js';
import { SimulatorDeviceTrustProvider } from '../../adapters/simulator/src/device-trust-simulator-provider.js';
import { createMilestoneRuntime } from '../../apps/mission-control/src/server.js';
import { assessAccessTraceCompleteness, assessDeviceTraceCompleteness } from '../../packages/telemetry/src/trace-completeness.js';

const NOW = '2026-09-06T14:00:00.000Z';
const INTENT = Object.freeze({ app_id: 'pixel-bench', capability: 'launch' });

function createIds(seed = 3000) {
  let event = seed;
  let span = seed;
  let trace = seed;
  return {
    nextEventId: () => `access-api-${String(++event).padStart(6, '0')}`,
    nextSpanId: () => (++span).toString(16).padStart(16, '0'),
    nextTraceId: () => (++trace).toString(16).padStart(32, '0'),
  };
}

async function startRuntime(options = {}) {
  const runtime = await createMilestoneRuntime({
    adapterFactory: (dependencies) => new SimulatorStorageAdapter(dependencies),
    scenario: 'degraded-storage',
    clock: () => NOW,
    ids: createIds(),
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

async function decision(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/access/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(INTENT),
  });
  return { response, body: await response.json() };
}

test('Mission Control runtime exposes the versioned Access Gate path', async (t) => {
  const runtime = await startRuntime();
  t.after(runtime.close);

  const result = await decision(runtime.baseUrl);

  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.event_name, 'pixel.access.decision.v1');
  assert.equal(result.body.data.decision, 'ALLOW');
  assert.equal(
    assessAccessTraceCompleteness(runtime.evidence.forTrace(result.body.data.trace_id)).complete,
    true,
  );
});

test('repeated access evaluations keep independent complete traces', async (t) => {
  const runtime = await startRuntime();
  t.after(runtime.close);
  const traceIds = [];

  for (let index = 0; index < 10; index += 1) {
    const result = await decision(runtime.baseUrl);
    traceIds.push(result.body.data.trace_id);
  }

  assert.equal(new Set(traceIds).size, 10);
  assert.equal(
    traceIds.every((traceId) => assessAccessTraceCompleteness(runtime.evidence.forTrace(traceId)).complete),
    true,
  );
});

test('access, attention, and device reads do not corrupt one another', async (t) => {
  const runtime = await startRuntime();
  t.after(runtime.close);

  const firstAccess = await decision(runtime.baseUrl);
  await fetch(`${runtime.baseUrl}/api/v1/attention`);
  await fetch(`${runtime.baseUrl}/api/v1/devices/PIXEL-STORAGE-01`);
  const secondAccess = await decision(runtime.baseUrl);

  assert.equal(
    assessAccessTraceCompleteness(runtime.evidence.forTrace(firstAccess.body.data.trace_id)).complete,
    true,
  );
  assert.equal(
    assessAccessTraceCompleteness(runtime.evidence.forTrace(secondAccess.body.data.trace_id)).complete,
    true,
  );
  assert.equal(
    assessDeviceTraceCompleteness(runtime.evidence.forTrace(runtime.event.trace_id)).complete,
    true,
  );
});

test('runtime revocation changes the next API decision without a client mutation route', async (t) => {
  const runtime = await startRuntime();
  t.after(runtime.close);

  const before = await decision(runtime.baseUrl);
  runtime.accessDeviceTrustProvider.revoke();
  const after = await decision(runtime.baseUrl);
  const attemptedMutation = await fetch(`${runtime.baseUrl}/api/v1/access/devices/revoke`, { method: 'POST' });

  assert.equal(before.body.data.decision, 'ALLOW');
  assert.equal(after.body.data.reason_code, 'DEVICE_REVOKED');
  assert.equal(attemptedMutation.status, 404);
});

test('runtime accepts an independently supplied untrusted provider without changing the API', async (t) => {
  const runtime = await startRuntime({
    accessDeviceTrustProvider: new SimulatorDeviceTrustProvider({ trustStatus: 'untrusted' }),
  });
  t.after(runtime.close);

  const result = await decision(runtime.baseUrl);

  assert.equal(result.response.status, 403);
  assert.equal(result.body.data.reason_code, 'DEVICE_UNTRUSTED');
});
