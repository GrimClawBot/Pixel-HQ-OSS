import assert from 'node:assert/strict';
import test from 'node:test';

import { baseRequirement, canonicalJob, createClock, schedulerRuntime } from '../helpers/px006-runtime.js';

function withJob(runtime, overrides = {}) {
  const job = canonicalJob(overrides);
  runtime.jobs.set(job.envelope.job_id, job);
  return job;
}

async function eligible(runtime, job, requirement = baseRequirement()) {
  const evaluation = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(evaluation.disposition, 'ELIGIBLE', JSON.stringify(evaluation.evaluation?.reason_code));
  return evaluation;
}

test('an eligible job can reserve capacity and confirm start', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const evaluation = await eligible(runtime, job);

  const reserved = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');
  assert.equal(reserved.reservation.state, 'ACTIVE');
  assert.ok(Date.parse(reserved.reservation.expires_at) > Date.parse('2026-09-12T12:00:00.000Z'));

  const confirmation = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id,
    requirement: baseRequirement(),
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmation.confirmed, true);
  assert.equal(confirmation.reason_code, 'START_CONFIRMED');
  assert.equal(confirmation.confirmation.outcome, 'CONFIRMED');
});

test('reservation is impossible without an ELIGIBLE decision', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const denied = { decision: 'DENY', reason_code: 'DENY_AUTHORITY_MISSING', eligibility_id: 'eligibility-x' };
  const reserved = runtime.scheduler.reserve({ evaluation: denied, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'DENY');
  assert.equal(reserved.reservation, null);
  assert.equal(runtime.schedulerStore.activeReservations().length, 0);
});

test('two jobs racing for one exclusive slot produce exactly one active reservation', async () => {
  const runtime = schedulerRuntime();
  const first = withJob(runtime, { jobId: 'job-001' });
  const second = withJob(runtime, { jobId: 'job-002', revision: 2 });

  const firstEval = await eligible(runtime, first);
  const secondEval = await eligible(runtime, second);

  const outcomes = await Promise.all([
    Promise.resolve(runtime.scheduler.reserve({ evaluation: firstEval.evaluation, job_id: first.envelope.job_id })),
    Promise.resolve(runtime.scheduler.reserve({ evaluation: secondEval.evaluation, job_id: second.envelope.job_id })),
  ]);
  const reservedCount = outcomes.filter(({ disposition }) => disposition === 'RESERVED').length;
  const waitCount = outcomes.filter(({ disposition }) => disposition === 'WAIT').length;
  assert.equal(reservedCount, 1);
  assert.equal(waitCount, 1);
  assert.equal(runtime.schedulerStore.activeReservations().length, 1);
});

test('a second reservation on the same resource fails while the lease is live', async () => {
  const runtime = schedulerRuntime();
  const first = withJob(runtime, { jobId: 'job-001' });
  const second = withJob(runtime, { jobId: 'job-002', revision: 2 });

  const firstEval = await eligible(runtime, first);
  const reserved = runtime.scheduler.reserve({ evaluation: firstEval.evaluation, job_id: first.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');

  // Re-evaluate the second job: capacity itself is not saturated, but the
  // reservation store must reject a concurrent exclusive claim.
  const secondEval = await eligible(runtime, second);
  const blocked = runtime.scheduler.reserve({ evaluation: secondEval.evaluation, job_id: second.envelope.job_id });
  assert.equal(blocked.disposition, 'WAIT');
  assert.equal(blocked.reservation.resource_ref, reserved.reservation.resource_ref);

  // Once the first is released, the second may reserve.
  const released = runtime.scheduler.release({
    reservation_id: reserved.reservation.reservation_id,
    expected_revision: reserved.reservation.revision,
  });
  assert.equal(released.disposition, 'RELEASED');
  const afterRelease = runtime.scheduler.reserve({ evaluation: secondEval.evaluation, job_id: second.envelope.job_id });
  assert.equal(afterRelease.disposition, 'RESERVED');
});

test('expired lease blocks start confirmation and requires re-evaluation', async () => {
  const clock = createClock('2026-09-12T12:00:00.000Z');
  const runtime = schedulerRuntime({ clock });
  const job = withJob(runtime);
  const evaluation = await eligible(runtime, job);
  const reserved = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');

  // Advance beyond the 5-minute lease.
  clock.advance(6 * 60 * 1000);
  const confirmation = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id,
    requirement: baseRequirement(),
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.reason_code, 'START_REJECTED_RESERVATION');

  // The lease is recorded as EXPIRED, and an expired reservation cannot be
  // reused or reactivated.
  const current = runtime.scheduler.reservation(reserved.reservation.reservation_id);
  assert.equal(current.state, 'EXPIRED');
  const reactivate = runtime.schedulerStore.transition(reserved.reservation.reservation_id, {
    toState: 'RELEASED', now: clock.now(), expectedRevision: current.revision,
  });
  assert.equal(reactivate.disposition, 'REJECTED');
});

test('wall-clock rollback cannot revive an expired lease', async () => {
  const clock = createClock('2026-09-12T12:00:00.000Z');
  let wall = '2026-09-12T12:00:00.000Z';
  // A trusted clock clamps to the highest observed time.
  const observed = [];
  const runtime = schedulerRuntime({
    clock: {
      now: () => {
        if (observed.length > 0 && Date.parse(wall) < Date.parse(observed.at(-1))) return observed.at(-1);
        observed.push(wall);
        return wall;
      },
      set: (value) => { wall = value; },
      advance: (milliseconds) => { wall = new Date(Date.parse(wall) + milliseconds).toISOString(); },
    },
  });
  const job = withJob(runtime);
  const evaluation = await eligible(runtime, job);
  const reserved = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');

  // Lease expires.
  wall = '2026-09-12T12:06:00.000Z';
  const expired = runtime.scheduler.reservation(reserved.reservation.reservation_id);
  assert.equal(expired.state, 'EXPIRED');

  // Attacker rolls the wall clock back before the lease window.
  wall = '2026-09-12T11:50:00.000Z';
  const afterRollback = runtime.scheduler.reservation(reserved.reservation.reservation_id);
  assert.equal(afterRollback.state, 'EXPIRED', 'an expired lease must not revive after rollback');
  const confirmation = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id,
    requirement: baseRequirement(),
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.reason_code, 'START_REJECTED_RESERVATION');
  // keep clock reference used
  assert.equal(typeof clock.now(), 'string');
});

