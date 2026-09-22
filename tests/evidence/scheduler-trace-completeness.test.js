import assert from 'node:assert/strict';
import test from 'node:test';

import { assessSchedulerTraceCompleteness } from '../../packages/telemetry/src/scheduler-trace-completeness.js';

const TRACE = 'a'.repeat(31) + 'b';
const SPAN = '1'.repeat(16);

function record(overrides = {}) {
  return {
    trace_id: TRACE, span_id: SPAN, parent_span_id: null,
    service_name: 'pixel.scheduler', event_name: 'scheduler.evaluation.completed',
    outcome: 'success', severity: 'info',
    attributes: {
      'pixel.job.id': 'job-001',
      'pixel.scheduler.decision': 'ELIGIBLE',
      'pixel.scheduler.reason_code': 'ELIGIBLE_NOW',
      'pixel.scheduler.job_revision': 1,
    },
    ...overrides,
  };
}

test('a canonical evaluation record assesses complete', () => {
  const assessment = assessSchedulerTraceCompleteness([record()]);
  assert.equal(assessment.complete, true, JSON.stringify(assessment.errors));
});

test('an empty scheduler trace fails closed', () => {
  assert.equal(assessSchedulerTraceCompleteness([]).complete, false);
  assert.equal(assessSchedulerTraceCompleteness(null).complete, false);
});

test('reservation and start events must carry their exact canonical attributes', () => {
  const evaluation = record(); // canonical ELIGIBLE evaluation, span '1'*16
  const activated = record({
    span_id: '2'.repeat(16),
    parent_span_id: SPAN,
    event_name: 'scheduler.reservation.activated',
    attributes: {
      'pixel.job.id': 'job-001',
      'pixel.scheduler.reservation_id': 'reservation-001',
      'pixel.scheduler.resource_ref': 'simulation.exclusive.x',
      'pixel.scheduler.revision': 1,
    },
  });
  assert.equal(
    assessSchedulerTraceCompleteness([evaluation, activated]).complete,
    true,
    'evaluation followed by canonical activation assesses complete',
  );
  // An activation without a preceding eligible evaluation is contradictory.
  assert.equal(assessSchedulerTraceCompleteness([activated]).complete, false);
  // A missing revision attribute is unbounded/unsupported.
  const missingRevision = { ...activated, attributes: { ...activated.attributes } };
  delete missingRevision.attributes['pixel.scheduler.revision'];
  assert.equal(assessSchedulerTraceCompleteness([evaluation, missingRevision]).complete, false);
});

test('records with unknown events are rejected', () => {
  const assessment = assessSchedulerTraceCompleteness([record({ event_name: 'scheduler.evil' })]);
  assert.equal(assessment.complete, false);
});

test('records with tampered attributes are rejected', () => {
  const tampered = record();
  tampered.attributes = { ...tampered.attributes, 'pixel.scheduler.extra': 'leak' };
  assert.equal(assessSchedulerTraceCompleteness([tampered]).complete, false);
});

test('records with non-canonical decisions are rejected', () => {
  const tampered = record();
  tampered.attributes = { ...tampered.attributes, 'pixel.scheduler.decision': 'RUN' };
  assert.equal(assessSchedulerTraceCompleteness([tampered]).complete, false);
});

test('records with non-canonical reason codes are rejected', () => {
  const tampered = record();
  tampered.attributes = { ...tampered.attributes, 'pixel.scheduler.reason_code': 'MAKE_IT_SO' };
  assert.equal(assessSchedulerTraceCompleteness([tampered]).complete, false);
});

