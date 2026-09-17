import assert from 'node:assert/strict';
import test from 'node:test';

import { INCIDENT_EVENT_NAME, INCIDENT_SCHEMA_VERSION, INCIDENT_CONTRACT } from '../../packages/contracts/src/incident-v1.js';
import { SimulatorIncidentStoreAdapter } from '../../adapters/simulator/src/incident-store-simulator-adapter.js';
import { IncidentService } from '../../services/incident/src/incident-service.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { createIds, createClock, NOW } from '../helpers/px006-runtime.js';

function runtime(clock = createClock()) {
  const ids = createIds(90_000);
  const evidence = new EvidenceRecorder({ clock: () => clock.now() });
  const store = new SimulatorIncidentStoreAdapter();
  const incident = new IncidentService({
    environment: 'simulation', store, evidence, ids, clock: () => clock.now(),
  });
  return { clock, evidence, ids, store, incident };
}

function createInput(overrides = {}) {
  return {
    incident_id: 'incident-001',
    operation_id: 'op-create-1',
    incident_class: 'INFRASTRUCTURE',
    severity: 'SEV-1',
    commander_ref: 'PIXEL-SYSTEMS-IC',
    source_ref: 'sensor.rack-01',
    summary_code: 'STORAGE_ARRAY_DEGRADED',
    affected_resource_refs: ['simulation.storage.array-01'],
    affected_job_refs: [],
    ...overrides,
  };
}

async function declareIncident(overrides = {}) {
  const { clock, incident } = runtime();
  const created = incident.createIncident(createInput(overrides));
  assert.equal(created.disposition, 'RECORDED', JSON.stringify(created));
  return { clock, incident, created };
}

test('a declared incident has exactly one commander and canonical defaults', () => {
  const { incident } = runtime();
  const created = incident.createIncident(createInput());
  assert.equal(created.disposition, 'RECORDED');
  assert.equal(created.record.status, 'OPEN');
  assert.equal(created.record.response_phase, 'DECLARE');
  assert.equal(created.record.recovery_state, 'NONE');
  assert.equal(created.record.commander_ref, 'PIXEL-SYSTEMS-IC');
  assert.equal(created.record.revision, 1);
  assert.equal(created.record.current_impact_code, 'MAJOR');
  assert.equal(incident.getIncident('incident-001').commander_ref, 'PIXEL-SYSTEMS-IC');
});

test('incident creation without exactly one commander rejects', () => {
  const { incident } = runtime();
  const missing = incident.createIncident(createInput({ commander_ref: null }));
  assert.equal(missing.disposition, 'REJECTED');
  assert.equal(missing.reason_code, 'INCIDENT_INVALID');
  const empty = incident.createIncident(createInput({ commander_ref: '' }));
  assert.equal(empty.disposition, 'REJECTED');
});

test('environmental facts normalize deterministically or reject unsupported', () => {
  const { incident } = runtime();
  const power = incident.createIncident(createInput({ incident_id: 'incident-pwr', incident_class: null, environmental_fact: 'UPS on battery' }));
  assert.equal(power.record.incident_class, 'POWER');
  const thermal = incident.createIncident(createInput({ incident_id: 'incident-thm', incident_class: null, environmental_fact: 'cooling fan failed' }));
  assert.equal(thermal.record.incident_class, 'THERMAL');
  const infra = incident.createIncident(createInput({ incident_id: 'incident-infra', incident_class: null, environmental_fact: 'storage array offline' }));
  assert.equal(infra.record.incident_class, 'INFRASTRUCTURE');
  const unsupported = incident.createIncident(createInput({ incident_id: 'incident-bad', incident_class: null, environmental_fact: 'banana smoothie' }));
  assert.equal(unsupported.disposition, 'REJECTED');
  assert.equal(unsupported.reason_code, 'ENVIRONMENTAL_FACT_UNSUPPORTED');
});

