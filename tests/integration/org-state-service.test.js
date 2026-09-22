import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorOrgStateStoreAdapter } from '../../adapters/simulator/src/org-state-store-simulator-adapter.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { assessOrgStateTraceCompleteness } from '../../packages/telemetry/src/org-state-trace-completeness.js';
import { OrganizationalStateService } from '../../services/organizational-state/src/org-state-service.js';
import { createIds, NOW } from '../helpers/px006-runtime.js';

function runtime() {
  const ids = createIds(10_000);
  const evidence = new EvidenceRecorder({ clock: () => NOW });
  const store = new SimulatorOrgStateStoreAdapter();
  const orgState = new OrganizationalStateService({
    environment: 'simulation', store, evidence, ids, clock: () => NOW,
  });
  return { evidence, orgState, store };
}

const approvalInput = {
  approval_id: 'approval-001', job_id: 'job-001', action_type: 'pixel.system-status.summary',
  scope: 'system-status-summary', requested_by: 'PIXEL-RELAY', required_authority: 'pixel.system-status.read',
};

test('a created approval starts REQUESTED at revision 1 and can be decided', () => {
  const { orgState } = runtime();
  const created = orgState.createApproval(approvalInput);
  assert.equal(created.disposition, 'RECORDED');
  assert.equal(created.record.status, 'REQUESTED');
  assert.equal(created.record.revision, 1);

  const decided = orgState.decideApproval({
    approval_id: 'approval-001', expected_revision: 1, status: 'APPROVED', approver_identity: 'PIXEL-FOUNDER',
  });
  assert.equal(decided.disposition, 'RECORDED');
  assert.equal(decided.record.status, 'APPROVED');
  assert.equal(decided.record.approver_identity, 'PIXEL-FOUNDER');
  assert.equal(decided.record.revision, 2);
});

test('stale decisions on approvals are rejected and change nothing', () => {
  const { orgState, store } = runtime();
  orgState.createApproval(approvalInput);
  orgState.decideApproval({ approval_id: 'approval-001', expected_revision: 1, status: 'APPROVED', approver_identity: 'PIXEL-FOUNDER' });
  // A second decision on an already-decided approval is refused.
  const again = orgState.decideApproval({ approval_id: 'approval-001', expected_revision: 1, status: 'REJECTED', approver_identity: 'PIXEL-FOUNDER' });
  assert.equal(again.disposition, 'REJECTED');
  assert.equal(again.reason_code, 'INVALID_TRANSITION');
  assert.equal(orgState.getApproval('approval-001').status, 'APPROVED');

  // The store-level optimistic guard itself rejects a stale writer that
  // composed revision 2 as an update while canonical state is already 2.
  const stale = store.put('approval', {
    ...orgState.getApproval('approval-001'), revision: 2, status: 'REJECTED',
  }, { expectedRevision: 1 });
  assert.equal(stale.disposition, 'STALE_REVISION');
  assert.equal(orgState.getApproval('approval-001').status, 'APPROVED');
});

test('a decided approval cannot be decided twice', () => {
  const { orgState } = runtime();
  orgState.createApproval(approvalInput);
  orgState.decideApproval({ approval_id: 'approval-001', expected_revision: 1, status: 'REJECTED', approver_identity: 'PIXEL-FOUNDER' });
  const again = orgState.decideApproval({ approval_id: 'approval-001', expected_revision: 2, status: 'APPROVED', approver_identity: 'PIXEL-FOUNDER' });
  assert.equal(again.disposition, 'REJECTED');
  assert.equal(again.reason_code, 'INVALID_TRANSITION');
  assert.equal(orgState.getApproval('approval-001').status, 'REJECTED');
});

