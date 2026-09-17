import { REJECTION_REASONS } from '../../../packages/contracts/src/scheduler-v1.js';

const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
const SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;
const MAX_ERRORS = 32;

const DECISION_REASONS = new Map([
  ['ELIGIBLE', new Set(['ELIGIBLE_NOW'])],
  ['WAIT', new Set(['WAIT_DEPENDENCY', 'WAIT_CAPACITY', 'WAIT_OFF_DUTY', 'WAIT_MAINTENANCE', 'WAIT_HOLIDAY', 'WAIT_NIGHT', 'WAIT_QUALIFICATION', 'WAIT_APPROVAL', 'WAIT_NOT_BEFORE'])],
  ['HOLD', new Set(['HOLD_SECURITY', 'HOLD_POLICY', 'HOLD_OWNER', 'HOLD_MAINTENANCE'])],
  ['DENY', new Set(['DENY_AUTHORITY_MISSING', 'DENY_DELEGATION_INVALID', 'DENY_ENVIRONMENT', 'DENY_RESOURCE_INELIGIBLE', 'DENY_COMPANY_STATE', 'DENY_WORKFORCE', 'DENY_INPUT_INVALID'])],
]);

const EVENT_RULES = new Map([
  ['scheduler.evaluation.completed', [
    'pixel.scheduler',
    ['pixel.job.id', 'pixel.scheduler.decision', 'pixel.scheduler.reason_code', 'pixel.scheduler.job_revision'],
  ]],
  ['scheduler.reservation.activated', [
    'pixel.scheduler',
    ['pixel.job.id', 'pixel.scheduler.reservation_id', 'pixel.scheduler.resource_ref', 'pixel.scheduler.revision'],
  ]],
  ['scheduler.reservation.rejected', [
    'pixel.scheduler',
    ['pixel.job.id', 'pixel.scheduler.reason_code', 'pixel.scheduler.resource_ref'],
  ]],
  ['scheduler.reservation.released', [
    'pixel.scheduler',
    ['pixel.job.id', 'pixel.scheduler.reservation_id', 'pixel.scheduler.revision'],
  ]],
  ['scheduler.start.confirmed', [
    'pixel.scheduler',
    ['pixel.job.id', 'pixel.scheduler.reason_code', 'pixel.scheduler.reservation_id', 'pixel.scheduler.job_revision'],
  ]],
  ['scheduler.start.rejected', [
    'pixel.scheduler',
    ['pixel.job.id', 'pixel.scheduler.reason_code', 'pixel.scheduler.reservation_id'],
  ]],
]);

// Rejection reasons the service can legitimately emit after the reservation
// was released: the input, job-state, and revision checks precede the
// reservation-state check in confirmExecutionStart.
const POST_RELEASE_REJECTIONS = new Set([
  'START_REJECTED_INPUT_INVALID', 'START_REJECTED_JOB_STATE',
  'START_REJECTED_REVISION', 'START_REJECTED_RESERVATION',
]);

function boundedAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return false;
  return Object.values(attributes).every((value) => (
    ['string', 'number', 'boolean'].includes(typeof value)
    && (typeof value !== 'string' || value.length <= 160)
    && (typeof value !== 'number' || Number.isSafeInteger(value))
  ));
}

function assessment(missing, errors) {
  const boundedMissing = Object.freeze([...new Set(missing)].slice(0, MAX_ERRORS));
  const boundedErrors = Object.freeze([...new Set(errors)].map((item) => String(item).slice(0, 160)).slice(0, MAX_ERRORS));
  return Object.freeze({
    complete: boundedMissing.length === 0 && boundedErrors.length === 0,
    missing: boundedMissing,
    errors: boundedErrors,
  });
}

