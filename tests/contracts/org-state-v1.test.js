import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVAL_EVENT_NAME,
  CAPACITY_STATE_EVENT_NAME,
  COMPANY_STATE_EVENT_NAME,
  DELEGATION_EVENT_NAME,
  DUTY_STATE_EVENT_NAME,
  HOLD_EVENT_NAME,
  ORG_STATE_SCHEMA_VERSION,
  assertValidApprovalV1,
  assertValidCapacityStateV1,
  assertValidCompanyStateV1,
  assertValidDelegationV1,
  assertValidDutyStateV1,
  assertValidHoldV1,
  derivedCompanyState,
  validateApprovalV1,
  validateCapacityStateV1,
  validateCompanyStateV1,
  validateDelegationV1,
  validateDutyStateV1,
  validateHoldV1,
} from '../../packages/contracts/src/organizational-state-v1.js';

const NOW = '2026-09-12T12:00:00.000Z';
const LATER = '2026-09-12T13:00:00.000Z';
const PROVENANCE = Object.freeze({ org_state_contract: 'pixel.organizational-state.v1' });

const approval = Object.freeze({
  approval_id: 'approval-001', event_name: APPROVAL_EVENT_NAME, schema_version: ORG_STATE_SCHEMA_VERSION,
  status: 'PENDING', revision: 1, created_at: NOW, updated_at: NOW,
  job_id: 'job-001', action_type: 'model-summary', scope: 'one bounded job',
  requested_by: 'PIXEL-PRINCIPAL', required_authority: 'owner', approver_identity: null,
  expires_at: LATER, decided_at: null, provenance: PROVENANCE,
});

const delegation = Object.freeze({
  grant_id: 'grant-001', event_name: DELEGATION_EVENT_NAME, schema_version: ORG_STATE_SCHEMA_VERSION,
  status: 'ACTIVE', revision: 1, created_at: NOW, updated_at: NOW,
  grantor: 'PIXEL-PRINCIPAL', grantee: 'PIXEL-SYSTEMS-WORKER-01', capability: 'pixel.system-status.read',
  scope: 'system status reads', environment: 'simulation', valid_from: NOW, expires_at: LATER,
  subdelegation_allowed: false, provenance: PROVENANCE,
});

const hold = Object.freeze({
  hold_id: 'hold-001', event_name: HOLD_EVENT_NAME, schema_version: ORG_STATE_SCHEMA_VERSION,
  status: 'ACTIVE', revision: 1, created_at: NOW, updated_at: NOW,
  job_id: 'job-001', hold_class: 'SECURITY', issuer: 'PIXEL-SECURITY', reason_code: 'INCIDENT',
  expires_at: null, provenance: PROVENANCE,
});

const companyState = Object.freeze({
  company_state_id: 'company.state.alpha', event_name: COMPANY_STATE_EVENT_NAME, schema_version: ORG_STATE_SCHEMA_VERSION,
  revision: 1, generated_at: NOW, state: 'NORMAL', cause_refs: [], constraints: [], provenance: PROVENANCE,
});

const duty = Object.freeze({
  duty_id: 'duty-001', event_name: DUTY_STATE_EVENT_NAME, schema_version: ORG_STATE_SCHEMA_VERSION,
  revision: 1, updated_at: NOW, agent_id: 'PIXEL-SYSTEMS-WORKER-01', duty: 'ON_DUTY', provenance: PROVENANCE,
});

const capacity = Object.freeze({
  capacity_id: 'capacity-001', event_name: CAPACITY_STATE_EVENT_NAME, schema_version: ORG_STATE_SCHEMA_VERSION,
  revision: 1, updated_at: NOW, resource_ref: 'simulation.exclusive.status-check', capacity: 'NORMAL', provenance: PROVENANCE,
});

test('all six PX-006 organizational-state contracts accept canonical values', () => {
  assert.deepEqual(validateApprovalV1(approval), { ok: true, errors: [] });
  assert.deepEqual(validateDelegationV1(delegation), { ok: true, errors: [] });
  assert.deepEqual(validateHoldV1(hold), { ok: true, errors: [] });
  assert.deepEqual(validateCompanyStateV1(companyState), { ok: true, errors: [] });
  assert.deepEqual(validateDutyStateV1(duty), { ok: true, errors: [] });
  assert.deepEqual(validateCapacityStateV1(capacity), { ok: true, errors: [] });
  assert.equal(assertValidHoldV1(hold), hold);
});

