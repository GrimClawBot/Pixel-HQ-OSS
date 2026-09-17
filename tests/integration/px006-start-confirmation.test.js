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
import { createClock, createIds, NOW } from '../helpers/px006-runtime.js';

function runtime({ clock = createClock() } = {}) {
  const ids = createIds(30_000);
  const evidence = new EvidenceRecorder({ clock: () => clock.now() });
  const store = new SimulatorRelayStoreAdapter();
  const memory = new MemoryService({
    environment: 'simulation',
    intakeContextProvider: new SimulatorMemoryIntakeContextProvider(),
    memoryStore: new SimulatorMemoryStoreAdapter(),
    relayStore: store,
    evidence,
    ids,
    clock: () => clock.now(),
  });
  const gateway = new ModelGateway({
    environment: 'simulation',
    store: { source: 'simulator', getJob: store.getJob.bind(store) },
    memory,
    adapters: [new FakeModelASimulatorAdapter(), new FakeModelBSimulatorAdapter()],
    evidence,
    ids,
    clock: () => clock.now(),
  });
  const orgState = new OrganizationalStateService({
    environment: 'simulation', store: new SimulatorOrgStateStoreAdapter(),
    evidence, ids, clock: () => clock.now(),
  });
  const scheduler = new SchedulerService({
    environment: 'simulation',
    orgState,
    jobs: { source: 'simulator', getJob: store.getJob.bind(store) },
    store: new SimulatorSchedulerStoreAdapter(),
    evidence,
    ids,
    clock: () => clock.now(),
  });
  const requirementProvider = new SimulatorExecutionRequirementProvider();
  const relay = new RelayService({
    environment: 'simulation',
    contextProvider: new SimulatorJobContextProvider(),
    store,
    toolGateway: { source: 'simulator', async execute() { return { disposition: 'COMPLETED' }; } },
    memory,
    modelGateway: gateway,
    scheduler,
    requirementProvider,
    evidence,
    ids,
    clock: () => clock.now(),
  });
  const prepare = async () => {
    await memory.intake({
      event_name: 'pixel.memory.intake-intent.v1', schema_version: '1.0.0',
      content: { text: 'System status stable.', tags: ['system', 'status'] },
    });
    return relay.accept({
      event_name: 'pixel.job.submit-intent.v1', schema_version: '1.0.0',
      idempotency_key: `scheduler-${Math.random().toString(16).slice(2)}`,
      job_type: 'system-status', requested_capability: 'pixel.system-status.read',
    });
  };
  return { clock, evidence, gateway, memory, orgState, prepare, relay, scheduler, store };
}

test('scheduler-wired model execution confirms start and commits the terminal result', async () => {
  const subject = runtime();
  const accepted = await subject.prepare();
  const response = await subject.relay.executeModelSummary(accepted.job.envelope.job_id);

  assert.equal(response.disposition, 'COMPLETED');
  assert.equal(response.job.current_state, 'COMPLETED');
  assert.equal(subject.memory.retainedPackageCount(), 0, 'terminal commit releases the approved package');

  const names = subject.evidence.all().map(({ event_name }) => event_name);
  assert.equal(names.includes('scheduler.evaluation.completed'), true);
  assert.equal(names.includes('scheduler.reservation.activated'), true);
  assert.equal(names.includes('scheduler.start.confirmed'), true);
  assert.equal(names.includes('scheduler.reservation.released'), true);
  // The job trace itself remains canonical: no WAIT/HOLD/DENY Relay states.
  const jobTrace = subject.evidence.forTrace(response.trace_id).map(({ event_name }) => event_name);
  assert.equal(jobTrace.includes('relay.job.running'), true);
  assert.equal(jobTrace.some((name) => ['WAIT', 'HOLD', 'DENY'].some((token) => name.includes(token))), false);
});

test('scheduler evidence family is bounded and complete', async () => {
  const subject = runtime();
  const accepted = await subject.prepare();
  await subject.relay.executeModelSummary(accepted.job.envelope.job_id);

  // Evaluation evidence lives on its own scheduler trace.
  const schedulerRecords = subject.evidence.all().filter(({ service_name }) => service_name === 'pixel.scheduler');
  const evaluationTrace = schedulerRecords.filter(({ event_name }) => event_name === 'scheduler.evaluation.completed');
  assert.equal(evaluationTrace.length >= 1, true);
  const assessment = assessSchedulerTraceCompleteness(subject.evidence.forTrace(evaluationTrace[0].trace_id));
  assert.equal(assessment.complete, true, JSON.stringify(assessment.errors));

  // Bounded: no Memory text or prompt content in scheduler evidence.
  const serialized = JSON.stringify(schedulerRecords);
  assert.equal(serialized.includes('System status stable.'), false);
});

test('a security hold blocks the model path before any context work; job stays ACCEPTED', async () => {
  const subject = runtime();
  const accepted = await subject.prepare();
  const jobId = accepted.job.envelope.job_id;
  subject.orgState.createHold({
    hold_id: 'hold-001', job_id: jobId, hold_class: 'SECURITY',
    issuer: 'PIXEL-SECURITY', reason_code: 'INCIDENT',
  });

  const response = await subject.relay.executeModelSummary(jobId);
  assert.equal(response.disposition, 'HOLD');
  assert.equal(response.reason_code, 'HOLD_SECURITY');
  assert.equal(subject.memory.retainedPackageCount(), 0, 'no context was built under a hold');
  const stored = await subject.store.getJob(jobId);
  assert.equal(stored.current_state, 'ACCEPTED');
});

