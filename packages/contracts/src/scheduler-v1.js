import { isCanonicalUtcTimestamp } from './trusted-time-v1.js';

export const SCHEDULER_SCHEMA_VERSION = '1.0.0';

export const ELIGIBILITY_EVENT_NAME = 'pixel.scheduler.eligibility.v1';
export const RESERVATION_EVENT_NAME = 'pixel.scheduler.reservation.v1';
export const START_CONFIRMATION_EVENT_NAME = 'pixel.scheduler.start-confirmation.v1';

export const SCHEDULER_CONTRACT = 'pixel.scheduler.v1';
export const SCHEDULER_POLICY_ID = 'pixel.scheduler.alpha.v1';

export const DECISION_CLASSES = Object.freeze(['ELIGIBLE', 'WAIT', 'HOLD', 'DENY']);

export const REASON_CODES = Object.freeze([
  'ELIGIBLE_NOW',
  'WAIT_DEPENDENCY',
  'WAIT_CAPACITY',
  'WAIT_OFF_DUTY',
  'WAIT_MAINTENANCE',
  'WAIT_HOLIDAY',
  'WAIT_NIGHT',
  'WAIT_QUALIFICATION',
  'WAIT_APPROVAL',
  'WAIT_NOT_BEFORE',
  'HOLD_SECURITY',
  'HOLD_POLICY',
  'HOLD_OWNER',
  'HOLD_MAINTENANCE',
  'DENY_AUTHORITY_MISSING',
  'DENY_DELEGATION_INVALID',
  'DENY_ENVIRONMENT',
  'DENY_RESOURCE_INELIGIBLE',
  'DENY_COMPANY_STATE',
  'DENY_WORKFORCE',
  'DENY_INPUT_INVALID',
]);

// A reason code's decision class is fixed; callers cannot invent mappings.
const REASON_CLASS = new Map([
  ['ELIGIBLE_NOW', 'ELIGIBLE'],
  ['WAIT_DEPENDENCY', 'WAIT'],
  ['WAIT_CAPACITY', 'WAIT'],
  ['WAIT_OFF_DUTY', 'WAIT'],
  ['WAIT_MAINTENANCE', 'WAIT'],
  ['WAIT_HOLIDAY', 'WAIT'],
  ['WAIT_NIGHT', 'WAIT'],
  ['WAIT_QUALIFICATION', 'WAIT'],
  ['WAIT_APPROVAL', 'WAIT'],
  ['WAIT_NOT_BEFORE', 'WAIT'],
  ['HOLD_SECURITY', 'HOLD'],
  ['HOLD_POLICY', 'HOLD'],
  ['HOLD_OWNER', 'HOLD'],
  ['HOLD_MAINTENANCE', 'HOLD'],
  ['DENY_AUTHORITY_MISSING', 'DENY'],
  ['DENY_DELEGATION_INVALID', 'DENY'],
  ['DENY_ENVIRONMENT', 'DENY'],
  ['DENY_RESOURCE_INELIGIBLE', 'DENY'],
  ['DENY_COMPANY_STATE', 'DENY'],
  ['DENY_WORKFORCE', 'DENY'],
  ['DENY_INPUT_INVALID', 'DENY'],
]);

export const RESERVATION_STATES = Object.freeze(['PENDING', 'ACTIVE', 'RELEASED', 'EXPIRED', 'CANCELLED']);
export const START_CONFIRMATION_OUTCOMES = Object.freeze(['CONFIRMED', 'REJECTED']);

// PX-007: narrow server-owned requirement extension. These fields describe
// execution safety class and incident binding for containment/survival work.
// They are server-owned facts: the Scheduler validates them against canonical
// incident state; callers cannot grant permission with them.
export const EXECUTION_SAFETY_CLASSES = Object.freeze(['ORDINARY', 'INCIDENT_CONTAINMENT', 'SURVIVAL_CRITICAL']);

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const HASH = /^[0-9a-f]{64}$/;

