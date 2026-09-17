// PX-007 Alpha canonical incident contract.
// Incident owns canonical incident truth: class, severity, commander, status,
// response phase, impact, affected refs, and bounded evidence references.
// This module is a strict validator only — it grants no authority.

import { isCanonicalUtcTimestamp } from './trusted-time-v1.js';

export const INCIDENT_SCHEMA_VERSION = '1.0.0';
export const INCIDENT_EVENT_NAME = 'pixel.incident.v1';
export const INCIDENT_CONTRACT = 'pixel.incident.v1';

export const INCIDENT_CLASSES = Object.freeze(['SECURITY', 'INFRASTRUCTURE', 'POWER', 'THERMAL']);
export const SEVERITIES = Object.freeze(['SEV-3', 'SEV-2', 'SEV-1', 'SEV-0']);
export const INCIDENT_STATUSES = Object.freeze(['OPEN', 'RESOLVED', 'CLOSED']);
export const RESPONSE_PHASES = Object.freeze([
  'DECLARE', 'CONTAIN', 'PRESERVE_EVIDENCE', 'DIAGNOSE', 'REMEDIATE',
  'RECOVER', 'VERIFY', 'CLOSE', 'POST_INCIDENT_REVIEW',
]);
export const RECOVERY_STATES = Object.freeze(['NONE', 'CONTAINED', 'RECOVERING', 'VERIFYING', 'RECOVERED']);
export const IMPACT_CODES = Object.freeze(['LOCALIZED', 'MEANINGFUL_DEGRADATION', 'MAJOR', 'CRITICAL']);
export const COMMAND_TRANSFER_FIELDS = Object.freeze([
  'prior_commander_ref', 'new_commander_ref', 'reason_code', 'actor_ref', 'transferred_at', 'revision',
]);
const COMMAND_TRANSFER_FIELD_SET = new Set(COMMAND_TRANSFER_FIELDS);

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const IDENTIFIER_MAX = 160;
const MAX_AFFECTED = 16;
const MAX_TRANSFERS = 8;

const INCIDENT_FIELDS = new Set([
  'incident_id', 'event_name', 'schema_version', 'status', 'revision',
  'opened_at', 'declared_at', 'acknowledged_at', 'resolved_at', 'closed_at',
  'incident_class', 'severity', 'commander_ref', 'response_phase', 'recovery_state',
  'current_impact_code', 'source_ref', 'summary_code',
  'affected_resource_refs', 'affected_job_refs', 'evidence_refs',
  'remaining_risk_code', 'commander_transfers', 'provenance',
]);
const ACTIVE_INCIDENT_FACT_FIELDS = new Set([
  'incident_id', 'incident_class', 'severity', 'status', 'affected_resource_refs',
]);
const INCIDENT_PROVENANCE_FIELDS = new Set(['incident_contract']);

const SEVERITY_IMPACT = Object.freeze({
  'SEV-3': 'LOCALIZED',
  'SEV-2': 'MEANINGFUL_DEGRADATION',
  'SEV-1': 'MAJOR',
  'SEV-0': 'CRITICAL',
});

const PHASE_INDEX = new Map(RESPONSE_PHASES.map((phase, index) => [phase, index]));

// Approved deterministic environmental normalization. Facts are mapped to a
// canonical incident class or rejected as unsupported — never guessed.
const ENVIRONMENTAL_KEYWORDS = Object.freeze({
  POWER: ['utility', 'ups', 'voltage', 'electrical', 'electric', 'power'],
  THERMAL: ['cooling', 'cooler', 'air conditioner', 'ac', 'fan', 'heat', 'temperature', 'thermal'],
  INFRASTRUCTURE: ['compute', 'network', 'storage', 'platform', 'server', 'switch', 'nas', 'disk', 'rack', 'gpu', 'uplink', 'connectivity', 'host', 'node'],
});

