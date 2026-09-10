export const JOB_CONTEXT_PROVIDER_CONTRACT = 'pixel.job-context-provider.v1';
export const CAPABILITY_GRANT_PROVIDER_CONTRACT = 'pixel.capability-grant-provider.v1';
export const RELAY_STORE_ADAPTER_CONTRACT = 'pixel.relay-store.adapter.v1';
export const SYSTEM_STATUS_WORKER_CONTRACT = 'pixel.system-status-worker.v1';

const SOURCES = new Set(['simulator', 'live']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONTEXT_FIELDS = new Set(['requester', 'owner', 'worker_binding', 'provider_contract', 'source']);
const REQUESTER_FIELDS = new Set(['subject_id']);
const OWNER_FIELDS = new Set(['department_ref', 'role_ref']);
const WORKER_FIELDS = new Set(['worker_id', 'department_ref', 'role_ref']);
const AUTHORIZATION_FIELDS = new Set([
  'job_id', 'execution_id', 'requester', 'owner', 'worker_binding', 'current_state',
  'environment', 'job_type', 'capability', 'tool_class', 'target', 'parameter_hash',
]);
const GRANT_FIELDS = new Set(['capabilities', 'policy_id', 'provider_contract', 'source']);
const OUTCOME_FIELDS = new Set(['outcome_code']);
const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const CAPABILITIES = new Set(['pixel.system-status.read', 'pixel.system-status.raw.read']);
const HASH = /^[0-9a-f]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, allowed, label, errors) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${label} contains unsupported field ${field}`);
  }
}

function identifier(value, label, errors) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) errors.push(`${label} must be a Pixel identifier`);
}

function text(value, label, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) errors.push(`${label} is required`);
}

function nested(value, fields, label, errors, validate) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  exact(value, fields, label, errors);
  validate(value);
}

function assertProvider(value, method, label) {
  if (!isRecord(value) || !SOURCES.has(value.source) || typeof value[method] !== 'function') {
    throw new TypeError(`${label} must declare simulator or live source and implement ${method}()`);
  }
  return value;
}

export function assertJobContextProvider(value) {
  return assertProvider(value, 'resolveJobContext', 'Job context provider');
}

export function assertCapabilityGrantProvider(value) {
  return assertProvider(value, 'resolveCapabilities', 'Capability grant provider');
}

export function assertSystemStatusWorker(value) {
  return assertProvider(value, 'execute', 'System status worker');
}

export function assertRelayStoreAdapter(value) {
  const methods = [
    'claimOrReturnExisting', 'getJob', 'applyTransition', 'recordGatewayDecision',
    'claimWorkerInvocation', 'commitTerminalResult',
  ];
  if (!isRecord(value) || !SOURCES.has(value.source) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`Relay store adapter must declare simulator or live source and implement ${methods.join(', ')}`);
  }
  return value;
}

export function assertModelRelayStoreAdapter(value) {
  assertRelayStoreAdapter(value);
  if (typeof value.claimModelInvocation !== 'function') {
    throw new TypeError('Model Relay store adapter must implement claimModelInvocation');
  }
  return value;
}

export function validateJobContext(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['job context must be an object'] };
  exact(value, CONTEXT_FIELDS, 'job context', errors);
  nested(value.requester, REQUESTER_FIELDS, 'requester', errors, (requester) => {
    identifier(requester.subject_id, 'requester.subject_id', errors);
  });
  nested(value.owner, OWNER_FIELDS, 'owner', errors, (owner) => {
    text(owner.department_ref, 'owner.department_ref', errors);
    text(owner.role_ref, 'owner.role_ref', errors);
  });
  nested(value.worker_binding, WORKER_FIELDS, 'worker_binding', errors, (worker) => {
    identifier(worker.worker_id, 'worker_binding.worker_id', errors);
    text(worker.department_ref, 'worker_binding.department_ref', errors);
    text(worker.role_ref, 'worker_binding.role_ref', errors);
  });
  if (
    value.owner?.department_ref !== value.worker_binding?.department_ref
    || value.owner?.role_ref !== value.worker_binding?.role_ref
  ) errors.push('worker_binding must match the owning Registry references');
  if (value.provider_contract !== JOB_CONTEXT_PROVIDER_CONTRACT) {
    errors.push(`provider_contract must equal ${JOB_CONTEXT_PROVIDER_CONTRACT}`);
  }
  if (!SOURCES.has(value.source)) errors.push('source must be simulator or live');
  return { ok: errors.length === 0, errors };
}

export function validateCapabilityGrantContext(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['capability grant context must be an object'] };
  exact(value, GRANT_FIELDS, 'capability grant context', errors);
  if (!Array.isArray(value.capabilities) || value.capabilities.some((item) => typeof item !== 'string' || !IDENTIFIER.test(item))) {
    errors.push('capabilities must be an array of Pixel identifiers');
  } else if (new Set(value.capabilities).size !== value.capabilities.length) {
    errors.push('capabilities must not contain duplicates');
  }
  identifier(value.policy_id, 'policy_id', errors);
  if (value.provider_contract !== CAPABILITY_GRANT_PROVIDER_CONTRACT) {
    errors.push(`provider_contract must equal ${CAPABILITY_GRANT_PROVIDER_CONTRACT}`);
  }
  if (!SOURCES.has(value.source)) errors.push('source must be simulator or live');
  return { ok: errors.length === 0, errors };
}

export function validateCapabilityAuthorizationContext(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['capability authorization context must be an object'] };
  exact(value, AUTHORIZATION_FIELDS, 'capability authorization context', errors);
  identifier(value.job_id, 'job_id', errors);
  identifier(value.execution_id, 'execution_id', errors);
  nested(value.requester, REQUESTER_FIELDS, 'requester', errors, (requester) => {
    identifier(requester.subject_id, 'requester.subject_id', errors);
  });
  nested(value.owner, OWNER_FIELDS, 'owner', errors, (owner) => {
    text(owner.department_ref, 'owner.department_ref', errors);
    text(owner.role_ref, 'owner.role_ref', errors);
  });
  nested(value.worker_binding, WORKER_FIELDS, 'worker_binding', errors, (worker) => {
    identifier(worker.worker_id, 'worker_binding.worker_id', errors);
    text(worker.department_ref, 'worker_binding.department_ref', errors);
    text(worker.role_ref, 'worker_binding.role_ref', errors);
  });
  if (
    value.owner?.department_ref !== value.worker_binding?.department_ref
    || value.owner?.role_ref !== value.worker_binding?.role_ref
  ) errors.push('worker_binding must match the owning Registry references');
  if (value.current_state !== 'RUNNING') errors.push('current_state must equal RUNNING');
  if (!ENVIRONMENTS.has(value.environment)) errors.push('environment must be canonical');
  if (value.job_type !== 'system-status') errors.push('job_type must equal system-status');
  if (!CAPABILITIES.has(value.capability)) errors.push('capability must be a PX-003 capability');
  if (value.tool_class !== 'pixel.system-status') errors.push('tool_class must equal pixel.system-status');
  if (value.target !== 'pixel.platform') errors.push('target must equal pixel.platform');
  if (!HASH.test(value.parameter_hash ?? '')) errors.push('parameter_hash must be a lowercase SHA-256 hash');
  return { ok: errors.length === 0, errors };
}

export function validateWorkerOutcome(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['worker outcome must be an object'] };
  exact(value, OUTCOME_FIELDS, 'worker outcome', errors);
  if (!['SYSTEM_STATUS_AVAILABLE', 'WORKER_UNAVAILABLE'].includes(value.outcome_code)) {
    errors.push('worker outcome_code must be SYSTEM_STATUS_AVAILABLE or WORKER_UNAVAILABLE');
  }
  return { ok: errors.length === 0, errors };
}
