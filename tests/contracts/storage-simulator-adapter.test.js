import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorStorageAdapter } from '../../adapters/simulator/src/storage-simulator-adapter.js';

const NOW = '2026-09-06T13:00:00.000Z';
const TRACE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function createIds() {
  let event = 0;
  let span = 0;
  return {
    nextEventId: () => `evt-storage-${String(++event).padStart(4, '0')}`,
    nextSpanId: () => String(++span).padStart(16, '0'),
  };
}

function createAdapter() {
  const clock = () => NOW;
  return new SimulatorStorageAdapter({ clock, ids: createIds() });
}

test('emits a healthy PIXEL-STORAGE-01 snapshot', async () => {
  const adapter = createAdapter();

  const event = await adapter.readSnapshot({
    scenario: 'healthy',
    traceContext: { traceId: TRACE_ID },
  });

  assert.equal(event.device.role_id, 'PIXEL-STORAGE-01');
  assert.equal(event.device.health_state, 'ready');
  assert.equal(event.owner.state, 'Ready');
  assert.equal(event.device.storage.protection_state, 'protected');
  assert.match(event.owner.summary, /ready and protected/i);
  assert.equal(event.attention, null);
  assert.equal(event.trace_id, TRACE_ID);
  assert.equal(event.source, 'simulator');
});

test('emits deterministic degraded storage through the same event contract', async () => {
  const adapter = createAdapter();

  const healthy = await adapter.readSnapshot({
    scenario: 'healthy',
    traceContext: { traceId: TRACE_ID },
  });
  const degraded = await adapter.readSnapshot({
    scenario: 'degraded-storage',
    traceContext: { traceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  });

  assert.equal(degraded.event_name, healthy.event_name);
  assert.equal(degraded.schema_version, healthy.schema_version);
  assert.deepEqual(Object.keys(degraded).sort(), Object.keys(healthy).sort());
  assert.equal(degraded.device.health_state, 'needs_attention');
  assert.equal(degraded.owner.state, 'Needs Attention');
  assert.equal(degraded.device.storage.protection_state, 'at_risk');
  assert.match(degraded.owner.summary, /protection is at risk/i);
  assert.doesNotMatch(degraded.owner.summary, /still protected/i);
  assert.equal(
    degraded.attention.deduplication_key,
    'PIXEL-STORAGE-01:storage-protection',
  );
});

test('rejects unknown scenarios before returning a snapshot', async () => {
  const adapter = createAdapter();

  await assert.rejects(
    adapter.readSnapshot({
      scenario: 'invented-state',
      traceContext: { traceId: TRACE_ID },
    }),
    /Unsupported storage simulator scenario/,
  );
});
