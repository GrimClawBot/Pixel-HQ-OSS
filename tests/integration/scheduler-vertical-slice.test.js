import assert from 'node:assert/strict';
import test from 'node:test';

import { baseRequirement, canonicalJob, createClock, RESOURCE, schedulerRuntime } from '../helpers/px006-runtime.js';

function withJob(runtime, overrides = {}) {
  const job = canonicalJob(overrides);
  runtime.jobs.set(job.envelope.job_id, job);
  return job;
}

test('normal, on-duty, available work with no hold and valid authority is ELIGIBLE', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });

  assert.equal(result.disposition, 'ELIGIBLE');
  assert.equal(result.evaluation.decision, 'ELIGIBLE');
  assert.equal(result.evaluation.reason_code, 'ELIGIBLE_NOW');
  assert.equal(result.evaluation.job_revision, job.job_revision);
  assert.equal(Object.isFrozen(result.evaluation), true);
});

test('saturated capacity is WAIT_CAPACITY and the job stays ACCEPTED with no RUNNING evidence', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  runtime.orgStore.put('capacity', {
    capacity_id: 'capacity-001', event_name: 'pixel.org-state.capacity.v1', schema_version: '1.0.0',
    revision: 1, updated_at: '2026-09-12T12:00:00.000Z', resource_ref: RESOURCE, capacity: 'SATURATED',
    provenance: { org_state_contract: 'pixel.organizational-state.v1' },
  });
  const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });

  assert.equal(result.disposition, 'WAIT');
  assert.equal(result.evaluation.reason_code, 'WAIT_CAPACITY');
  assert.equal(runtime.jobs.get(job.envelope.job_id).current_state, 'ACCEPTED');
  assert.equal(runtime.evidence.all().some(({ event_name }) => event_name === 'relay.job.running'), false);
});

test('off-duty employee is WAIT_OFF_DUTY', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  runtime.orgStore.put('duty', {
    duty_id: 'duty-001', event_name: 'pixel.org-state.duty.v1', schema_version: '1.0.0',
    revision: 1, updated_at: '2026-09-12T12:00:00.000Z', agent_id: 'PIXEL-SYSTEMS-WORKER-01', duty: 'OFF_DUTY',
    provenance: { org_state_contract: 'pixel.organizational-state.v1' },
  });
  const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });

  assert.equal(result.disposition, 'WAIT');
  assert.equal(result.evaluation.reason_code, 'WAIT_OFF_DUTY');
});

test('required approval that is missing is WAIT_APPROVAL, never optimistic allow', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const result = await runtime.scheduler.evaluate({
    job_id: job.envelope.job_id,
    requirement: baseRequirement({ requires_approval: true, approval_id: 'approval-absent' }),
  });

  assert.equal(result.disposition, 'WAIT');
  assert.equal(result.evaluation.reason_code, 'WAIT_APPROVAL');
});

test('an approved, unexpired approval allows eligibility and its ID is recorded', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const created = runtime.orgState.createApproval({
    approval_id: 'approval-001', job_id: job.envelope.job_id, action_type: 'model-summary',
    scope: 'one bounded job', requested_by: 'PIXEL-PRINCIPAL', required_authority: 'owner',
    expires_at: '2026-09-12T18:00:00.000Z',
  });
  assert.equal(created.disposition, 'RECORDED');
  const decided = runtime.orgState.decideApproval({
    approval_id: 'approval-001', expected_revision: 1, status: 'APPROVED', approver_identity: 'PIXEL-PRINCIPAL',
  });
  assert.equal(decided.disposition, 'RECORDED');

  const result = await runtime.scheduler.evaluate({
    job_id: job.envelope.job_id,
    requirement: baseRequirement({ requires_approval: true, approval_id: 'approval-001' }),
  });
  assert.equal(result.disposition, 'ELIGIBLE');
  assert.equal(result.evaluation.approval_id, 'approval-001');
});

