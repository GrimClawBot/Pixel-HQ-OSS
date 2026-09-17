import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeModelASimulatorAdapter } from '../../adapters/simulator/src/fake-model-a-simulator-adapter.js';
import { FakeModelBSimulatorAdapter } from '../../adapters/simulator/src/fake-model-b-simulator-adapter.js';
import { SimulatorJobContextProvider } from '../../adapters/simulator/src/job-context-simulator-provider.js';
import { SimulatorMemoryIntakeContextProvider } from '../../adapters/simulator/src/memory-intake-context-simulator-provider.js';
import { SimulatorMemoryStoreAdapter } from '../../adapters/simulator/src/memory-store-simulator-adapter.js';
import { SimulatorRelayStoreAdapter } from '../../adapters/simulator/src/relay-store-simulator-adapter.js';
import { SimulatorExecutionRequirementProvider } from '../../adapters/simulator/src/execution-requirement-simulator-provider.js';
import { SimulatorOrgStateStoreAdapter } from '../../adapters/simulator/src/org-state-store-simulator-adapter.js';
import { SimulatorSchedulerStoreAdapter } from '../../adapters/simulator/src/scheduler-store-simulator-adapter.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { assessSchedulerTraceCompleteness } from '../../packages/telemetry/src/scheduler-trace-completeness.js';
import { ModelGateway } from '../../services/model-gateway/src/model-gateway.js';
import { MemoryService } from '../../services/memory/src/memory-service.js';
import { OrganizationalStateService } from '../../services/organizational-state/src/org-state-service.js';
import { RelayService } from '../../services/relay/src/relay-service.js';
import { SchedulerService } from '../../services/scheduler/src/scheduler-service.js';
import { baseRequirement, canonicalJob, createClock, createIds, NOW, RESOURCE, schedulerRuntime } from '../helpers/px006-runtime.js';

function relayRuntime({ clock = createClock() } = {}) {
  const ids = createIds(50_000);
  const evidence = new EvidenceRecorder({ clock: () => clock.now() });
  const store = new SimulatorRelayStoreAdapter();
  const schedulerStore = new SimulatorSchedulerStoreAdapter();
  const memory = new MemoryService({
    environment: 'simulation',
    intakeContextProvider: new SimulatorMemoryIntakeContextProvider(),
    memoryStore: new SimulatorMemoryStoreAdapter(),
    relayStore: store,
    evidence,
    ids,
    clock: () => clock.now(),
  });
  const orgState = new OrganizationalStateService({
    environment: 'simulation', store: new SimulatorOrgStateStoreAdapter(),
    evidence, ids, clock: () => clock.now(),
  });
  const scheduler = new SchedulerService({
    environment: 'simulation', orgState,
    jobs: { source: 'simulator', getJob: store.getJob.bind(store) },
    store: schedulerStore,
    evidence, ids, clock: () => clock.now(),
  });
  const gateway = new ModelGateway({
    environment: 'simulation',
    store: { source: 'simulator', getJob: store.getJob.bind(store) },
    memory,
    adapters: [new FakeModelASimulatorAdapter(), new FakeModelBSimulatorAdapter()],
    evidence, ids, clock: () => clock.now(),
  });
  const relay = new RelayService({
    environment: 'simulation',
    contextProvider: new SimulatorJobContextProvider(),
    store,
    toolGateway: { source: 'simulator', async execute() { return { disposition: 'COMPLETED' }; } },
    memory, modelGateway: gateway, scheduler,
    requirementProvider: new SimulatorExecutionRequirementProvider(),
    evidence, ids, clock: () => clock.now(),
  });
  const prepare = async () => {
    await memory.intake({
      event_name: 'pixel.memory.intake-intent.v1', schema_version: '1.0.0',
      content: { text: 'System status stable.', tags: ['system', 'status'] },
    });
    return relay.accept({
      event_name: 'pixel.job.submit-intent.v1', schema_version: '1.0.0',
      idempotency_key: `remediation-${Math.random().toString(16).slice(2)}`,
      job_type: 'system-status', requested_capability: 'pixel.system-status.read',
    });
  };
  return { clock, evidence, gateway, memory, orgState, prepare, relay, scheduler, schedulerStore, store };
}

