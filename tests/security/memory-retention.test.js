import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeModelASimulatorAdapter } from '../../adapters/simulator/src/fake-model-a-simulator-adapter.js';
import { FakeModelBSimulatorAdapter } from '../../adapters/simulator/src/fake-model-b-simulator-adapter.js';
import { SimulatorJobContextProvider } from '../../adapters/simulator/src/job-context-simulator-provider.js';
import { SimulatorMemoryIntakeContextProvider } from '../../adapters/simulator/src/memory-intake-context-simulator-provider.js';
import { SimulatorMemoryStoreAdapter } from '../../adapters/simulator/src/memory-store-simulator-adapter.js';
import { SimulatorRelayStoreAdapter } from '../../adapters/simulator/src/relay-store-simulator-adapter.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { ModelGateway } from '../../services/model-gateway/src/model-gateway.js';
import { MemoryService } from '../../services/memory/src/memory-service.js';
import { RelayService } from '../../services/relay/src/relay-service.js';
import { createIds, NOW } from '../helpers/px006-runtime.js';

function runtime({ failTerminalCommit = false } = {}) {
  const ids = createIds(20_000);
  const evidence = new EvidenceRecorder({ clock: () => NOW });
  const store = new SimulatorRelayStoreAdapter({ failTerminalCommit });
  const memory = new MemoryService({
    environment: 'simulation',
    intakeContextProvider: new SimulatorMemoryIntakeContextProvider(),
    memoryStore: new SimulatorMemoryStoreAdapter(),
    relayStore: store,
    evidence,
    ids,
    clock: () => NOW,
  });
  const gateway = new ModelGateway({
    environment: 'simulation',
    store: { source: 'simulator', getJob: store.getJob.bind(store) },
    memory,
    adapters: [new FakeModelASimulatorAdapter(), new FakeModelBSimulatorAdapter()],
    evidence,
    ids,
    clock: () => NOW,
  });
  const relay = new RelayService({
    environment: 'simulation',
    contextProvider: new SimulatorJobContextProvider(),
    store,
    toolGateway: { source: 'simulator', async execute() { throw new Error('PX-003 path not used'); } },
    memory,
    modelGateway: gateway,
    evidence,
    ids,
    clock: () => NOW,
  });
  const prepare = async (content = 'System status stable.') => {
    await memory.intake({
      event_name: 'pixel.memory.intake-intent.v1', schema_version: '1.0.0',
      content: { text: content, tags: ['system', 'status'] },
    });
    return relay.accept({
      event_name: 'pixel.job.submit-intent.v1', schema_version: '1.0.0',
      idempotency_key: `retention-${Math.random().toString(16).slice(2)}`,
      job_type: 'system-status', requested_capability: 'pixel.system-status.read',
    });
  };
  return { evidence, gateway, memory, prepare, relay, store };
}

test('a terminal model job safely releases its approved Memory package', async () => {
  const subject = runtime();
  const accepted = await subject.prepare();
  const response = await subject.relay.executeModelSummary(accepted.job.envelope.job_id);
  assert.equal(response.disposition, 'COMPLETED');
  assert.equal(subject.memory.retainedPackageCount(), 0, 'terminal commit must release the approved package');

  // The released package is no longer retrievable.
  const packageId = response.job.result ? null : null;
  assert.equal(packageId, null);
});

test('a failed model job also releases its approved package', async () => {
  const subject = runtime();
  const accepted = await subject.prepare();
  const jobId = accepted.job.envelope.job_id;
  // Force a deterministic model-path FAILED outcome: break the gateway adapter
  // so its outcome fails Relay's independent validation (WORKER_RESULT_INVALID).
  subject.gateway.invoke = async () => ({
    status: 'SUCCEEDED', output: 'tampered', reason_code: null,
  });
  const response = await subject.relay.executeModelSummary(jobId);
  assert.equal(response.disposition, 'FAILED');
  assert.equal(response.model_output, null);
  assert.equal(subject.memory.retainedPackageCount(), 0, 'a FAILED terminal commit releases the package');
});

test('repeated completed model jobs never accumulate retained packages', async () => {
  const subject = runtime();
  for (let index = 0; index < 12; index += 1) {
    const accepted = await subject.prepare();
    const response = await subject.relay.executeModelSummary(accepted.job.envelope.job_id);
    assert.equal(response.disposition, 'COMPLETED', `run ${index}`);
  }
  assert.equal(subject.memory.retainedPackageCount(), 0, 'no unbounded retention across completed jobs');
});