const ELIGIBILITY_FIELDS = new Set([
  'eligibility_id', 'event_name', 'schema_version', 'evaluated_at', 'job_id', 'execution_id',
  'environment', 'decision', 'reason_code', 'policy_id', 'authority_state', 'approval_id',
  'delegation_id', 'hold_id', 'company_state', 'duty', 'capacity', 'resource_ref',
  'job_revision', 'provenance',
]);
const RESERVATION_FIELDS = new Set([
  'reservation_id', 'event_name', 'schema_version', 'state', 'revision', 'created_at', 'updated_at',
  'job_id', 'execution_id', 'resource_ref', 'eligibility_id', 'expires_at', 'provenance',
]);
const START_CONFIRMATION_FIELDS = new Set([
  'confirmation_id', 'event_name', 'schema_version', 'confirmed_at', 'job_id', 'execution_id',
  'reservation_id', 'outcome', 'reason_code', 'policy_id', 'provenance',
]);
const INPUT_STATE_FIELDS = new Set([
  'kind', 'ref', 'revision', 'status', 'expires_at', 'environment',
]);
const SCHEDULER_PROVENANCE_FIELDS = new Set(['scheduler_contract']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, allowed, label, errors) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${label} contains unsupported field ${field}`);
  }
}

// Identifiers are bounded to the same 160-character cap the schemas use, so an
// over-long caller identifier is invalid rather than recorded into evidence.
const IDENTIFIER_MAX = 160;
function identifier(value, label, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > IDENTIFIER_MAX || !IDENTIFIER.test(value)) {
    errors.push(`${label} must be a Pixel identifier`);
  }
}

function revision(value, label, errors) {
  if (!Number.isSafeInteger(value) || value < 1) errors.push(`${label} must be a positive safe integer`);
}

function timestamp(value, label, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!isCanonicalUtcTimestamp(value)) errors.push(`${label} must be a canonical UTC ISO-8601 millisecond timestamp`);
}

function boundedText(value, label, errors, maximum = 160) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    errors.push(`${label} must be between 1 and ${maximum} characters`);
  }
}

function result(errors) {
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors.slice(0, 32)) });
}

function schedulerCommon(value, fields, label, eventName, timestampField, errors) {
  exact(value, fields, label, errors);
  if (value.event_name !== eventName) errors.push(`event_name must equal ${eventName}`);
  if (value.schema_version !== SCHEDULER_SCHEMA_VERSION) errors.push(`schema_version must equal ${SCHEDULER_SCHEMA_VERSION}`);
  if (!isRecord(value.provenance)) {
    errors.push('provenance must be an object');
    return;
  }
  exact(value.provenance, SCHEDULER_PROVENANCE_FIELDS, 'provenance', errors);
  if (value.provenance.scheduler_contract !== SCHEDULER_CONTRACT) {
    errors.push(`provenance.scheduler_contract must equal ${SCHEDULER_CONTRACT}`);
  }
  timestamp(value[timestampField], timestampField, errors);
}

function validateInputState(state, label, errors) {
  if (state === null) return;
  if (!isRecord(state)) {
    errors.push(`${label} must be an object or null`);
    return;
  }
  exact(state, INPUT_STATE_FIELDS, label, errors);
  if (typeof state.kind !== 'string' || state.kind.trim().length === 0) errors.push(`${label}.kind is required`);
  identifier(state.ref, `${label}.ref`, errors);
  revision(state.revision, `${label}.revision`, errors);
  boundedText(state.status, `${label}.status`, errors);
  timestamp(state.expires_at, `${label}.expires_at`, errors, { nullable: true });
  if (state.environment !== null && typeof state.environment !== 'string') errors.push(`${label}.environment must be a string or null`);
}

export function decisionClassForReason(reasonCode) {
  return REASON_CLASS.get(reasonCode) ?? null;
}

export function validateEligibilityV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['eligibility must be an object']);
  schedulerCommon(value, ELIGIBILITY_FIELDS, 'eligibility', ELIGIBILITY_EVENT_NAME, 'evaluated_at', errors);
  identifier(value.eligibility_id, 'eligibility_id', errors);
  boundedText(value.job_id, 'job_id', errors);
  identifier(value.execution_id, 'execution_id', errors, { nullable: true });
  boundedText(value.environment, 'environment', errors);
  if (value.policy_id !== SCHEDULER_POLICY_ID) errors.push(`policy_id must equal ${SCHEDULER_POLICY_ID}`);
  if (!REASON_CODES.includes(value.reason_code)) {
    errors.push('reason_code must be a canonical scheduler reason code');
  }
  const expectedClass = decisionClassForReason(value.reason_code);
  if (expectedClass !== null && value.decision !== expectedClass) {
    errors.push(`decision must equal ${expectedClass} for reason ${value.reason_code}`);
  }
  if (!DECISION_CLASSES.includes(value.decision)) errors.push('decision must be a canonical decision class');
  revision(value.job_revision, 'job_revision', errors);

  for (const key of ['approval_id', 'delegation_id', 'hold_id']) {
    identifier(value[key], key, errors, { nullable: true });
  }
  if (value.decision === 'HOLD' && value.hold_id === null) errors.push('hold_id is required for a HOLD decision');
  if (value.decision === 'ELIGIBLE' && value.hold_id !== null) errors.push('hold_id must be null for an ELIGIBLE decision');

  boundedText(value.authority_state, 'authority_state', errors);
  if (value.company_state !== null && (typeof value.company_state !== 'string' || value.company_state.length > 160)) {
    errors.push('company_state must be a bounded string or null');
  }
  if (value.duty !== null && (typeof value.duty !== 'string' || value.duty.length > 160)) {
    errors.push('duty must be a bounded string or null');
  }
  if (value.capacity !== null && (typeof value.capacity !== 'string' || value.capacity.length > 160)) {
    errors.push('capacity must be a bounded string or null');
  }
  identifier(value.resource_ref, 'resource_ref', errors, { nullable: true });
  if ((value.decision === 'ELIGIBLE' || value.decision === 'HOLD') && value.resource_ref === null) {
    errors.push('resource_ref is required for an ELIGIBLE or HOLD decision');
  }
  return result(errors);
}

export function validateReservationV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['reservation must be an object']);
  schedulerCommon(value, RESERVATION_FIELDS, 'reservation', RESERVATION_EVENT_NAME, 'created_at', errors);
  identifier(value.reservation_id, 'reservation_id', errors);
  revision(value.revision, 'revision', errors);
  if (!RESERVATION_STATES.includes(value.state)) errors.push('state must be a canonical reservation state');
  boundedText(value.job_id, 'job_id', errors);
  identifier(value.execution_id, 'execution_id', errors, { nullable: true });
  boundedText(value.resource_ref, 'resource_ref', errors);
  identifier(value.eligibility_id, 'eligibility_id', errors);
  timestamp(value.updated_at, 'updated_at', errors);
  timestamp(value.expires_at, 'expires_at', errors, { nullable: true });
  if (['ACTIVE', 'PENDING'].includes(value.state)) {
    if (value.expires_at === null) errors.push('an active or pending reservation requires an expiry');
    if (isCanonicalUtcTimestamp(value.created_at) && isCanonicalUtcTimestamp(value.expires_at)
      && Date.parse(value.expires_at) <= Date.parse(value.created_at)) {
      errors.push('expires_at must be later than created_at');
    }
  }
  if (value.state === 'RELEASED' || value.state === 'CANCELLED') {
    if (value.expires_at !== null) errors.push(`${value.state.toLowerCase()} reservations must not carry an expiry`);
  }
  return result(errors);
}

const REJECTION_REASONS = new Set([
  'START_REJECTED_JOB_STATE',
  'START_REJECTED_RESERVATION',
  'START_REJECTED_HOLD',
  'START_REJECTED_COMPANY_STATE',
  'START_REJECTED_DUTY',
  'START_REJECTED_CAPACITY',
  'START_REJECTED_APPROVAL',
  'START_REJECTED_DELEGATION',
  'START_REJECTED_ENVIRONMENT',
  'START_REJECTED_AUTHORITY',
  'START_REJECTED_RESOURCE',
  'START_REJECTED_NOT_BEFORE',
  'START_REJECTED_REVISION',
  'START_REJECTED_DEPENDENCY',
  'START_REJECTED_WORKFORCE',
  'START_REJECTED_INPUT_INVALID',
]);

// Rejection reasons are exported so bounded-evidence assessors can enforce the
// same split the runtime validator enforces (START_CONFIRMED is never a
// rejection reason).
export { REJECTION_REASONS };

export function validateStartConfirmationV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['start confirmation must be an object']);
  schedulerCommon(value, START_CONFIRMATION_FIELDS, 'start confirmation', START_CONFIRMATION_EVENT_NAME, 'confirmed_at', errors);
  identifier(value.confirmation_id, 'confirmation_id', errors);
  boundedText(value.job_id, 'job_id', errors);
  identifier(value.execution_id, 'execution_id', errors, { nullable: true });
  identifier(value.reservation_id, 'reservation_id', errors);
  if (value.policy_id !== SCHEDULER_POLICY_ID) errors.push(`policy_id must equal ${SCHEDULER_POLICY_ID}`);
  if (!START_CONFIRMATION_OUTCOMES.includes(value.outcome)) errors.push('outcome must be CONFIRMED or REJECTED');
  if (value.reason_code !== 'START_CONFIRMED' && !REJECTION_REASONS.has(value.reason_code)) {
    errors.push('reason_code must be a canonical start-confirmation reason');
  }
  if (value.outcome === 'CONFIRMED' && value.reason_code !== 'START_CONFIRMED') {
    errors.push('a confirmed start must use reason_code START_CONFIRMED');
  }
  if (value.outcome === 'REJECTED' && value.reason_code === 'START_CONFIRMED') {
    errors.push('a rejected start must not use reason_code START_CONFIRMED');
  }
  return result(errors);
}

export function assertValidEligibilityV1(value) {
  const validation = validateEligibilityV1(value);
  if (!validation.ok) throw new TypeError('Scheduler eligibility failed contract validation');
  return value;
}

const REQUIREMENT_FIELDS = new Set([
  'requires_approval', 'approval_id', 'requires_delegation', 'delegation_id',
  'not_before', 'resource_ref', 'resource', 'dependency', 'authority',
  'execution_safety_class', 'incident_ref',
]);
const AUTHORITY_STATUSES = new Set(['ALLOW', 'DENY', 'MISSING', 'UNAVAILABLE']);
const DEPENDENCY_STATUSES = new Set(['COMPLETE', 'PENDING', 'BLOCKED', 'FAILED', 'UNKNOWN']);
const RESOURCE_STATUSES = new Set(['HEALTHY', 'DEGRADED', 'UNKNOWN', 'UNAVAILABLE']);

export function validateExecutionRequirementV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['execution requirement must be an object']);
  exact(value, REQUIREMENT_FIELDS, 'execution requirement', errors);
  if (typeof value.requires_approval !== 'boolean') errors.push('requires_approval must be a boolean');
  if (typeof value.requires_delegation !== 'boolean') errors.push('requires_delegation must be a boolean');
  const safetyClass = value.execution_safety_class ?? 'ORDINARY';
  if (!EXECUTION_SAFETY_CLASSES.includes(safetyClass)) {
    errors.push('execution_safety_class must be ORDINARY, INCIDENT_CONTAINMENT, or SURVIVAL_CRITICAL');
  }
  if (value.incident_ref !== undefined && value.incident_ref !== null) {
    identifier(value.incident_ref, 'incident_ref', errors);
  }
  if (safetyClass === 'ORDINARY' && value.incident_ref !== undefined && value.incident_ref !== null) {
    errors.push('incident_ref must be null for ORDINARY execution');
  }
  if (safetyClass !== 'ORDINARY' && (value.incident_ref === null || value.incident_ref === undefined)) {
    errors.push('incident_ref is required when execution_safety_class is not ORDINARY');
  }
  identifier(value.approval_id, 'approval_id', errors, { nullable: true });
  identifier(value.delegation_id, 'delegation_id', errors, { nullable: true });
  if (value.requires_approval && value.approval_id === null) errors.push('approval_id is required when approval is required');
  if (value.requires_delegation && value.delegation_id === null) errors.push('delegation_id is required when a delegation is required');
  timestamp(value.not_before, 'not_before', errors, { nullable: true });
  boundedText(value.resource_ref, 'resource_ref', errors);
  validateInputState(value.resource, 'resource', errors);
  if (value.resource != null && !RESOURCE_STATUSES.has(value.resource.status)) {
    errors.push('resource.status must be a canonical resource status');
  }
  validateInputState(value.dependency, 'dependency', errors);
  if (value.dependency != null && !DEPENDENCY_STATUSES.has(value.dependency.status)) {
    errors.push('dependency.status must be a canonical dependency status');
  }
  validateInputState(value.authority, 'authority', errors);
  if (value.authority != null && !AUTHORITY_STATUSES.has(value.authority.status)) {
    errors.push('authority.status must be a canonical authority status');
  }
  return result(errors);
}

export function assertValidExecutionRequirementV1(value) {
  const validation = validateExecutionRequirementV1(value);
  if (!validation.ok) throw new TypeError('Execution requirement failed contract validation');
  return value;
}

const CONFIRMATION_CLASS = new Map([
  ['START_CONFIRMED', 'ELIGIBLE'],
  ['START_REJECTED_JOB_STATE', 'DENY'],
  ['START_REJECTED_RESERVATION', 'WAIT'],
  ['START_REJECTED_HOLD', 'HOLD'],
  ['START_REJECTED_COMPANY_STATE', 'WAIT'],
  ['START_REJECTED_DUTY', 'WAIT'],
  ['START_REJECTED_CAPACITY', 'WAIT'],
  ['START_REJECTED_APPROVAL', 'WAIT'],
  ['START_REJECTED_DELEGATION', 'DENY'],
  ['START_REJECTED_ENVIRONMENT', 'DENY'],
  ['START_REJECTED_AUTHORITY', 'DENY'],
  ['START_REJECTED_RESOURCE', 'DENY'],
  ['START_REJECTED_NOT_BEFORE', 'WAIT'],
  ['START_REJECTED_REVISION', 'WAIT'],
  ['START_REJECTED_DEPENDENCY', 'WAIT'],
  ['START_REJECTED_WORKFORCE', 'DENY'],
  ['START_REJECTED_INPUT_INVALID', 'DENY'],
]);

export function decisionClassForConfirmation(reasonCode) {
  return CONFIRMATION_CLASS.get(reasonCode) ?? null;
}

export function assertValidReservationV1(value) {
  const validation = validateReservationV1(value);
  if (!validation.ok) throw new TypeError('Scheduler reservation failed contract validation');
  return value;
}

export function assertValidStartConfirmationV1(value) {
  const validation = validateStartConfirmationV1(value);
  if (!validation.ok) throw new TypeError('Scheduler start confirmation failed contract validation');
  return value;
}