test('a security hold produces HOLD_SECURITY without failing the job', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const hold = runtime.orgState.createHold({
    hold_id: 'hold-001', job_id: job.envelope.job_id, hold_class: 'SECURITY',
    issuer: 'PIXEL-SECURITY', reason_code: 'INCIDENT',
  });
  assert.equal(hold.disposition, 'RECORDED');

  const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(result.disposition, 'HOLD');
  assert.equal(result.evaluation.reason_code, 'HOLD_SECURITY');
  assert.equal(result.evaluation.hold_id, 'hold-001');
  assert.equal(runtime.jobs.get(job.envelope.job_id).current_state, 'ACCEPTED');
});

test('an expired delegation is DENY_DELEGATION_INVALID', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  runtime.orgState.grantDelegation({
    grant_id: 'grant-001', grantor: 'PIXEL-PRINCIPAL', grantee: 'PIXEL-SYSTEMS-WORKER-01',
    capability: 'pixel.system-status.read', scope: 'system status', environment: 'simulation',
    valid_from: '2026-09-12T08:00:00.000Z', expires_at: '2026-09-12T09:00:00.000Z',
  });

  const result = await runtime.scheduler.evaluate({
    job_id: job.envelope.job_id,
    requirement: baseRequirement({ requires_delegation: true, delegation_id: 'grant-001' }),
  });
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_DELEGATION_INVALID');
});

test('a valid delegation for this grantee and environment allows eligibility', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  runtime.orgState.grantDelegation({
    grant_id: 'grant-002', grantor: 'PIXEL-PRINCIPAL', grantee: 'PIXEL-SYSTEMS-WORKER-01',
    capability: 'pixel.system-status.read', scope: 'system status', environment: 'simulation',
    valid_from: '2026-09-12T08:00:00.000Z', expires_at: '2026-09-12T18:00:00.000Z',
  });

  const result = await runtime.scheduler.evaluate({
    job_id: job.envelope.job_id,
    requirement: baseRequirement({ requires_delegation: true, delegation_id: 'grant-002' }),
  });
  assert.equal(result.disposition, 'ELIGIBLE');
  assert.equal(result.evaluation.delegation_id, 'grant-002');
});

test('Survival company state denies ordinary work with DENY_COMPANY_STATE', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  runtime.orgState.setCompanyState({ inputs: [{ state: 'SURVIVAL', ref: 'facilities-power' }] });

  const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_COMPANY_STATE');
  assert.equal(result.evaluation.company_state, 'SURVIVAL');
});

test('client-supplied company state cannot force a lower-precedence value over Survival', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  runtime.orgState.setCompanyState({ inputs: [{ state: 'SURVIVAL', ref: 'facility' }] });
  // A later write that only names NORMAL cannot silently downgrade the
  // canonical SURVIVAL record: precedence protection refuses it unless the
  // write explicitly carries the prior cause as resolved evidence.
  const forced = runtime.orgState.setCompanyState({ inputs: [{ state: 'NORMAL', ref: 'client' }] });
  assert.equal(forced.disposition, 'REJECTED');
  assert.equal(forced.reason_code, 'COMPANY_STATE_DOWNGRADE');
  assert.equal(runtime.orgState.companyState().state, 'SURVIVAL');
  // Precedence still yields the highest state when a write names both facts;
  // an explicit resolution carrying the prior cause may lower it deliberately.
  const resolved = runtime.orgState.setCompanyState({
    inputs: [{ state: 'NORMAL', ref: 'facility' }, { state: 'NORMAL', ref: 'client' }],
  });
  assert.equal(resolved.disposition, 'RECORDED');
  assert.equal(resolved.record.state, 'NORMAL');
  runtime.orgState.setCompanyState({ inputs: [{ state: 'SURVIVAL', ref: 'facility' }] });
  const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(result.evaluation.company_state, 'SURVIVAL');
  assert.equal(result.disposition, 'DENY');
});

test('missing authority fails closed with DENY_AUTHORITY_MISSING', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const requirement = baseRequirement();
  requirement.authority = { ...requirement.authority, status: 'MISSING' };

  const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_AUTHORITY_MISSING');
});

