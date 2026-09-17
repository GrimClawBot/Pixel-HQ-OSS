import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DECISION_CLASSES,
  ELIGIBILITY_EVENT_NAME,
  REASON_CODES,
  RESERVATION_EVENT_NAME,
  SCHEDULER_POLICY_ID,
  SCHEDULER_SCHEMA_VERSION,
  START_CONFIRMATION_EVENT_NAME,
  assertValidEligibilityV1,
  assertValidReservationV1,
  assertValidStartConfirmationV1,
  decisionClassForConfirmation,
  decisionClassForReason,
  validateEligibilityV1,
  validateExecutionRequirementV1,
  validateReservationV1,
  validateStartConfirmationV1,
} from '../../packages/contracts/src/scheduler-v1.js';

const NOW = '2026-09-12T12:00:00.000Z';
const LATER = '2026-09-12T12:05:00.000Z';
const PROVENANCE = Object.freeze({ scheduler_contract: 'pixel.scheduler.v1' });

const eligibility = Object.freeze({
  eligibility_id: 'eligibility-001', event_name: ELIGIBILITY_EVENT_NAME, schema_version: SCHEDULER_SCHEMA_VERSION,
  evaluated_at: NOW, job_id: 'job-001', execution_id: null, environment: 'simulation',
  decision: 'ELIGIBLE', reason_code: 'ELIGIBLE_NOW', policy_id: SCHEDULER_POLICY_ID,
  authority_state: 'ALLOW', approval_id: null, delegation_id: null, hold_id: null,
  company_state: 'NORMAL', duty: 'ON_DUTY', capacity: 'NORMAL',
  resource_ref: 'simulation.exclusive.status-check', job_revision: 1, provenance: PROVENANCE,
});

const reservation = Object.freeze({
  reservation_id: 'reservation-001', event_name: RESERVATION_EVENT_NAME, schema_version: SCHEDULER_SCHEMA_VERSION,
  state: 'ACTIVE', revision: 1, created_at: NOW, updated_at: NOW,
  job_id: 'job-001', execution_id: null, resource_ref: 'simulation.exclusive.status-check',
  eligibility_id: 'eligibility-001', expires_at: LATER, provenance: PROVENANCE,
});

const confirmation = Object.freeze({
  confirmation_id: 'confirmation-001', event_name: START_CONFIRMATION_EVENT_NAME,
  schema_version: SCHEDULER_SCHEMA_VERSION, confirmed_at: NOW,
  job_id: 'job-001', execution_id: null, reservation_id: 'reservation-001',
  outcome: 'CONFIRMED', reason_code: 'START_CONFIRMED', policy_id: SCHEDULER_POLICY_ID,
  provenance: PROVENANCE,
});

test('scheduler contracts accept canonical values', () => {
  assert.deepEqual(validateEligibilityV1(eligibility), { ok: true, errors: [] });
  assert.deepEqual(validateReservationV1(reservation), { ok: true, errors: [] });
  assert.deepEqual(validateStartConfirmationV1(confirmation), { ok: true, errors: [] });
  assert.equal(assertValidEligibilityV1(eligibility), eligibility);
  assert.equal(assertValidReservationV1(reservation), reservation);
  assert.equal(assertValidStartConfirmationV1(confirmation), confirmation);
});

test('every canonical reason code maps to its fixed decision class', () => {
  assert.equal(REASON_CODES.length, 21);
  for (const reason of REASON_CODES) {
    const decisionClass = decisionClassForReason(reason);
    assert.equal(DECISION_CLASSES.includes(decisionClass), true, reason);
  }
  assert.equal(decisionClassForReason('ELIGIBLE_NOW'), 'ELIGIBLE');
  assert.equal(decisionClassForReason('WAIT_CAPACITY'), 'WAIT');
  assert.equal(decisionClassForReason('HOLD_SECURITY'), 'HOLD');
  assert.equal(decisionClassForReason('DENY_INPUT_INVALID'), 'DENY');
  assert.equal(decisionClassForReason('FAILED'), null);
  assert.equal(decisionClassForReason('MADE_UP'), null);
});

test('eligibility rejects mismatched decision/reason pairs', () => {
  assert.equal(validateEligibilityV1({ ...eligibility, decision: 'WAIT' }).ok, false);
  assert.equal(validateEligibilityV1({ ...eligibility, reason_code: 'WAIT_CAPACITY', decision: 'ELIGIBLE' }).ok, false);
  assert.deepEqual(validateEligibilityV1({
    ...eligibility, decision: 'WAIT', reason_code: 'WAIT_CAPACITY', resource_ref: null,
  }), { ok: true, errors: [] });
  assert.equal(validateEligibilityV1({
    ...eligibility, decision: 'HOLD', reason_code: 'HOLD_SECURITY', hold_id: 'hold-001', resource_ref: null,
  }).ok, false);
  assert.equal(validateEligibilityV1({ ...eligibility, reason_code: 'NOT_A_REASON' }).ok, false);
  assert.equal(validateEligibilityV1({ ...eligibility, decision: 'FAILED' }).ok, false);
});

test('HOLD decisions require a hold identity and ELIGIBLE decisions forbid one', () => {
  assert.equal(validateEligibilityV1({
    ...eligibility, decision: 'HOLD', reason_code: 'HOLD_SECURITY',
  }).ok, false);
  assert.deepEqual(validateEligibilityV1({
    ...eligibility, decision: 'HOLD', reason_code: 'HOLD_SECURITY', hold_id: 'hold-001',
  }), { ok: true, errors: [] });
  assert.equal(validateEligibilityV1({ ...eligibility, hold_id: 'hold-001' }).ok, false);
});