test('holds are job-scoped and release is revision-guarded', () => {
  const { orgState } = runtime();
  const created = orgState.createHold({
    hold_id: 'hold-001', job_id: 'job-001', hold_class: 'SECURITY', issuer: 'PIXEL-SECURITY', reason_code: 'INCIDENT',
  });
  assert.equal(created.disposition, 'RECORDED');
  assert.equal(created.record.status, 'ACTIVE');
  assert.equal(orgState.holdsForJob('job-001').length, 1);
  assert.equal(orgState.holdsForJob('job-002').length, 0);

  const released = orgState.releaseHold({ hold_id: 'hold-001', expected_revision: 1 });
  assert.equal(released.disposition, 'RECORDED');
  assert.equal(released.record.status, 'RELEASED');
  // Release is one-way: a second release on a released hold is refused.
  const again = orgState.releaseHold({ hold_id: 'hold-001', expected_revision: 2 });
  assert.equal(again.reason_code, 'INVALID_TRANSITION');
  assert.equal(orgState.holdsForJob('job-001').find(({ hold_id: id }) => id === 'hold-001').status, 'RELEASED');
});

test('an expired hold is not an active hold under Trusted Time', () => {
  const ids = createIds(11_000);
  const evidence = new EvidenceRecorder({ clock: () => '2026-09-12T13:00:00.000Z' });
  const orgState = new OrganizationalStateService({
    environment: 'simulation', store: new SimulatorOrgStateStoreAdapter(), evidence, ids,
    clock: () => '2026-09-12T13:00:00.000Z',
  });
  orgState.createHold({
    hold_id: 'hold-001', job_id: 'job-001', hold_class: 'MAINTENANCE', issuer: 'PIXEL-OPS',
    reason_code: 'MAINTENANCE', expires_at: '2026-09-12T12:30:00.000Z',
  });
  // The raw record exists, but evaluation treats it as expired.
  const inputs = orgState.evaluateExecutionInputs({
    job: { envelope: { job_id: 'job-001', environment: 'simulation' } }, requirement: { resource_ref: 'simulation.x' },
  });
  assert.equal(inputs.active_hold, null);
  assert.equal(inputs.hold_id, null);
});

test('company state is derived from its worst input and revision-guarded', () => {
  const { orgState } = runtime();
  const created = orgState.setCompanyState({
    inputs: [{ state: 'SURVIVAL', ref: 'facility' }, { state: 'NORMAL', ref: 'commerce' }],
  });
  assert.equal(created.disposition, 'RECORDED');
  assert.equal(created.record.state, 'SURVIVAL');
  const stale = orgState.setCompanyState({ inputs: [{ state: 'NORMAL', ref: 'facility' }], expected_revision: 99 });
  assert.equal(stale.reason_code, 'STALE_REVISION');
  assert.equal(orgState.companyState().state, 'SURVIVAL');
});

test('capacity degrades when set and evaluates as NORMAL while unset', () => {
  const { orgState } = runtime();
  // The store holds no record until set; evaluation treats absence as NORMAL.
  assert.equal(orgState.capacityFor('simulation.exclusive.status-check'), null);
  const unsetInputs = orgState.evaluateExecutionInputs({
    job: { envelope: { job_id: 'job-001', environment: 'simulation' } },
    requirement: { resource_ref: 'simulation.exclusive.status-check' },
  });
  assert.equal(unsetInputs.capacity, 'NORMAL');
  const set = orgState.setCapacity({
    capacity_id: 'capacity-001', resource_ref: 'simulation.exclusive.status-check', capacity: 'SATURATED',
  });
  assert.equal(set.disposition, 'RECORDED');
  assert.equal(orgState.capacityFor('simulation.exclusive.status-check').capacity, 'SATURATED');
  const updated = orgState.setCapacity({
    capacity_id: 'capacity-001', resource_ref: 'simulation.exclusive.status-check', capacity: 'NORMAL', expected_revision: 1,
  });
  assert.equal(updated.disposition, 'RECORDED');
  assert.equal(updated.record.revision, 2);
});