test('an environment mismatch is DENY_ENVIRONMENT', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const result = await runtime.scheduler.evaluate({
    job_id: job.envelope.job_id,
    requirement: baseRequirement({ resource_ref: 'simulation.exclusive.status-check' }),
  });
  assert.equal(result.disposition, 'ELIGIBLE');

  // Same job id, but evaluated with a different environment scheduler runtime.
  const other = schedulerRuntime({ environment: 'dev' });
  other.jobs.set(job.envelope.job_id, job);
  const result2 = await other.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(result2.disposition, 'DENY');
  assert.equal(result2.evaluation.reason_code, 'DENY_ENVIRONMENT');
});

test('not-before timing produces WAIT_NOT_BEFORE until the instant passes', async () => {
  const clock = createClock('2026-09-12T12:00:00.000Z');
  const runtime = schedulerRuntime({ clock });
  const job = withJob(runtime);
  const requirement = baseRequirement({ not_before: '2026-09-12T12:10:00.000Z' });

  const early = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(early.evaluation.reason_code, 'WAIT_NOT_BEFORE');

  clock.set('2026-09-12T12:10:00.000Z');
  const atTime = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(atTime.disposition, 'ELIGIBLE');
});

test('dependency PENDING waits, BLOCKED and FAILED deny', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  for (const [status, decision, reason] of [
    ['PENDING', 'WAIT', 'WAIT_DEPENDENCY'],
    ['UNKNOWN', 'WAIT', 'WAIT_DEPENDENCY'],
    ['BLOCKED', 'WAIT', 'WAIT_DEPENDENCY'],
    ['FAILED', 'DENY', 'DENY_RESOURCE_INELIGIBLE'],
    ['COMPLETE', 'ELIGIBLE', 'ELIGIBLE_NOW'],
  ]) {
    const result = await runtime.scheduler.evaluate({
      job_id: job.envelope.job_id,
      requirement: baseRequirement({
        dependency: { kind: 'parent-job', ref: 'job-parent', revision: 1, status, expires_at: null, environment: null },
      }),
    });
    assert.equal(result.disposition, decision, status);
    assert.equal(result.evaluation.reason_code, reason, status);
  }
});

test('unknown or unavailable resource health fails closed', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  for (const status of ['UNKNOWN', 'UNAVAILABLE']) {
    const result = await runtime.scheduler.evaluate({
      job_id: job.envelope.job_id,
      requirement: baseRequirement({
        resource: { kind: 'exclusive-slot', ref: RESOURCE, revision: 1, status, expires_at: null, environment: null },
      }),
    });
    assert.equal(result.disposition, 'DENY', status);
    assert.equal(result.evaluation.reason_code, 'DENY_RESOURCE_INELIGIBLE', status);
  }
});

test('maintenance, holiday, and night states wait with distinct planned-state reasons', async () => {
  const expected = {
    MAINTENANCE: 'WAIT_MAINTENANCE',
    HOLIDAY: 'WAIT_HOLIDAY',
    NIGHT: 'WAIT_NIGHT',
  };
  for (const state of Object.keys(expected)) {
    const runtime = schedulerRuntime();
    const job = withJob(runtime);
    runtime.orgState.setCompanyState({ inputs: [{ state, ref: 'calendar' }] });
    const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
    assert.equal(result.disposition, 'WAIT', state);
    assert.equal(result.evaluation.reason_code, expected[state], state);
  }
});

test('unknown or malformed job input is DENY_INPUT_INVALID', async () => {
  const runtime = schedulerRuntime();
  const missing = await runtime.scheduler.evaluate({ job_id: 'job-absent', requirement: baseRequirement() });
  assert.equal(missing.disposition, 'DENY');
  assert.equal(missing.evaluation.reason_code, 'DENY_INPUT_INVALID');

  const job = withJob(runtime);
  const badRequirement = await runtime.scheduler.evaluate({
    job_id: job.envelope.job_id,
    requirement: { ...baseRequirement(), rogue_authority: 'ALLOW' },
  });
  assert.equal(badRequirement.disposition, 'DENY');
  assert.equal(badRequirement.evaluation.reason_code, 'DENY_INPUT_INVALID');
});

test('scheduler cannot select models: evaluation carries no model/provider/runtime fields', async () => {
  const runtime = schedulerRuntime();
  const job = withJob(runtime);
  const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  const serialized = JSON.stringify(result.evaluation);
  assert.equal(/model|provider|runtime|placement/i.test(serialized), false);
});
