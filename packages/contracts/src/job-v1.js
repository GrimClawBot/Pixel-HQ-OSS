export const JOB_SCHEMA_VERSION = '1.0.0';
export const JOB_SUBMIT_INTENT_EVENT_NAME = 'pixel.job.submit-intent.v1';
export const JOB_ENVELOPE_EVENT_NAME = 'pixel.relay.job-envelope.v1';
export const JOB_TRANSITION_EVENT_NAME = 'pixel.relay.job-transition.v1';
export const TOOL_EXECUTION_REQUEST_EVENT_NAME = 'pixel.tool.execution-request.v1';
export const TOOL_CAPABILITY_DECISION_EVENT_NAME = 'pixel.tool.capability-decision.v1';
export const JOB_RESULT_EVENT_NAME = 'pixel.job.result.v1';

export const JOB_STATES = Object.freeze(['SUBMITTED', 'ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED']);
export const JOB_CAPABILITIES = Object.freeze([
  'pixel.system-status.read',
  'pixel.system-status.raw.read',
]);

const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const SOURCES = new Set(['simulator', 'live']);
const CAPABILITIES = new Set(JOB_CAPABILITIES);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const HASH = /^[0-9a-f]{64}$/;

const INTENT_FIELDS = new Set(['event_name', 'schema_version', 'idempotency_key', 'job_type', 'requested_capability']);
const ENVELOPE_FIELDS = new Set([
  'job_id', 'event_name', 'schema_version', 'created_at', 'environment', 'trace_id', 'span_id',
  'requester', 'owner', 'job_type', 'requested_capability', 'execution', 'state', 'idempotency',
  'provenance',
]);
const TRANSITION_FIELDS = new Set([
  'transition_id', 'event_name', 'schema_version', 'occurred_at', 'environment', 'trace_id',
  'span_id', 'job_id', 'execution_id', 'from_state', 'to_state', 'reason_code', 'provenance',
]);
const EXECUTION_REQUEST_FIELDS = new Set([
  'request_id', 'event_name', 'schema_version', 'occurred_at', 'environment', 'trace_id',
  'span_id', 'job_id', 'execution_id', 'capability', 'tool_class', 'target', 'parameter_hash',
  'worker_binding', 'provenance',
]);
const DECISION_FIELDS = new Set([
  'decision_id', 'event_name', 'schema_version', 'decided_at', 'environment', 'trace_id',
  'span_id', 'request_id', 'job_id', 'execution_id', 'capability', 'tool_class', 'target',
  'parameter_hash', 'worker_binding', 'decision', 'reason_code', 'policy_id', 'provenance',
]);
const RESULT_FIELDS = new Set([
  'result_id', 'event_name', 'schema_version', 'completed_at', 'environment', 'trace_id',
  'span_id', 'job_id', 'execution_id', 'state', 'outcome_code', 'summary', 'provenance',
]);
const REQUESTER_FIELDS = new Set(['subject_id']);
const OWNER_FIELDS = new Set(['department_ref', 'role_ref']);
const WORKER_BINDING_FIELDS = new Set(['worker_id', 'department_ref', 'role_ref']);
const EXECUTION_FIELDS = new Set(['capability', 'tool_class', 'target', 'parameter_hash', 'worker_binding']);
const IDEMPOTENCY_FIELDS = new Set(['key', 'fingerprint']);
const ENVELOPE_PROVENANCE_FIELDS = new Set(['relay_contract', 'context_provider_contract', 'context_source']);
const RELAY_PROVENANCE_FIELDS = new Set(['relay_contract']);
const EXECUTION_PROVENANCE_FIELDS = new Set(['tool_gateway_contract']);
const DECISION_PROVENANCE_FIELDS = new Set([
  'tool_gateway_contract', 'grant_provider_contract', 'grant_source',
]);
const RESULT_PROVENANCE_FIELDS = new Set(['relay_contract', 'worker_contract', 'worker_source']);