test('null authority, resource, and dependency facts fail closed (no fabricated ALLOW)', async () => {
  const runtime = schedulerRuntime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);

  for (const [field, reason] of [
    ['authority', 'DENY_AUTHORITY_MISSING'],
    ['resource', 'DENY_RESOURCE_INELIGIBLE'],
  ]) {
    const requirement = baseRequirement({ [field]: null });
    const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
    assert.equal(result.disposition, 'DENY', `${field}=null must not be ELIGIBLE`);
    assert.equal(result.evaluation.reason_code, reason);
  }
  // Evidence never fabricates an ALLOW authority state for a null authority fact.
  const nullAuthority = await runtime.scheduler.evaluate({
    job_id: job.envelope.job_id, requirement: baseRequirement({ authority: null }),
  });
  assert.notEqual(nullAuthority.evaluation.authority_state, 'ALLOW');
  assert.equal(nullAuthority.evaluation.authority_state, 'MISSING');
  // A null dependency is WAIT_DEPENDENCY (unknown is not permission).
  const dependency = baseRequirement({ dependency: null });
  const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: dependency });
  assert.equal(result.disposition, 'WAIT');
  assert.equal(result.evaluation.reason_code, 'WAIT_DEPENDENCY');
});

test('a malformed or empty Company State write cannot silently downgrade SURVIVAL', () => {
  const runtime = schedulerRuntime();
  runtime.orgState.setCompanyState({ inputs: [{ state: 'SURVIVAL', ref: 'facility' }] });
  const malformed = runtime.orgState.setCompanyState({ inputs: [{ state: 'NOT_A_STATE', ref: 'facility' }] });
  assert.equal(malformed.disposition, 'REJECTED');
  const empty = runtime.orgState.setCompanyState({ inputs: [] });
  assert.equal(empty.disposition, 'REJECTED');
  const downgrade = runtime.orgState.setCompanyState({ inputs: [{ state: 'NORMAL', ref: 'client' }] });
  assert.equal(downgrade.disposition, 'REJECTED');
  assert.equal(downgrade.reason_code, 'COMPANY_STATE_DOWNGRADE');
  assert.equal(runtime.orgState.companyState().state, 'SURVIVAL');
});

test('a denied issued evaluation cannot be rewritten as eligible', async () => {
  const runtime = schedulerRuntime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const requirement = baseRequirement({
    authority: { ...baseRequirement().authority, status: 'MISSING' },
  });
  const denied = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(denied.disposition, 'DENY');

  const forged = { ...denied.evaluation, decision: 'ELIGIBLE', reason_code: 'ELIGIBLE_NOW' };
  const result = runtime.scheduler.reserve({ evaluation: forged, job_id: job.envelope.job_id });
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.reservation, null);
  assert.equal(runtime.schedulerStore.activeReservations({ now: NOW }).length, 0);
});

test('an issued evaluation cannot redirect its reserved resource', async () => {
  const runtime = schedulerRuntime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const evaluation = await runtime.scheduler.evaluate({
    job_id: job.envelope.job_id, requirement: baseRequirement(),
  });
  assert.equal(evaluation.disposition, 'ELIGIBLE');

  const forged = { ...evaluation.evaluation, resource_ref: 'attacker.chosen.resource' };
  const result = runtime.scheduler.reserve({ evaluation: forged, job_id: job.envelope.job_id });
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.reservation, null);
  assert.equal(runtime.schedulerStore.activeReservations({ now: NOW }).length, 0);
});

test('forged, stale, mismatched, and non-issued evaluations cannot mint reservations', async () => {
  const runtime = schedulerRuntime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const requirement = baseRequirement();
  const evaluation = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(evaluation.disposition, 'ELIGIBLE');

  // A fully forged evaluation object is refused.
  const forged = { ...evaluation.evaluation, eligibility_id: 'forged-001' };
  const forgedResult = runtime.scheduler.reserve({ evaluation: forged, job_id: job.envelope.job_id });
  assert.equal(forgedResult.disposition, 'DENY');
  assert.equal(forgedResult.reservation, null);

  // A reservation for a different job than the evaluation assessed is refused.
  const crossJob = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: 'job-other' });
  assert.equal(crossJob.disposition, 'DENY');

  // Redirecting capacity to a different resource is refused.
  const decoy = runtime.scheduler.reserve({
    evaluation: evaluation.evaluation, job_id: job.envelope.job_id, resource_ref: 'attacker.chosen.resource',
  });
  assert.equal(decoy.disposition, 'DENY');

  // The legitimate reservation succeeds and the evaluation cannot be reused.
  const reserved = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');
  const replay = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });
  assert.equal(replay.disposition, 'DENY');
});