// Token/boundary-aware environmental matching: keywords are matched as whole
// tokens (or exact multi-word phrases), never as substrings, so a short
// keyword such as "ac" cannot match inside "rack".
function environmentalTokens(text) {
  return text.trim().toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

function hasEnvironmentalKeyword(tokens, keyword) {
  const phrase = keyword.split(' ');
  if (phrase.length === 1) return tokens.includes(keyword);
  for (let index = 0; index + phrase.length <= tokens.length; index += 1) {
    if (phrase.every((part, offset) => tokens[index + offset] === part)) return true;
  }
  return false;
}

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
  if (typeof value !== 'string' || value.length > IDENTIFIER_MAX || !IDENTIFIER.test(value)) {
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

function boundedRefArray(value, label, errors, { maximum = MAX_AFFECTED, nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Array.isArray(value) || value.length > maximum) {
    errors.push(`${label} must be an array of at most ${maximum} bounded identifiers`);
    return;
  }
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > IDENTIFIER_MAX || !IDENTIFIER.test(entry) || seen.has(entry)) {
      errors.push(`${label} must contain unique bounded Pixel identifiers`);
      return;
    }
    seen.add(entry);
  }
}

function validateTransfer(transfer, index, errors) {
  if (!isRecord(transfer)) {
    errors.push(`commander_transfers[${index}] must be an object`);
    return;
  }
  exact(transfer, COMMAND_TRANSFER_FIELD_SET, `commander_transfers[${index}]`, errors);
  identifier(transfer.prior_commander_ref, `commander_transfers[${index}].prior_commander_ref`, errors);
  identifier(transfer.new_commander_ref, `commander_transfers[${index}].new_commander_ref`, errors);
  identifier(transfer.reason_code, `commander_transfers[${index}].reason_code`, errors);
  identifier(transfer.actor_ref, `commander_transfers[${index}].actor_ref`, errors);
  timestamp(transfer.transferred_at, `commander_transfers[${index}].transferred_at`, errors);
  revision(transfer.revision, `commander_transfers[${index}].revision`, errors);
}

function result(errors) {
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors.slice(0, 32)) });
}

