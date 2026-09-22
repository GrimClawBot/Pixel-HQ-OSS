import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorIncidentStoreAdapter } from '../../adapters/simulator/src/incident-store-simulator-adapter.js';
import { createIds, createClock } from '../helpers/px006-runtime.js';
import { IncidentService } from '../../services/incident/src/incident-service.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';

function serviceWithStore(store, clock = createClock()) {
  const ids = createIds(80_000);
  const evidence = new EvidenceRecorder({ clock: () => clock.now() });
  const incident = new IncidentService({
    environment: 'simulation', store, evidence, ids, clock: () => clock.now(),
  });
  return { incident, evidence, clock, ids };
}

function createInput(overrides = {}) {
  return {
    incident_id: 'incident-001', operation_id: 'op-create-1',
    incident_class: 'INFRASTRUCTURE', severity: 'SEV-1',
    commander_ref: 'PIXEL-SYSTEMS-IC', source_ref: 'sensor', summary_code: 'X',
    affected_resource_refs: ['r1'], affected_job_refs: [],
    ...overrides,
  };
}

// A store wrapper that can simulate ambiguous (unknown outcome) writes.
class AmbiguousStoreWrapper {
  constructor(inner, { ambiguousCount = 0, failReadBack = false } = {}) {
    this.inner = inner;
    this.ambiguousRemaining = ambiguousCount;
    this.failReadBack = failReadBack;
    this.putCalls = 0;
    this.readBackCalls = 0;
  }

  get source() { return this.inner.source; }

  put(kind, value, options) {
    this.putCalls += 1;
    if (this.ambiguousRemaining > 0) {
      // The write may have committed before the caller learned the outcome.
      this.ambiguousRemaining -= 1;
      const committed = this.inner.put(kind, value, options);
      return { disposition: 'AMBIGUOUS', record: committed.record };
    }
    return this.inner.put(kind, value, options);
  }

  get(kind, id) { return this.inner.get(kind, id); }
  list(kind) { return this.inner.list(kind); }
  activeIncidents() { return this.inner.activeIncidents(); }
  readOperation(operationId) {
    this.readBackCalls += 1;
    if (this.failReadBack) return null;
    return this.inner.readOperation(operationId);
  }
}

test('exact operation replay is idempotent and returns the committed result', () => {
  const store = new SimulatorIncidentStoreAdapter();
  const { incident } = serviceWithStore(store);
  const first = incident.createIncident(createInput());
  assert.equal(first.disposition, 'RECORDED');
  const replay = incident.createIncident(createInput());
  assert.equal(replay.disposition, 'RECORDED');
  assert.deepEqual(replay.record, first.record);
  assert.equal(store.list('incident').length, 1);
});

test('conflicting operation-ID reuse rejects', () => {
  const { incident } = serviceWithStore(new SimulatorIncidentStoreAdapter());
  incident.createIncident(createInput());
  // Same operation id, different payload -> conflict, no mutation.
  const conflict = incident.createIncident(createInput({ severity: 'SEV-0' }));
  assert.equal(conflict.disposition, 'REJECTED');
  assert.equal(conflict.reason_code, 'OP_CONFLICT');
  assert.equal(incident.getIncident('incident-001').severity, 'SEV-1');
});

test('empty operation IDs reject as OPERATION_INVALID before any state read', () => {
  const store = new SimulatorIncidentStoreAdapter();
  const { incident } = serviceWithStore(store);
  assert.equal(incident.createIncident(createInput()).disposition, 'RECORDED');
  const record = incident.getIncident('incident-001');
  const empty = store.put('incident', record, { expectedRevision: record.revision, operationId: '' });
  assert.equal(empty.disposition, 'REJECTED');
  assert.equal(empty.reason_code, 'OPERATION_INVALID');
  assert.equal(store.readOperation(''), null);
  assert.equal(incident.getIncident('incident-001').revision, record.revision);
});

test('duplicate incident IDs reject except exact idempotent replay', () => {
  const { incident } = serviceWithStore(new SimulatorIncidentStoreAdapter());
  incident.createIncident(createInput());
  const duplicate = incident.createIncident(createInput({ operation_id: 'op-create-2' }));
  assert.equal(duplicate.disposition, 'REJECTED');
  assert.equal(duplicate.reason_code, 'ALREADY_EXISTS');
});

test('stale mutations reject without state change', () => {
  const { incident } = serviceWithStore(new SimulatorIncidentStoreAdapter());
  incident.createIncident(createInput());
  const stale = incident.advancePhase({
    incident_id: 'incident-001', operation_id: 'op-stale', expected_revision: 99, phase: 'CONTAIN',
  });
  assert.equal(stale.disposition, 'REJECTED');
  assert.equal(stale.reason_code, 'STALE_REVISION');
  assert.equal(incident.getIncident('incident-001').response_phase, 'DECLARE');
});

test('ambiguous write with committed operation reads back and never mutates twice', () => {
  const store = new AmbiguousStoreWrapper(new SimulatorIncidentStoreAdapter(), { ambiguousCount: 1 });
  const { incident } = serviceWithStore(store);
  const result = incident.createIncident(createInput());
  assert.equal(result.disposition, 'RECORDED');
  assert.equal(store.putCalls, 1);
  assert.equal(store.readBackCalls, 1);
  assert.equal(incident.getIncident('incident-001').status, 'OPEN');
});