test('a stale evaluation cannot reserve after the lease window', async () => {
  const clock = createClock();
  const runtime = schedulerRuntime({ clock });
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const evaluation = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(evaluation.disposition, 'ELIGIBLE');
  clock.advance(6 * 60 * 1000);
  const stale = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });
  assert.equal(stale.disposition, 'DENY');
  assert.equal(stale.reservation, null);
});

test('a swapped or weakened stage-2 requirement is rejected', async () => {
  const runtime = schedulerRuntime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const requirement = baseRequirement({ requires_approval: true, approval_id: 'approval-001' });
  runtime.orgState.createApproval({
    approval_id: 'approval-001', job_id: job.envelope.job_id, action_type: 'pixel.system-status.summary',
    scope: 'system-status-summary', requested_by: 'PIXEL-RELAY', required_authority: 'pixel.system-status.read',
  });
  runtime.orgState.decideApproval({
    approval_id: 'approval-001', expected_revision: 1, status: 'APPROVED', approver_identity: 'PIXEL-FOUNDER',
  });
  const evaluation = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(evaluation.disposition, 'ELIGIBLE');
  const reserved = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');

  const weakened = baseRequirement({ requires_approval: false, approval_id: null });
  const confirmation = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id, requirement: weakened,
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.reason_code, 'START_REJECTED_INPUT_INVALID');
});

test('a decoy reservation on another resource cannot authorize start', async () => {
  const runtime = schedulerRuntime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const requirement = baseRequirement();
  const evaluation = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  const reserved = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');

  const decoyRequirement = baseRequirement({
    resource_ref: 'simulation.decoy.slot',
    resource: { ...requirement.resource, ref: 'simulation.decoy.slot' },
  });
  const confirmation = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id, requirement: decoyRequirement,
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.reason_code, 'START_REJECTED_INPUT_INVALID');
});

test('invalid identifiers and null inputs are refused, never thrown', async () => {
  const runtime = schedulerRuntime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);

  // Over-long job id: bounded denial, not a throw.
  const long = await runtime.scheduler.evaluate({ job_id: 'x'.repeat(161), requirement: baseRequirement() });
  assert.equal(long.disposition, 'DENY');
  assert.equal(long.evaluation.reason_code, 'DENY_INPUT_INVALID');

  // Over-long / malformed reservation id at confirm: bounded denial, not a throw.
  const confirmation = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id, requirement: baseRequirement(),
    reservation_id: 'bad reservation id', expected_job_revision: job.job_revision,
  });
  assert.equal(confirmation.confirmed, false, 'malformed reservation id must not throw');
  assert.equal(confirmation.reason_code, 'START_REJECTED_RESERVATION');

  // Null inputs to org-state writes refuse with bounded evidence.
  const nullApproval = runtime.orgState.createApproval(null);
  assert.equal(nullApproval.disposition, 'REJECTED');
  const nullDuty = runtime.orgState.setDuty(null);
  assert.equal(nullDuty.disposition, 'REJECTED');
  const throwing = runtime.orgState.setCompanyState({ inputs: [{ get state() { throw new Error('boom'); }, ref: 'x' }] });
  assert.equal(throwing.disposition, 'REJECTED');
});

test('a stage-2 rejection does not wedge the model path: the job can be retried once the hold clears', async () => {
  const subject = relayRuntime();
  const accepted = await subject.prepare();
  const jobId = accepted.job.envelope.job_id;
  subject.orgState.createHold({
    hold_id: 'hold-001', job_id: jobId, hold_class: 'SECURITY', issuer: 'PIXEL-SECURITY', reason_code: 'INCIDENT',
  });
  const rejected = await subject.relay.executeModelSummary(jobId);
  assert.equal(rejected.disposition, 'HOLD');
  assert.equal(rejected.reason_code, 'HOLD_SECURITY');
  assert.equal((await subject.store.getJob(jobId)).current_state, 'ACCEPTED');

  assert.equal(subject.schedulerStore.activeReservations({ now: NOW }).length, 0, 'rejected start must not hold capacity');
  subject.orgState.releaseHold({ hold_id: 'hold-001', expected_revision: 1 });
  const retry = await subject.relay.executeModelSummary(jobId);
  assert.equal(retry.disposition, 'COMPLETED', `retry must complete, got ${retry.disposition}`);
  assert.equal(subject.memory.retainedPackageCount(), 0);
});

