import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_ID, CAPABILITY, baseRequirement, canonicalJob, createClock, seedActiveWorkforce, workforceRuntime,
} from '../helpers/px009-runtime.js';
import { OrganizationalStateService } from '../../services/organizational-state/src/org-state-service.js';
import { SchedulerService } from '../../services/scheduler/src/scheduler-service.js';

function requirement(capability = CAPABILITY) {
  return baseRequirement({
    authority: { kind: 'simulated-capability-grant', ref: capability, revision: 1, status: 'ALLOW', expires_at: null, environment: 'simulation' },
  });
}

function runtimeWithSeam(seam, { seed = true } = {}) {
  const r = workforceRuntime();
  if (seed) seedActiveWorkforce(r);
  const orgState = new OrganizationalStateService({
    environment: 'simulation', store: r.orgStore, evidence: r.evidence, ids: r.ids,
    clock: () => r.clock.now(), workforce: seam,
  });
  const scheduler = new SchedulerService({
    environment: 'simulation', orgState,
    jobs: { source: 'simulator', getJob: (id) => r.jobs.get(id) ?? null },
    store: r.schedulerStore, evidence: r.evidence, ids: r.ids, clock: () => r.clock.now(),
  });
  return { ...r, orgState, scheduler };
}

async function evaluate(r, job) {
  r.jobs.set(job.envelope.job_id, job);
  return r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: requirement() });
}

test('configured workforce seam throw fails closed', async () => {
  const r = runtimeWithSeam({ source: 'simulator', workforceFactsFor: () => { throw new Error('down'); } });
  const result = await evaluate(r, canonicalJob({ workerId: AGENT_ID }));
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_WORKFORCE');
});

test('malformed projection values fail closed', async () => {
  const projection = {
    agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', qualification_status: 'QUALIFIED', capability: CAPABILITY,
    evaluation_state: 'NORMAL', qualification_expires_at: null, observed_at: '2026-09-12T12:00:00.000Z', revision_token: 'a'.repeat(64),
  };
  const cases = [
    ['unknown lifecycle', { ...projection, lifecycle_status: 'GOD_MODE' }],
    ['missing qualification field', { ...projection, qualification_status: undefined }],
    ['bad revision token', { ...projection, revision_token: 'not-a-hash' }],
    ['extra field', { ...projection, extra: 'debris' }],
    ['bad evaluation state', { ...projection, evaluation_state: 'PUNISH' }],
    ['no capability', { ...projection, capability: null }],
  ];
  for (const [label, facts] of cases) {
    const r = runtimeWithSeam({ source: 'simulator', workforceFactsFor: () => facts });
    const result = await evaluate(r, canonicalJob({ workerId: AGENT_ID }));
    assert.equal(result.disposition, 'DENY', label);
    assert.equal(result.evaluation.reason_code, 'DENY_WORKFORCE', label);
  }
});

test('missing workforce record, agent mismatch, and missing qualification all fail closed', async () => {
  const absent = workforceRuntime();
  const absentResult = await evaluate(absent, canonicalJob({ workerId: AGENT_ID }));
  assert.equal(absentResult.disposition, 'DENY');
  assert.equal(absentResult.evaluation.reason_code, 'DENY_WORKFORCE');

  const mismatch = workforceRuntime();
  seedActiveWorkforce(mismatch, { agentId: AGENT_ID });
  const mismatchResult = await evaluate(mismatch, canonicalJob({ workerId: 'PIXEL-UNKNOWN-WORKER-01' }));
  assert.equal(mismatchResult.disposition, 'DENY');
  assert.equal(mismatchResult.evaluation.reason_code, 'DENY_WORKFORCE');

  const missingQualification = workforceRuntime();
  seedActiveWorkforce(missingQualification, { capability: 'other.capability' });
  const missingResult = await evaluate(missingQualification, canonicalJob({ workerId: AGENT_ID }));
  assert.equal(missingResult.disposition, 'WAIT');
  assert.equal(missingResult.evaluation.reason_code, 'WAIT_QUALIFICATION');
});

test('a projection claiming another agent id fails closed even when lifecycle looks valid', async () => {
  const r = workforceRuntime();
  seedActiveWorkforce(r);
  const spoofed = { source: 'simulator', workforceFactsFor: () => ({
    agent_id: 'PIXEL-OTHER-01', lifecycle_status: 'ACTIVE', qualification_status: 'QUALIFIED', capability: CAPABILITY,
    evaluation_state: 'NORMAL', qualification_expires_at: null, observed_at: '2026-09-12T12:00:00.000Z', revision_token: 'a'.repeat(64),
  }) };
  const sealed = runtimeWithSeam(spoofed);
  const result = await evaluate(sealed, canonicalJob({ workerId: AGENT_ID }));
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_WORKFORCE');
});

test('caller authority cannot replace a missing Relay requested capability', async () => {
  const r = workforceRuntime();
  seedActiveWorkforce(r);
  const job = canonicalJob({ workerId: AGENT_ID });
  delete job.envelope.requested_capability;
  const result = await evaluate(r, job);
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_WORKFORCE');
});

