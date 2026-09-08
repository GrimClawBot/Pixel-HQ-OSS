import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorStorageAdapter } from '../../adapters/simulator/src/storage-simulator-adapter.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { DeviceStateProjector } from '../../services/device-state-api/src/device-state-projector.js';

const NOW = '2026-09-06T13:00:00.000Z';

function createIds() {
  let event = 0;
  let span = 0;
  return {
    nextEventId: () => `evt-projection-${String(++event).padStart(4, '0')}`,
    nextSpanId: () => (++span).toString(16).padStart(16, '0'),
  };
}

function createHarness() {
  const ids = createIds();
  const clock = () => NOW;
  const evidence = new EvidenceRecorder({ clock });
  const adapter = new SimulatorStorageAdapter({ clock, evidence, ids });
  const projector = new DeviceStateProjector({ evidence, ids, clock });
  return { adapter, evidence, projector };
}

test('projects a validated healthy event into the storage read model', async () => {
  const { adapter, projector } = createHarness();
  const event = await adapter.readSnapshot({
    scenario: 'healthy',
    traceContext: { traceId: '11111111111111111111111111111111' },
  });

  const view = projector.accept(event);

  assert.equal(view.role_id, 'PIXEL-STORAGE-01');
  assert.equal(view.display_name, 'Storage');
  assert.equal(view.state, 'Ready');
  assert.equal(view.trace_id, event.trace_id);
  assert.equal(view.storage.available_bytes, 16800000000000);
  assert.deepEqual(projector.getActiveAttention(), []);
});

test('deduplicates repeated degraded events into one attention item', async () => {
  const { adapter, projector } = createHarness();
  const first = await adapter.readSnapshot({
    scenario: 'degraded-storage',
    traceContext: { traceId: '22222222222222222222222222222222' },
  });
  const second = await adapter.readSnapshot({
    scenario: 'degraded-storage',
    traceContext: { traceId: '33333333333333333333333333333333' },
  });

  projector.accept(first);
  projector.accept(second);

  const attention = projector.getActiveAttention();
  assert.equal(attention.length, 1);
  assert.equal(attention[0].deduplication_key, 'PIXEL-STORAGE-01:storage-protection');
  assert.equal(attention[0].occurrence_count, 2);
  assert.equal(attention[0].first_seen_at, NOW);
  assert.equal(attention[0].last_seen_at, NOW);
  assert.equal(attention[0].trace_id, second.trace_id);
});

test('a later healthy event resolves active attention for the same role', async () => {
  const { adapter, projector } = createHarness();
  const degraded = await adapter.readSnapshot({
    scenario: 'degraded-storage',
    traceContext: { traceId: '44444444444444444444444444444444' },
  });
  const recovered = await adapter.readSnapshot({
    scenario: 'healthy',
    traceContext: { traceId: '55555555555555555555555555555555' },
  });

  projector.accept(degraded);
  projector.accept(recovered);

  assert.deepEqual(projector.getActiveAttention(), []);
  assert.equal(projector.getDevice('PIXEL-STORAGE-01').state, 'Ready');
});

test('invalid events fail closed without replacing the latest valid view', async () => {
  const { adapter, projector } = createHarness();
  const healthy = await adapter.readSnapshot({
    scenario: 'healthy',
    traceContext: { traceId: '66666666666666666666666666666666' },
  });
  projector.accept(healthy);

  assert.throws(
    () => projector.accept({ ...healthy, schema_version: '2.0.0' }),
    { name: 'PixelContractValidationError' },
  );
  assert.equal(projector.getDevice('PIXEL-STORAGE-01').event_id, healthy.event_id);
});

test('undeclared adapter fields cannot enter the projected API view', async () => {
  const { adapter, projector } = createHarness();
  const healthy = await adapter.readSnapshot({
    scenario: 'healthy',
    traceContext: { traceId: '68686868686868686868686868686868' },
  });
  projector.accept(healthy);

  const tainted = {
    ...healthy,
    device: {
      ...healthy.device,
      storage: { ...healthy.device.storage, raw_finance: { amount: 500 } },
    },
    provenance: { ...healthy.provenance, secret: 'must-not-project' },
  };

  assert.throws(() => projector.accept(tainted), { name: 'PixelContractValidationError' });
  const view = projector.getDevice('PIXEL-STORAGE-01');
  assert.equal('raw_finance' in view.storage, false);
  assert.equal('secret' in view.provenance, false);
});

test('records validation, projection, and attention stages under the event trace', async () => {
  const { adapter, evidence, projector } = createHarness();
  const traceId = '77777777777777777777777777777777';
  const degraded = await adapter.readSnapshot({
    scenario: 'degraded-storage',
    traceContext: { traceId },
  });

  projector.accept(degraded);

  assert.deepEqual(
    evidence.forTrace(traceId).map((record) => record.event_name),
    [
      'contract.device_snapshot.validated',
      'state.device.projected',
      'attention.item.upserted',
    ],
  );
});