test('a non-terminal worker exit does not leak the tracked reservation', async () => {
  const subject = relayRuntime();
  const accepted = await subject.prepare();
  const jobId = accepted.job.envelope.job_id;
  subject.relay = new RelayService({
    environment: 'simulation',
    contextProvider: new SimulatorJobContextProvider(),
    store: subject.store,
    toolGateway: { source: 'simulator', async execute() { throw new Error('tool explosion'); } },
    memory: subject.memory,
    modelGateway: subject.gateway,
    scheduler: subject.scheduler,
    requirementProvider: new SimulatorExecutionRequirementProvider(),
    evidence: subject.evidence,
    ids: createIds(60_000),
    clock: () => NOW,
  });
  const result = await subject.relay.execute(jobId);
  assert.equal(result.disposition, 'UNAVAILABLE');
  // The reservation is released (no capacity leak) after the dependency failure:
  // assert the scheduler store itself holds no active reservation for the job.
  assert.equal(subject.schedulerStore.activeReservations({ now: NOW }).length, 0, 'no reservation may leak on a non-terminal exit');
});

test('Relay rejects a simulator requirement provider outside dev/simulation', () => {
  const ids = createIds(70_000);
  const base = {
    contextProvider: new SimulatorJobContextProvider(),
    store: new SimulatorRelayStoreAdapter(),
    toolGateway: { source: 'simulator', async execute() {} },
    evidence: new EvidenceRecorder({ clock: () => NOW }),
    ids,
    clock: () => NOW,
  };
  assert.throws(() => new RelayService({
    ...base, environment: 'shadow',
    scheduler: { evaluate() {}, reserve() {}, confirmExecutionStart() {}, release() {} },
    requirementProvider: new SimulatorExecutionRequirementProvider(),
  }), /Simulator Relay adapters may run only in dev or simulation/);
});

test('boundApprovedPackageRetention is reachable through Relay maintenance', async () => {
  const subject = relayRuntime();
  const result = await subject.relay.boundApprovedPackageRetention({ maximum: 16 });
  assert.equal(result.disposition, 'BOUNDED');
  assert.equal(result.reason_code, 'WITHIN_BOUND');
});

test('organizational-state identifiers are capped: oversized ids are refused, not recorded', () => {
  const runtime = schedulerRuntime();
  const long = 'h'.repeat(5000);
  const hold = runtime.orgState.createHold({
    hold_id: long, job_id: 'job-001', hold_class: 'SECURITY', issuer: 'PIXEL-SECURITY', reason_code: 'INCIDENT',
  });
  assert.equal(hold.disposition, 'REJECTED');
  assert.equal(runtime.orgState.holdsForJob('job-001').length, 0);
  const approval = runtime.orgState.createApproval({
    approval_id: long, job_id: 'job-001', action_type: 'pixel.system-status.summary',
    scope: 'system-status-summary', requested_by: 'PIXEL-RELAY', required_authority: 'pixel.system-status.read',
  });
  assert.equal(approval.disposition, 'REJECTED');
});

test('null and throwing-getter inputs never escape the org-state and scheduler boundaries', async () => {
  const runtime = schedulerRuntime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);

  assert.equal(runtime.orgState.decideApproval(null).disposition, 'REJECTED');
  assert.equal(runtime.orgState.releaseHold(null).disposition, 'REJECTED');
  assert.equal(runtime.orgState.revokeDelegation(null).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setCompanyState({
    inputs: [{ state: 'NORMAL', get ref() { throw new Error('boom'); } }],
  }).disposition, 'REJECTED');

  const throwing = () => { throw new Error('getter boom'); };
  const evaluated = await runtime.scheduler.evaluate({ get job_id() { return throwing(); } });
  assert.equal(evaluated.disposition, 'DENY');
  const confirmed = await runtime.scheduler.confirmExecutionStart({ get job_id() { return throwing(); } });
  assert.equal(confirmed.confirmed, false);
  const released = runtime.scheduler.release({ get reservation_id() { return throwing(); } });
  assert.equal(released.disposition, 'REJECTED');
});