test('a seam cannot revive an expired qualification by claiming QUALIFIED', async () => {
  const seam = { source: 'simulator', workforceFactsFor: () => ({
    agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', qualification_status: 'QUALIFIED', capability: CAPABILITY,
    evaluation_state: 'NORMAL', qualification_expires_at: '2026-09-12T11:59:59.000Z',
    observed_at: '2026-09-12T11:00:00.000Z', revision_token: 'a'.repeat(64),
  }) };
  const r = runtimeWithSeam(seam);
  const result = await evaluate(r, canonicalJob({ workerId: AGENT_ID }));
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_WORKFORCE');
});

test('workforce === null remains the deliberate Alpha opt-out (no workforce gate applied)', async () => {
  const r = workforceRuntime();
  const orgState = new OrganizationalStateService({
    environment: 'simulation', store: r.orgStore, evidence: r.evidence, ids: r.ids,
    clock: () => r.clock.now(), workforce: null,
  });
  const scheduler = new SchedulerService({
    environment: 'simulation', orgState,
    jobs: { source: 'simulator', getJob: (id) => r.jobs.get(id) ?? null },
    store: r.schedulerStore, evidence: r.evidence, ids: r.ids, clock: () => r.clock.now(),
  });
  const job = canonicalJob({ workerId: AGENT_ID });
  r.jobs.set(job.envelope.job_id, job);
  const result = await scheduler.evaluate({ job_id: job.envelope.job_id, requirement: requirement() });
  assert.equal(result.disposition, 'ELIGIBLE');
});

test('malformed workforce mutation inputs never throw across the service boundary', () => {
  const r = workforceRuntime();
  seedActiveWorkforce(r);
  const cyclic = {}; cyclic.self = cyclic;
  const getter = Object.defineProperty({}, 'agent_id', { enumerable: true, get() { throw new Error('getter'); } });
  const sparse = new Array(2);
  for (const debris of [undefined, null, 7, 'x', [], cyclic, getter, sparse, { agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', operation_id: {} }]) {
    assert.doesNotThrow(() => assert.equal(r.workforce.changeLifecycle(debris).disposition, 'REJECTED'));
    assert.doesNotThrow(() => assert.equal(r.workforce.changeQualification(debris).disposition, 'REJECTED'));
    assert.doesNotThrow(() => assert.equal(r.workforce.recordEvidence(debris).disposition, 'REJECTED'));
    assert.doesNotThrow(() => assert.equal(r.workforce.recordAttribution(debris).disposition, 'REJECTED'));
    assert.doesNotThrow(() => assert.equal(r.workforce.evaluateAgentOps(debris).disposition, 'REJECTED'));
  }
});

test('Trusted Time rollback cannot revive an expired qualification through the seam', async () => {
  const clock = createClock();
  const r = workforceRuntime({ clock });
  seedActiveWorkforce(r);
  r.workforce.changeQualification({
    qualification_id: `qualification-${AGENT_ID}`, qualification_status: 'QUALIFIED',
    expires_at: '2026-09-12T13:00:00.000Z', expected_revision: 1, operation_id: 'op-expire',
  });
  clock.set('2026-09-12T13:00:00.000Z');
  const job = canonicalJob({ workerId: AGENT_ID });
  r.jobs.set(job.envelope.job_id, job);
  const expired = await r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: requirement() });
  assert.equal(expired.disposition, 'WAIT');
  assert.equal(expired.evaluation.reason_code, 'WAIT_QUALIFICATION');
  clock.set('2026-09-12T09:00:00.000Z');
  const afterRollback = await r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: requirement() });
  assert.equal(afterRollback.disposition, 'WAIT');
  assert.equal(afterRollback.evaluation.reason_code, 'WAIT_QUALIFICATION');
});

test('no new Relay lifecycle states are introduced by workforce outcomes', async () => {
  const r = workforceRuntime();
  seedActiveWorkforce(r, { lifecycle: 'INACTIVE' });
  const job = canonicalJob({ workerId: AGENT_ID });
  r.jobs.set(job.envelope.job_id, job);
  const result = await r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: requirement() });
  assert.equal(result.disposition, 'DENY');
  assert.equal(job.current_state, 'ACCEPTED');
  assert.ok(['SUBMITTED', 'ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED'].includes(job.current_state));
});

test('workforce evaluation never invokes a worker, tool, or model hidden path', async () => {
  const r = workforceRuntime();
  seedActiveWorkforce(r);
  const before = r.evidence.all().length;
  const job = canonicalJob({ workerId: AGENT_ID });
  r.jobs.set(job.envelope.job_id, job);
  await r.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: requirement() });
  // Workforce emits bounded scheduler/org-state evidence but never executes
  // anything; the Relay job remains accepted with no execution id.
  assert.equal(job.execution_id, null);
  assert.equal(job.current_state, 'ACCEPTED');
  assert.ok(r.evidence.all().length >= before);
});