test('stale job revision at start confirmation is rejected', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const evaluation = await eligible(runtime, job);
  const reserved = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });

  const confirmation = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id,
    requirement: baseRequirement(),
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision + 1,
  });
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.reason_code, 'START_REJECTED_REVISION');
});

test('a hold appearing after eligibility rejects start with START_REJECTED_HOLD', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const evaluation = await eligible(runtime, job);
  const reserved = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');

  // Security hold appears after eligibility and reservation.
  runtime.orgState.createHold({
    hold_id: 'hold-001', job_id: job.envelope.job_id, hold_class: 'SECURITY',
    issuer: 'PIXEL-SECURITY', reason_code: 'INCIDENT',
  });
  const confirmation = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id,
    requirement: baseRequirement(),
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.reason_code, 'START_REJECTED_HOLD');
  assert.equal(runtime.jobs.get(job.envelope.job_id).current_state, 'ACCEPTED');
});

test('a stale eligibility result is not a reusable authorization token', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const evaluation = await eligible(runtime, job);
  const reserved = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });

  // Company state degrades to Survival after the ELIGIBLE decision.
  runtime.orgState.setCompanyState({ inputs: [{ state: 'SURVIVAL', ref: 'facility' }] });
  const confirmation = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id,
    requirement: baseRequirement(),
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.reason_code, 'START_REJECTED_COMPANY_STATE');
});

test('release and cancellation are revision-guarded and one-way', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const evaluation = await eligible(runtime, job);
  const reserved = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });

  // Wrong revision cannot release.
  const stale = runtime.scheduler.release({
    reservation_id: reserved.reservation.reservation_id,
    expected_revision: 99,
  });
  assert.equal(stale.disposition, 'STALE_REVISION');
  assert.equal(stale.reservation.state, 'ACTIVE');

  const released = runtime.scheduler.release({
    reservation_id: reserved.reservation.reservation_id,
    expected_revision: 1,
  });
  assert.equal(released.disposition, 'RELEASED');
  // A released reservation cannot be released twice or cancelled.
  const again = runtime.scheduler.release({
    reservation_id: reserved.reservation.reservation_id,
    expected_revision: 2,
  });
  assert.equal(again.disposition, 'REJECTED');
  const cancelled = runtime.schedulerStore.transition(reserved.reservation.reservation_id, {
    toState: 'CANCELLED', now: '2026-09-12T12:00:00.000Z', expectedRevision: 2,
  });
  assert.equal(cancelled.disposition, 'REJECTED');
});

test('a non-existent reservation cannot be confirmed', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const confirmation = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id,
    requirement: baseRequirement(),
    reservation_id: 'reservation-absent',
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.reason_code, 'START_REJECTED_RESERVATION');
});

test('reservation IDs are unique across many allocations', async () => {
  const runtime = schedulerRuntime();
  const ids = new Set();
  for (let index = 0; index < 24; index += 1) {
    const job = withJob(runtime, { jobId: `job-${String(index).padStart(3, '0')}` });
    // Distinct resources per evaluation so all reservations may activate; the
    // reserved resource is always the resource the evaluation assessed.
    const resourceRef = `simulation.exclusive.slot-${index}`;
    const requirement = baseRequirement({
      resource_ref: resourceRef,
      resource: { ...baseRequirement().resource, ref: resourceRef },
    });
    const evaluation = await eligible(runtime, job, requirement);
    const reserved = runtime.scheduler.reserve({
      evaluation: evaluation.evaluation, job_id: job.envelope.job_id,
    });
    assert.equal(reserved.disposition, 'RESERVED');
    assert.equal(ids.has(reserved.reservation.reservation_id), false);
    ids.add(reserved.reservation.reservation_id);
  }
  assert.equal(ids.size, 24);
});
