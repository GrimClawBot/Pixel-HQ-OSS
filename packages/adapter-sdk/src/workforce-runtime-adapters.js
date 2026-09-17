import { createHash } from 'node:crypto';

// PX-009 Alpha Workforce runtime seams. These validators describe the shape of
// server-owned dependencies only; they grant no authority and define no
// employee identity of their own.

const SOURCES = new Set(['simulator', 'live']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const IDENTIFIER_MAX = 160;

const IDENTITY_RESOLUTION_FIELDS = new Set(['agent_id', 'department_ref', 'role_ref']);
const EVIDENCE_INTAKE_FIELDS = new Set([
  'source_ref', 'subject_ref', 'agent_id', 'evidence_type', 'observed_result', 'related_refs',
]);
const EVIDENCE_DECISION_FIELDS = new Set([
  'authenticated', 'authority', 'source_ref', 'request_fingerprint',
]);
const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateIdentifier(value, label, errors) {
  if (!hasText(value) || value.length > IDENTIFIER_MAX || !IDENTIFIER.test(value)) {
    errors.push(`${label} must be a Pixel identifier`);
  }
}

function validateBoundedText(value, label, errors) {
  if (!hasText(value) || value.length > IDENTIFIER_MAX) {
    errors.push(`${label} must be bounded text`);
  }
}

function exactFields(value, fields, label, errors) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) errors.push(`${label} contains unsupported field ${key}`);
  }
}

function validateProvider(provider, method, label) {
  if (!isRecord(provider) || !SOURCES.has(provider.source) || typeof provider[method] !== 'function') {
    throw new TypeError(`${label} must declare simulator or live source and implement ${method}()`);
  }
  return provider;
}

export function assertWorkforceIdentityResolver(resolver) {
  return validateProvider(resolver, 'resolveAgentIdentity', 'Workforce identity resolver');
}

export function assertWorkforceEvidenceIntake(intake) {
  return validateProvider(intake, 'authorizeEvidence', 'Workforce evidence intake');
}

export function assertWorkforceMutationAuthorizer(authorizer) {
  return validateProvider(authorizer, 'authorize', 'Workforce mutation authorizer');
}

// The resolver confirms an EXISTING canonical Pixel identity. It is not a
// create/hire API: an unresolved identity returns null and record creation
// fails closed.
export function validateAgentIdentityResolution(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['identity resolution must be an object'] };
  exactFields(value, IDENTITY_RESOLUTION_FIELDS, 'identity resolution', errors);
  validateIdentifier(value.agent_id, 'identity resolution agent_id', errors);
  // department_ref/role_ref are Organization Registry display references such
  // as "Infrastructure / HomeLab"; they are bounded text, matching the
  // Registry and Relay worker-binding contracts, not strict Pixel identifiers.
  validateBoundedText(value.department_ref, 'identity resolution department_ref', errors);
  validateBoundedText(value.role_ref, 'identity resolution role_ref', errors);
  return { ok: errors.length === 0, errors };
}

export function validateEvidenceIntakeRequest(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['evidence intake request must be an object'] };
  exactFields(value, EVIDENCE_INTAKE_FIELDS, 'evidence intake request', errors);
  validateIdentifier(value.source_ref, 'evidence intake source_ref', errors);
  validateIdentifier(value.subject_ref, 'evidence intake subject_ref', errors);
  validateIdentifier(value.agent_id, 'evidence intake agent_id', errors);
  validateIdentifier(value.evidence_type, 'evidence intake evidence_type', errors);
  if (!hasText(value.observed_result) || value.observed_result.length > IDENTIFIER_MAX) {
    errors.push('evidence intake observed_result must be bounded text');
  }
  if (!Array.isArray(value.related_refs) || value.related_refs.length > 16
    || value.related_refs.some((ref) => !hasText(ref) || ref.length > IDENTIFIER_MAX || !IDENTIFIER.test(ref))) {
    errors.push('evidence intake related_refs must be a bounded array of Pixel identifiers');
  }
  return { ok: errors.length === 0, errors };
}

export function workforceEvidenceRequestFingerprint(value) {
  if (!validateEvidenceIntakeRequest(value).ok) return null;
  return createHash('sha256').update(JSON.stringify([
    value.source_ref,
    value.subject_ref,
    value.agent_id,
    value.evidence_type,
    value.observed_result,
    value.related_refs,
  ])).digest('hex');
}

// An authenticated decision binds the exact source it vouches for. Caller
// strings alone are provenance; only this server-owned decision makes evidence
// authoritative.
export function validateEvidenceIntakeDecision(value, request) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['evidence intake decision must be an object'] };
  exactFields(value, EVIDENCE_DECISION_FIELDS, 'evidence intake decision', errors);
  if (value.authenticated !== true) errors.push('evidence intake decision must be authenticated');
  if (!['AUTHENTICATED', 'SELF_REPORT'].includes(value.authority)) {
    errors.push('evidence intake authority must be AUTHENTICATED or SELF_REPORT');
  }
  validateIdentifier(value.source_ref, 'evidence intake decision source_ref', errors);
  if (typeof value.request_fingerprint !== 'string' || !SHA256.test(value.request_fingerprint)) {
    errors.push('evidence intake decision request_fingerprint must be a SHA-256 digest');
  }
  if (isRecord(request) && value.source_ref !== request.source_ref) {
    errors.push('evidence intake decision source_ref must match the submitted source_ref');
  }
  if (isRecord(request) && value.request_fingerprint !== workforceEvidenceRequestFingerprint(request)) {
    errors.push('evidence intake decision must bind the complete submitted request');
  }
  return { ok: errors.length === 0, errors };
}