const LEGAL_TRANSITIONS = new Map([
  ['SUBMITTED:ACCEPTED', new Set(['JOB_ACCEPTED'])],
  ['ACCEPTED:RUNNING', new Set(['EXECUTION_STARTED'])],
  ['RUNNING:COMPLETED', new Set(['EXECUTION_COMPLETED'])],
  ['RUNNING:FAILED', new Set(['CAPABILITY_DENIED', 'AUTHORIZATION_UNAVAILABLE', 'WORKER_FAILED', 'WORKER_RESULT_INVALID'])],
]);
const RESULT_OUTCOMES = new Map([
  ['COMPLETED', new Set(['SYSTEM_STATUS_AVAILABLE'])],
  ['FAILED', new Set(['CAPABILITY_DENIED', 'AUTHORIZATION_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'WORKER_RESULT_INVALID'])],
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactFields(value, allowed, label, errors) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${label} contains unsupported field ${field}`);
  }
}

function identifier(value, label, errors) {
  if (!hasText(value) || !IDENTIFIER.test(value)) errors.push(`${label} must be a Pixel identifier`);
}

function timestamp(value, label, errors) {
  if (!hasText(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    errors.push(`${label} must be an ISO 8601 UTC timestamp`);
  }
}

function trace(value, errors) {
  if (!TRACE_ID.test(value.trace_id ?? '') || /^0+$/.test(value.trace_id ?? '')) {
    errors.push('trace_id must be 32 non-zero lowercase hexadecimal characters');
  }
  if (!SPAN_ID.test(value.span_id ?? '') || /^0+$/.test(value.span_id ?? '')) {
    errors.push('span_id must be 16 non-zero lowercase hexadecimal characters');
  }
}

function environment(value, errors) {
  if (!ENVIRONMENTS.has(value)) errors.push('environment must be dev, simulation, shadow, canary, or production');
}

function capability(value, label, errors) {
  if (!CAPABILITIES.has(value)) errors.push(`${label} must be a supported PX-003 capability`);
}

function source(value, label, errors) {
  if (!SOURCES.has(value)) errors.push(`${label} must be simulator or live`);
}

function record(value, fields, label, errors, validate) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  exactFields(value, fields, label, errors);
  validate(value);
}

function validateRequester(value, errors) {
  record(value, REQUESTER_FIELDS, 'requester', errors, (requester) => {
    identifier(requester.subject_id, 'requester.subject_id', errors);
  });
}

function validateOwner(value, errors, label = 'owner') {
  record(value, OWNER_FIELDS, label, errors, (owner) => {
    if (!hasText(owner.department_ref)) errors.push(`${label}.department_ref is required`);
    if (!hasText(owner.role_ref)) errors.push(`${label}.role_ref is required`);
  });
}

function validateWorkerBinding(value, errors) {
  record(value, WORKER_BINDING_FIELDS, 'worker_binding', errors, (binding) => {
    identifier(binding.worker_id, 'worker_binding.worker_id', errors);
    if (!hasText(binding.department_ref)) errors.push('worker_binding.department_ref is required');
    if (!hasText(binding.role_ref)) errors.push('worker_binding.role_ref is required');
  });
}

function validateExecution(value, errors) {
  record(value, EXECUTION_FIELDS, 'execution', errors, (execution) => {
    capability(execution.capability, 'execution.capability', errors);
    if (execution.tool_class !== 'pixel.system-status') errors.push('execution.tool_class must equal pixel.system-status');
    if (execution.target !== 'pixel.platform') errors.push('execution.target must equal pixel.platform');
    if (!HASH.test(execution.parameter_hash ?? '')) errors.push('execution.parameter_hash must be a lowercase SHA-256 hash');
    validateWorkerBinding(execution.worker_binding, errors);
  });
}

function validateCommon(value, fields, label, eventName, timeField, errors) {
  exactFields(value, fields, label, errors);
  if (value.event_name !== eventName) errors.push(`event_name must equal ${eventName}`);
  if (value.schema_version !== JOB_SCHEMA_VERSION) errors.push(`schema_version must equal ${JOB_SCHEMA_VERSION}`);
  timestamp(value[timeField], timeField, errors);
  environment(value.environment, errors);
  trace(value, errors);
}

export class PixelJobContractValidationError extends Error {
  constructor(label, errors) {
    super(`${label} failed contract validation (${errors.length} error${errors.length === 1 ? '' : 's'})`);
    this.name = 'PixelJobContractValidationError';
    this.errors = Object.freeze([...errors]);
  }
}

function assertContract(label, value, validate) {
  const result = validate(value);
  if (!result.ok) throw new PixelJobContractValidationError(label, result.errors);
  return value;
}

export function validateJobSubmitIntentV1(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['job submit intent must be an object'] };
  exactFields(value, INTENT_FIELDS, 'job submit intent', errors);
  if (value.event_name !== JOB_SUBMIT_INTENT_EVENT_NAME) errors.push(`event_name must equal ${JOB_SUBMIT_INTENT_EVENT_NAME}`);
  if (value.schema_version !== JOB_SCHEMA_VERSION) errors.push(`schema_version must equal ${JOB_SCHEMA_VERSION}`);
  identifier(value.idempotency_key, 'idempotency_key', errors);
  if (value.job_type !== 'system-status') errors.push('job_type must equal system-status');
  capability(value.requested_capability, 'requested_capability', errors);
  return { ok: errors.length === 0, errors };
}

export function assertValidJobSubmitIntentV1(value) {
  return assertContract('Job submit intent', value, validateJobSubmitIntentV1);
}

export function validateJobEnvelopeV1(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['job envelope must be an object'] };
  validateCommon(value, ENVELOPE_FIELDS, 'job envelope', JOB_ENVELOPE_EVENT_NAME, 'created_at', errors);
  identifier(value.job_id, 'job_id', errors);
  validateRequester(value.requester, errors);
  validateOwner(value.owner, errors);
  if (value.job_type !== 'system-status') errors.push('job_type must equal system-status');
  capability(value.requested_capability, 'requested_capability', errors);
  validateExecution(value.execution, errors);
  if (value.execution?.capability !== value.requested_capability) {
    errors.push('execution.capability must equal requested_capability');
  }
  if (value.state !== 'SUBMITTED') errors.push('job envelope state must equal SUBMITTED');
  record(value.idempotency, IDEMPOTENCY_FIELDS, 'idempotency', errors, (idempotency) => {
    identifier(idempotency.key, 'idempotency.key', errors);
    if (!HASH.test(idempotency.fingerprint ?? '')) errors.push('idempotency.fingerprint must be a lowercase SHA-256 hash');
  });
  record(value.provenance, ENVELOPE_PROVENANCE_FIELDS, 'provenance', errors, (provenance) => {
    if (provenance.relay_contract !== 'pixel.relay.v1') errors.push('provenance.relay_contract must equal pixel.relay.v1');
    if (provenance.context_provider_contract !== 'pixel.job-context-provider.v1') {
      errors.push('provenance.context_provider_contract must equal pixel.job-context-provider.v1');
    }
    source(provenance.context_source, 'provenance.context_source', errors);
  });
  return { ok: errors.length === 0, errors };
}

export function assertValidJobEnvelopeV1(value) {
  return assertContract('Job envelope', value, validateJobEnvelopeV1);
}

export function validateJobTransitionV1(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['job transition must be an object'] };
  validateCommon(value, TRANSITION_FIELDS, 'job transition', JOB_TRANSITION_EVENT_NAME, 'occurred_at', errors);
  identifier(value.transition_id, 'transition_id', errors);
  identifier(value.job_id, 'job_id', errors);
  if (value.execution_id !== null) identifier(value.execution_id, 'execution_id', errors);
  const reasons = LEGAL_TRANSITIONS.get(`${value.from_state}:${value.to_state}`);
  if (!reasons) errors.push('job transition must follow the PX-003 lifecycle');
  else if (!reasons.has(value.reason_code)) errors.push('reason_code must match the legal job transition');
  if (value.to_state === 'RUNNING' || value.from_state === 'RUNNING') {
    if (value.execution_id === null) errors.push('RUNNING transitions require execution_id');
  } else if (value.execution_id !== null) {
    errors.push('SUBMITTED to ACCEPTED requires a null execution_id');
  }
  record(value.provenance, RELAY_PROVENANCE_FIELDS, 'provenance', errors, (provenance) => {
    if (provenance.relay_contract !== 'pixel.relay.v1') errors.push('provenance.relay_contract must equal pixel.relay.v1');
  });
  return { ok: errors.length === 0, errors };
}

export function assertValidJobTransitionV1(value) {
  return assertContract('Job transition', value, validateJobTransitionV1);
}

function validateExecutionRequestShape(value, errors) {
  identifier(value.request_id, 'request_id', errors);
  identifier(value.job_id, 'job_id', errors);
  identifier(value.execution_id, 'execution_id', errors);
  capability(value.capability, 'capability', errors);
  if (value.tool_class !== 'pixel.system-status') errors.push('tool_class must equal pixel.system-status');
  if (value.target !== 'pixel.platform') errors.push('target must equal pixel.platform');
  if (!HASH.test(value.parameter_hash ?? '')) errors.push('parameter_hash must be a lowercase SHA-256 hash');
  validateWorkerBinding(value.worker_binding, errors);
}

export function validateToolExecutionRequestV1(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['tool execution request must be an object'] };
  validateCommon(value, EXECUTION_REQUEST_FIELDS, 'tool execution request', TOOL_EXECUTION_REQUEST_EVENT_NAME, 'occurred_at', errors);
  validateExecutionRequestShape(value, errors);
  record(value.provenance, EXECUTION_PROVENANCE_FIELDS, 'provenance', errors, (provenance) => {
    if (provenance.tool_gateway_contract !== 'pixel.tool-gateway.v1') {
      errors.push('provenance.tool_gateway_contract must equal pixel.tool-gateway.v1');
    }
  });
  return { ok: errors.length === 0, errors };
}

export function assertValidToolExecutionRequestV1(value) {
  return assertContract('Tool execution request', value, validateToolExecutionRequestV1);
}

export function validateToolCapabilityDecisionV1(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['tool capability decision must be an object'] };
  validateCommon(value, DECISION_FIELDS, 'tool capability decision', TOOL_CAPABILITY_DECISION_EVENT_NAME, 'decided_at', errors);
  identifier(value.decision_id, 'decision_id', errors);
  validateExecutionRequestShape(value, errors);
  if (!['ALLOW', 'DENY'].includes(value.decision)) errors.push('decision must be ALLOW or DENY');
  const validReason = value.decision === 'ALLOW'
    ? value.reason_code === 'CAPABILITY_GRANTED'
    : ['CAPABILITY_NOT_GRANTED', 'AUTHORIZATION_UNAVAILABLE'].includes(value.reason_code);
  if (!validReason) errors.push('reason_code must match the capability decision');
  if (value.decision === 'ALLOW') identifier(value.policy_id, 'policy_id', errors);
  else if (value.policy_id !== null) identifier(value.policy_id, 'policy_id', errors);
  record(value.provenance, DECISION_PROVENANCE_FIELDS, 'provenance', errors, (provenance) => {
    if (provenance.tool_gateway_contract !== 'pixel.tool-gateway.v1') {
      errors.push('provenance.tool_gateway_contract must equal pixel.tool-gateway.v1');
    }
    if (provenance.grant_provider_contract !== 'pixel.capability-grant-provider.v1') {
      errors.push('provenance.grant_provider_contract must equal pixel.capability-grant-provider.v1');
    }
    source(provenance.grant_source, 'provenance.grant_source', errors);
  });
  return { ok: errors.length === 0, errors };
}

export function assertValidToolCapabilityDecisionV1(value) {
  return assertContract('Tool capability decision', value, validateToolCapabilityDecisionV1);
}

export function validateJobResultV1(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['job result must be an object'] };
  validateCommon(value, RESULT_FIELDS, 'job result', JOB_RESULT_EVENT_NAME, 'completed_at', errors);
  identifier(value.result_id, 'result_id', errors);
  identifier(value.job_id, 'job_id', errors);
  identifier(value.execution_id, 'execution_id', errors);
  const outcomes = RESULT_OUTCOMES.get(value.state);
  if (!outcomes) errors.push('state must be COMPLETED or FAILED');
  else if (!outcomes.has(value.outcome_code)) errors.push('outcome_code must match the terminal state');
  if (!hasText(value.summary) || value.summary.length > 160) {
    errors.push('summary must be server-generated text between 1 and 160 characters');
  }
  record(value.provenance, RESULT_PROVENANCE_FIELDS, 'provenance', errors, (provenance) => {
    if (provenance.relay_contract !== 'pixel.relay.v1') errors.push('provenance.relay_contract must equal pixel.relay.v1');
    if (value.outcome_code === 'CAPABILITY_DENIED' || value.outcome_code === 'AUTHORIZATION_UNAVAILABLE') {
      if (provenance.worker_contract !== null || provenance.worker_source !== null) {
        errors.push('denied results must not claim worker provenance');
      }
    } else {
      if (provenance.worker_contract !== 'pixel.system-status-worker.v1') {
        errors.push('provenance.worker_contract must equal pixel.system-status-worker.v1');
      }
      source(provenance.worker_source, 'provenance.worker_source', errors);
    }
  });
  return { ok: errors.length === 0, errors };
}

export function assertValidJobResultV1(value) {
  return assertContract('Job result', value, validateJobResultV1);
}
