// PX-009 Alpha canonical Workforce + AgentOps contracts.
// Workforce owns lifecycle, qualification, causal-attribution, evidence, and
// AgentOps projection truth. This module is a strict validator only: it grants
// no authority, no Access/Policy permission, and no execution eligibility.

import { isCanonicalUtcTimestamp, isExpiredAt } from './trusted-time-v1.js';

export const WORKFORCE_SCHEMA_VERSION = '1.0.0';
export const WORKFORCE_RECORD_EVENT_NAME = 'pixel.workforce-record.v1';
export const CAPABILITY_QUALIFICATION_EVENT_NAME = 'pixel.capability-qualification.v1';
export const WORKFORCE_ATTRIBUTION_EVENT_NAME = 'pixel.workforce-attribution.v1';
export const WORKFORCE_EVIDENCE_EVENT_NAME = 'pixel.workforce-evidence.v1';
export const AGENTOPS_EVALUATION_EVENT_NAME = 'pixel.agentops-evaluation.v1';
export const WORKFORCE_CONTRACT = 'pixel.workforce.v1';

export const LIFECYCLE_STATUSES = Object.freeze([
  'CANDIDATE', 'ACTIVE', 'LIMITED', 'RETRAINING', 'INACTIVE', 'RETIRED',
]);

// Alpha transition allowlist. RETIRED is terminal; unlisted transitions reject
// even when a caller requests them. The matrix itself grants no authority.
export const LIFECYCLE_TRANSITIONS = Object.freeze({
  CANDIDATE: Object.freeze(['ACTIVE', 'INACTIVE', 'RETIRED']),
  ACTIVE: Object.freeze(['LIMITED', 'RETRAINING', 'INACTIVE', 'RETIRED']),
  LIMITED: Object.freeze(['ACTIVE', 'RETRAINING', 'INACTIVE', 'RETIRED']),
  RETRAINING: Object.freeze(['ACTIVE', 'LIMITED', 'INACTIVE', 'RETIRED']),
  INACTIVE: Object.freeze(['ACTIVE', 'LIMITED', 'RETRAINING', 'RETIRED']),
  RETIRED: Object.freeze([]),
});

// Globally ineligible for ordinary autonomous work.
export const GLOBALLY_INELIGIBLE_LIFECYCLE_STATUSES = Object.freeze(['CANDIDATE', 'INACTIVE', 'RETIRED']);
// Lifecycle values that may pass the Workforce gate when the requested
// capability itself remains QUALIFIED.
export const SCOPE_ELIGIBLE_LIFECYCLE_STATUSES = Object.freeze(['ACTIVE', 'LIMITED', 'RETRAINING']);

export const QUALIFICATION_STATUSES = Object.freeze(['QUALIFIED', 'LIMITED', 'RETRAINING', 'UNQUALIFIED']);

export const ATTRIBUTION_CAUSES = Object.freeze([
  'EMPLOYEE', 'RUNTIME_MODEL', 'CONTEXT_PACKAGE', 'TOOL', 'DEPENDENCY',
  'POLICY_AUTHORIZATION', 'INFRASTRUCTURE', 'EXTERNAL_PROVIDER',
  'PROCESS_WORKFLOW', 'MIXED', 'UNKNOWN',
]);

export const EVIDENCE_DIMENSIONS = Object.freeze([
  'QUALITY', 'RELIABILITY', 'POLICY_COMPLIANCE', 'EVIDENCE_QUALITY',
  'JUDGMENT', 'COLLABORATION', 'EFFICIENCY',
]);

export const OBSERVATION_VALUES = Object.freeze(['POSITIVE', 'ACCEPTABLE', 'CONCERN', 'FAIL']);

export const AGENTOPS_STATES = Object.freeze(['NORMAL', 'WATCH', 'REVIEW']);

export const AGENTOPS_RECOMMENDATIONS = Object.freeze([
  'NO_ACTION', 'REVIEW_RUNTIME', 'REVIEW_CONTEXT', 'REVIEW_TOOL', 'REVIEW_PROCESS',
  'REQUEST_TRAINING_REVIEW', 'REQUEST_WORKFORCE_REVIEW',
]);

export const EVIDENCE_AUTHORITIES = Object.freeze(['AUTHENTICATED', 'SELF_REPORT']);
// Derived read-model value: a QUALIFIED record whose Trusted Time expiry has
// passed. It is never persisted as a canonical qualification status.
export const DERIVED_QUALIFICATION_STATUSES = Object.freeze([...QUALIFICATION_STATUSES, 'EXPIRED']);
export const CONFIDENCE_VALUES = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);