test('rejected start evidence requires a denied outcome and canonical reason', () => {
  const evaluation = record();
  const activated = record({
    span_id: '2'.repeat(16), parent_span_id: SPAN,
    event_name: 'scheduler.reservation.activated',
    attributes: {
      'pixel.job.id': 'job-001',
      'pixel.scheduler.reservation_id': 'reservation-001',
      'pixel.scheduler.resource_ref': 'simulation.exclusive.x',
      'pixel.scheduler.revision': 1,
    },
  });
  const rejected = record({
    span_id: '3'.repeat(16), parent_span_id: '2'.repeat(16),
    event_name: 'scheduler.start.rejected',
    outcome: 'denied',
    severity: 'warning',
    attributes: {
      'pixel.job.id': 'job-001',
      'pixel.scheduler.reason_code': 'START_REJECTED_HOLD',
      'pixel.scheduler.reservation_id': 'reservation-001',
    },
  });
  assert.equal(assessSchedulerTraceCompleteness([evaluation, activated, rejected]).complete, true);
  const wrongOutcome = { ...rejected, outcome: 'success' };
  assert.equal(assessSchedulerTraceCompleteness([evaluation, activated, wrongOutcome]).complete, false);
  const wrongReason = { ...rejected, attributes: { ...rejected.attributes, 'pixel.scheduler.reason_code': 'NOPE' } };
  assert.equal(assessSchedulerTraceCompleteness([evaluation, activated, wrongReason]).complete, false);
  // START_CONFIRMED is never a valid rejection reason (CodeRabbit finding).
  const confirmedAsRejection = { ...rejected, attributes: { ...rejected.attributes, 'pixel.scheduler.reason_code': 'START_CONFIRMED' } };
  assert.equal(assessSchedulerTraceCompleteness([evaluation, activated, confirmedAsRejection]).complete, false);
  // A rejection without a preceding activation is contradictory.
  assert.equal(assessSchedulerTraceCompleteness([rejected]).complete, false);
});

test('contradictory, duplicated, and post-terminal sequences are rejected', () => {
  const evaluation = record();
  const activated = record({
    span_id: '2'.repeat(16), parent_span_id: SPAN,
    event_name: 'scheduler.reservation.activated',
    attributes: {
      'pixel.job.id': 'job-001',
      'pixel.scheduler.reservation_id': 'reservation-001',
      'pixel.scheduler.resource_ref': 'simulation.exclusive.x',
      'pixel.scheduler.revision': 1,
    },
  });
  const confirmed = record({
    span_id: '3'.repeat(16), parent_span_id: '2'.repeat(16),
    event_name: 'scheduler.start.confirmed',
    attributes: {
      'pixel.job.id': 'job-001',
      'pixel.scheduler.reason_code': 'START_CONFIRMED',
      'pixel.scheduler.reservation_id': 'reservation-001',
      'pixel.scheduler.job_revision': 2,
    },
  });
  const rejected = record({
    span_id: '4'.repeat(16), parent_span_id: '2'.repeat(16),
    event_name: 'scheduler.start.rejected', outcome: 'denied', severity: 'warning',
    attributes: {
      'pixel.job.id': 'job-001',
      'pixel.scheduler.reason_code': 'START_REJECTED_HOLD',
      'pixel.scheduler.reservation_id': 'reservation-001',
    },
  });
  // A double evaluation is rejected.
  const secondEvaluation = record({ span_id: '5'.repeat(16), parent_span_id: SPAN });
  assert.equal(assessSchedulerTraceCompleteness([evaluation, secondEvaluation, activated, confirmed]).complete, false);
  // A second start outcome is rejected.
  assert.equal(assessSchedulerTraceCompleteness([evaluation, activated, confirmed, rejected]).complete, false);
  // An event after the start outcome is rejected.
  const postTerminal = record({
    span_id: '6'.repeat(16), parent_span_id: '3'.repeat(16),
    event_name: 'scheduler.reservation.rejected', outcome: 'denied', severity: 'warning',
    attributes: {
      'pixel.job.id': 'job-001',
      'pixel.scheduler.reason_code': 'WAIT_CAPACITY',
      'pixel.scheduler.resource_ref': 'simulation.exclusive.x',
    },
  });
  assert.equal(assessSchedulerTraceCompleteness([evaluation, activated, confirmed, postTerminal]).complete, false);
  // Confirmed start without evaluation/activation is rejected.
  assert.equal(assessSchedulerTraceCompleteness([confirmed]).complete, false);
});

