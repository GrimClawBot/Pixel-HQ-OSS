const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
const SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;
const MAX_ERRORS = 32;

const KIND_RULES = new Map([
  ['org-state.approval.recorded', ['pixel.organizational-state', ['pixel.org-state.approval_id', 'pixel.org-state.status', 'pixel.org-state.revision']]],
  ['org-state.delegation.recorded', ['pixel.organizational-state', ['pixel.org-state.grant_id', 'pixel.org-state.status', 'pixel.org-state.revision']]],
  ['org-state.hold.recorded', ['pixel.organizational-state', ['pixel.org-state.hold_id', 'pixel.org-state.status', 'pixel.org-state.revision']]],
  ['org-state.duty.recorded', ['pixel.organizational-state', ['pixel.org-state.duty_id', 'pixel.org-state.status', 'pixel.org-state.revision']]],
  ['org-state.capacity.recorded', ['pixel.organizational-state', ['pixel.org-state.capacity_id', 'pixel.org-state.status', 'pixel.org-state.revision']]],
  ['org-state.company-state.recorded', ['pixel.organizational-state', ['pixel.org-state.status', 'pixel.org-state.revision']]],
  ['org-state.approval.refused', ['pixel.organizational-state', ['pixel.org-state.reason_code']]],
  ['org-state.delegation.refused', ['pixel.organizational-state', ['pixel.org-state.reason_code']]],
  ['org-state.hold.refused', ['pixel.organizational-state', ['pixel.org-state.reason_code']]],
  ['org-state.duty.refused', ['pixel.organizational-state', ['pixel.org-state.reason_code']]],
  ['org-state.capacity.refused', ['pixel.organizational-state', ['pixel.org-state.reason_code']]],
  ['org-state.company-state.refused', ['pixel.organizational-state', ['pixel.org-state.reason_code']]],
]);

const COMPANY_STATES = new Set([
  'SURVIVAL', 'SECURITY_INCIDENT', 'INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT',
  'MAINTENANCE', 'HOLIDAY', 'NIGHT', 'NORMAL',
]);
const APPROVAL_STATUSES = new Set(['REQUESTED', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED']);
const DELEGATION_STATUSES = new Set(['PROPOSED', 'ACTIVE', 'EXPIRED', 'REVOKED', 'COMPLETED']);
const HOLD_STATUSES = new Set(['ACTIVE', 'RELEASED', 'EXPIRED']);
const DUTY_STATES = new Set(['ON_DUTY', 'OFF_DUTY', 'ON_CALL', 'MAINTENANCE_DUTY', 'INCIDENT_DUTY']);
const CAPACITY_STATES = new Set(['AVAILABLE', 'LIGHT', 'NORMAL', 'HIGH', 'SATURATED', 'UNAVAILABLE']);
const STATUS_BY_EVENT = new Map([
  ['org-state.approval.recorded', APPROVAL_STATUSES],
  ['org-state.delegation.recorded', DELEGATION_STATUSES],
  ['org-state.hold.recorded', HOLD_STATUSES],
  ['org-state.duty.recorded', DUTY_STATES],
  ['org-state.capacity.recorded', CAPACITY_STATES],
  ['org-state.company-state.recorded', COMPANY_STATES],
]);

function boundedAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return false;
  return Object.values(attributes).every((value) => (
    ['string', 'number', 'boolean'].includes(typeof value)
    && (typeof value !== 'string' || value.length <= 160)
    && (typeof value !== 'number' || Number.isSafeInteger(value))
  ));
}

function assessment(errors) {
  const boundedErrors = Object.freeze([...new Set(errors)].map((item) => String(item).slice(0, 160)).slice(0, MAX_ERRORS));
  return Object.freeze({ complete: boundedErrors.length === 0, missing: Object.freeze([]), errors: boundedErrors });
}

// Bounded Organizational State evidence: canonical change/refusal events with
// exact bounded attributes only. Records carry IDs, statuses, revisions, and
// reason codes — never Memory text, task contents, or raw sensitive data.
export function assessOrgStateTraceCompleteness(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return assessment(['organizational-state trace has no evidence']);
  }
  if (records.some((record) => record === null || typeof record !== 'object')) {
    return assessment(['trace contains malformed organizational-state records']);
  }
  const errors = [];
  const traceId = records[0]?.trace_id;
  const spans = new Set();
  for (const record of records) {
    const rule = KIND_RULES.get(record?.event_name);
    if (!rule) {
      errors.push('trace contains an unsupported organizational-state event');
      continue;
    }
    if (typeof record.trace_id !== 'string' || !TRACE_ID.test(record.trace_id) || record.trace_id !== traceId) {
      errors.push('trace identifiers must be valid and equal');
    }
    if (typeof record.span_id !== 'string' || !SPAN_ID.test(record.span_id) || spans.has(record.span_id)) {
      errors.push('span identifiers must be valid and unique');
    }
    spans.add(record.span_id);
    if (record.service_name !== rule[0]) errors.push(`${record.event_name} has the wrong service owner`);
    const keys = Object.keys(record.attributes ?? {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...rule[1]].sort()) || !boundedAttributes(record.attributes)) {
      errors.push(`${record.event_name} has unbounded or unsupported attributes`);
    }
    const statuses = STATUS_BY_EVENT.get(record.event_name);
    if (statuses && !statuses.has(record.attributes?.['pixel.org-state.status'])) {
      errors.push(`${record.event_name} carries an invalid canonical status`);
    }
    if (record.event_name.endsWith('.recorded')
      && (!Number.isSafeInteger(record.attributes?.['pixel.org-state.revision']) || record.attributes['pixel.org-state.revision'] < 1)) {
      errors.push(`${record.event_name} requires a positive revision`);
    }
    if (record.event_name.endsWith('.refused') && record.outcome !== 'denied') {
      errors.push(`${record.event_name} must record a denied outcome`);
    }
  }
  return assessment(errors);
}