// Bounded Alpha limits.
export const MAX_CONTRIBUTING_CAUSES = 8;
export const MAX_EVIDENCE_REFS = 16;
export const MAX_REASON_CODES = 16;
export const MAX_RECOMMENDATIONS = 8;
export const MAX_REFS = 16;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const IDENTIFIER_MAX = 160;
const HASH = /^[0-9a-f]{64}$/;
export const MAX_TRANSITIONS = 64;

const WORKFORCE_PROVENANCE_FIELDS = new Set(['workforce_contract']);

const WORKFORCE_RECORD_FIELDS = new Set([
  'agent_id', 'event_name', 'schema_version', 'lifecycle_status', 'role_ref',
  'department_ref', 'effective_at', 'revision', 'updated_at', 'history', 'provenance',
]);
const WORKFORCE_HISTORY_FIELDS = new Set([
  'lifecycle_status', 'role_ref', 'department_ref', 'effective_at', 'revision',
]);
const QUALIFICATION_FIELDS = new Set([
  'qualification_id', 'event_name', 'schema_version', 'agent_id', 'capability',
  'qualification_status', 'source_ref', 'effective_at', 'expires_at', 'revision',
  'updated_at', 'authorization_ref', 'provenance',
]);
const ATTRIBUTION_FIELDS = new Set([
  'attribution_id', 'event_name', 'schema_version', 'agent_id', 'subject_ref',
  'source_ref', 'primary_cause', 'contributing_causes', 'confidence', 'supporting_evidence_refs',
  'related_incident_ref', 'observed_at', 'provenance',
]);
const EVIDENCE_FIELDS = new Set([
  'evidence_id', 'event_name', 'schema_version', 'agent_id', 'subject_ref',
  'dimension', 'observation', 'source_ref', 'attribution_ref', 'authority',
  'observed_at', 'provenance',
]);
const AGENTOPS_FIELDS = new Set([
  'evaluation_id', 'event_name', 'schema_version', 'agent_id', 'evaluation_state',
  'window_start', 'window_end', 'reason_codes', 'evidence_refs', 'attribution_refs',
  'recommendations', 'generated_at', 'revision_token', 'provenance',
]);

// The Organizational-State projection is a bounded read model, not a full
// record. It is validated at the seam so a malformed projection fails closed.
// Derived seam statuses: the projection may report EXPIRED for a QUALIFIED
// qualification whose Trusted Time expiry has passed. EXPIRED is never a
// persisted canonical qualification status.
export const WORKFORCE_PROJECTION_QUALIFICATION_STATUSES = Object.freeze([
  ...QUALIFICATION_STATUSES, 'EXPIRED',
]);

