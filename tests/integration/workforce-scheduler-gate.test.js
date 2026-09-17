import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_ID, CAPABILITY, baseRequirement, canonicalJob, createClock, evaluateOrdinary,
  seedActiveWorkforce, workforceRuntime,
} from '../helpers/px009-runtime.js';

function requirementWithCapability(capability, overrides = {}) {
  return baseRequirement({
    authority: {
      kind: 'simulated-capability-grant',
      ref: capability,
      revision: 1,
      status: 'ALLOW',
      expires_at: null,
      environment: 'simulation',
    },
    ...overrides,
  });
}

function activeRuntime() {
  const r = workforceRuntime();
  seedActiveWorkforce(r);
  return r;
}

test('existing agent_id remains the identity across a runtime/model replacement', async () => {
  const r = activeRuntime();
  const before = r.workforce.getRecord(AGENT_ID);
  // Two distinct real evaluations over separate runtime executions: Workforce
  // observes both jobs yet never mints a new identity or revision from
  // runtime/model activity, which only changes the model envelope it ignores.
  const first = await evaluateOrdinary(r, { job: canonicalJob({ workerId: AGENT_ID }) });
  const second = await evaluateOrdinary(r, { job: canonicalJob({ jobId: 'job-002', workerId: AGENT_ID }) });
  assert.equal(first.result.disposition, 'ELIGIBLE');
  assert.equal(second.result.disposition, 'ELIGIBLE');
  const after = r.workforce.getRecord(AGENT_ID);
  assert.equal(after.agent_id, before.agent_id);
  assert.equal(after.revision, before.revision);
});

test('ACTIVE + QUALIFIED passes the Workforce gate when every other gate allows', async () => {
  const r = activeRuntime();
  const { result } = await evaluateOrdinary(r);
  assert.equal(result.disposition, 'ELIGIBLE');
  assert.equal(result.evaluation.reason_code, 'ELIGIBLE_NOW');
});

test('CANDIDATE, INACTIVE, and RETIRED are globally ineligible for ordinary work', async () => {
  for (const lifecycle of ['CANDIDATE', 'INACTIVE', 'RETIRED']) {
    const r = workforceRuntime();
    seedActiveWorkforce(r, { lifecycle });
    const { result } = await evaluateOrdinary(r);
    assert.equal(result.disposition, 'DENY', lifecycle);
    assert.equal(result.evaluation.reason_code, 'DENY_WORKFORCE', lifecycle);
  }
});

test('LIMITED and RETRAINING keep unrelated QUALIFIED capabilities eligible', async () => {
  for (const lifecycle of ['LIMITED', 'RETRAINING']) {
    const r = workforceRuntime();
    seedActiveWorkforce(r, { lifecycle });
    const { result } = await evaluateOrdinary(r);
    assert.equal(result.disposition, 'ELIGIBLE', lifecycle);
  }
});

test('the requested capability must be QUALIFIED for LIMITED/RETRAINING lifecycles', async () => {
  for (const [lifecycle, qualification] of [
    ['LIMITED', 'LIMITED'],
    ['RETRAINING', 'RETRAINING'],
    ['ACTIVE', 'UNQUALIFIED'],
    ['ACTIVE', 'LIMITED'],
    ['ACTIVE', 'RETRAINING'],
  ]) {
    const r = workforceRuntime();
    seedActiveWorkforce(r, { lifecycle, qualification });
    const { result } = await evaluateOrdinary(r);
    assert.equal(result.disposition, 'WAIT', `${lifecycle}/${qualification}`);
    assert.equal(result.evaluation.reason_code, 'WAIT_QUALIFICATION', `${lifecycle}/${qualification}`);
  }
});

test('missing, expired, and unrelated capabilities fail closed', async () => {
  const missing = workforceRuntime();
  seedActiveWorkforce(missing, { capability: 'other.capability' });
  const absent = await evaluateOrdinary(missing);
  assert.equal(absent.result.disposition, 'WAIT');
  assert.equal(absent.result.evaluation.reason_code, 'WAIT_QUALIFICATION');

  const clock = createClock();
  const expired = workforceRuntime({ clock });
  seedActiveWorkforce(expired);
  expired.workforce.changeQualification({
    qualification_id: `qualification-${AGENT_ID}`, qualification_status: 'QUALIFIED',
    expires_at: '2026-09-12T13:00:00.000Z', expected_revision: 1, operation_id: 'op-expire',
  });
  clock.set('2026-09-12T13:00:00.000Z');
  const expiredResult = await evaluateOrdinary(expired);
  assert.equal(expiredResult.result.disposition, 'WAIT');
  assert.equal(expiredResult.result.evaluation.reason_code, 'WAIT_QUALIFICATION');
});

test('a configured Workforce seam that throws or returns malformed facts fails closed', async () => {
  const modes = [
    { workforceFactsFor: () => { throw new Error('seam down'); } },
    { workforceFactsFor: () => null },
    { workforceFactsFor: () => ({ agent_id: AGENT_ID, lifecycle_status: 'ACTIVE' }) },
    { workforceFactsFor: () => ({ agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', qualification_status: 'QUALIFIED', capability: CAPABILITY, evaluation_state: 'NORMAL', qualification_expires_at: null, observed_at: '2026-09-12T12:00:00.000Z', revision_token: 'nope' }) },
    { workforceFactsFor: () => ({ agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', qualification_status: 'QUALIFIED', capability: CAPABILITY, evaluation_state: 'NORMAL', qualification_expires_at: null, observed_at: '2026-09-12T12:00:00.000Z', revision_token: 'a'.repeat(64), extra: 'debris' }) },
  ];
  for (const seam of modes) {
    const r = workforceRuntime();
    r.orgState = new (await import('../../services/organizational-state/src/org-state-service.js')).OrganizationalStateService({
      environment: 'simulation', store: r.orgStore, evidence: r.evidence, ids: r.ids,
      clock: () => r.clock.now(), workforce: seam,
    });
    const rebuilt = new (await import('../../services/scheduler/src/scheduler-service.js')).SchedulerService({
      environment: 'simulation', orgState: r.orgState, jobs: { source: 'simulator', getJob: (id) => r.jobs.get(id) ?? null },
      store: r.schedulerStore, evidence: r.evidence, ids: r.ids, clock: () => r.clock.now(),
    });
    const job = canonicalJob({ workerId: AGENT_ID });
    r.jobs.set(job.envelope.job_id, job);
    const result = await rebuilt.evaluate({ job_id: job.envelope.job_id, requirement: requirementWithCapability(CAPABILITY) });
    assert.equal(result.disposition, 'DENY');
    assert.equal(result.evaluation.reason_code, 'DENY_WORKFORCE');
  }
});

test('a workforce agent mismatch with the Relay worker fails closed', async () => {
  const r = workforceRuntime();
  seedActiveWorkforce(r, { agentId: AGENT_ID });
  const job = canonicalJob({ workerId: 'PIXEL-OTHER-WORKER-01' });
  r.jobs.set(job.envelope.job_id, job);
  const result = await r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: requirementWithCapability(CAPABILITY) });
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_WORKFORCE');
});

test('unbound workforce mode (workforce === null) remains the deliberate opt-out', async () => {
  const r = workforceRuntime();
  // No workforce record: the projection is null, which fails closed by design.
  const { result } = await evaluateOrdinary(r);
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_WORKFORCE');
});