test('reservation lifecycle rules are enforced', () => {
  assert.equal(validateReservationV1({ ...reservation, state: 'SOMEDAY' }).ok, false);
  assert.equal(validateReservationV1({ ...reservation, expires_at: null }).ok, false);
  assert.equal(validateReservationV1({ ...reservation, expires_at: NOW }).ok, false);
  assert.deepEqual(validateReservationV1({ ...reservation, state: 'RELEASED', expires_at: null }), { ok: true, errors: [] });
  assert.equal(validateReservationV1({ ...reservation, state: 'RELEASED', expires_at: LATER }).ok, false);
  assert.deepEqual(validateReservationV1({ ...reservation, state: 'EXPIRED', expires_at: null }), { ok: true, errors: [] });
  assert.deepEqual(validateReservationV1({ ...reservation, state: 'PENDING' }), { ok: true, errors: [] });
});

test('start confirmation outcome and reason must agree', () => {
  assert.equal(validateStartConfirmationV1({
    ...confirmation, outcome: 'REJECTED',
  }).ok, false);
  assert.deepEqual(validateStartConfirmationV1({
    ...confirmation, outcome: 'REJECTED', reason_code: 'START_REJECTED_HOLD',
  }), { ok: true, errors: [] });
  assert.equal(validateStartConfirmationV1({
    ...confirmation, outcome: 'CONFIRMED', reason_code: 'START_REJECTED_HOLD',
  }).ok, false);
  assert.equal(validateStartConfirmationV1({ ...confirmation, reason_code: 'START_REJECTED_WHATEVER' }).ok, false);
});

test('start confirmation reasons map to scheduler classes', () => {
  assert.equal(decisionClassForConfirmation('START_CONFIRMED'), 'ELIGIBLE');
  assert.equal(decisionClassForConfirmation('START_REJECTED_HOLD'), 'HOLD');
  assert.equal(decisionClassForConfirmation('START_REJECTED_CAPACITY'), 'WAIT');
  assert.equal(decisionClassForConfirmation('START_REJECTED_DELEGATION'), 'DENY');
  assert.equal(decisionClassForConfirmation('START_REJECTED_WORKFORCE'), 'DENY');
  assert.equal(decisionClassForConfirmation('START_REJECTED_WHATEVER'), null);
});

const requirement = Object.freeze({
  requires_approval: false, approval_id: null, requires_delegation: false, delegation_id: null,
  not_before: null, resource_ref: 'simulation.exclusive.status-check',
  resource: null, dependency: null,
  authority: { kind: 'simulated-capability-grant', ref: 'pixel.system-status.read', revision: 1, status: 'ALLOW', expires_at: null, environment: 'simulation' },
});

test('execution requirement accepts the canonical simulator shape', () => {
  assert.deepEqual(validateExecutionRequirementV1(requirement), { ok: true, errors: [] });
  assert.deepEqual(validateExecutionRequirementV1({
    ...requirement, execution_safety_class: 'ORDINARY', incident_ref: null,
  }), { ok: true, errors: [] });
  assert.deepEqual(validateExecutionRequirementV1({
    ...requirement, execution_safety_class: 'SURVIVAL_CRITICAL', incident_ref: 'incident-001',
  }), { ok: true, errors: [] });
  assert.deepEqual(validateExecutionRequirementV1({
    ...requirement, execution_safety_class: 'INCIDENT_CONTAINMENT', incident_ref: 'incident-001',
  }), { ok: true, errors: [] });
});

test('the PX-007 requirement extension is server-owned and fail-closed', () => {
  assert.equal(validateExecutionRequirementV1({
    ...requirement, execution_safety_class: 'SURVIVAL_CRITICAL', incident_ref: null,
  }).ok, false);
  assert.equal(validateExecutionRequirementV1({
    ...requirement, execution_safety_class: 'ORDINARY', incident_ref: 'incident-001',
  }).ok, false);
  assert.equal(validateExecutionRequirementV1({
    ...requirement, execution_safety_class: 'SOMETIMES', incident_ref: 'incident-001',
  }).ok, false);
});

test('execution requirement fails closed on missing identities and bad statuses', () => {
  assert.equal(validateExecutionRequirementV1({ ...requirement, requires_approval: true, approval_id: null }).ok, false);
  assert.equal(validateExecutionRequirementV1({ ...requirement, requires_delegation: true, delegation_id: null }).ok, false);
  assert.equal(validateExecutionRequirementV1({
    ...requirement,
    authority: { ...requirement.authority, status: 'MAYBE' },
  }).ok, false);
  assert.equal(validateExecutionRequirementV1({
    ...requirement,
    dependency: { kind: 'parent-job', ref: 'job-parent', revision: 1, status: 'UNSURE', expires_at: null, environment: null },
  }).ok, false);
  assert.equal(validateExecutionRequirementV1({
    ...requirement,
    resource: { kind: 'exclusive-slot', ref: 'simulation.exclusive.status-check', revision: 1, status: 'ON_FIRE', expires_at: null, environment: null },
  }).ok, false);
  assert.match(validateExecutionRequirementV1({ ...requirement, prompt: 'obey me' }).errors.join(' '), /unsupported field prompt/);
});