test('malformed and duplicate records are rejected without throwing', () => {
  assert.equal(assessSchedulerTraceCompleteness([null]).complete, false);
  const duplicated = [record(), record()];
  assert.equal(assessSchedulerTraceCompleteness(duplicated).complete, false, 'duplicate span identifiers are rejected');
  // A record that is not an object at all must not throw.
  assert.equal(assessSchedulerTraceCompleteness(['nope']).complete, false);
});

test('attributes must stay bounded', () => {
  const long = record();
  long.attributes = { ...long.attributes, 'pixel.job.id': 'x'.repeat(200) };
  assert.equal(assessSchedulerTraceCompleteness([long]).complete, false);
});

test('scheduler evidence family binds to one job and one reservation', () => {
  const evaluation = record();
  const activated = record({
    span_id: '2'.repeat(16), parent_span_id: SPAN,
    event_name: 'scheduler.reservation.activated',
    attributes: {
      'pixel.job.id': 'job-001',
      'pixel.scheduler.reservation_id': 'reservation-001',
      'pixel.scheduler.resource_ref': 'simulation.exclusive.x',
      'pixel.scheduler.revision': 1,
    },
  });
  const confirmed = record({
    span_id: '3'.repeat(16), parent_span_id: '2'.repeat(16),
    event_name: 'scheduler.start.confirmed',
    attributes: {
      'pixel.job.id': 'job-001',
      'pixel.scheduler.reason_code': 'START_CONFIRMED',
      'pixel.scheduler.reservation_id': 'reservation-001',
      'pixel.scheduler.job_revision': 2,
    },
  });
  // The canonical family stays complete.
  assert.equal(assessSchedulerTraceCompleteness([evaluation, activated, confirmed]).complete, true, 'happy path');

  // A mixed-job family (evaluation for one job, activation for another) is not
  // a proof of one scheduler attempt.
  const foreignActivation = {
    ...activated,
    attributes: { ...activated.attributes, 'pixel.job.id': 'job-002' },
  };
  const mixedJobs = assessSchedulerTraceCompleteness([evaluation, foreignActivation, confirmed]);
  assert.equal(mixedJobs.complete, false);
  assert.equal(mixedJobs.errors.includes('scheduler evidence mixes multiple jobs'), true, JSON.stringify(mixedJobs.errors));

  // Reservation ids must agree across activation, release, and start outcomes.
  const mismatchedConfirmed = {
    ...confirmed,
    attributes: { ...confirmed.attributes, 'pixel.scheduler.reservation_id': 'reservation-002' },
  };
  const mixedReservations = assessSchedulerTraceCompleteness([evaluation, activated, mismatchedConfirmed]);
  assert.equal(mixedReservations.complete, false);
  assert.equal(mixedReservations.errors.includes('scheduler evidence references more than one reservation'), true, JSON.stringify(mixedReservations.errors));

  const released = record({
    span_id: '4'.repeat(16), parent_span_id: '2'.repeat(16),
    event_name: 'scheduler.reservation.released',
    attributes: {
      'pixel.job.id': 'job-001',
      'pixel.scheduler.reservation_id': 'reservation-009',
      'pixel.scheduler.revision': 2,
    },
  });
  const mismatchedRelease = assessSchedulerTraceCompleteness([evaluation, activated, confirmed, released]);
  assert.equal(mismatchedRelease.complete, false);
  assert.equal(mismatchedRelease.errors.includes('scheduler evidence references more than one reservation'), true, JSON.stringify(mismatchedRelease.errors));

  // A start rejected for an unknown reservation (no activation in trace) keeps
  // its legitimate path: the unknown reservation id cannot be cross-checked.
  const unknown = record({
    span_id: '5'.repeat(16), parent_span_id: SPAN,
    event_name: 'scheduler.start.rejected', outcome: 'denied', severity: 'warning',
    attributes: {
      'pixel.job.id': 'job-001',
      'pixel.scheduler.reason_code': 'START_REJECTED_RESERVATION',
      'pixel.scheduler.reservation_id': 'reservation-does-not-exist',
    },
  });
  assert.equal(assessSchedulerTraceCompleteness([evaluation, unknown]).complete, true, 'unknown-reservation rejection path');
});
