import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_ID, CAPABILITY, baseRequirement, canonicalJob, createClock,
  seedActiveWorkforce, workforceRuntime,
} from '../helpers/px009-runtime.js';

function capabilityRequirement(capability = CAPABILITY) {
  return baseRequirement({
    authority: { kind: 'simulated-capability-grant', ref: capability, revision: 1, status: 'ALLOW', expires_at: null, environment: 'simulation' },
  });
}

function runtime() {
  const r = workforceRuntime();
  seedActiveWorkforce(r);
  return r;
}

async function eligible(r, { workerId = AGENT_ID } = {}) {
  const job = canonicalJob({ workerId });
  r.jobs.set(job.envelope.job_id, job);
  const requirement = capabilityRequirement();
  const evaluated = await r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(evaluated.disposition, 'ELIGIBLE');
  const reserved = r.scheduler.reserve({ evaluation: evaluated.evaluation, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');
  return { job, requirement, reserved };
}

test('stage two re-reads Workforce: a lifecycle downgrade to INACTIVE blocks start', async () => {
  const r = runtime();
  const { job, requirement, reserved } = await eligible(r);
  const changed = r.workforce.changeLifecycle({
    agent_id: AGENT_ID, lifecycle_status: 'INACTIVE', expected_revision: 1, operation_id: 'op-downgrade',
  });
  assert.equal(changed.disposition, 'RECORDED');
  const confirmed = await r.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id, requirement,
    reservation_id: reserved.reservation.reservation_id, expected_job_revision: job.job_revision,
  });
  assert.equal(confirmed.confirmed, false);
  assert.equal(confirmed.reason_code, 'START_REJECTED_WORKFORCE');
  assert.equal(job.current_state, 'ACCEPTED');
});

test('stage two re-reads Workforce: a qualification downgrade blocks start', async () => {
  const r = runtime();
  const { job, requirement, reserved } = await eligible(r);
  const changed = r.workforce.changeQualification({
    qualification_id: `qualification-${AGENT_ID}`, qualification_status: 'UNQUALIFIED',
    expected_revision: 1, operation_id: 'op-qual-downgrade',
  });
  assert.equal(changed.disposition, 'RECORDED');
  const confirmed = await r.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id, requirement,
    reservation_id: reserved.reservation.reservation_id, expected_job_revision: job.job_revision,
  });
  assert.equal(confirmed.confirmed, false);
  assert.equal(confirmed.reason_code, 'START_REJECTED_WORKFORCE');
});

test('a stale reservation cannot bypass a workforce downgrade', async () => {
  const r = runtime();
  const { job, requirement, reserved } = await eligible(r);
  r.workforce.changeLifecycle({ agent_id: AGENT_ID, lifecycle_status: 'RETIRED', expected_revision: 1, operation_id: 'op-retire' });
  // Re-running stage one must already deny; the reservation cannot be reused.
  const rechecked = await r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(rechecked.disposition, 'DENY');
  assert.equal(rechecked.evaluation.reason_code, 'DENY_WORKFORCE');
  const confirmed = await r.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id, requirement,
    reservation_id: reserved.reservation.reservation_id, expected_job_revision: job.job_revision,
  });
  assert.equal(confirmed.confirmed, false);
  assert.equal(confirmed.reason_code, 'START_REJECTED_WORKFORCE');
});

test('Duty State remains independent from workforce lifecycle', async () => {
  const r = runtime();
  r.orgState.setDuty({ duty_id: 'duty-001', agent_id: AGENT_ID, duty: 'OFF_DUTY' });
  const { result } = await (async () => {
    const job = canonicalJob({ workerId: AGENT_ID });
    r.jobs.set(job.envelope.job_id, job);
    return { result: await r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: capabilityRequirement() }) };
  })();
  assert.equal(result.disposition, 'WAIT');
  assert.equal(result.evaluation.reason_code, 'WAIT_OFF_DUTY');
  // Duty change never altered the workforce record or qualification.
  assert.equal(r.workforce.getRecord(AGENT_ID).lifecycle_status, 'ACTIVE');
  assert.equal(r.workforce.getQualification(AGENT_ID, CAPABILITY).qualification_status, 'QUALIFIED');
});

test('Capacity remains independent from workforce qualification', async () => {
  const r = runtime();
  r.orgState.setCapacity({ capacity_id: 'capacity-001', resource_ref: 'simulation.exclusive.status-check', capacity: 'SATURATED' });
  const job = canonicalJob({ workerId: AGENT_ID });
  r.jobs.set(job.envelope.job_id, job);
  const result = await r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: capabilityRequirement() });
  assert.equal(result.disposition, 'WAIT');
  assert.equal(result.evaluation.reason_code, 'WAIT_CAPACITY');
  assert.equal(r.workforce.getRecord(AGENT_ID).lifecycle_status, 'ACTIVE');
});

