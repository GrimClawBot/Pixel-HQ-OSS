import assert from 'node:assert/strict';
import test from 'node:test';

import { calendarRuntime, defaultCompanyHours, baseEvent } from '../helpers/px008-runtime.js';
import { baseRequirement, canonicalJob, createClock } from '../helpers/px006-runtime.js';
import { SimulatorOrgStateStoreAdapter } from '../../adapters/simulator/src/org-state-store-simulator-adapter.js';
import { OrganizationalStateService } from '../../services/organizational-state/src/org-state-service.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { createIds } from '../helpers/px006-runtime.js';

async function evaluateOrdinary(runtime) {
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  return runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
}

function withCompanyHours(clock) {
  const runtime = calendarRuntime({ clock });
  runtime.calendar.setCompanyHours(defaultCompanyHours());
  return runtime;
}

test('NORMAL during business hours allows ordinary work', async () => {
  const clock = createClock();
  const runtime = withCompanyHours(clock);
  clock.set('2026-09-14T15:00:00.000Z'); // Monday 11:00 EDT
  const result = await evaluateOrdinary(runtime);
  assert.equal(result.disposition, 'ELIGIBLE');
  assert.equal(runtime.calendar.operatingFactsAt().calendar_state, 'NORMAL');
});

test('NIGHT outside hours waits with canonical reason', async () => {
  const clock = createClock();
  const runtime = withCompanyHours(clock);
  clock.set('2026-09-14T03:00:00.000Z'); // Monday 23:00 EDT
  const result = await evaluateOrdinary(runtime);
  assert.equal(result.disposition, 'WAIT');
  assert.equal(result.evaluation.reason_code, 'WAIT_NIGHT');
});

test('HOLIDAY waits with WAIT_HOLIDAY', async () => {
  const clock = createClock();
  const runtime = withCompanyHours(clock);
  runtime.calendar.createEvent(baseEvent({
    calendar_event_id: 'event-holiday',
    event_class: 'COMPANY_HOLIDAY',
    starts_at: '2026-09-14T00:00:00.000Z',
    ends_at: '2026-09-15T00:00:00.000Z',
  }));
  clock.set('2026-09-14T15:00:00.000Z');
  const result = await evaluateOrdinary(runtime);
  assert.equal(result.disposition, 'WAIT');
  assert.equal(result.evaluation.reason_code, 'WAIT_HOLIDAY');
});

test('MAINTENANCE waits with WAIT_MAINTENANCE', async () => {
  const clock = createClock();
  const runtime = withCompanyHours(clock);
  runtime.calendar.createEvent(baseEvent({
    calendar_event_id: 'event-maint',
    event_class: 'MAINTENANCE_WINDOW',
    starts_at: '2026-09-14T12:00:00.000Z',
    ends_at: '2026-09-14T22:00:00.000Z',
  }));
  clock.set('2026-09-14T15:00:00.000Z');
  const result = await evaluateOrdinary(runtime);
  assert.equal(result.disposition, 'WAIT');
  assert.equal(result.evaluation.reason_code, 'WAIT_MAINTENANCE');
});

test('PX-007 incident outranks planned calendar states', async () => {
  const clock = createClock();
  const runtime = withCompanyHours(clock);
  runtime.calendar.createEvent(baseEvent({
    calendar_event_id: 'event-holiday',
    event_class: 'COMPANY_HOLIDAY',
    starts_at: '2026-09-14T00:00:00.000Z',
    ends_at: '2026-09-15T00:00:00.000Z',
  }));
  const ids = createIds(55_000);
  const evidence = new EvidenceRecorder({ clock: () => clock.now() });
  const orgStore = new SimulatorOrgStateStoreAdapter();
  const orgState = new OrganizationalStateService({
    environment: 'simulation', store: orgStore, evidence, ids, clock: () => clock.now(),
    calendar: runtime.calendar,
    incidents: {
      activeIncidentFacts: () => [{
        incident_id: 'incident-sev0', incident_class: 'POWER', severity: 'SEV-0',
        status: 'OPEN', affected_resource_refs: [],
      }],
    },
  });
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const rebuilt = new (await import('../../services/scheduler/src/scheduler-service.js')).SchedulerService({
    environment: 'simulation', orgState, jobs: { source: 'simulator', getJob: (id) => runtime.jobs.get(id) ?? null },
    store: runtime.schedulerStore, evidence, ids, clock: () => clock.now(),
  });
  clock.set('2026-09-14T15:00:00.000Z');
  const result = await rebuilt.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(result.evaluation.company_state, 'SURVIVAL');
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_COMPANY_STATE');
});