test('duty state evaluates on-duty and off-duty correctly', () => {
  const { orgState } = runtime();
  orgState.setDuty({ duty_id: 'duty-001', agent_id: 'PIXEL-SYSTEMS-WORKER-01', duty: 'OFF_DUTY' });
  const offDutyInputs = orgState.evaluateExecutionInputs({
    job: { envelope: { job_id: 'job-001', environment: 'simulation', execution: { worker_binding: { worker_id: 'PIXEL-SYSTEMS-WORKER-01' } } } },
    requirement: { resource_ref: 'simulation.x' },
  });
  assert.equal(offDutyInputs.off_duty, true);
  orgState.setDuty({ duty_id: 'duty-001', agent_id: 'PIXEL-SYSTEMS-WORKER-01', duty: 'ON_DUTY', expected_revision: 1 });
  const onDutyInputs = orgState.evaluateExecutionInputs({
    job: { envelope: { job_id: 'job-001', environment: 'simulation', execution: { worker_binding: { worker_id: 'PIXEL-SYSTEMS-WORKER-01' } } } },
    requirement: { resource_ref: 'simulation.x' },
  });
  assert.equal(onDutyInputs.on_duty, true);
  assert.equal(onDutyInputs.off_duty, false);
});

test('invalid org-state writes fail closed and change nothing', () => {
  const { orgState } = runtime();
  const bad = orgState.createHold({ hold_id: 'hold-!!', job_id: 'job-001', hold_class: 'SECURITY', issuer: 'X', reason_code: 'Y' });
  assert.equal(bad.disposition, 'REJECTED');
  assert.equal(orgState.holdsForJob('job-001').length, 0);
});

test('org-state trace completeness accepts canonical traces and rejects tampered ones', () => {
  const { evidence, orgState } = runtime();
  orgState.createHold({ hold_id: 'hold-001', job_id: 'job-001', hold_class: 'SECURITY', issuer: 'PIXEL-SECURITY', reason_code: 'INCIDENT' });
  orgState.setCompanyState({ inputs: [{ state: 'NORMAL', ref: 'facility' }] });
  const records = evidence.all();
  const traceIds = new Set(records.map(({ trace_id: traceId }) => traceId));
  assert.equal(traceIds.size >= 2, true);
  for (const traceId of traceIds) {
    const assessment = assessOrgStateTraceCompleteness(evidence.forTrace(traceId));
    assert.equal(assessment.complete, true, `${traceId}: ${JSON.stringify(assessment.errors)}`);
  }
  // An empty trace fails closed.
  assert.equal(assessOrgStateTraceCompleteness([]).complete, false);
  // A record with a tampered event name is rejected.
  const firstTrace = evidence.forTrace([...traceIds][0]);
  const tampered = firstTrace.map((record, index) => (index === 0 ? { ...record, event_name: 'org-state.evil' } : record));
  assert.equal(assessOrgStateTraceCompleteness(tampered).complete, false);
  // A record with a tampered attribute key is rejected.
  const tamperedAttributes = firstTrace.map((record, index) => (index === 0 ? { ...record, attributes: { ...record.attributes, 'pixel.org-state.extra': 'x' } } : record));
  assert.equal(assessOrgStateTraceCompleteness(tamperedAttributes).complete, false);
});

test('org-state evidence is bounded and carries only canonical pixel keys', () => {
  const { evidence, orgState } = runtime();
  orgState.createApproval(approvalInput);
  orgState.decideApproval({ approval_id: 'approval-001', expected_revision: 1, status: 'APPROVED', approver_identity: 'PIXEL-FOUNDER' });
  const serialized = JSON.stringify(evidence.all());
  assert.equal(serialized.length < 20_000, true, 'org-state evidence stays bounded');
  for (const record of evidence.all()) {
    for (const key of Object.keys(record.attributes ?? {})) {
      assert.match(key, /^pixel\.[a-z0-9._-]+$/, `attribute ${key} must be a canonical pixel key`);
    }
  }
});
