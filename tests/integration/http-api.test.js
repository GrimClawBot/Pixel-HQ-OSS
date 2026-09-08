import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { SimulatorStorageAdapter } from '../../adapters/simulator/src/storage-simulator-adapter.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { DeviceStateProjector } from '../../services/device-state-api/src/device-state-projector.js';
import { createPixelHttpServer } from '../../services/device-state-api/src/http-api.js';
import { ENGINEERING_SIMULATED_REQUESTER } from '../../services/policy/src/trusted-requester-context.js';

function createIds() {
  let event = 0;
  let span = 0;
  let trace = 8;
  return {
    nextEventId: () => `evt-http-${String(++event).padStart(4, '0')}`,
    nextSpanId: () => (++span).toString(16).padStart(16, '0'),
    nextTraceId: () => (++trace).toString(16).padStart(32, '0'),
  };
}

async function createServer(scenario = 'healthy') {
  const clock = () => '2026-09-06T13:00:00.000Z';
  const ids = createIds();
  const evidence = new EvidenceRecorder({ clock });
  const projector = new DeviceStateProjector({ evidence, ids, clock });
  const adapter = new SimulatorStorageAdapter({ clock, evidence, ids });
  const event = await adapter.readSnapshot({
    scenario,
    traceContext: { traceId: '88888888888888888888888888888888' },
  });
  projector.accept(event);
  const server = createPixelHttpServer({
    projector,
    evidence,
    requesterContext: ENGINEERING_SIMULATED_REQUESTER,
    ids,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    evidence,
    event,
  };
}

test('serves the projected storage device through the versioned API', async (t) => {
  const runtime = await createServer('healthy');
  t.after(runtime.close);

  const response = await fetch(`${runtime.baseUrl}/api/v1/devices/PIXEL-STORAGE-01`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(body.data.role_id, 'PIXEL-STORAGE-01');
  assert.equal(body.data.state, 'Ready');
  assert.equal(body.data.trace_id, runtime.event.trace_id);
});

test('serves one deduplicated attention collection', async (t) => {
  const runtime = await createServer('degraded-storage');
  t.after(runtime.close);

  const response = await fetch(`${runtime.baseUrl}/api/v1/attention`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].state, 'Needs Attention');
  assert.equal(body.items[0].role_id, 'PIXEL-STORAGE-01');
});

test('serves structured evidence by trace ID', async (t) => {
  const runtime = await createServer('healthy');
  t.after(runtime.close);

  await fetch(`${runtime.baseUrl}/api/v1/devices/PIXEL-STORAGE-01`);
  const response = await fetch(`${runtime.baseUrl}/api/v1/evidence/${runtime.event.trace_id}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.trace_id, runtime.event.trace_id);
  assert.equal(body.records.length >= 3, true);
  assert.equal(body.records.every((record) => record.trace_id === runtime.event.trace_id), true);
});

test('rejects malformed evidence trace identifiers before lookup', async (t) => {
  const runtime = await createServer('healthy');
  t.after(runtime.close);

  const response = await fetch(`${runtime.baseUrl}/api/v1/evidence/not-a-trace`);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'invalid_trace_id',
    message: 'The trace identifier is invalid.',
  });
});

test('returns bounded JSON for unknown API routes', async (t) => {
  const runtime = await createServer();
  t.after(runtime.close);

  const response = await fetch(`${runtime.baseUrl}/api/v1/unknown`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: 'not_found',
    message: 'The requested Pixel resource was not found.',
  });
});
