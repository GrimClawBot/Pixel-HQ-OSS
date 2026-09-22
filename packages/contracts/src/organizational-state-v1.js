import { isCanonicalUtcTimestamp } from './trusted-time-v1.js';

export const ORG_STATE_SCHEMA_VERSION = '1.0.0';

export const APPROVAL_EVENT_NAME = 'pixel.org-state.approval.v1';
export const DELEGATION_EVENT_NAME = 'pixel.org-state.delegation.v1';
export const HOLD_EVENT_NAME = 'pixel.org-state.hold.v1';
export const COMPANY_STATE_EVENT_NAME = 'pixel.org-state.company-state.v1';
export const DUTY_STATE_EVENT_NAME = 'pixel.org-state.duty.v1';
export const CAPACITY_STATE_EVENT_NAME = 'pixel.org-state.capacity.v1';

export const ORG_STATE_CONTRACT = 'pixel.organizational-state.v1';

export const APPROVAL_STATUSES = Object.freeze(['REQUESTED', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED']);
export const DELEGATION_STATUSES = Object.freeze(['PROPOSED', 'ACTIVE', 'EXPIRED', 'REVOKED', 'COMPLETED']);
export const HOLD_CLASSES = Object.freeze(['SECURITY', 'POLICY', 'OWNER', 'MAINTENANCE']);
export const HOLD_STATUSES = Object.freeze(['ACTIVE', 'RELEASED', 'EXPIRED']);
export const COMPANY_STATES = Object.freeze([
  'SURVIVAL', 'SECURITY_INCIDENT', 'INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT',
  'MAINTENANCE', 'HOLIDAY', 'NIGHT', 'NORMAL',
]);
export const COMPANY_STATE_PRECEDENCE = Object.freeze([...COMPANY_STATES]);
export const DUTY_STATES = Object.freeze(['ON_DUTY', 'OFF_DUTY', 'ON_CALL', 'MAINTENANCE_DUTY', 'INCIDENT_DUTY']);
export const CAPACITY_STATES = Object.freeze(['AVAILABLE', 'LIGHT', 'NORMAL', 'HIGH', 'SATURATED', 'UNAVAILABLE']);

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const HASH = /^[0-9a-f]{64}$/;
const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const STATUS_SETS = new Map([
  ['approval', new Set(APPROVAL_STATUSES)],
  ['delegation', new Set(DELEGATION_STATUSES)],
  ['hold', new Set(HOLD_STATUSES)],
]);
const COMPANY_STATE_INDEX = new Map(COMPANY_STATES.map((state, index) => [state, index]));

const APPROVAL_FIELDS = new Set([
  'approval_id', 'event_name', 'schema_version', 'status', 'revision', 'created_at', 'updated_at',
  'job_id', 'action_type', 'scope', 'requested_by', 'required_authority', 'approver_identity',
  'expires_at', 'decided_at', 'provenance',
]);
const DELEGATION_FIELDS = new Set([
  'grant_id', 'event_name', 'schema_version', 'status', 'revision', 'created_at', 'updated_at',
  'grantor', 'grantee', 'capability', 'scope', 'environment', 'valid_from', 'expires_at',
  'subdelegation_allowed', 'provenance',
]);
const HOLD_FIELDS = new Set([
  'hold_id', 'event_name', 'schema_version', 'status', 'revision', 'created_at', 'updated_at',
  'job_id', 'hold_class', 'issuer', 'reason_code', 'expires_at', 'incident_id', 'provenance',
]);
const COMPANY_STATE_FIELDS = new Set([
  'company_state_id', 'event_name', 'schema_version', 'revision', 'generated_at', 'state',
  'cause_refs', 'constraints', 'provenance',
]);
const DUTY_FIELDS = new Set([
  'duty_id', 'event_name', 'schema_version', 'revision', 'updated_at', 'agent_id', 'duty', 'provenance',
]);
const CAPACITY_FIELDS = new Set([
  'capacity_id', 'event_name', 'schema_version', 'revision', 'updated_at', 'resource_ref',
  'capacity', 'provenance',
]);
const ORG_STATE_PROVENANCE_FIELDS = new Set(['org_state_contract']);

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
function identifier(value, label, errors) {
  if (typeof value !== 'string' || value.length > IDENTIFIER_MAX || !IDENTIFIER.test(value)) {
    errors.push(`${label} must be a Pixel identifier`);
  }
}

function boundedText(value, label, errors, maximum = 160) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    errors.push(`${label} must be between 1 and ${maximum} characters`);
  }
}

function revision(value, label, errors) {
  if (!Number.isSafeInteger(value) || value < 1) errors.push(`${label} must be a positive safe integer`);
}