// Bounded scheduler evidence: every record must be a canonical scheduler event
// with exact bounded attributes. Evaluation decisions must agree with their
// canonical reason codes; a reservation may only follow an ELIGIBLE decision in
// the same trace and at most once; a start may be confirmed or rejected only
// once and only after a preceding ELIGIBLE evaluation; START_CONFIRMED is never
// a rejection reason; and no event may appear after a start confirmation or
// rejection. No Task Package text, prompts, or Memory content may appear.
export function assessSchedulerTraceCompleteness(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return assessment(['scheduler.evaluation.completed'], ['trace has no scheduler evidence']);
  }
  if (records.some((record) => record === null || typeof record !== 'object')) {
    return assessment([], ['trace contains malformed scheduler records']);
  }
  const errors = [];
  const traceId = records[0]?.trace_id;
  const spans = new Set();
  let evaluationCount = 0;
  let activationCount = 0;
  let startOutcomeCount = 0;
  let eligibleSeen = false;
  let startSeen = false;
  let releaseSeen = false;
  let releasedBeforeStart = false;

  for (const record of records) {
    const rule = EVENT_RULES.get(record?.event_name);
    if (!rule) {
      errors.push('trace contains an unsupported scheduler event');
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

    // Post-terminal: nothing may follow a confirmed or rejected start.
    if (startSeen && !releaseSeen && record.event_name !== 'scheduler.reservation.released') {
      errors.push(`${record.event_name} appears after the start outcome`);
    }

    const attributes = record.attributes ?? {};
    const reason = attributes['pixel.scheduler.reason_code'];
    if (record.event_name === 'scheduler.evaluation.completed') {
      evaluationCount += 1;
      if (evaluationCount > 1 || startSeen) errors.push('trace contains more than one evaluation');
      const decision = attributes['pixel.scheduler.decision'];
      const allowed = DECISION_REASONS.get(decision);
      if (!allowed || !allowed.has(reason)) errors.push('evaluation decision and reason code disagree');
      const expectedSignal = decision === 'ELIGIBLE' ? 'success' : 'denied';
      if (record.outcome !== expectedSignal) errors.push('evaluation outcome contradicts its decision');
      if (decision === 'ELIGIBLE') eligibleSeen = true;
    }
    if (record.event_name === 'scheduler.reservation.activated') {
      activationCount += 1;
      if (activationCount > 1) errors.push('trace activates more than one reservation');
      if (!eligibleSeen) errors.push('reservation activated without an eligible evaluation in trace');
      if (startSeen) errors.push('reservation activated after the start outcome');
    }
    if (record.event_name === 'scheduler.reservation.rejected') {
      if (record.outcome !== 'denied' || reason !== 'WAIT_CAPACITY') {
        errors.push('scheduler.reservation.rejected evidence is contradictory');
      }
      if (startSeen) errors.push('reservation rejected after the start outcome');
    }
    if (record.event_name === 'scheduler.reservation.released') {
      if (releaseSeen) errors.push('trace releases the reservation more than once');
      if (activationCount === 0) errors.push('reservation released without an activation in trace');
      // Once a reservation is released, no start outcome may follow in this
      // trace: the service releases the reservation when it abandons the
      // attempt, so a later confirmed/rejected start contradicts the release.
      releasedBeforeStart = true;
      releaseSeen = true;
    }
    if (record.event_name === 'scheduler.start.confirmed') {
      startOutcomeCount += 1;
      startSeen = true;
      if (startOutcomeCount > 1) errors.push('trace contains more than one start outcome');
      if (releasedBeforeStart) errors.push('start outcome recorded after the reservation was released');
      if (reason !== 'START_CONFIRMED' || record.outcome !== 'success') {
        errors.push('confirmed start evidence is contradictory');
      }
      if (!eligibleSeen || activationCount === 0) {
        errors.push('confirmed start without a preceding eligible evaluation and activation');
      }
    }
    if (record.event_name === 'scheduler.start.rejected' && releasedBeforeStart
      && !POST_RELEASE_REJECTIONS.has(reason)) {
      // The service checks input validity, job state, and revision BEFORE the
      // reservation-state check, so those rejection reasons (and the
      // reservation-state rejection itself) are legitimately emittable into a
      // released reservation's trace. Every deeper reason (HOLD/CAPACITY/
      // APPROVAL/...) requires an ACTIVE reservation, so it cannot follow a
      // release of that same reservation in a correct trace.
      errors.push('start outcome recorded after the reservation was released');
    }
    if (record.event_name === 'scheduler.start.rejected') {
      startOutcomeCount += 1;
      startSeen = true;
      if (startOutcomeCount > 1) errors.push('trace contains more than one start outcome');
      if (record.outcome !== 'denied' || !REJECTION_REASONS.has(reason)) {
        errors.push('scheduler.start.rejected evidence is contradictory');
      }
      // A start rejected because the reservation is unknown or expired has no
      // activation in its trace by definition; every other rejection requires
      // the activation the start was attempted against.
      if (activationCount === 0 && reason !== 'START_REJECTED_RESERVATION') {
        errors.push('rejected start without a preceding activation in trace');
      }
    }
  }
  for (const record of records) {
    if (record.parent_span_id !== null && !spans.has(record.parent_span_id)) {
      errors.push(`${record.event_name} has broken parentage`);
    }
  }
  return assessment([], errors);
}
