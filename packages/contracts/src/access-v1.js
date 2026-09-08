export const PROTECTED_APP_INTENT_SCHEMA_VERSION = '1.0.0';
export const ACCESS_REQUEST_EVENT_NAME = 'pixel.access.request.v1';
export const ACCESS_DECISION_EVENT_NAME = 'pixel.access.decision.v1';
export const ACCESS_SCHEMA_VERSION = '1.0.0';
export const ACCESS_GATE_CONTRACT = 'pixel.access-gate.v1';

const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const SOURCES = new Set(['simulator', 'live']);
const VERIFICATION_STATUSES = new Set(['verified', 'not_verified', 'unknown']);
const ENROLLMENT_STATUSES = new Set(['enrolled', 'not_enrolled', 'unknown']);
const TRUST_STATUSES = new Set(['trusted', 'untrusted', 'revoked', 'unknown']);
const CERTIFICATE_STATUSES = new Set(['valid', 'not_valid', 'unknown']);
const RISK_POSTURES = new Set(['acceptable', 'not_acceptable', 'unknown']);
const DECISIONS = new Set(['ALLOW', 'DENY']);
export const ACCESS_REASON_CODES = Object.freeze([
  'ACCESS_ALLOWED',
  'IDENTITY_NOT_VERIFIED',
  'DEVICE_NOT_ENROLLED',
  'DEVICE_REVOKED',
  'DEVICE_UNTRUSTED',
  'CERTIFICATE_NOT_VALID',
  'RISK_NOT_ACCEPTABLE',
  'APP_NOT_PERMITTED',
  'CLIENT_AUTHORITY_CLAIM_REJECTED',
  'CLIENT_INTENT_INVALID',
  'IDENTITY_CONTEXT_UNAVAILABLE',
  'DEVICE_TRUST_CONTEXT_UNAVAILABLE',
  'ACCESS_CONTEXT_INVALID',
]);

const EARLY_DENIAL_REASONS = new Set([
  'CLIENT_AUTHORITY_CLAIM_REJECTED',
  'CLIENT_INTENT_INVALID',
  'IDENTITY_CONTEXT_UNAVAILABLE',
  'DEVICE_TRUST_CONTEXT_UNAVAILABLE',
  'ACCESS_CONTEXT_INVALID',
]);
const REASON_CODES = new Set(ACCESS_REASON_CODES);
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const INTENT_FIELDS = new Set(['app_id', 'capability']);
const REQUEST_FIELDS = new Set([
  'request_id', 'event_name', 'schema_version', 'occurred_at', 'environment',
  'trace_id', 'span_id', 'identity', 'device', 'target', 'provenance',
]);
const IDENTITY_FIELDS = new Set(['subject_id', 'identity_class', 'role', 'verification_status']);
const DEVICE_FIELDS = new Set([
  'device_id', 'enrollment_status', 'trust_status', 'certificate_status', 'risk_posture',
]);
const TARGET_FIELDS = new Set(['app_id', 'capability']);
const REQUEST_PROVENANCE_FIELDS = new Set([
  'identity_provider_contract', 'identity_source',
  'device_trust_provider_contract', 'device_trust_source',
]);
const DECISION_FIELDS = new Set([
  'decision_id', 'event_name', 'schema_version', 'decided_at', 'environment',
  'trace_id', 'span_id', 'request_id', 'decision', 'reason_code', 'target',
  'owner', 'policy_id', 'provenance',
]);
const OWNER_FIELDS = new Set(['state', 'summary', 'impact']);
const DECISION_PROVENANCE_FIELDS = new Set(['access_gate_contract']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  return hasText(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateExactFields(record, allowedFields, errors, label) {
  for (const field of Object.keys(record)) {
    if (!allowedFields.has(field)) {
      errors.push(`${label} contains unsupported field ${field}`);
    }
  }
}

function validateIdentifier(value, field, errors) {
  if (!hasText(value) || !IDENTIFIER.test(value)) {
    errors.push(`${field} must be a non-empty Pixel identifier`);
  }
}

function validateTraceIds(value, errors) {
  if (!HEX_32.test(value.trace_id) || /^0+$/.test(value.trace_id ?? '')) {
    errors.push('trace_id must be 32 non-zero lowercase hexadecimal characters');
  }
  if (!HEX_16.test(value.span_id) || /^0+$/.test(value.span_id ?? '')) {
    errors.push('span_id must be 16 non-zero lowercase hexadecimal characters');
  }
}

function validateTarget(target, errors) {
  if (!isRecord(target)) {
    errors.push('target must be an object');
    return;
  }
  validateExactFields(target, TARGET_FIELDS, errors, 'target');
  if (target.app_id !== 'pixel-bench') {
    errors.push('target.app_id must equal pixel-bench');
  }
  if (target.capability !== 'launch') {
    errors.push('target.capability must equal launch');
  }
}

export class PixelAccessContractValidationError extends Error {
  constructor(label, errors) {
    super(`${label} failed contract validation (${errors.length} error${errors.length === 1 ? '' : 's'})`);
    this.name = 'PixelAccessContractValidationError';
    this.errors = Object.freeze([...errors]);
  }
}

export function validateProtectedAppIntentV1(value) {
  const errors = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['intent must be an object'] };
  }
  validateExactFields(value, INTENT_FIELDS, errors, 'intent');
  if (value.app_id !== 'pixel-bench') {
    errors.push('intent.app_id must equal pixel-bench');
  }
  if (value.capability !== 'launch') {
    errors.push('intent.capability must equal launch');
  }
  return { ok: errors.length === 0, errors };
}