test('organizational-state contracts reject unsupported fields and statuses', () => {
  assert.match(validateApprovalV1({ ...approval, grant: 'ALLOW' }).errors.join(' '), /unsupported field grant/);
  assert.equal(validateApprovalV1({ ...approval, status: 'MAYBE' }).ok, false);
  assert.equal(validateDelegationV1({ ...delegation, environment: 'somewhere' }).ok, false);
  assert.equal(validateHoldV1({ ...hold, hold_class: 'INFORMAL' }).ok, false);
  assert.deepEqual(validateHoldV1({ ...hold, incident_id: 'incident-001' }), { ok: true, errors: [] });
  assert.deepEqual(validateHoldV1({ ...hold, incident_id: null }), { ok: true, errors: [] });
  assert.equal(validateHoldV1({ ...hold, incident_id: 'bad id!' }).ok, false);
  assert.equal(validateDutyStateV1({ ...duty, duty: 'SLEEPING' }).ok, false);
  assert.equal(validateCapacityStateV1({ ...capacity, capacity: 'PLENTY' }).ok, false);
  assert.equal(validateCompanyStateV1({ ...companyState, state: 'WEEKEND' }).ok, false);
});

test('approval decision fields are enforced', () => {
  assert.equal(validateApprovalV1({ ...approval, status: 'APPROVED' }).ok, false);
  assert.deepEqual(validateApprovalV1({
    ...approval, status: 'APPROVED', approver_identity: 'PIXEL-PRINCIPAL', decided_at: LATER,
  }), { ok: true, errors: [] });
  assert.equal(validateApprovalV1({
    ...approval, status: 'PENDING', approver_identity: 'PIXEL-PRINCIPAL',
  }).ok, false);
  assert.equal(validateApprovalV1({ ...approval, decided_at: LATER }).ok, false);
});

test('delegation validity window must be ordered', () => {
  assert.equal(validateDelegationV1({ ...delegation, expires_at: NOW }).ok, false);
  assert.equal(validateDelegationV1({ ...delegation, valid_from: LATER, expires_at: NOW }).ok, false);
});

test('company state precedence derives the highest-precedence input', () => {
  assert.equal(derivedCompanyState([]), 'NORMAL');
  assert.equal(derivedCompanyState([{ state: 'NORMAL' }, { state: 'NIGHT' }]), 'NIGHT');
  assert.equal(derivedCompanyState([{ state: 'MAINTENANCE' }, { state: 'HOLIDAY' }]), 'MAINTENANCE');
  assert.equal(derivedCompanyState([{ state: 'NORMAL' }, { state: 'SECURITY_INCIDENT' }]), 'SECURITY_INCIDENT');
  assert.equal(derivedCompanyState([{ state: 'SECURITY_INCIDENT' }, { state: 'SURVIVAL' }]), 'SURVIVAL');
  assert.equal(derivedCompanyState([{ state: 'bogus' }, { state: 'HOLIDAY' }]), 'HOLIDAY');
  assert.throws(() => derivedCompanyState('SURVIVAL'), /array/);
});

test('company state rejects duplicate or oversized cause/constraint lists', () => {
  assert.equal(validateCompanyStateV1({ ...companyState, cause_refs: ['a', 'a'] }).ok, false);
  assert.equal(validateCompanyStateV1({ ...companyState, cause_refs: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'] }).ok, false);
  assert.equal(validateCompanyStateV1({ ...companyState, constraints: ['x', 'x'] }).ok, false);
  assert.equal(validateCompanyStateV1({ ...companyState, constraints: ['x'.repeat(161)] }).ok, false);
});

test('revision must be a positive safe integer on every mutable object', () => {
  for (const [validate, value] of [
    [validateApprovalV1, approval], [validateDelegationV1, delegation], [validateHoldV1, hold],
    [validateCompanyStateV1, companyState], [validateDutyStateV1, duty], [validateCapacityStateV1, capacity],
  ]) {
    assert.equal(validate({ ...value, revision: 0 }).ok, false);
    assert.equal(validate({ ...value, revision: -1 }).ok, false);
    assert.equal(validate({ ...value, revision: 1.5 }).ok, false);
  }
});

test('timestamps must be canonical UTC ISO-8601 milliseconds', () => {
  assert.equal(validateApprovalV1({ ...approval, updated_at: '2026-09-12T12:00:00Z' }).ok, false);
  assert.equal(validateApprovalV1({ ...approval, updated_at: '2026-09-12T08:00:00.000-04:00' }).ok, false);
  assert.equal(validateApprovalV1({ ...approval, updated_at: 'yesterday' }).ok, false);
});

test('assert helpers throw on invalid records', () => {
  assert.throws(() => assertValidDelegationV1({ ...delegation, revision: 0 }), /Delegation failed/);
  assert.throws(() => assertValidCompanyStateV1({ ...companyState, state: 'X' }), /Company state failed/);
  assert.throws(() => assertValidCapacityStateV1({ ...capacity, capacity: 'X' }), /Capacity state failed/);
});
