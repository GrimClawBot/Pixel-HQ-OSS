import assert from 'node:assert/strict';
import test from 'node:test';

import { baseRequirement, canonicalJob, createClock } from '../helpers/px006-runtime.js';
import { px007Runtime, incidentInput } from '../helpers/px007-runtime.js';
import { assessSchedulerTraceCompleteness } from '../../packages/telemetry/src/scheduler-trace-completeness.js';

test('an incident arriving between Scheduler stage 1 and stage 2 blocks unsafe start', async () => {
  const { clock, scheduler, jobs, incidentService } = px007Runtime();
  const job = canonicalJob();
  jobs.set(job.envelope.job_id, job);
  const requirement = baseRequirement();
  const evaluated = await scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(evaluated.disposition, 'ELIGIBLE');
  const reserved = scheduler.reserve({ evaluation: evaluated.evaluation, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');
  // SEV-0 incident arrives between stage 1 and stage 2.
  incidentService.createIncident(incidentInput({
    incident_id: 'incident-arrival', severity: 'SEV-0', operation_id: 'op-arrival',
  }));
  const confirmed = await scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id,
    requirement,
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmed.confirmed, false);
  assert.equal(confirmed.reason_code, 'START_REJECTED_COMPANY_STATE');
  // No Relay lifecycle state changed by the Scheduler.
  assert.equal(jobs.get(job.envelope.job_id).current_state, 'ACCEPTED');
});

test('a bound containment/survival route can be confirmed at stage 2 under SURVIVAL', async () => {
  const { scheduler, jobs, incidentService, evidence } = px007Runtime();
  const job = canonicalJob();
  jobs.set(job.envelope.job_id, job);
  incidentService.createIncident(incidentInput({
    incident_id: 'incident-sev0', severity: 'SEV-0', operation_id: 'op-sev0',
  }));
  const requirement = baseRequirement({
    execution_safety_class: 'SURVIVAL_CRITICAL',
    incident_ref: 'incident-sev0',
  });
  const evaluated = await scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(evaluated.disposition, 'ELIGIBLE');
  assert.equal(evaluated.evaluation.company_state, 'SURVIVAL');
  const reserved = scheduler.reserve({ evaluation: evaluated.evaluation, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');
  const confirmed = await scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id,
    requirement,
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.reason_code, 'START_CONFIRMED');
});

test('ordinary work remains denied at stage 2 after a SEV-1 security incident', async () => {
  const { scheduler, jobs, incidentService } = px007Runtime();
  const job = canonicalJob();
  jobs.set(job.envelope.job_id, job);
  incidentService.createIncident(incidentInput({
    incident_id: 'incident-sec1', incident_class: 'SECURITY', severity: 'SEV-1', operation_id: 'op-sec1',
  }));
  const requirement = baseRequirement();
  const evaluated = await scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(evaluated.disposition, 'DENY');
  assert.equal(evaluated.evaluation.reason_code, 'DENY_COMPANY_STATE');
  assert.equal(jobs.get(job.envelope.job_id).current_state, 'ACCEPTED');
});

test('scheduler evidence families stay complete and bounded across incident stage-two rejection', async () => {
  const { clock, scheduler, jobs, incidentService, evidence } = px007Runtime();
  const job = canonicalJob();
  jobs.set(job.envelope.job_id, job);
  const requirement = baseRequirement();
  const evaluated = await scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  const reserved = scheduler.reserve({ evaluation: evaluated.evaluation, job_id: job.envelope.job_id });
  incidentService.createIncident(incidentInput({
    incident_id: 'incident-arrival', severity: 'SEV-0', operation_id: 'op-arrival',
  }));
  const confirmed = await scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id,
    requirement,
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmed.confirmed, false);
  const schedulerTraceIds = new Set(evidence.all()
    .filter(({ service_name: serviceName }) => serviceName === 'pixel.scheduler')
    .map(({ trace_id: id }) => id));
  for (const traceId of schedulerTraceIds) {
    const assessment = assessSchedulerTraceCompleteness(evidence.forTrace(traceId));
    assert.equal(assessment.complete, true, `${traceId}: ${JSON.stringify(assessment.errors)}`);
  }
});