function timestamp(value, label, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!isCanonicalUtcTimestamp(value)) errors.push(`${label} must be a canonical UTC ISO-8601 millisecond timestamp`);
}

function common(value, fields, label, eventName, timestampField, errors) {
  exact(value, fields, label, errors);
  if (value.event_name !== eventName) errors.push(`event_name must equal ${eventName}`);
  if (value.schema_version !== ORG_STATE_SCHEMA_VERSION) errors.push(`schema_version must equal ${ORG_STATE_SCHEMA_VERSION}`);
  revision(value.revision, 'revision', errors);
  timestamp(value[timestampField], timestampField, errors);
  if (!isRecord(value.provenance)) {
    errors.push('provenance must be an object');
    return;
  }
  exact(value.provenance, ORG_STATE_PROVENANCE_FIELDS, 'provenance', errors);
  if (value.provenance.org_state_contract !== ORG_STATE_CONTRACT) {
    errors.push(`provenance.org_state_contract must equal ${ORG_STATE_CONTRACT}`);
  }
}

function result(errors) {
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors.slice(0, 32)) });
}

export function validateApprovalV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['approval must be an object']);
  common(value, APPROVAL_FIELDS, 'approval', APPROVAL_EVENT_NAME, 'created_at', errors);
  identifier(value.approval_id, 'approval_id', errors);
  if (!STATUS_SETS.get('approval').has(value.status)) errors.push('status must be a canonical approval status');
  boundedText(value.job_id, 'job_id', errors);
  identifier(value.action_type, 'action_type', errors);
  boundedText(value.scope, 'scope', errors);
  identifier(value.requested_by, 'requested_by', errors);
  boundedText(value.required_authority, 'required_authority', errors);
  timestamp(value.updated_at, 'updated_at', errors);
  timestamp(value.expires_at, 'expires_at', errors, { nullable: true });
  timestamp(value.decided_at, 'decided_at', errors, { nullable: true });
  if (['APPROVED', 'REJECTED'].includes(value.status)) {
    identifier(value.approver_identity, 'approver_identity', errors);
    timestamp(value.decided_at, 'decided_at', errors);
  } else if (value.approver_identity !== null) {
    errors.push('approver_identity must be null until a decision is recorded');
  }
  if (value.status === 'PENDING' || value.status === 'REQUESTED') {
    if (value.decided_at !== null) errors.push('decided_at must be null while the approval is undecided');
  }
  return result(errors);
}

export function validateDelegationV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['delegation must be an object']);
  common(value, DELEGATION_FIELDS, 'delegation', DELEGATION_EVENT_NAME, 'created_at', errors);
  identifier(value.grant_id, 'grant_id', errors);
  if (!STATUS_SETS.get('delegation').has(value.status)) errors.push('status must be a canonical delegation status');
  identifier(value.grantor, 'grantor', errors);
  identifier(value.grantee, 'grantee', errors);
  identifier(value.capability, 'capability', errors);
  boundedText(value.scope, 'scope', errors);
  if (!ENVIRONMENTS.has(value.environment)) errors.push('environment must be canonical');
  timestamp(value.valid_from, 'valid_from', errors);
  timestamp(value.expires_at, 'expires_at', errors, { nullable: true });
  if (typeof value.subdelegation_allowed !== 'boolean') errors.push('subdelegation_allowed must be a boolean');
  timestamp(value.updated_at, 'updated_at', errors);
  if (value.expires_at !== null && isCanonicalUtcTimestamp(value.valid_from) && isCanonicalUtcTimestamp(value.expires_at)
    && Date.parse(value.expires_at) <= Date.parse(value.valid_from)) {
    errors.push('expires_at must be later than valid_from');
  }
  return result(errors);
}

export function validateHoldV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['hold must be an object']);
  common(value, HOLD_FIELDS, 'hold', HOLD_EVENT_NAME, 'created_at', errors);
  identifier(value.hold_id, 'hold_id', errors);
  if (!STATUS_SETS.get('hold').has(value.status)) errors.push('status must be a canonical hold status');
  boundedText(value.job_id, 'job_id', errors);
  if (!HOLD_CLASSES.includes(value.hold_class)) errors.push('hold_class must be a canonical hold class');
  identifier(value.issuer, 'issuer', errors);
  identifier(value.reason_code, 'reason_code', errors);
  if (value.incident_id !== undefined && value.incident_id !== null) {
    identifier(value.incident_id, 'incident_id', errors);
  }
  timestamp(value.updated_at, 'updated_at', errors);
  timestamp(value.expires_at, 'expires_at', errors, { nullable: true });
  return result(errors);
}