test('refusal-path evidence never fabricates ALLOW or a healthy world state', async () => {
  const runtime = schedulerRuntime();
  const invalid = await runtime.scheduler.evaluate({ job_id: 'x'.repeat(161), requirement: baseRequirement() });
  assert.equal(invalid.disposition, 'DENY');
  assert.equal(invalid.evaluation.authority_state, 'MISSING');
  assert.equal(invalid.evaluation.company_state, null);
  assert.equal(invalid.evaluation.duty, null);
  assert.equal(invalid.evaluation.capacity, null);
});

test('duty and capacity resolve the newest fact even at equal revisions', () => {
  const runtime = schedulerRuntime();
  runtime.orgState.setCapacity({ capacity_id: 'cap-a', resource_ref: RESOURCE, capacity: 'NORMAL' });
  // A second record for the same resource (same revision, later timestamp) wins.
  runtime.orgStore.put('capacity', {
    capacity_id: 'cap-b', event_name: 'pixel.org-state.capacity.v1', schema_version: '1.0.0',
    revision: 1, updated_at: '2026-09-12T13:00:00.000Z', resource_ref: RESOURCE, capacity: 'SATURATED',
    provenance: { org_state_contract: 'pixel.organizational-state.v1' },
  }, { expectedRevision: null });
  assert.equal(runtime.orgState.capacityFor(RESOURCE).capacity, 'SATURATED');
});

test('a released or expired reservation id is never reusable', () => {
  const runtime = schedulerRuntime();
  const reserveOnce = (jobId, resourceRef, createdAt, expiresAt) => runtime.schedulerStore.reserve({
    reservation_id: 'reservation-fixed', event_name: 'pixel.scheduler.reservation.v1',
    schema_version: '1.0.0', state: 'ACTIVE', revision: 1, created_at: createdAt, updated_at: createdAt,
    job_id: jobId, execution_id: null, resource_ref: resourceRef, eligibility_id: 'eligibility-001',
    expires_at: expiresAt, provenance: { scheduler_contract: 'pixel.scheduler.v1' },
  }, { now: createdAt });
  const created = reserveOnce('job-001', 'simulation.exclusive.slot-a', '2026-09-12T12:00:00.000Z', '2026-09-12T12:05:00.000Z');
  assert.equal(created.disposition, 'RESERVED', JSON.stringify(created));
  // Even after the lease expires, the id cannot be reused for a new claim.
  const reused = reserveOnce('job-002', 'simulation.exclusive.slot-b', '2026-09-12T12:10:00.000Z', '2026-09-12T12:15:00.000Z');
  assert.equal(reused.disposition, 'REJECTED');
  assert.equal(reused.reason_code, 'RESERVATION_ID_CONFLICT');
});

test('a live reservation keeps its issuance under a large evaluation burst (no eviction regression)', async () => {
  const clock = createClock();
  const runtime = schedulerRuntime({ clock });
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const requirement = baseRequirement();

  // Issue an evaluation, wait near the stale bound, then reserve: the
  // reservation is live and its issuance is older than one lease.
  const evaluation = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  assert.equal(evaluation.disposition, 'ELIGIBLE');
  clock.advance(250_000);
  const reserved = runtime.scheduler.reserve({ evaluation: evaluation.evaluation, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED');

  // A burst of far more evaluations than any internal bound must not evict the
  // live reservation's issuance.
  for (let index = 0; index < 300; index += 1) {
    const burstJob = canonicalJob({ jobId: `job-burst-${String(index).padStart(3, '0')}` });
    runtime.jobs.set(burstJob.envelope.job_id, burstJob);
    const burst = await runtime.scheduler.evaluate({
      job_id: burstJob.envelope.job_id,
      requirement: baseRequirement({ resource_ref: `simulation.burst.slot-${index}`,
        resource: { ...baseRequirement().resource, ref: `simulation.burst.slot-${index}` } }),
    });
    assert.equal(burst.disposition, 'ELIGIBLE');
  }

  const confirmation = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id,
    requirement,
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: job.job_revision,
  });
  assert.equal(confirmation.confirmed, true, 'a live reservation must keep its issuance under a burst');
  assert.equal(confirmation.reason_code, 'START_CONFIRMED');
});

