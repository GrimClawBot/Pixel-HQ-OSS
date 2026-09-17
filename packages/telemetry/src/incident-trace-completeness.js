import { INCIDENT_STATUSES, RESPONSE_PHASES } from '../../../packages/contracts/src/incident-v1.js';

const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
const SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;
const MAX_ERRORS = 32;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const EVENT_RULES = new Map([
  ['incident.created', ['pixel.incident', ['pixel.incident.incident_id', 'pixel.incident.status', 'pixel.incident.revision']]],
  ['incident.acknowledged', ['pixel.incident', ['pixel.incident.incident_id', 'pixel.incident.status', 'pixel.incident.revision']]],
  ['incident.phase.advanced', ['pixel.incident', ['pixel.incident.incident_id', 'pixel.incident.status', 'pixel.incident.phase', 'pixel.incident.revision']]],
  ['incident.command.transferred', ['pixel.incident', ['pixel.incident.incident_id', 'pixel.incident.commander_ref', 'pixel.incident.revision']]],
  ['incident.resolved', ['pixel.incident', ['pixel.incident.incident_id', 'pixel.incident.status', 'pixel.incident.revision']]],
  ['incident.closed', ['pixel.incident', ['pixel.incident.incident_id', 'pixel.incident.status', 'pixel.incident.revision']]],
  ['incident.post-review.recorded', ['pixel.incident', ['pixel.incident.incident_id', 'pixel.incident.phase', 'pixel.incident.revision']]],
  ['incident.refused', ['pixel.incident', ['pixel.incident.incident_id', 'pixel.incident.reason_code']]],
]);

function boundedAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return false;
  return Object.values(attributes).every((value) => (
    ['string', 'number', 'boolean'].includes(typeof value)
    && (typeof value !== 'string' || (value.length <= 160 && IDENTIFIER.test(value)))
    && (typeof value !== 'number' || Number.isSafeInteger(value))
  ));
}

function assessment(errors) {
  const boundedErrors = Object.freeze([...new Set(errors)].map((item) => String(item).slice(0, 160)).slice(0, MAX_ERRORS));
  return Object.freeze({ complete: boundedErrors.length === 0, missing: Object.freeze([]), errors: boundedErrors });
}

// Bounded incident evidence: canonical incident change/refusal events with
// exact bounded attributes. Incident records are the truth; evidence only
// proves the mutation happened and never carries content, prompts, or secrets.
export function assessIncidentTraceCompleteness(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return assessment(['incident trace has no evidence']);
  }
  if (records.some((record) => record === null || typeof record !== 'object')) {
    return assessment(['trace contains malformed incident records']);
  }
  const errors = [];
  const traceId = records[0]?.trace_id;
  const spans = new Set();
  for (const record of records) {
    const rule = EVENT_RULES.get(record?.event_name);
    if (!rule) {
      errors.push('trace contains an unsupported incident event');
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
    const attributes = record.attributes ?? {};
    if (attributes['pixel.incident.status'] !== undefined
      && !INCIDENT_STATUSES.includes(attributes['pixel.incident.status'])) {
      errors.push(`${record.event_name} carries an invalid canonical status`);
    }
    if (attributes['pixel.incident.phase'] !== undefined
      && !RESPONSE_PHASES.includes(attributes['pixel.incident.phase'])) {
      errors.push(`${record.event_name} carries an invalid response phase`);
    }
    if (['incident.created', 'incident.acknowledged', 'incident.resolved', 'incident.closed'].includes(record.event_name)
      && (!Number.isSafeInteger(attributes['pixel.incident.revision']) || attributes['pixel.incident.revision'] < 1)) {
      errors.push(`${record.event_name} requires a positive revision`);
    }
    if (record.event_name === 'incident.refused' && record.outcome !== 'denied') {
      errors.push('incident.refused must record a denied outcome');
    }
  }
  return assessment(errors);
}