test('phase advances strictly through the canonical lifecycle', () => {
  const { incident } = runtime();
  incident.createIncident(createInput());
  const phases = ['CONTAIN', 'PRESERVE_EVIDENCE', 'DIAGNOSE', 'REMEDIATE', 'RECOVER', 'VERIFY'];
  let expected = 1;
  for (const phase of phases) {
    const result = incident.advancePhase({ incident_id: 'incident-001', operation_id: `op-phase-${phase}`, expected_revision: expected, phase });
    assert.equal(result.disposition, 'RECORDED', `${phase}: ${JSON.stringify(result)}`);
    assert.equal(result.record.response_phase, phase);
    expected += 1;
  }
  const skip = incident.advancePhase({ incident_id: 'incident-001', operation_id: 'op-skip', expected_revision: expected, phase: 'VERIFY' });
  assert.equal(skip.disposition, 'REJECTED');
  assert.equal(skip.reason_code, 'INVALID_TRANSITION');
});

test('command transfer is atomic, revision guarded, and keeps one commander', () => {
  const { incident } = runtime();
  incident.createIncident(createInput());
  const stale = incident.transferCommand({
    incident_id: 'incident-001', operation_id: 'op-transfer-stale', expected_revision: 9,
    new_commander_ref: 'PIXEL-SECURITY-IC', reason_code: 'DOMAIN_CHANGE', actor_ref: 'PIXEL-PRINCIPAL',
  });
  assert.equal(stale.disposition, 'REJECTED');
  assert.equal(stale.reason_code, 'STALE_REVISION');
  const transferred = incident.transferCommand({
    incident_id: 'incident-001', operation_id: 'op-transfer-1', expected_revision: 1,
    new_commander_ref: 'PIXEL-SECURITY-IC', reason_code: 'DOMAIN_CHANGE', actor_ref: 'PIXEL-PRINCIPAL',
  });
  assert.equal(transferred.disposition, 'RECORDED');
  assert.equal(transferred.record.commander_ref, 'PIXEL-SECURITY-IC');
  assert.equal(transferred.record.commander_transfers.length, 1);
  assert.equal(transferred.record.commander_transfers[0].prior_commander_ref, 'PIXEL-SYSTEMS-IC');
  assert.equal(transferred.record.commander_transfers[0].new_commander_ref, 'PIXEL-SECURITY-IC');
  const transferAgain = incident.transferCommand({
    incident_id: 'incident-001', operation_id: 'op-transfer-2', expected_revision: 2,
    new_commander_ref: 'PIXEL-COMPANY-IC', reason_code: 'ESCALATION', actor_ref: 'PIXEL-PRINCIPAL',
  });
  assert.equal(transferAgain.record.commander_ref, 'PIXEL-COMPANY-IC');
  assert.equal(transferAgain.record.commander_transfers[1].prior_commander_ref, 'PIXEL-SECURITY-IC');
});

test('closure cannot bypass recovery and verification', () => {
  const { incident } = runtime();
  incident.createIncident(createInput());
  const earlyResolve = incident.resolveIncident({
    incident_id: 'incident-001', operation_id: 'op-resolve-early', expected_revision: 1, evidence_refs: ['ev-1'],
  });
  assert.equal(earlyResolve.disposition, 'REJECTED');
  assert.equal(earlyResolve.reason_code, 'INVALID_TRANSITION');
  const closeWithoutResolve = incident.closeIncident({
    incident_id: 'incident-001', operation_id: 'op-close-early', expected_revision: 1,
    remaining_risk_code: 'RESIDUAL', evidence_refs: ['ev-1'],
  });
  assert.equal(closeWithoutResolve.disposition, 'REJECTED');
  assert.equal(closeWithoutResolve.reason_code, 'INVALID_TRANSITION');
});