const WORKFORCE_OPERATING_FACT_FIELDS = new Set([
  'agent_id', 'lifecycle_status', 'qualification_status', 'capability',
  'evaluation_state', 'qualification_expires_at', 'observed_at', 'revision_token',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, allowed, label, errors) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${label} contains unsupported field ${field}`);
  }
}

function identifier(value, label, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length === 0 || value.length > IDENTIFIER_MAX || !IDENTIFIER.test(value)) {
    errors.push(`${label} must be a Pixel identifier`);
  }
}

function boundedText(value, label, errors, { nullable = false, maximum = IDENTIFIER_MAX } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    errors.push(`${label} must be between 1 and ${maximum} characters`);
  }
}

function timestamp(value, label, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!isCanonicalUtcTimestamp(value)) {
    errors.push(`${label} must be a canonical UTC ISO-8601 millisecond timestamp`);
  }
}

function revision(value, label, errors) {
  if (!Number.isSafeInteger(value) || value < 1) errors.push(`${label} must be a positive safe integer`);
}

function hash(value, label, errors) {
  if (typeof value !== 'string' || !HASH.test(value)) errors.push(`${label} must be a lowercase SHA-256 hash`);
}

function boundedArray(value, label, errors, { maximum = MAX_REFS, nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Array.isArray(value) || value.length > maximum) {
    errors.push(`${label} must be an array of at most ${maximum} entries`);
    return;
  }
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > IDENTIFIER_MAX || !IDENTIFIER.test(entry) || seen.has(entry)) {
      errors.push(`${label} must contain unique bounded Pixel identifiers`);
      return;
    }
    seen.add(entry);
  }
}

function enumValue(value, allowed, label, errors) {
  if (!allowed.includes(value)) errors.push(`${label} must be canonical`);
}

function result(errors) {
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors.slice(0, 32)) });
}

function provenance(value, errors) {
  if (!isRecord(value)) {
    errors.push('provenance must be an object');
    return;
  }
  exact(value, WORKFORCE_PROVENANCE_FIELDS, 'provenance', errors);
  if (value.workforce_contract !== WORKFORCE_CONTRACT) {
    errors.push(`provenance.workforce_contract must equal ${WORKFORCE_CONTRACT}`);
  }
}

function common(value, fields, label, eventName, timestampField, errors) {
  exact(value, fields, label, errors);
  if (value.event_name !== eventName) errors.push(`event_name must equal ${eventName}`);
  if (value.schema_version !== WORKFORCE_SCHEMA_VERSION) errors.push(`schema_version must equal ${WORKFORCE_SCHEMA_VERSION}`);
  provenance(value.provenance, errors);
  timestamp(value[timestampField], timestampField, errors);
}

export function lifecycleTransitionAllowed(from, to) {
  return LIFECYCLE_TRANSITIONS[from]?.includes(to) === true;
}

function validateHistoryEntry(entry, index, errors) {
  if (!isRecord(entry)) {
    errors.push(`history[${index}] must be an object`);
    return;
  }
  exact(entry, WORKFORCE_HISTORY_FIELDS, `history[${index}]`, errors);
  enumValue(entry.lifecycle_status, LIFECYCLE_STATUSES, `history[${index}].lifecycle_status`, errors);
  boundedText(entry.role_ref, `history[${index}].role_ref`, errors);
  boundedText(entry.department_ref, `history[${index}].department_ref`, errors);
  timestamp(entry.effective_at, `history[${index}].effective_at`, errors);
  revision(entry.revision, `history[${index}].revision`, errors);
}

// pixel.workforce-record.v1 — canonical current organizational standing for one
// existing agent_id. History is an immutable, superseded chain; it is never
// rewritten in place.
export function validateWorkforceRecordV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['workforce record must be an object']);
  common(value, WORKFORCE_RECORD_FIELDS, 'workforce record', WORKFORCE_RECORD_EVENT_NAME, 'updated_at', errors);
  identifier(value.agent_id, 'agent_id', errors);
  enumValue(value.lifecycle_status, LIFECYCLE_STATUSES, 'lifecycle_status', errors);
  // role_ref/department_ref are Organization Registry references (for example
  // "Infrastructure / HomeLab"), matching the Registry and Relay worker
  // binding contracts: bounded text, not strict Pixel identifiers.
  boundedText(value.role_ref, 'role_ref', errors);
  boundedText(value.department_ref, 'department_ref', errors);
  timestamp(value.effective_at, 'effective_at', errors);
  revision(value.revision, 'revision', errors);
  timestamp(value.updated_at, 'updated_at', errors);
  if (!Array.isArray(value.history) || value.history.length > MAX_TRANSITIONS) {
    errors.push(`history must be an array of at most ${MAX_TRANSITIONS} entries`);
  } else {
    for (let index = 0; index < value.history.length; index += 1) {
      validateHistoryEntry(value.history[index], index, errors);
    }
  }
  // History is superseded truth: every entry must be an earlier revision than
  // the current one, and the chain must be strictly increasing.
  const history = Array.isArray(value.history) ? value.history : [];
  let previous = null;
  for (const entry of history) {
    if (!Number.isSafeInteger(entry?.revision)) continue;
    if (previous !== null && entry.revision <= previous) {
      errors.push('history revisions must be strictly increasing');
      break;
    }
    if (Number.isSafeInteger(value.revision) && entry.revision >= value.revision) {
      errors.push('history revisions must precede the current revision');
      break;
    }
    previous = entry.revision;
  }
  return result(errors);
}

// pixel.capability-qualification.v1 — qualification is per (agent_id,
// capability), separate from Access permission, and never creates authority.
export function validateCapabilityQualificationV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['capability qualification must be an object']);
  common(value, QUALIFICATION_FIELDS, 'capability qualification', CAPABILITY_QUALIFICATION_EVENT_NAME, 'updated_at', errors);
  identifier(value.qualification_id, 'qualification_id', errors);
  identifier(value.agent_id, 'agent_id', errors);
  identifier(value.capability, 'capability', errors);
  enumValue(value.qualification_status, QUALIFICATION_STATUSES, 'qualification_status', errors);
  identifier(value.source_ref, 'source_ref', errors);
  timestamp(value.effective_at, 'effective_at', errors);
  timestamp(value.expires_at, 'expires_at', errors, { nullable: true });
  revision(value.revision, 'revision', errors);
  timestamp(value.updated_at, 'updated_at', errors);
  identifier(value.authorization_ref, 'authorization_ref', errors);
  if (isCanonicalUtcTimestamp(value.effective_at) && isCanonicalUtcTimestamp(value.expires_at)
    && Date.parse(value.expires_at) <= Date.parse(value.effective_at)) {
    errors.push('expires_at must be strictly later than effective_at');
  }
  return result(errors);
}

// pixel.workforce-attribution.v1 — append-only causal attribution for a bounded
// subject. UNKNOWN never defaults to EMPLOYEE.
export function validateWorkforceAttributionV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['workforce attribution must be an object']);
  common(value, ATTRIBUTION_FIELDS, 'workforce attribution', WORKFORCE_ATTRIBUTION_EVENT_NAME, 'observed_at', errors);
  identifier(value.attribution_id, 'attribution_id', errors);
  identifier(value.agent_id, 'agent_id', errors);
  identifier(value.subject_ref, 'subject_ref', errors);
  identifier(value.source_ref, 'source_ref', errors);
  enumValue(value.primary_cause, ATTRIBUTION_CAUSES, 'primary_cause', errors);
  boundedArray(value.contributing_causes, 'contributing_causes', errors, { maximum: MAX_CONTRIBUTING_CAUSES });
  if (Array.isArray(value.contributing_causes)) {
    for (const cause of value.contributing_causes) {
      if (!ATTRIBUTION_CAUSES.includes(cause)) {
        errors.push('contributing_causes must be canonical');
        break;
      }
    }
  }
  enumValue(value.confidence, CONFIDENCE_VALUES, 'confidence', errors);
  boundedArray(value.supporting_evidence_refs, 'supporting_evidence_refs', errors, { maximum: MAX_EVIDENCE_REFS });
  identifier(value.related_incident_ref, 'related_incident_ref', errors, { nullable: true });
  timestamp(value.observed_at, 'observed_at', errors);
  if (Array.isArray(value.supporting_evidence_refs) && value.supporting_evidence_refs.length === 0) {
    errors.push('supporting_evidence_refs must reference canonical evidence');
  }
  if (Array.isArray(value.contributing_causes) && value.contributing_causes.includes(value.primary_cause)) {
    errors.push('contributing_causes must not repeat the primary_cause');
  }
  return result(errors);
}

// pixel.workforce-evidence.v1 — bounded, source-referenced evidence. SELF_REPORT
// is explicitly non-authoritative and can never support employee blame.
export function validateWorkforceEvidenceV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['workforce evidence must be an object']);
  common(value, EVIDENCE_FIELDS, 'workforce evidence', WORKFORCE_EVIDENCE_EVENT_NAME, 'observed_at', errors);
  identifier(value.evidence_id, 'evidence_id', errors);
  identifier(value.agent_id, 'agent_id', errors);
  identifier(value.subject_ref, 'subject_ref', errors, { nullable: true });
  enumValue(value.dimension, EVIDENCE_DIMENSIONS, 'dimension', errors);
  enumValue(value.observation, OBSERVATION_VALUES, 'observation', errors);
  identifier(value.source_ref, 'source_ref', errors);
  identifier(value.attribution_ref, 'attribution_ref', errors, { nullable: true });
  enumValue(value.authority, EVIDENCE_AUTHORITIES, 'authority', errors);
  timestamp(value.observed_at, 'observed_at', errors);
  // Self-report is never authoritative and can never independently establish a
  // FAIL; that requires an authenticated source (parity with the schema).
  if (value.authority === 'SELF_REPORT' && value.observation === 'FAIL') {
    errors.push('SELF_REPORT evidence cannot carry a FAIL observation');
  }
  return result(errors);
}

// pixel.agentops-evaluation.v1 — bounded, non-authoritative evaluation read
// model. It is never a mutation credential.
export function validateAgentOpsEvaluationV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['agentops evaluation must be an object']);
  common(value, AGENTOPS_FIELDS, 'agentops evaluation', AGENTOPS_EVALUATION_EVENT_NAME, 'generated_at', errors);
  identifier(value.evaluation_id, 'evaluation_id', errors);
  identifier(value.agent_id, 'agent_id', errors);
  enumValue(value.evaluation_state, AGENTOPS_STATES, 'evaluation_state', errors);
  timestamp(value.window_start, 'window_start', errors);
  timestamp(value.window_end, 'window_end', errors);
  boundedArray(value.reason_codes, 'reason_codes', errors, { maximum: MAX_REASON_CODES });
  boundedArray(value.evidence_refs, 'evidence_refs', errors, { maximum: MAX_EVIDENCE_REFS });
  boundedArray(value.attribution_refs, 'attribution_refs', errors, { maximum: MAX_EVIDENCE_REFS });
  boundedArray(value.recommendations, 'recommendations', errors, { maximum: MAX_RECOMMENDATIONS });
  timestamp(value.generated_at, 'generated_at', errors);
  hash(value.revision_token, 'revision_token', errors);
  if (Array.isArray(value.recommendations)) {
    for (const recommendation of value.recommendations) {
      if (!AGENTOPS_RECOMMENDATIONS.includes(recommendation)) {
        errors.push('recommendations must be canonical');
        break;
      }
    }
  }
  if (isCanonicalUtcTimestamp(value.window_start) && isCanonicalUtcTimestamp(value.window_end)
    && Date.parse(value.window_end) < Date.parse(value.window_start)) {
    errors.push('window_end must not precede window_start');
  }
  return result(errors);
}

// Seam-specific validation for the Organizational-State workforceFactsFor()
// projection. This is intentionally NOT validateWorkforceRecordV1: the seam
// returns a bounded read model, and the full record validator is the wrong
// boundary for facts crossing the Workforce seam. Any invalid projection makes
// the configured seam unavailable (fail closed) so no eligibility is inferred.
export function validateWorkforceOperatingFactsV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['workforce operating facts must be an object']);
  exact(value, WORKFORCE_OPERATING_FACT_FIELDS, 'workforce operating facts', errors);
  identifier(value.agent_id, 'agent_id', errors);
  enumValue(value.lifecycle_status, LIFECYCLE_STATUSES, 'lifecycle_status', errors);
  if (value.qualification_status !== null) {
    enumValue(value.qualification_status, DERIVED_QUALIFICATION_STATUSES, 'qualification_status', errors);
  }
  identifier(value.capability, 'capability', errors);
  enumValue(value.evaluation_state, AGENTOPS_STATES, 'evaluation_state', errors);
  timestamp(value.qualification_expires_at, 'qualification_expires_at', errors, { nullable: true });
  timestamp(value.observed_at, 'observed_at', errors);
  hash(value.revision_token, 'revision_token', errors);
  if (value.qualification_status === 'QUALIFIED'
    && isCanonicalUtcTimestamp(value.qualification_expires_at)
    && isCanonicalUtcTimestamp(value.observed_at)
    && isExpiredAt(value.qualification_expires_at, value.observed_at)) {
    errors.push('QUALIFIED operating facts must not be expired');
  }
  if (value.qualification_status === 'EXPIRED' && value.qualification_expires_at === null) {
    errors.push('EXPIRED operating facts require qualification_expires_at');
  }
  return result(errors);
}

// Derived qualification fact with Trusted Time. Expiry is evaluated against the
// caller's trusted instant, never a caller-supplied clock.
export function derivedQualificationStatus(qualification, now) {
  if (!isRecord(qualification)) return null;
  if (!QUALIFICATION_STATUSES.includes(qualification.qualification_status)) return null;
  if (qualification.qualification_status === 'QUALIFIED'
    && isExpiredAt(qualification.expires_at, now)) return 'EXPIRED';
  return qualification.qualification_status;
}

export function assertValidWorkforceRecordV1(value) {
  const validation = validateWorkforceRecordV1(value);
  if (!validation.ok) throw new TypeError('Workforce record failed contract validation');
  return value;
}

export function assertValidCapabilityQualificationV1(value) {
  const validation = validateCapabilityQualificationV1(value);
  if (!validation.ok) throw new TypeError('Capability qualification failed contract validation');
  return value;
}

export function assertValidWorkforceAttributionV1(value) {
  const validation = validateWorkforceAttributionV1(value);
  if (!validation.ok) throw new TypeError('Workforce attribution failed contract validation');
  return value;
}

export function assertValidWorkforceEvidenceV1(value) {
  const validation = validateWorkforceEvidenceV1(value);
  if (!validation.ok) throw new TypeError('Workforce evidence failed contract validation');
  return value;
}

export function assertValidAgentOpsEvaluationV1(value) {
  const validation = validateAgentOpsEvaluationV1(value);
  if (!validation.ok) throw new TypeError('AgentOps evaluation failed contract validation');
  return value;
}