export function validateCompanyStateV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['company state must be an object']);
  common(value, COMPANY_STATE_FIELDS, 'company state', COMPANY_STATE_EVENT_NAME, 'generated_at', errors);
  identifier(value.company_state_id, 'company_state_id', errors);
  if (!COMPANY_STATES.includes(value.state)) errors.push('state must be a canonical company state');
  if (!Array.isArray(value.cause_refs) || value.cause_refs.some((item) => (
    typeof item !== 'string' || item.length > IDENTIFIER_MAX || !IDENTIFIER.test(item)
  ))) {
    errors.push('cause_refs must be an array of Pixel identifiers');
  } else if (new Set(value.cause_refs).size !== value.cause_refs.length) {
    errors.push('cause_refs must not contain duplicates');
  } else if (value.cause_refs.length > 8) {
    errors.push('cause_refs must contain at most 8 entries');
  }
  if (!Array.isArray(value.constraints) || value.constraints.some((item) => typeof item !== 'string' || item.trim().length === 0 || item.length > 160)) {
    errors.push('constraints must be an array of bounded strings');
  } else if (new Set(value.constraints).size !== value.constraints.length) {
    errors.push('constraints must not contain duplicates');
  } else if (value.constraints.length > 8) {
    errors.push('constraints must contain at most 8 entries');
  }
  return result(errors);
}

export function validateDutyStateV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['duty state must be an object']);
  common(value, DUTY_FIELDS, 'duty state', DUTY_STATE_EVENT_NAME, 'updated_at', errors);
  identifier(value.duty_id, 'duty_id', errors);
  identifier(value.agent_id, 'agent_id', errors);
  if (!DUTY_STATES.includes(value.duty)) errors.push('duty must be a canonical duty state');
  return result(errors);
}

export function validateCapacityStateV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['capacity state must be an object']);
  common(value, CAPACITY_FIELDS, 'capacity state', CAPACITY_STATE_EVENT_NAME, 'updated_at', errors);
  identifier(value.capacity_id, 'capacity_id', errors);
  boundedText(value.resource_ref, 'resource_ref', errors);
  if (!CAPACITY_STATES.includes(value.capacity)) errors.push('capacity must be a canonical capacity state');
  return result(errors);
}

// Company State is derived from authoritative inputs; a lower-precedence state
// can never override a higher-precedence one, and clients cannot force a value.
export function derivedCompanyState(inputs = []) {
  if (!Array.isArray(inputs)) throw new TypeError('company state inputs must be an array');
  let selected = null;
  let selectedIndex = Number.POSITIVE_INFINITY;
  for (const input of inputs) {
    if (!isRecord(input) || !COMPANY_STATE_INDEX.has(input.state)) continue;
    const index = COMPANY_STATE_INDEX.get(input.state);
    if (index < selectedIndex) {
      selected = input.state;
      selectedIndex = index;
    }
  }
  return selected ?? 'NORMAL';
}

// Every mutable PX-006 object exposes optimistic concurrency. A mutation that
// expects revision N may commit only if N is still current.
export function revisionMatches(expected, current) {
  return Number.isSafeInteger(expected) && expected === current;
}

export function contractFor(kind) {
  switch (kind) {
    case 'approval': return APPROVAL_EVENT_NAME;
    case 'delegation': return DELEGATION_EVENT_NAME;
    case 'hold': return HOLD_EVENT_NAME;
    case 'company-state': return COMPANY_STATE_EVENT_NAME;
    case 'duty': return DUTY_STATE_EVENT_NAME;
    case 'capacity': return CAPACITY_STATE_EVENT_NAME;
    default: return null;
  }
}

export function assertValidApprovalV1(value) {
  const validation = validateApprovalV1(value);
  if (!validation.ok) throw new TypeError('Approval failed contract validation');
  return value;
}

export function assertValidDelegationV1(value) {
  const validation = validateDelegationV1(value);
  if (!validation.ok) throw new TypeError('Delegation failed contract validation');
  return value;
}

export function assertValidHoldV1(value) {
  const validation = validateHoldV1(value);
  if (!validation.ok) throw new TypeError('Hold failed contract validation');
  return value;
}

export function assertValidCompanyStateV1(value) {
  const validation = validateCompanyStateV1(value);
  if (!validation.ok) throw new TypeError('Company state failed contract validation');
  return value;
}

export function assertValidDutyStateV1(value) {
  const validation = validateDutyStateV1(value);
  if (!validation.ok) throw new TypeError('Duty state failed contract validation');
  return value;
}

export function assertValidCapacityStateV1(value) {
  const validation = validateCapacityStateV1(value);
  if (!validation.ok) throw new TypeError('Capacity state failed contract validation');
  return value;
}