// The canonical incident record. Exactly one commander is represented by the
// mandatory commander_ref; every transfer records the prior/new commander,
// reason, actor, Trusted Time, and revision, and the chain must end at the
// current commander_ref (no silent replacement).
export function validateIncidentV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['incident must be an object']);
  exact(value, INCIDENT_FIELDS, 'incident', errors);
  if (value.event_name !== INCIDENT_EVENT_NAME) errors.push(`event_name must equal ${INCIDENT_EVENT_NAME}`);
  if (value.schema_version !== INCIDENT_SCHEMA_VERSION) errors.push(`schema_version must equal ${INCIDENT_SCHEMA_VERSION}`);
  if (!isRecord(value.provenance)) {
    errors.push('provenance must be an object');
  } else {
    exact(value.provenance, INCIDENT_PROVENANCE_FIELDS, 'provenance', errors);
    if (value.provenance.incident_contract !== INCIDENT_CONTRACT) {
      errors.push(`provenance.incident_contract must equal ${INCIDENT_CONTRACT}`);
    }
  }
  identifier(value.incident_id, 'incident_id', errors);
  revision(value.revision, 'revision', errors);
  timestamp(value.opened_at, 'opened_at', errors);
  timestamp(value.declared_at, 'declared_at', errors);
  timestamp(value.acknowledged_at, 'acknowledged_at', errors, { nullable: true });
  timestamp(value.resolved_at, 'resolved_at', errors, { nullable: true });
  timestamp(value.closed_at, 'closed_at', errors, { nullable: true });
  if (!INCIDENT_CLASSES.includes(value.incident_class)) errors.push('incident_class must be canonical');
  if (!SEVERITIES.includes(value.severity)) errors.push('severity must be canonical');
  if (!INCIDENT_STATUSES.includes(value.status)) errors.push('status must be canonical');
  identifier(value.commander_ref, 'commander_ref', errors);
  if (!RESPONSE_PHASES.includes(value.response_phase)) errors.push('response_phase must be canonical');
  if (!RECOVERY_STATES.includes(value.recovery_state)) errors.push('recovery_state must be canonical');
  if (!IMPACT_CODES.includes(value.current_impact_code)) errors.push('current_impact_code must be canonical');
  identifier(value.source_ref, 'source_ref', errors);
  boundedText(value.summary_code, 'summary_code', errors, { maximum: 80 });
  boundedRefArray(value.affected_resource_refs, 'affected_resource_refs', errors, { maximum: MAX_AFFECTED });
  boundedRefArray(value.affected_job_refs, 'affected_job_refs', errors, { maximum: MAX_AFFECTED });
  boundedRefArray(value.evidence_refs, 'evidence_refs', errors, { maximum: MAX_AFFECTED });
  boundedText(value.remaining_risk_code, 'remaining_risk_code', errors, { nullable: true, maximum: 80 });
  if (!Array.isArray(value.commander_transfers) || value.commander_transfers.length > MAX_TRANSFERS) {
    errors.push(`commander_transfers must be an array of at most ${MAX_TRANSFERS} transfers`);
  } else {
    value.commander_transfers.forEach((transfer, index) => validateTransfer(transfer, index, errors));
  }

  if (value.acknowledged_at !== null && value.acknowledged_at !== undefined
    && isCanonicalUtcTimestamp(value.declared_at) && isCanonicalUtcTimestamp(value.acknowledged_at)
    && Date.parse(value.acknowledged_at) < Date.parse(value.declared_at)) {
    errors.push('acknowledged_at must not precede declared_at');
  }
  if (value.status === 'OPEN') {
    if (value.resolved_at !== null) errors.push('an OPEN incident must not carry resolved_at');
    if (value.closed_at !== null) errors.push('an OPEN incident must not carry closed_at');
    if (PHASE_INDEX.get(value.response_phase) > PHASE_INDEX.get('VERIFY')) {
      errors.push('an OPEN incident phase must not exceed VERIFY');
    }
  }
  if (value.status !== 'OPEN') {
    if (value.resolved_at === null) errors.push(`${value.status} incident requires resolved_at`);
    if (value.status === 'CLOSED') {
      if (value.closed_at === null) errors.push('CLOSED incident requires closed_at');
      if (PHASE_INDEX.get(value.response_phase) < PHASE_INDEX.get('CLOSE')) {
        errors.push('a CLOSED incident phase must be CLOSE or POST_INCIDENT_REVIEW');
      }
    }
  }
  if (value.resolved_at !== null && value.closed_at !== null
    && Date.parse(value.closed_at) < Date.parse(value.resolved_at)) {
    errors.push('closed_at must not precede resolved_at');
  }
  // Exactly one commander: the transfer chain is contiguous and ends at the
  // current commander_ref. A broken chain means silent replacement occurred.
  const transfers = Array.isArray(value.commander_transfers) ? value.commander_transfers : [];
  for (let index = 1; index < transfers.length; index += 1) {
    if (transfers[index].prior_commander_ref !== transfers[index - 1].new_commander_ref) {
      errors.push('commander transfer chain is broken');
      break;
    }
  }
  if (transfers.length > 0 && transfers[transfers.length - 1].new_commander_ref !== value.commander_ref) {
    errors.push('commander_ref must equal the latest transfer commander');
  }
  return result(errors);
}