test('saturated capacity leaves the job ACCEPTED and the next attempt can retry', async () => {
  const subject = runtime();
  const accepted = await subject.prepare();
  const jobId = accepted.job.envelope.job_id;

  subject.orgState.setCapacity({
    capacity_id: 'capacity-001', resource_ref: 'simulation.exclusive.status-check', capacity: 'SATURATED',
  });
  const blocked = await subject.relay.executeModelSummary(jobId);
  assert.equal(blocked.disposition, 'WAIT');
  assert.equal(blocked.reason_code, 'WAIT_CAPACITY');
  assert.equal((await subject.store.getJob(jobId)).current_state, 'ACCEPTED');

  // Capacity recovers; the same job can then execute.
  subject.orgState.setCapacity({
    capacity_id: 'capacity-001', resource_ref: 'simulation.exclusive.status-check', capacity: 'NORMAL',
    expected_revision: 1,
  });
  const response = await subject.relay.executeModelSummary(jobId);
  assert.equal(response.disposition, 'COMPLETED');
});

test('a hold appearing between eligibility and start blocks RUNNING at the model path', async () => {
  const subject = runtime();
  const accepted = await subject.prepare();
  const jobId = accepted.job.envelope.job_id;

  // Stage 1 succeeds (reservation is taken), then a hold appears before the
  // Stage 2 confirmation inside executeModelSummary. We simulate the exact
  // sequence by taking the reservation path manually first.
  const requirement = new SimulatorExecutionRequirementProvider()
    .resolveExecutionRequirement({ job: await subject.store.getJob(jobId) }).requirement;
  const evaluated = await subject.scheduler.evaluate({ job_id: jobId, requirement });
  assert.equal(evaluated.disposition, 'ELIGIBLE');
  const reserved = subject.scheduler.reserve({ evaluation: evaluated.evaluation, job_id: jobId });
  assert.equal(reserved.disposition, 'RESERVED');

  subject.orgState.createHold({
    hold_id: 'hold-001', job_id: jobId, hold_class: 'POLICY', issuer: 'PIXEL-POLICY', reason_code: 'REVIEW',
  });
  const confirmation = await subject.scheduler.confirmExecutionStart({
    job_id: jobId, requirement,
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: (await subject.store.getJob(jobId)).job_revision,
  });
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.reason_code, 'START_REJECTED_HOLD');
  assert.equal((await subject.store.getJob(jobId)).current_state, 'ACCEPTED');
});

test('an expired lease rejects model-path start and requires re-evaluation', async () => {
  const clock = createClock();
  const subject = runtime({ clock });
  const accepted = await subject.prepare();
  const jobId = accepted.job.envelope.job_id;

  // Occupy the slot with a long-dead lease by advancing time between stages.
  await subject.orgState.setCapacity({
    capacity_id: 'capacity-001', resource_ref: 'simulation.exclusive.status-check', capacity: 'NORMAL',
  });
  const requirement = new SimulatorExecutionRequirementProvider()
    .resolveExecutionRequirement({ job: await subject.store.getJob(jobId) }).requirement;
  const evaluated = await subject.scheduler.evaluate({ job_id: jobId, requirement });
  const reserved = subject.scheduler.reserve({ evaluation: evaluated.evaluation, job_id: jobId });
  assert.equal(reserved.disposition, 'RESERVED');

  clock.advance(6 * 60 * 1000);
  const confirmation = await subject.scheduler.confirmExecutionStart({
    job_id: jobId, requirement,
    reservation_id: reserved.reservation.reservation_id,
    expected_job_revision: (await subject.store.getJob(jobId)).job_revision,
  });
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.reason_code, 'START_REJECTED_RESERVATION');
});

test('worker path also confirms start when a scheduler is wired', async () => {
  const subject = runtime();
  const accepted = await subject.prepare();
  const jobId = accepted.job.envelope.job_id;
  const response = await subject.relay.execute(jobId);
  assert.equal(response.disposition, 'COMPLETED');
  const names = subject.evidence.all().map(({ event_name }) => event_name);
  assert.equal(names.includes('scheduler.start.confirmed'), true);
});

test('Relay requires both scheduler and requirement provider when either is present', () => {
  const ids = createIds(40_000);
  const base = {
    environment: 'simulation',
    contextProvider: new SimulatorJobContextProvider(),
    store: new SimulatorRelayStoreAdapter(),
    toolGateway: { source: 'simulator', async execute() {} },
    evidence: new EvidenceRecorder({ clock: () => NOW }),
    ids,
    clock: () => NOW,
  };
  assert.throws(() => new RelayService({
    ...base,
    scheduler: { evaluate() {}, confirmExecutionStart() {}, reserve() {}, release() {} },
  }), /requirement provider/);
  assert.throws(() => new RelayService({
    ...base,
    requirementProvider: new SimulatorExecutionRequirementProvider(),
  }), /requires a Scheduler/);
  assert.throws(() => new RelayService({
    ...base,
    scheduler: { evaluate() {}, release() {} },
    requirementProvider: new SimulatorExecutionRequirementProvider(),
  }), /Scheduler/);
});

test('Relay requires scheduler.release alongside the other scheduler methods', () => {
  const ids = createIds(40_000);
  const base = {
    environment: 'simulation',
    contextProvider: new SimulatorJobContextProvider(),
    store: new SimulatorRelayStoreAdapter(),
    toolGateway: { source: 'simulator', async execute() {} },
    evidence: new EvidenceRecorder({ clock: () => NOW }),
    ids,
    clock: () => NOW,
  };
  // A scheduler that cannot release would leak reservations through the
  // best-effort cleanup path, so it is rejected at dependency construction.
  assert.throws(() => new RelayService({
    ...base,
    scheduler: { evaluate() {}, confirmExecutionStart() {}, reserve() {} },
    requirementProvider: new SimulatorExecutionRequirementProvider(),
  }), /release|requires a Scheduler/);
});