export function validateAccessRequestV1(value) {
  const errors = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['access request must be an object'] };
  }

  validateExactFields(value, REQUEST_FIELDS, errors, 'access request');
  validateIdentifier(value.request_id, 'request_id', errors);
  if (value.event_name !== ACCESS_REQUEST_EVENT_NAME) {
    errors.push(`event_name must equal ${ACCESS_REQUEST_EVENT_NAME}`);
  }
  if (value.schema_version !== ACCESS_SCHEMA_VERSION) {
    errors.push(`schema_version must equal ${ACCESS_SCHEMA_VERSION}`);
  }
  if (!isIsoTimestamp(value.occurred_at)) {
    errors.push('occurred_at must be an ISO 8601 UTC timestamp');
  }
  if (!ENVIRONMENTS.has(value.environment)) {
    errors.push('environment must be dev, simulation, shadow, canary, or production');
  }
  validateTraceIds(value, errors);

  if (!isRecord(value.identity)) {
    errors.push('identity must be an object');
  } else {
    validateExactFields(value.identity, IDENTITY_FIELDS, errors, 'identity');
    validateIdentifier(value.identity.subject_id, 'identity.subject_id', errors);
    if (value.identity.identity_class !== 'human') {
      errors.push('identity.identity_class must equal human');
    }
    validateIdentifier(value.identity.role, 'identity.role', errors);
    if (!VERIFICATION_STATUSES.has(value.identity.verification_status)) {
      errors.push('identity.verification_status must be verified, not_verified, or unknown');
    }
  }

  if (!isRecord(value.device)) {
    errors.push('device must be an object');
  } else {
    validateExactFields(value.device, DEVICE_FIELDS, errors, 'device');
    validateIdentifier(value.device.device_id, 'device.device_id', errors);
    if (!ENROLLMENT_STATUSES.has(value.device.enrollment_status)) {
      errors.push('device.enrollment_status must be enrolled, not_enrolled, or unknown');
    }
    if (!TRUST_STATUSES.has(value.device.trust_status)) {
      errors.push('device.trust_status must be trusted, untrusted, revoked, or unknown');
    }
    if (!CERTIFICATE_STATUSES.has(value.device.certificate_status)) {
      errors.push('device.certificate_status must be valid, not_valid, or unknown');
    }
    if (!RISK_POSTURES.has(value.device.risk_posture)) {
      errors.push('device.risk_posture must be acceptable, not_acceptable, or unknown');
    }
    if (value.device.trust_status === 'trusted' && value.device.enrollment_status !== 'enrolled') {
      errors.push('device.trust_status trusted requires enrollment_status enrolled');
    }
  }

  validateTarget(value.target, errors);

  if (!isRecord(value.provenance)) {
    errors.push('provenance must be an object');
  } else {
    validateExactFields(value.provenance, REQUEST_PROVENANCE_FIELDS, errors, 'provenance');
    if (value.provenance.identity_provider_contract !== 'pixel.identity-context-provider.v1') {
      errors.push('provenance.identity_provider_contract must equal pixel.identity-context-provider.v1');
    }
    if (!SOURCES.has(value.provenance.identity_source)) {
      errors.push('provenance.identity_source must be simulator or live');
    }
    if (value.provenance.device_trust_provider_contract !== 'pixel.device-trust-provider.v1') {
      errors.push('provenance.device_trust_provider_contract must equal pixel.device-trust-provider.v1');
    }
    if (!SOURCES.has(value.provenance.device_trust_source)) {
      errors.push('provenance.device_trust_source must be simulator or live');
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidAccessRequestV1(value) {
  const result = validateAccessRequestV1(value);
  if (!result.ok) {
    throw new PixelAccessContractValidationError('Access request', result.errors);
  }
  return value;
}

export function validateAccessDecisionV1(value) {
  const errors = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['access decision must be an object'] };
  }

  validateExactFields(value, DECISION_FIELDS, errors, 'access decision');
  validateIdentifier(value.decision_id, 'decision_id', errors);
  if (value.event_name !== ACCESS_DECISION_EVENT_NAME) {
    errors.push(`event_name must equal ${ACCESS_DECISION_EVENT_NAME}`);
  }
  if (value.schema_version !== ACCESS_SCHEMA_VERSION) {
    errors.push(`schema_version must equal ${ACCESS_SCHEMA_VERSION}`);
  }
  if (!isIsoTimestamp(value.decided_at)) {
    errors.push('decided_at must be an ISO 8601 UTC timestamp');
  }
  if (!ENVIRONMENTS.has(value.environment)) {
    errors.push('environment must be dev, simulation, shadow, canary, or production');
  }
  validateTraceIds(value, errors);
  if (value.request_id !== null) {
    validateIdentifier(value.request_id, 'request_id', errors);
  }
  if (!DECISIONS.has(value.decision)) {
    errors.push('decision must be ALLOW or DENY');
  }
  if (!REASON_CODES.has(value.reason_code)) {
    errors.push('reason_code must be a Pixel access reason code');
  }
  validateTarget(value.target, errors);

  if (!isRecord(value.owner)) {
    errors.push('owner must be an object');
  } else {
    validateExactFields(value.owner, OWNER_FIELDS, errors, 'owner');
    if (value.decision === 'ALLOW' && value.owner.state !== 'Ready') {
      errors.push('owner.state must be Ready when decision is ALLOW');
    }
    if (value.decision === 'DENY' && value.owner.state !== 'Protected') {
      errors.push('owner.state must be Protected when decision is DENY');
    }
    if (!hasText(value.owner.summary)) {
      errors.push('owner.summary must be a non-empty string');
    }
    if (!hasText(value.owner.impact)) {
      errors.push('owner.impact must be a non-empty string');
    }
  }

  if (value.decision === 'ALLOW' && value.reason_code !== 'ACCESS_ALLOWED') {
    errors.push('ALLOW requires reason_code ACCESS_ALLOWED');
  }
  if (value.decision === 'DENY' && value.reason_code === 'ACCESS_ALLOWED') {
    errors.push('DENY cannot use reason_code ACCESS_ALLOWED');
  }
  if (EARLY_DENIAL_REASONS.has(value.reason_code)) {
    if (value.request_id !== null) {
      errors.push('request_id must be null when canonical evaluation was not completed');
    }
    if (value.policy_id !== null) {
      errors.push('policy_id must be null when Policy was not evaluated');
    }
  } else {
    if (!hasText(value.request_id)) {
      errors.push('request_id is required when Policy was evaluated');
    }
    if (!hasText(value.policy_id)) {
      errors.push('policy_id is required when Policy was evaluated');
    }
  }

  if (!isRecord(value.provenance)) {
    errors.push('provenance must be an object');
  } else {
    validateExactFields(value.provenance, DECISION_PROVENANCE_FIELDS, errors, 'provenance');
    if (value.provenance.access_gate_contract !== ACCESS_GATE_CONTRACT) {
      errors.push(`provenance.access_gate_contract must equal ${ACCESS_GATE_CONTRACT}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidAccessDecisionV1(value) {
  const result = validateAccessDecisionV1(value);
  if (!result.ok) {
    throw new PixelAccessContractValidationError('Access decision', result.errors);
  }
  return value;
}