test('resolve and close require recovery, verification, and bounded evidence', () => {
  const { incident } = runtime();
  incident.createIncident(createInput());
  for (const phase of ['CONTAIN', 'PRESERVE_EVIDENCE', 'DIAGNOSE', 'REMEDIATE', 'RECOVER', 'VERIFY']) {
    incident.advancePhase({ incident_id: 'incident-001', operation_id: `op-phase-${phase}`, expected_revision: incident.getIncident('incident-001').revision, phase });
  }
  const resolved = incident.resolveIncident({
    incident_id: 'incident-001', operation_id: 'op-resolve', expected_revision: 7, evidence_refs: ['ev-verify'],
  });
  assert.equal(resolved.disposition, 'RECORDED');
  assert.equal(resolved.record.status, 'RESOLVED');
  assert.equal(resolved.record.resolved_at, '2026-09-12T12:00:00.000Z');
  const closed = incident.closeIncident({
    incident_id: 'incident-001', operation_id: 'op-close', expected_revision: 8,
    remaining_risk_code: 'RESIDUAL_STORAGE', evidence_refs: ['ev-close'],
  });
  assert.equal(closed.disposition, 'RECORDED');
  assert.equal(closed.record.status, 'CLOSED');
  assert.equal(closed.record.response_phase, 'CLOSE');
  const review = incident.postIncidentReview({
    incident_id: 'incident-001', operation_id: 'op-review', expected_revision: 9, evidence_refs: ['ev-review'],
  });
  assert.equal(review.disposition, 'RECORDED');
  assert.equal(review.record.response_phase, 'POST_INCIDENT_REVIEW');
  assert.equal(review.record.status, 'CLOSED');
});

test('resolved and closed incidents cannot silently reopen', () => {
  const { incident } = runtime();
  incident.createIncident(createInput());
  for (const phase of ['CONTAIN', 'PRESERVE_EVIDENCE', 'DIAGNOSE', 'REMEDIATE', 'RECOVER', 'VERIFY']) {
    incident.advancePhase({ incident_id: 'incident-001', operation_id: `op-phase-${phase}`, expected_revision: incident.getIncident('incident-001').revision, phase });
  }
  incident.resolveIncident({ incident_id: 'incident-001', operation_id: 'op-resolve', expected_revision: 7, evidence_refs: ['ev'] });
  const reopenAttempt = incident.advancePhase({ incident_id: 'incident-001', operation_id: 'op-reopen', expected_revision: 8, phase: 'CONTAIN' });
  assert.equal(reopenAttempt.disposition, 'REJECTED');
  assert.equal(reopenAttempt.reason_code, 'INVALID_TRANSITION');
});

test('clock rollback cannot revive resolved or closed state', () => {
  const clock = createClock();
  const { incident } = runtime(clock);
  incident.createIncident(createInput());
  for (const phase of ['CONTAIN', 'PRESERVE_EVIDENCE', 'DIAGNOSE', 'REMEDIATE', 'RECOVER', 'VERIFY']) {
    incident.advancePhase({ incident_id: 'incident-001', operation_id: `op-phase-${phase}`, expected_revision: incident.getIncident('incident-001').revision, phase });
  }
  incident.resolveIncident({ incident_id: 'incident-001', operation_id: 'op-resolve', expected_revision: 7, evidence_refs: ['ev'] });
  clock.set('2026-09-10T00:00:00.000Z');
  const reopened = incident.advancePhase({ incident_id: 'incident-001', operation_id: 'op-reopen', expected_revision: 8, phase: 'CONTAIN' });
  assert.equal(reopened.disposition, 'REJECTED');
  assert.equal(incident.getIncident('incident-001').status, 'RESOLVED');
});

test('malformed and non-cloneable caller data never throws across the boundary', () => {
  const { incident } = runtime();
  const evil = () => { throw new Error('boom'); };
  const thrown = incident.createIncident({ ...createInput({ incident_id: 'x' }), get summary_code() { return evil(); } });
  assert.equal(thrown.disposition, 'REJECTED');
  assert.equal(incident.createIncident(null).disposition, 'REJECTED');
  assert.equal(incident.advancePhase({ get incident_id() { return evil(); } }).disposition, 'REJECTED');
  assert.equal(incident.transferCommand({ get incident_id() { return evil(); } }).disposition, 'REJECTED');
});