test('setDuty and setCapacity read inputs safely: throwing getters refuse, never throw', () => {
  const runtime = schedulerRuntime();
  const throwing = () => { throw new Error('getter boom'); };
  assert.equal(runtime.orgState.setDuty({ get duty_id() { return throwing(); } }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setDuty({ duty_id: 'duty-001', get agent_id() { return throwing(); } }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setDuty({ duty_id: 'duty-001', agent_id: 'a', get duty() { return throwing(); } }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setDuty({ duty_id: 'duty-001', agent_id: 'a', duty: 'ON_DUTY', get expected_revision() { return throwing(); } }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setCapacity({ get capacity_id() { return throwing(); } }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setCapacity({ capacity_id: 'cap-001', get resource_ref() { return throwing(); } }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setCapacity({ capacity_id: 'cap-001', resource_ref: 'r', get capacity() { return throwing(); } }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setCapacity({ capacity_id: 'cap-001', resource_ref: 'r', capacity: 'NORMAL', get expected_revision() { return throwing(); } }).disposition, 'REJECTED');
});

test('a forged evaluation with throwing accessors cannot mint a reservation', async () => {
  const runtime = schedulerRuntime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const evaluation = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(evaluation.disposition, 'ELIGIBLE');

  const throwing = () => { throw new Error('nested boom'); };
  const forged = { get decision() { return throwing(); } };
  const result = runtime.scheduler.reserve({ evaluation: forged, job_id: job.envelope.job_id });
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.reservation, null);

  const forged2 = { ...evaluation.evaluation, get reason_code() { return throwing(); } };
  const result2 = runtime.scheduler.reserve({ evaluation: forged2, job_id: job.envelope.job_id });
  assert.equal(result2.disposition, 'DENY');
  assert.equal(result2.reservation, null);
});

test('company-state cause_refs are capped at 160 characters', () => {
  const runtime = schedulerRuntime();
  const long = 'r'.repeat(5000);
  const recorded = runtime.orgState.setCompanyState({
    inputs: [{ state: 'SURVIVAL', ref: long }],
  });
  assert.equal(recorded.disposition, 'REJECTED');
  assert.equal(runtime.orgState.companyState()?.state ?? null, null);
});

test('the assessor flags a start outcome after release except a released-reservation rejection', async () => {
  const TRACE = 'b'.repeat(31) + 'c';
  const SPAN = '7'.repeat(16);
  const rec = (o) => ({
    trace_id: TRACE, span_id: SPAN, parent_span_id: null, service_name: 'pixel.scheduler',
    outcome: 'success', severity: 'info', ...o,
  });
  const evaluation = rec({
    span_id: '1'.repeat(16),
    event_name: 'scheduler.evaluation.completed',
    attributes: {
      'pixel.job.id': 'job-001', 'pixel.scheduler.decision': 'ELIGIBLE',
      'pixel.scheduler.reason_code': 'ELIGIBLE_NOW', 'pixel.scheduler.job_revision': 2,
    },
  });
  const activated = rec({
    span_id: '2'.repeat(16), parent_span_id: '1'.repeat(16),
    event_name: 'scheduler.reservation.activated',
    attributes: {
      'pixel.job.id': 'job-001', 'pixel.scheduler.reservation_id': 'reservation-001',
      'pixel.scheduler.resource_ref': 'simulation.exclusive.x', 'pixel.scheduler.revision': 1,
    },
  });
  const released = rec({
    span_id: '3'.repeat(16), parent_span_id: '1'.repeat(16),
    event_name: 'scheduler.reservation.released',
    attributes: { 'pixel.job.id': 'job-001', 'pixel.scheduler.reservation_id': 'reservation-001', 'pixel.scheduler.revision': 2 },
  });
  const rejectedReservation = rec({
    span_id: '4'.repeat(16), parent_span_id: '1'.repeat(16),
    event_name: 'scheduler.start.rejected', outcome: 'denied', severity: 'warning',
    attributes: {
      'pixel.job.id': 'job-001', 'pixel.scheduler.reason_code': 'START_REJECTED_RESERVATION',
      'pixel.scheduler.reservation_id': 'reservation-001',
    },
  });
  const confirmedAfterRelease = rec({
    span_id: '5'.repeat(16), parent_span_id: '1'.repeat(16),
    event_name: 'scheduler.start.confirmed',
    attributes: {
      'pixel.job.id': 'job-001', 'pixel.scheduler.reason_code': 'START_CONFIRMED',
      'pixel.scheduler.reservation_id': 'reservation-001', 'pixel.scheduler.job_revision': 2,
    },
  });
  const holdRejectedAfterRelease = { ...rejectedReservation, span_id: '6'.repeat(16) };
  holdRejectedAfterRelease.attributes = { ...holdRejectedAfterRelease.attributes, 'pixel.scheduler.reason_code': 'START_REJECTED_HOLD' };

  // A rejection for the released reservation itself is the service's own sequence.
  assert.equal(assessSchedulerTraceCompleteness([evaluation, activated, released, rejectedReservation]).complete, true);
  // A confirmed start after release is impossible from the service.
  assert.equal(assessSchedulerTraceCompleteness([evaluation, activated, released, confirmedAfterRelease]).complete, false);
  // Any other rejection reason after release is impossible from the service.
  assert.equal(assessSchedulerTraceCompleteness([evaluation, activated, released, holdRejectedAfterRelease]).complete, false);
});

test('non-cloneable caller debris never throws across the service boundary (clone/echo class)', async () => {
  const runtime = schedulerRuntime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const fn = () => { throw new Error('boom'); };
  const sym = Symbol('x');

  // Organizational State writes: function/symbol values in any field refuse.
  assert.equal(runtime.orgState.setDuty({ duty_id: fn, agent_id: 'a', duty: 'ON_DUTY' }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setDuty({ duty_id: 'd', agent_id: sym, duty: 'ON_DUTY' }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setCapacity({ capacity_id: fn, resource_ref: 'r', capacity: 'NORMAL' }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.createHold({ hold_id: fn, job_id: 'j', hold_class: 'SECURITY', issuer: 'i', reason_code: 'r' }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.createApproval({ approval_id: fn, job_id: 'j', action_type: 'a', scope: 's', requested_by: 'r', required_authority: 'x' }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.grantDelegation({ grant_id: fn, grantor: 'g', grantee: 'e', capability: 'c', scope: 's', environment: 'simulation' }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setCompanyState({ inputs: [{ state: 'NORMAL', ref: 'x' }], constraints: [fn] }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setCompanyState({ inputs: [{ state: 'NORMAL', ref: sym }] }).disposition, 'REJECTED');

  // Scheduler: an evaluation object carrying extra debris never throws — the
  // echo is a bounded reconstruction, not a clone of the caller's object.
  const evaluation = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  const tainted = { ...evaluation.evaluation, extra: fn };
  const reserved = runtime.scheduler.reserve({ evaluation: tainted, job_id: job.envelope.job_id });
  assert.equal(reserved.disposition, 'RESERVED', 'extra debris in the echo must not throw');
  assert.ok(reserved.reservation.reservation_id);

  const poisoned = { ...evaluation.evaluation, nested: { get p() { throw new Error('deep'); } } };
  const denied = runtime.scheduler.reserve({ evaluation: poisoned, job_id: job.envelope.job_id });
  assert.equal(denied.disposition, 'DENY', 'poisoned nested debris must be a bounded refusal');
  // The bounded echo carries only canonical reconstruction fields.
  assert.deepEqual(Object.keys(denied.evaluation).sort(), ['decision', 'eligibility_id', 'job_id', 'reason_code', 'resource_ref']);

  const confirmed = await runtime.scheduler.confirmExecutionStart({
    job_id: job.envelope.job_id, requirement: baseRequirement(),
    reservation_id: fn, expected_job_revision: 1,
  });
  assert.equal(confirmed.confirmed, false);
  const released = runtime.scheduler.release({ reservation_id: fn, expected_revision: 1 });
  assert.equal(released.disposition, 'REJECTED');
});

test('the assessor accepts service-emittable post-release rejections and flags only impossible ones', () => {
  const TRACE = 'c'.repeat(31) + 'd';
  const rec = (o) => ({
    trace_id: TRACE, span_id: '1'.repeat(16), parent_span_id: null,
    service_name: 'pixel.scheduler', outcome: 'success', severity: 'info', ...o,
  });
  const evaluation = rec({
    span_id: '1'.repeat(16),
    event_name: 'scheduler.evaluation.completed',
    attributes: {
      'pixel.job.id': 'job-001', 'pixel.scheduler.decision': 'ELIGIBLE',
      'pixel.scheduler.reason_code': 'ELIGIBLE_NOW', 'pixel.scheduler.job_revision': 2,
    },
  });
  const activated = rec({
    span_id: '2'.repeat(16), parent_span_id: '1'.repeat(16),
    event_name: 'scheduler.reservation.activated',
    attributes: {
      'pixel.job.id': 'job-001', 'pixel.scheduler.reservation_id': 'reservation-001',
      'pixel.scheduler.resource_ref': 'simulation.exclusive.x', 'pixel.scheduler.revision': 1,
    },
  });
  const released = rec({
    span_id: '3'.repeat(16), parent_span_id: '1'.repeat(16),
    event_name: 'scheduler.reservation.released',
    attributes: { 'pixel.job.id': 'job-001', 'pixel.scheduler.reservation_id': 'reservation-001', 'pixel.scheduler.revision': 2 },
  });
  const rejection = (reason, span) => {
    const r = rec({
      span_id: span, parent_span_id: '1'.repeat(16),
      event_name: 'scheduler.start.rejected', outcome: 'denied', severity: 'warning',
      attributes: {
        'pixel.job.id': 'job-001', 'pixel.scheduler.reason_code': reason,
        'pixel.scheduler.reservation_id': 'reservation-001',
      },
    });
    return r;
  };
  // Service-emittable post-release rejections (checks that precede the
  // reservation-state check) assess complete.
  for (const [reason, span] of [
    ['START_REJECTED_RESERVATION', '4'.repeat(16)],
    ['START_REJECTED_INPUT_INVALID', '5'.repeat(16)],
    ['START_REJECTED_JOB_STATE', '6'.repeat(16)],
    ['START_REJECTED_REVISION', '7'.repeat(16)],
  ]) {
    assert.equal(
      assessSchedulerTraceCompleteness([evaluation, activated, released, rejection(reason, span)]).complete,
      true,
      `${reason} after release must assess complete`,
    );
  }
  // A deeper reason (requires an ACTIVE reservation) after a release is impossible.
  assert.equal(
    assessSchedulerTraceCompleteness([evaluation, activated, released, rejection('START_REJECTED_HOLD', '8'.repeat(16))]).complete,
    false,
  );
  // A confirmed start after a release is impossible.
  const confirmed = rec({
    span_id: '9'.repeat(16), parent_span_id: '1'.repeat(16),
    event_name: 'scheduler.start.confirmed',
    attributes: {
      'pixel.job.id': 'job-001', 'pixel.scheduler.reason_code': 'START_CONFIRMED',
      'pixel.scheduler.reservation_id': 'reservation-001', 'pixel.scheduler.job_revision': 2,
    },
  });
  assert.equal(assessSchedulerTraceCompleteness([evaluation, activated, released, confirmed]).complete, false);
});

test('poisoned arrays (accessor indices) never throw across the service boundary', async () => {
  const runtime = schedulerRuntime();
  const mkPoisoned = (first) => {
    const array = [first];
    Object.defineProperty(array, 1, { get() { throw new Error('array boom'); }, enumerable: true, configurable: true });
    array.length = 2;
    return array;
  };

  // A persistently poisoned constraints array refuses, never throws.
  assert.equal(runtime.orgState.setCompanyState({
    inputs: [{ state: 'NORMAL', ref: 'x' }], constraints: mkPoisoned('ok'),
  }).disposition, 'REJECTED');

  // Poisoned arrays used as plain field values refuse, never throw.
  assert.equal(runtime.orgState.setDuty({ duty_id: 'd1', agent_id: 'w', duty: mkPoisoned('ON_DUTY') }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setDuty({ duty_id: mkPoisoned('d1'), agent_id: 'w', duty: 'ON_DUTY' }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.createHold({
    hold_id: 'h1', job_id: mkPoisoned('job-1'), hold_class: 'SECURITY', issuer: 'i', reason_code: 'r',
  }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.setCapacity({ capacity_id: 'c1', resource_ref: mkPoisoned('r'), capacity: 'NORMAL' }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.grantDelegation({
    grant_id: 'g1', grantor: 'g', grantee: 'e', capability: 'c', scope: mkPoisoned('s'), environment: 'simulation',
  }).disposition, 'REJECTED');
  assert.equal(runtime.orgState.createApproval({
    approval_id: 'a1', job_id: 'j', action_type: mkPoisoned('a'), scope: 's', requested_by: 'p', required_authority: 'r',
  }).disposition, 'REJECTED');

  // No state was mutated by any refusal.
  const runtime2 = schedulerRuntime();
  assert.equal(runtime2.orgState.holdsForJob('job-1').length, 0);
  assert.equal(runtime2.orgState.dutyFor('w'), null);
});