// Seam-specific validation for the Organizational-State activeIncidentFacts()
// projection. This is intentionally NOT validateIncidentV1: the projection is a
// bounded five-field view, and the full incident record validator is the wrong
// boundary for facts crossing the incident seam. Any invalid fact must make
// the configured seam unavailable (fail closed) so no permission is inferred.
export function validateActiveIncidentFactV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['active incident fact must be an object']);
  exact(value, ACTIVE_INCIDENT_FACT_FIELDS, 'active incident fact', errors);
  identifier(value.incident_id, 'incident_id', errors);
  if (!INCIDENT_CLASSES.includes(value.incident_class)) errors.push('incident_class must be canonical');
  if (!SEVERITIES.includes(value.severity)) errors.push('severity must be canonical');
  if (value.status !== 'OPEN') errors.push('status must be OPEN for an active incident fact');
  boundedRefArray(value.affected_resource_refs, 'affected_resource_refs', errors, { maximum: MAX_AFFECTED });
  return result(errors);
}

export function normalizeEnvironmentalFact(text) {
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > 160) {
    return Object.freeze({ ok: false, reason: 'UNSUPPORTED' });
  }
  const tokens = environmentalTokens(text);
  for (const keyword of ENVIRONMENTAL_KEYWORDS.POWER) {
    if (hasEnvironmentalKeyword(tokens, keyword)) return Object.freeze({ ok: true, incident_class: 'POWER' });
  }
  for (const keyword of ENVIRONMENTAL_KEYWORDS.THERMAL) {
    if (hasEnvironmentalKeyword(tokens, keyword)) return Object.freeze({ ok: true, incident_class: 'THERMAL' });
  }
  for (const keyword of ENVIRONMENTAL_KEYWORDS.INFRASTRUCTURE) {
    if (hasEnvironmentalKeyword(tokens, keyword)) return Object.freeze({ ok: true, incident_class: 'INFRASTRUCTURE' });
  }
  return Object.freeze({ ok: false, reason: 'UNSUPPORTED' });
}

export function derivedImpactCode(severity) {
  return SEVERITY_IMPACT[severity] ?? null;
}

// Deterministic per-incident mapping. Active SEV-0 incidents are SURVIVAL;
// active SEV-1 maps by class; SEV-2/SEV-3 contribute no global state.
function derivedIncidentCompanyState({ incident_class: incidentClass, severity } = {}) {
  if (severity === 'SEV-0') return 'SURVIVAL';
  if (severity === 'SEV-1' && incidentClass === 'SECURITY') return 'SECURITY_INCIDENT';
  if (severity === 'SEV-1' && ['INFRASTRUCTURE', 'POWER', 'THERMAL'].includes(incidentClass)) {
    return 'INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT';
  }
  return null;
}

const INCIDENT_STATE_PRECEDENCE = { SURVIVAL: 0, SECURITY_INCIDENT: 1, INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT: 2 };

// Incident-derived Company State with PX-006 precedence: the worst active
// incident wins. Non-incident inputs are never invented here.
export function derivedCompanyStateForIncidents(incidents = []) {
  if (!Array.isArray(incidents)) return null;
  let best = null;
  for (const incident of incidents) {
    if (incident?.status !== 'OPEN') continue;
    const state = derivedIncidentCompanyState(incident);
    if (state !== null && (best === null || INCIDENT_STATE_PRECEDENCE[state] < INCIDENT_STATE_PRECEDENCE[best])) {
      best = state;
    }
  }
  return best;
}

export { derivedIncidentCompanyState };

// Degraded resource facts: affected resources of active incidents are
// deterministically degraded; unknown/unavailable health still fails closed.
export function degradedResourceRefsForIncidents(incidents = []) {
  const refs = new Set();
  for (const incident of incidents) {
    if (incident?.status !== 'OPEN') continue;
    if (!['SEV-2', 'SEV-1', 'SEV-0'].includes(incident?.severity)) continue;
    for (const ref of incident?.affected_resource_refs ?? []) {
      if (typeof ref === 'string' && ref.length > 0) refs.add(ref);
    }
  }
  return refs;
}

export function assertValidIncidentV1(value) {
  const validation = validateIncidentV1(value);
  if (!validation.ok) throw new TypeError('Incident failed contract validation');
  return value;
}