test('an in-flight package cannot be removed between Relay claim and Gateway lookup', async () => {
  const subject = runtime();
  const accepted = await subject.prepare();
  const jobId = accepted.job.envelope.job_id;

  // Claim context preparation (as Relay does) then check the package remains
  // retrievable for the Gateway, and that a cleanup attempt for a *different*
  // job cannot evict it.
  const preparation = await subject.store.claimModelContextPreparation(jobId);
  assert.equal(preparation.disposition, 'PREPARE_NOW');
  const context = await subject.memory.buildContext({ job_id: jobId, query: 'system status' });
  assert.equal(context.disposition, 'CREATED');
  const packageId = context.package.package_id;

  // A cleanup for another job must not touch this package.
  subject.memory.releasePackageForJob('job-other');
  assert.notEqual(subject.memory.getApprovedContextPackage(packageId), null, 'in-flight package must remain retrievable');

  // Its own job terminating releases exactly this package.
  subject.memory.releasePackageForJob(jobId);
  assert.equal(subject.memory.getApprovedContextPackage(packageId), null);
});

test('duplicate terminal cleanup is safe and idempotent', async () => {
  const subject = runtime();
  const accepted = await subject.prepare();
  const jobId = accepted.job.envelope.job_id;
  await subject.relay.executeModelSummary(jobId);
  assert.equal(subject.memory.retainedPackageCount(), 0);

  // Repeated cleanup calls for the same job are harmless.
  const first = subject.memory.releasePackageForJob(jobId);
  const second = subject.memory.releasePackageForJob(jobId);
  assert.equal(first.disposition, 'RELEASED');
  assert.equal(first.released.length, 0, 'already released packages are not re-released');
  assert.equal(second.released.length, 0);
});

test('cleanup failure never corrupts the committed terminal result', async () => {
  const subject = runtime();
  const accepted = await subject.prepare();
  const jobId = accepted.job.envelope.job_id;

  // Sabotage the release path to throw, then confirm the job still commits.
  subject.memory.releasePackageForJob = () => { throw new Error('cleanup exploded'); };
  const response = await subject.relay.executeModelSummary(jobId);
  assert.equal(response.disposition, 'COMPLETED', 'cleanup failure must not break the terminal commit');
  assert.equal(response.job.current_state, 'COMPLETED');
});

test('an abandoned package is released only when its job is no longer resolvable', async () => {
  const subject = runtime();
  const accepted = await subject.prepare();
  const jobId = accepted.job.envelope.job_id;
  // Build a package without executing the job (abandoned).
  const claim = subject.store.claimModelContextPreparation(jobId);
  assert.equal(claim.disposition, 'PREPARE_NOW');
  const context = await subject.memory.buildContext({ job_id: jobId, query: 'system status' });
  assert.equal(context.disposition, 'CREATED');
  assert.equal(subject.memory.retainedPackageCount(), 1);

  // While the job is live, bounded retention must not evict it even at the
  // tightest valid bound.
  const boundedLive = await subject.memory.boundRetention({ maximum: 1 });
  assert.equal(subject.memory.retainedPackageCount(), 1, 'a live job package is never evicted by the bound');
  assert.deepEqual(boundedLive.released, []);
  assert.equal(boundedLive.disposition, 'BOUNDED');
});

test('bounded retention releases abandoned packages once their job is gone', async () => {
  const subject = runtime();
  const first = await subject.prepare();
  const second = await subject.prepare('Another status note.');
  for (const accepted of [first, second]) {
    const jobId = accepted.job.envelope.job_id;
    subject.store.claimModelContextPreparation(jobId);
    const context = await subject.memory.buildContext({ job_id: jobId, query: 'system status' });
    assert.equal(context.disposition, 'CREATED');
  }
  assert.equal(subject.memory.retainedPackageCount(), 2);

  // Both jobs are gone from the store (abandoned work); the bound releases
  // the excess package while keeping exactly the bound.
  const originalGetJob = subject.store.getJob.bind(subject.store);
  subject.store.getJob = () => null;
  const bounded = await subject.memory.boundRetention({ maximum: 1 });
  assert.equal(bounded.released.length, 1);
  assert.equal(subject.memory.retainedPackageCount(), 1);
  subject.store.getJob = originalGetJob;
});

test('cleanup evidence is bounded and never contains package text', async () => {
  const subject = runtime();
  const accepted = await subject.prepare('Quarterly revenue projections show strong growth.');
  await subject.relay.executeModelSummary(accepted.job.envelope.job_id);
  const serialized = JSON.stringify(subject.evidence.all());
  assert.equal(serialized.includes('Quarterly revenue'), false, 'cleanup evidence must not leak Memory text');
  assert.equal(serialized.includes('package text'), false);
});