test('an Access ALLOW cannot override workforce ineligibility', async () => {
  const r = workforceRuntime();
  seedActiveWorkforce(r, { lifecycle: 'INACTIVE' });
  const job = canonicalJob({ workerId: AGENT_ID });
  r.jobs.set(job.envelope.job_id, job);
  // The requirement authority is explicitly ALLOW; workforce still denies.
  const requirement = capabilityRequirement();
  assert.equal(requirement.authority.status, 'ALLOW');
  const result = await r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_WORKFORCE');
});

test('Workforce eligibility cannot manufacture Access ALLOW', async () => {
  const r = runtime();
  const job = canonicalJob({ workerId: AGENT_ID });
  r.jobs.set(job.envelope.job_id, job);
  const denied = await r.scheduler.evaluate({
    job_id: job.envelope.job_id,
    requirement: capabilityRequirement().authority
      ? { ...capabilityRequirement(), authority: { ...capabilityRequirement().authority, status: 'MISSING' } }
      : capabilityRequirement(),
  });
  assert.equal(denied.disposition, 'DENY');
  assert.equal(denied.evaluation.reason_code, 'DENY_AUTHORITY_MISSING');
});

test('AgentOps WATCH alone never denies work or mutates lifecycle', async () => {
  const r = runtime();
  r.workforce.recordEvidence({
    evidence_id: 'evidence-fail', agent_id: AGENT_ID, subject_ref: 'job-old', dimension: 'QUALITY',
    observation: 'FAIL', source_ref: 'sensor.rack-01', operation_id: 'op-evidence',
  });
  const evaluated = r.workforce.evaluateAgentOps({ evaluation_id: 'eval-1', agent_id: AGENT_ID, operation_id: 'op-eval' });
  assert.equal(evaluated.record.evaluation_state, 'WATCH');
  assert.equal(r.workforce.getRecord(AGENT_ID).lifecycle_status, 'ACTIVE');
  const job = canonicalJob({ workerId: AGENT_ID });
  r.jobs.set(job.envelope.job_id, job);
  const result = await r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: capabilityRequirement() });
  assert.equal(result.disposition, 'ELIGIBLE');
});

test('the Workforce projection is bound to the exact requested capability', async () => {
  const r = runtime();
  seedActiveWorkforce(r, { capability: CAPABILITY });
  // The job envelope is the canonical capability source: a different admitted
  // capability must be evaluated against its own qualification, not the
  // qualified one, and a caller-supplied requirement cannot redirect it.
  const otherJob = canonicalJob({ jobId: 'job-raw', workerId: AGENT_ID });
  otherJob.envelope.requested_capability = 'pixel.system-status.raw.read';
  otherJob.envelope.execution.capability = 'pixel.system-status.raw.read';
  r.jobs.set(otherJob.envelope.job_id, otherJob);
  const other = await r.scheduler.evaluate({ job_id: otherJob.envelope.job_id, requirement: capabilityRequirement('pixel.system-status.raw.read') });
  assert.equal(other.disposition, 'WAIT');
  assert.equal(other.evaluation.reason_code, 'WAIT_QUALIFICATION');
  // A mismatched requirement cannot substitute the qualified capability.
  const mismatched = await r.scheduler.evaluate({ job_id: otherJob.envelope.job_id, requirement: capabilityRequirement(CAPABILITY) });
  assert.equal(mismatched.disposition, 'DENY');
  assert.equal(mismatched.evaluation.reason_code, 'DENY_AUTHORITY_MISSING');
});

test('Access authority for another capability cannot authorize the Relay capability', async () => {
  const r = runtime();
  assert.equal(r.workforce.createQualification({
    qualification_id: 'qualification-raw', agent_id: AGENT_ID,
    capability: 'pixel.system-status.raw.read', qualification_status: 'QUALIFIED',
    source_ref: 'academy.result-raw', operation_id: 'op-qualify-raw',
  }).disposition, 'RECORDED');
  const job = canonicalJob({ jobId: 'job-raw-authority', workerId: AGENT_ID });
  job.envelope.requested_capability = 'pixel.system-status.raw.read';
  job.envelope.execution.capability = 'pixel.system-status.raw.read';
  r.jobs.set(job.envelope.job_id, job);
  const result = await r.scheduler.evaluate({
    job_id: job.envelope.job_id, requirement: capabilityRequirement(CAPABILITY),
  });
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_AUTHORITY_MISSING');
});