test('ambiguous write with no committed operation retries the same operation ID', () => {
  const inner = new SimulatorIncidentStoreAdapter();
  // First put is swallowed: it is NOT committed, so read-back finds nothing.
  const store = new class extends AmbiguousStoreWrapper {
    put(kind, value, options) {
      this.putCalls += 1;
      if (this.ambiguousRemaining > 0) {
        this.ambiguousRemaining -= 1;
        return { disposition: 'AMBIGUOUS', record: null };
      }
      return this.inner.put(kind, value, options);
    }
  }(inner, { ambiguousCount: 1 });
  const { incident } = serviceWithStore(store);
  const result = incident.createIncident(createInput());
  assert.equal(result.disposition, 'RECORDED');
  assert.equal(store.putCalls, 2);
  assert.equal(store.readBackCalls, 1);
  assert.equal(incident.getIncident('incident-001').status, 'OPEN');
});

test('ambiguous write with revision drift fails closed', () => {
  const inner = new SimulatorIncidentStoreAdapter();
  // The incident is created and advanced to revision 2 through a clean inner
  // store; only the update under test is ambiguous (unknown outcome). The
  // ambiguous write is NOT committed, so read-back finds nothing, and the
  // current revision has drifted from the caller's expected revision.
  const clean = serviceWithStore(inner);
  clean.incident.createIncident(createInput());
  const other = serviceWithStore(inner);
  other.incident.advancePhase({
    incident_id: 'incident-001', operation_id: 'op-other-advance',
    expected_revision: 1, phase: 'CONTAIN',
  });
  const store = new class extends AmbiguousStoreWrapper {
    put(kind, value, options) {
      this.putCalls += 1;
      if (this.ambiguousRemaining > 0) {
        this.ambiguousRemaining -= 1;
        return { disposition: 'AMBIGUOUS', record: null };
      }
      return this.inner.put(kind, value, options);
    }
  }(inner, { ambiguousCount: 1 });
  const { incident } = serviceWithStore(store);
  const result = incident.advancePhase({
    incident_id: 'incident-001', operation_id: 'op-ambiguous-advance',
    expected_revision: 1, phase: 'PRESERVE_EVIDENCE',
  });
  assert.equal(result.disposition, 'REJECTED');
  assert.equal(result.reason_code, 'RECONCILIATION_REQUIRED');
});

test('read-back reconcile uses the committed operation even when revision moved', () => {
  const inner = new SimulatorIncidentStoreAdapter();
  // A second actor advances the committed incident between the ambiguous
  // write and the read-back, so the revision genuinely moves before the
  // service reconciles the ambiguous outcome.
  const store = new class extends AmbiguousStoreWrapper {
    readOperation(operationId) {
      if (!this.drifted) {
        this.drifted = true;
        const other = serviceWithStore(this.inner);
        other.incident.advancePhase({
          incident_id: 'incident-001', operation_id: 'op-drift-advance',
          expected_revision: 1, phase: 'CONTAIN',
        });
      }
      return super.readOperation(operationId);
    }
  }(inner, { ambiguousCount: 1 });
  const { incident } = serviceWithStore(store);
  const result = incident.createIncident(createInput());
  assert.equal(result.disposition, 'RECORDED');
  assert.equal(store.putCalls, 1, 'a drifted but committed operation is never retried');
  // The committed operation's record is authoritative and immutable: the
  // read-back reconciles to exactly the create record even though the current
  // incident revision has moved on, and the drift itself is preserved.
  assert.equal(result.record.revision, 1);
  assert.equal(result.record.response_phase, 'DECLARE');
  assert.equal(incident.getIncident('incident-001').revision, 2, 'the second actor\u2019s advance really moved the revision');
  assert.equal(incident.getIncident('incident-001').response_phase, 'CONTAIN');
});

test('store refuses conflicting operation and non-cloneable boundary values', () => {
  const store = new SimulatorIncidentStoreAdapter();
  const { incident } = serviceWithStore(store);
  const fn = () => {};
  assert.equal(incident.createIncident(createInput({ source_ref: fn })).disposition, 'REJECTED');
  assert.equal(incident.transferCommand({ incident_id: fn }).disposition, 'REJECTED');
});

test('operation IDs never accept delimiter material that could shadow keys', () => {
  const store = new SimulatorIncidentStoreAdapter();
  const { incident } = serviceWithStore(store);
  assert.equal(incident.createIncident(createInput()).disposition, 'RECORDED');
  const record = incident.getIncident('incident-001');
  // #operationKey() composes "<operationId>::incident::<id>" and readOperation()
  // matches by prefix, so any ID carrying delimiter material could collide with
  // or shadow another operation's committed key. The canonical charset rejects
  // such IDs before any key is built.
  for (const operationId of ['op-1::incident::incident-2', '::incident::incident-2', 'op-1:extra', 'op with space', '.dot-first']) {
    const result = store.put('incident', record, { expectedRevision: record.revision, operationId });
    assert.equal(result.disposition, 'REJECTED', operationId);
    assert.equal(result.reason_code, 'OPERATION_INVALID', operationId);
  }
  // A crafted ID can never read back another operation's committed record.
  assert.equal(store.readOperation('op-1'), null);
  assert.equal(store.readOperation('op-1::incident::incident-2'), null);
  // Valid existing operation IDs (alnum start, then alnum/._-) keep working.
  const replayed = incident.createIncident(createInput());
  assert.equal(replayed.disposition, 'RECORDED');
  assert.equal(replayed.record.incident_id, 'incident-001');
});
