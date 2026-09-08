import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { SimulatorStorageAdapter } from '../../adapters/simulator/src/storage-simulator-adapter.js';
import { renderStorageCard } from '../../apps/mission-control/src/storage-card-view.js';
import { createMilestoneRuntime } from '../../apps/mission-control/src/server.js';
import { assessDeviceTraceCompleteness } from '../../packages/telemetry/src/trace-completeness.js';

const DEVICE_PATH = '/api/v1/devices/PIXEL-STORAGE-01';
const NOW = '2026-09-06T13:00:00.000Z';

function createIds(seed) {
  let event = seed;
  let span = seed;
  let trace = seed;
  return {
    nextEventId: () => `evt-vertical-${String(++event).padStart(4, '0')}`,
    nextSpanId: () => (++span).toString(16).padStart(16, '0'),
    nextTraceId: () => (++trace).toString(16).padStart(32, '0'),
  };
}

async function listen(runtime) {
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const address = runtime.server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => runtime.server.close((error) => error ? reject(error) : resolve())),
  };
}

function liveReplacementAdapter() {
  return {
    async readSnapshot({ traceContext }) {
      return {
        event_id: 'evt-live-replacement-0001',
        event_name: 'pixel.device.snapshot.v1',
        schema_version: '1.0.0',
        occurred_at: NOW,
        environment: 'shadow',
        source: 'live',
        trace_id: traceContext.traceId,
        span_id: 'eeeeeeeeeeeeeeee',
        device: {
          device_id: 'enrolled-storage-test-01',
          role_id: 'PIXEL-STORAGE-01',
          lifecycle_state: 'active',
          health_state: 'ready',
          storage: {
            capacity_bytes: 24000000000000,
            used_bytes: 7200000000000,
            available_bytes: 16800000000000,
            protection_state: 'protected',
          },
        },
        owner: {
          state: 'Ready',
          summary: 'Your storage is ready and protected.',
          impact: 'Files and backups remain available.',
          action_required: false,
          recommended_action: null,
          verified_at: NOW,
        },
        attention: null,
        provenance: {
          adapter_contract: 'pixel.device.adapter.v1',
          adapter_id: 'test.live.storage.v1',
          scenario: 'shadow-readiness',
        },
      };
    },
  };
}

function simulatorAdapterFactory(dependencies) {
  return new SimulatorStorageAdapter(dependencies);
}

test('healthy and degraded scenarios use one API path and one card renderer', async (t) => {
  const healthyRuntime = await createMilestoneRuntime({
    adapterFactory: simulatorAdapterFactory,
    scenario: 'healthy',
    clock: () => NOW,
    ids: createIds(300),
  });
  const degradedRuntime = await createMilestoneRuntime({
    adapterFactory: simulatorAdapterFactory,
    scenario: 'degraded-storage',
    clock: () => NOW,
    ids: createIds(400),
  });
  const healthy = await listen(healthyRuntime);
  const degraded = await listen(degradedRuntime);
  t.after(healthy.close);
  t.after(degraded.close);

  const healthyResponse = await fetch(`${healthy.baseUrl}${DEVICE_PATH}`);
  const degradedResponse = await fetch(`${degraded.baseUrl}${DEVICE_PATH}`);
  const healthyView = (await healthyResponse.json()).data;
  const degradedView = (await degradedResponse.json()).data;
  const healthyCard = renderStorageCard(healthyView);
  const degradedCard = renderStorageCard(degradedView);

  assert.equal(new URL(healthyResponse.url).pathname, DEVICE_PATH);
  assert.equal(new URL(degradedResponse.url).pathname, DEVICE_PATH);
  assert.match(healthyCard, />Ready<\/span>/);
  assert.match(degradedCard, />Needs Attention<\/span>/);
  assert.equal(healthyView.event_name, degradedView.event_name);
  assert.equal(healthyView.schema_version, degradedView.schema_version);
  assert.equal(healthyView.storage.protection_state, 'protected');
  assert.equal(degradedView.storage.protection_state, 'at_risk');
  assert.match(degradedCard, /Protection<\/dt><dd>At Risk<\/dd>/);
  assert.match(degradedCard, /Protection is at risk\./);
  assert.doesNotMatch(degradedCard, /still protected/i);

  const attention = await fetch(`${degraded.baseUrl}/api/v1/attention`).then((response) => response.json());
  assert.equal(attention.items.length, 1);
});

test('Mission Control page loads the storage card from the versioned API', async (t) => {
  const runtime = await createMilestoneRuntime({
    adapterFactory: simulatorAdapterFactory,
    scenario: 'healthy',
    clock: () => NOW,
    ids: createIds(500),
  });
  const server = await listen(runtime);
  t.after(server.close);

  const page = await fetch(`${server.baseUrl}/`).then((response) => response.text());
  const controller = await fetch(`${server.baseUrl}/storage-card.js`).then((response) => response.text());

  assert.match(page, /<main[^>]+id="mission-control"/);
  assert.match(page, /id="storage-card-root"/);
  assert.match(controller, /fetch\('\/api\/v1\/devices\/PIXEL-STORAGE-01'/);
});

test('a replacement adapter reaches the same API, card, and evidence path without Mission Control changes', async (t) => {
  const runtime = await createMilestoneRuntime({
    adapterFactory: () => liveReplacementAdapter(),
    scenario: 'healthy',
    clock: () => NOW,
    ids: createIds(600),
  });
  const server = await listen(runtime);
  t.after(server.close);

  const response = await fetch(`${server.baseUrl}${DEVICE_PATH}`);
  const view = (await response.json()).data;
  const card = renderStorageCard(view);

  assert.equal(new URL(response.url).pathname, DEVICE_PATH);
  assert.equal(view.source, 'live');
  assert.match(card, />Ready<\/span>/);
  assert.match(card, /test\.live\.storage\.v1/);
  assert.equal(
    assessDeviceTraceCompleteness(runtime.evidence.forTrace(runtime.event.trace_id)).complete,
    true,
  );
});

test('shared composition records a source-neutral adapter boundary', async () => {
  const runtime = await createMilestoneRuntime({
    adapterFactory: () => liveReplacementAdapter(),
    scenario: 'healthy',
    clock: () => NOW,
    ids: createIds(700),
  });

  assert.deepEqual(
    runtime.evidence.forTrace(runtime.event.trace_id).map((record) => record.event_name),
    [
      'adapter.snapshot.received',
      'contract.device_snapshot.validated',
      'state.device.projected',
    ],
  );
});
