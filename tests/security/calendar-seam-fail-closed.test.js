import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorOrgStateStoreAdapter } from '../../adapters/simulator/src/org-state-store-simulator-adapter.js';
import { SimulatorSchedulerStoreAdapter } from '../../adapters/simulator/src/scheduler-store-simulator-adapter.js';
import { OrganizationalStateService } from '../../services/organizational-state/src/org-state-service.js';
import { SchedulerService } from '../../services/scheduler/src/scheduler-service.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { baseRequirement, canonicalJob, createClock, createIds, jobLookup } from '../helpers/px006-runtime.js';

function brokenCalendar(mode) {
  return {
    activeCalendarFacts: () => {
      if (mode === 'throw') throw new Error('calendar unavailable');
      if (mode === 'malformed') return { available: true, calendar_state: 'NOT_A_STATE', active_event_refs: [] };
      if (mode === 'unavailable') return { available: false, calendar_state: null, active_event_refs: [] };
      return null;
    },
  };
}

function seamRuntime({ mode, calendar } = {}) {
  const clock = createClock();
  const ids = createIds(60_000);
  const evidence = new EvidenceRecorder({ clock: () => clock.now() });
  const orgStore = new SimulatorOrgStateStoreAdapter();
  const schedulerStore = new SimulatorSchedulerStoreAdapter();
  const orgState = new OrganizationalStateService({
    environment: 'simulation', store: orgStore, evidence, ids, clock: () => clock.now(),
    calendar: calendar || brokenCalendar(mode),
  });
  const jobs = new Map();
  const scheduler = new SchedulerService({
    environment: 'simulation', orgState, jobs: jobLookup(jobs), store: schedulerStore,
    evidence, ids, clock: () => clock.now(),
  });
  return { orgState, scheduler, jobs, clock };
}

for (const mode of ['throw', 'malformed', 'unavailable']) {
  test(`configured calendar seam that ${mode} fails closed for eligible ordinary work`, async () => {
    const { scheduler, jobs, orgState } = seamRuntime({ mode });
    const job = canonicalJob();
    jobs.set(job.envelope.job_id, job);
    const result = await scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
    assert.equal(result.disposition, 'WAIT');
    assert.equal(result.evaluation.reason_code, 'WAIT_DEPENDENCY');
    assert.equal(orgState.evaluateExecutionInputs({ job, requirement: baseRequirement() }).calendar_seam_unavailable, true);
    assert.equal(job.current_state, 'ACCEPTED');
  });
}

test('calendar === null remains the deliberate opt-out for ordinary work', async () => {
  const clock = createClock();
  const ids = createIds(60_001);
  const evidence = new EvidenceRecorder({ clock: () => clock.now() });
  const orgStore = new SimulatorOrgStateStoreAdapter();
  const schedulerStore = new SimulatorSchedulerStoreAdapter();
  const orgState = new OrganizationalStateService({
    environment: 'simulation', store: orgStore, evidence, ids, clock: () => clock.now(),
    calendar: null,
  });
  const jobs = new Map();
  const scheduler = new SchedulerService({
    environment: 'simulation', orgState, jobs: jobLookup(jobs), store: schedulerStore,
    evidence, ids, clock: () => clock.now(),
  });
  const job = canonicalJob();
  jobs.set(job.envelope.job_id, job);
  const result = await scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(result.disposition, 'ELIGIBLE');
  const inputs = orgState.evaluateExecutionInputs({ job, requirement: baseRequirement() });
  assert.equal(inputs.calendar_seam_unavailable, false);
  assert.equal(inputs.calendar_state, null);
});

// Real Calendar seam through Organizational State: transition between Scheduler
// stage 1 and stage 2 blocks the unsafe start (live re-read at stage 2).
test('calendar transition between Scheduler stage 1 and stage 2 blocks unsafe start', async () => {
  const { defaultCompanyHours } = await import('../helpers/px008-runtime.js');
  const runtime = await import('../helpers/px008-runtime.js').then((m) => m.calendarRuntime());
  runtime.calendar.setCompanyHours(defaultCompanyHours());
  runtime.clock.set('2026-09-14T19:59:59.000Z');
  assert.equal(runtime.calendar.createEvent({
    calendar_event_id: 'event-stage2', event_class: 'MAINTENANCE_WINDOW',
    starts_at: '2026-09-14T20:00:00.000Z', ends_at: '2026-09-14T23:00:00.000Z',
    timezone: 'America/New_York', summary_code: 'STAGE2_WINDOW',
  }).disposition, 'RECORDED');
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const requirement = baseRequirement();
  const evaluated = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(evaluated.disposition, 'ELIGIBLE');
  const reserved = runtime.scheduler.reserve({ evaluation: evaluated.evaluation, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');
  // Maintenance window begins before stage 2.
  runtime.clock.advance(1000);
  const confirmed = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id,
    requirement,
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmed.confirmed, false);
  assert.equal(confirmed.reason_code, 'START_REJECTED_COMPANY_STATE');
  assert.equal(job.current_state, 'ACCEPTED');
});

for (const [label, change] of [
  ['unsupported state', f => ({ ...f, calendar_state: 'SURVIVAL' })],
  ['missing observation', f => ({ ...f, observed_at: undefined })],
  ['invalid timezone', f => ({ ...f, company_timezone: 'Not/AZone' })],
  ['offset timezone', f => ({ ...f, company_timezone: '+01:00' })],
  ['missing revision', f => ({ ...f, revision_token: null })],
  ['malformed event ref', f => ({ ...f, active_event_refs: ['bad ref'] })],
  ['oversized event ref', f => ({ ...f, active_event_refs: ['a'.repeat(161)] })],
  ['duplicate event refs', f => ({ ...f, active_event_refs: ['event-1', 'event-1'] })],
  ['oversized projection', f => ({ ...f, active_event_refs: Array.from({ length: 65 }, (_, i) => `event-${i}`) })],
  ['sparse event refs', f => ({ ...f, active_event_refs: new Array(1) })],
  ['unbacked holiday', f => ({ ...f, calendar_state: 'HOLIDAY' })],
  ['authority debris', f => ({ ...f, allowed: true })],
  ['Promise', f => Promise.resolve(f)],
]) {
  test(`untrusted Calendar projection (${label}) discards facts and blocks stage two`, async () => {
    const good = { available: true, observed_at: '2026-09-12T12:00:00.000Z', company_hours_id: 'hours-1',
      company_timezone: 'UTC', calendar_state: 'NORMAL', active_event_refs: [], revision_token: 'a'.repeat(64) };
    let facts = good;
    const r = seamRuntime({ calendar: { activeCalendarFacts: () => facts } });
    const job = canonicalJob(); r.jobs.set(job.envelope.job_id, job);
    const requirement = baseRequirement();
    const before = await r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
    assert.equal(before.disposition, 'ELIGIBLE');
    const reserved = r.scheduler.reserve({ evaluation: before.evaluation, job_id: job.envelope.job_id });
    facts = change(good);
    const inputs = r.orgState.evaluateExecutionInputs({ job, requirement });
    assert.equal(inputs.calendar_seam_unavailable, true);
    assert.equal(inputs.calendar_state, null);
    assert.deepEqual(inputs.calendar_event_refs, []);
    const after = await r.scheduler.confirmExecutionStart({ job_id: job.envelope.job_id, requirement,
      reservation_id: reserved.reservation.reservation_id, expected_job_revision: job.job_revision });
    assert.equal(after.confirmed, false);
    assert.equal(after.reason_code, 'START_REJECTED_DEPENDENCY');
    assert.equal(job.current_state, 'ACCEPTED');
  });
}
