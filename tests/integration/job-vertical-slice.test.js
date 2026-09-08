import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorCapabilityGrantProvider } from '../../adapters/simulator/src/capability-grant-simulator-provider.js';
import { SimulatorJobContextProvider } from '../../adapters/simulator/src/job-context-simulator-provider.js';
import { SimulatorRelayStoreAdapter } from '../../adapters/simulator/src/relay-store-simulator-adapter.js';
import { SimulatorSystemStatusWorker } from '../../adapters/simulator/src/system-status-worker-simulator-adapter.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { assessJobTraceCompleteness } from '../../packages/telemetry/src/job-trace-completeness.js';
import { RelayService } from '../../services/relay/src/relay-service.js';
import { ToolGateway } from '../../services/tool-gateway/src/tool-gateway.js';

const NOW = '2026-09-07T12:00:00.000Z';
const HAPPY_INTENT = Object.freeze({
  event_name: 'pixel.job.submit-intent.v1',
  schema_version: '1.0.0',
  idempotency_key: 'status-check-001',
  job_type: 'system-status',
  requested_capability: 'pixel.system-status.read',
});

function createIds(seed = 10_000) {
  let value = seed;
  return {
    nextEventId: () => `event-${++value}`,
    nextJobId: () => `job-${++value}`,
    nextExecutionId: () => `execution-${++value}`,
    nextSpanId: () => (++value).toString(16).padStart(16, '0'),
    nextTraceId: () => (++value).toString(16).padStart(32, '0'),
  };
}

function createRuntime({
  environment = 'simulation',
  contextProvider = new SimulatorJobContextProvider(),
  grantProvider = new SimulatorCapabilityGrantProvider(),
  store = new SimulatorRelayStoreAdapter(),
  worker = new SimulatorSystemStatusWorker(),
  evidence = new EvidenceRecorder({ clock: () => NOW }),
  ids = createIds(),
} = {}) {
  const toolGateway = new ToolGateway({
    environment, grantProvider, store, worker, evidence, ids, clock: () => NOW,
  });
  const relay = new RelayService({
    environment, contextProvider, store, toolGateway, evidence, ids, clock: () => NOW,
  });
  return { contextProvider, evidence, grantProvider, ids, relay, store, toolGateway, worker };
}

test('permitted capability follows the one legal lifecycle to a bounded completed result', async () => {
  const runtime = createRuntime();
  const response = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(response.disposition, 'CREATED');
  assert.equal(response.job.current_state, 'COMPLETED');
  assert.deepEqual(response.job.transitions.map(({ from_state, to_state }) => `${from_state}->${to_state}`), [
    'SUBMITTED->ACCEPTED',
    'ACCEPTED->RUNNING',
    'RUNNING->COMPLETED',
  ]);
  assert.equal(response.job.result.outcome_code, 'SYSTEM_STATUS_AVAILABLE');
  assert.equal(response.job.result.summary, 'Pixel system status is available.');
  assert.equal(runtime.worker.invocationCount, 1);
  assert.equal('grants' in response.job.envelope, false);
  assert.equal('capabilities' in response.job.envelope, false);
});

test('many concurrent identical submissions create one canonical job and invoke one worker', async () => {
  const runtime = createRuntime();
  const responses = await Promise.all(Array.from({ length: 50 }, () => runtime.relay.submit(HAPPY_INTENT)));

  assert.equal(responses.filter(({ disposition }) => disposition === 'CREATED').length, 1);
  assert.equal(new Set(responses.map(({ job }) => job.envelope.job_id)).size, 1);
  assert.equal(runtime.worker.invocationCount, 1);

  const replay = await runtime.relay.submit(HAPPY_INTENT);
  assert.equal(replay.disposition, 'EXISTING');
  assert.equal(replay.job.current_state, 'COMPLETED');
  assert.equal(replay.job.result.result_id, responses.find(({ job }) => job.result)?.job.result.result_id);
  assert.equal(runtime.worker.invocationCount, 1);
});

test('same idempotency namespace with unequal fingerprint is a bounded conflict', async () => {
  const runtime = createRuntime();
  await runtime.relay.submit(HAPPY_INTENT);
  const conflict = await runtime.relay.submit({
    ...HAPPY_INTENT,
    requested_capability: 'pixel.system-status.raw.read',
  });

  assert.deepEqual(conflict, {
    disposition: 'CONFLICT',
    reason_code: 'IDEMPOTENCY_CONFLICT',
    job: null,
    trace_id: conflict.trace_id,
  });
  assert.equal(runtime.worker.invocationCount, 1);
});

test('submit preserves INVALID_STATE when the accepted job cannot enter RUNNING', async () => {
  const canonicalStore = new SimulatorRelayStoreAdapter();
  const store = {
    source: 'simulator',
    claimOrReturnExisting: canonicalStore.claimOrReturnExisting.bind(canonicalStore),
    getJob: canonicalStore.getJob.bind(canonicalStore),
    applyTransition: async (jobId, transition) => (
      transition.to_state === 'RUNNING'
        ? { disposition: 'REJECTED', job: await canonicalStore.getJob(jobId) }
        : canonicalStore.applyTransition(jobId, transition)
    ),
    recordGatewayDecision: canonicalStore.recordGatewayDecision.bind(canonicalStore),
    claimWorkerInvocation: canonicalStore.claimWorkerInvocation.bind(canonicalStore),
    commitTerminalResult: canonicalStore.commitTerminalResult.bind(canonicalStore),
  };
  const runtime = createRuntime({ store });

  const response = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(response.disposition, 'INVALID_STATE');
  assert.equal(response.job.current_state, 'ACCEPTED');
  assert.equal(runtime.worker.invocationCount, 0);
});

test('submit preserves a non-terminal Tool Gateway execution disposition', async () => {
  const store = new SimulatorRelayStoreAdapter();
  const ids = createIds();
  const evidence = new EvidenceRecorder({ clock: () => NOW });
  const toolGateway = {
    source: 'simulator',
    async execute({ executionRequest }) {
      return {
        disposition: 'ALREADY_CLAIMED',
        job: await store.getJob(executionRequest.job_id),
      };
    },
  };
  const relay = new RelayService({
    environment: 'simulation',
    contextProvider: new SimulatorJobContextProvider(),
    store,
    toolGateway,
    evidence,
    ids,
    clock: () => NOW,
  });

  const response = await relay.submit(HAPPY_INTENT);

  assert.equal(response.disposition, 'ALREADY_CLAIMED');
  assert.equal(response.job.current_state, 'RUNNING');
});

test('exact replay remains equal when only the temporary worker identity changes', async () => {
  let resolution = 0;
  const contextProvider = {
    source: 'simulator',
    async resolveJobContext() {
      resolution += 1;
      return {
        requester: { subject_id: 'PIXEL-PRINCIPAL' },
        owner: { department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems' },
        worker_binding: {
          worker_id: `PIXEL-SYSTEMS-WORKER-${String(resolution).padStart(2, '0')}`,
          department_ref: 'Infrastructure / HomeLab',
          role_ref: 'Systems',
        },
        provider_contract: 'pixel.job-context-provider.v1',
        source: 'simulator',
      };
    },
  };
  const runtime = createRuntime({ contextProvider });
  const created = await runtime.relay.submit(HAPPY_INTENT);
  const replay = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(replay.disposition, 'EXISTING');
  assert.equal(replay.job.envelope.job_id, created.job.envelope.job_id);
  assert.equal(replay.job.envelope.execution.worker_binding.worker_id, 'PIXEL-SYSTEMS-WORKER-01');
  assert.equal(runtime.worker.invocationCount, 1);
});

test('Tool Gateway resolves grants with the complete canonical execution context', async () => {
  const received = [];
  const grantProvider = {
    source: 'simulator',
    async resolveCapabilities(context) {
      received.push(context);
      return {
        capabilities: ['pixel.system-status.read'],
        policy_id: 'pixel.alpha.system-status.v1',
        provider_contract: 'pixel.capability-grant-provider.v1',
        source: 'simulator',
      };
    },
  };
  const runtime = createRuntime({ grantProvider });
  const response = await runtime.relay.submit(HAPPY_INTENT);

  assert.deepEqual(received, [{
    job_id: response.job.envelope.job_id,
    execution_id: response.job.execution_id,
    requester: { subject_id: 'PIXEL-PRINCIPAL' },
    owner: { department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems' },
    worker_binding: response.job.envelope.execution.worker_binding,
    current_state: 'RUNNING',
    environment: 'simulation',
    job_type: 'system-status',
    capability: 'pixel.system-status.read',
    tool_class: 'pixel.system-status',
    target: 'pixel.platform',
    parameter_hash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  }]);
  assert.equal(runtime.worker.invocationCount, 1);
});

test('simulated authorization cannot grant a divergent execution context', async () => {
  const provider = new SimulatorCapabilityGrantProvider();
  const canonical = {
    job_id: 'job-001',
    execution_id: 'execution-001',
    requester: { subject_id: 'PIXEL-PRINCIPAL' },
    owner: { department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems' },
    worker_binding: {
      worker_id: 'PIXEL-SYSTEMS-WORKER-01',
      department_ref: 'Infrastructure / HomeLab',
      role_ref: 'Systems',
    },
    current_state: 'RUNNING',
    environment: 'simulation',
    job_type: 'system-status',
    capability: 'pixel.system-status.read',
    tool_class: 'pixel.system-status',
    target: 'pixel.platform',
    parameter_hash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  };
  const divergent = [
    { ...canonical, requester: { subject_id: 'PIXEL-OTHER' } },
    {
      ...canonical,
      owner: { department_ref: 'Infrastructure / HomeLab', role_ref: 'Network' },
      worker_binding: { ...canonical.worker_binding, role_ref: 'Network' },
    },
    { ...canonical, current_state: 'ACCEPTED' },
    { ...canonical, environment: 'production' },
    { ...canonical, target: 'pixel.other' },
    { ...canonical, parameter_hash: 'b'.repeat(64) },
  ];

  for (const context of divergent) {
    const grants = await provider.resolveCapabilities(context);
    assert.deepEqual(grants.capabilities, []);
  }
});

test('Tool Gateway denies stale or mismatched canonical authorization context with zero worker calls', async () => {
  const mutations = [
    (job) => { job.envelope.requester.subject_id = 'PIXEL-OTHER'; },
    (job) => { job.envelope.owner.role_ref = 'Network'; },
    (job) => { job.current_state = 'ACCEPTED'; },
    (job) => { job.envelope.environment = 'production'; },
    (job) => { job.envelope.execution.target = 'pixel.other'; },
    (job) => { job.envelope.execution.parameter_hash = 'b'.repeat(64); },
  ];

  for (const mutate of mutations) {
    const canonicalStore = new SimulatorRelayStoreAdapter();
    let reads = 0;
    const store = {
      source: 'simulator',
      claimOrReturnExisting: canonicalStore.claimOrReturnExisting.bind(canonicalStore),
      getJob: async (jobId) => {
        const job = await canonicalStore.getJob(jobId);
        reads += 1;
        if (reads !== 2 || !job) return job;
        const divergent = structuredClone(job);
        mutate(divergent);
        return divergent;
      },
      applyTransition: canonicalStore.applyTransition.bind(canonicalStore),
      recordGatewayDecision: canonicalStore.recordGatewayDecision.bind(canonicalStore),
      claimWorkerInvocation: canonicalStore.claimWorkerInvocation.bind(canonicalStore),
      commitTerminalResult: canonicalStore.commitTerminalResult.bind(canonicalStore),
    };
    const runtime = createRuntime({ store });
    const response = await runtime.relay.submit(HAPPY_INTENT);

    assert.equal(response.job.current_state, 'FAILED');
    assert.equal(response.job.result.outcome_code, 'AUTHORIZATION_UNAVAILABLE');
    assert.equal(runtime.worker.invocationCount, 0);
  }
});

test('Tool Gateway records DENY when canonical authorization context cannot be read', async () => {
  const canonicalStore = new SimulatorRelayStoreAdapter();
  let reads = 0;
  const store = {
    source: 'simulator',
    claimOrReturnExisting: canonicalStore.claimOrReturnExisting.bind(canonicalStore),
    getJob: async (jobId) => {
      reads += 1;
      if (reads === 2) throw new Error('sensitive canonical context failure');
      return canonicalStore.getJob(jobId);
    },
    applyTransition: canonicalStore.applyTransition.bind(canonicalStore),
    recordGatewayDecision: canonicalStore.recordGatewayDecision.bind(canonicalStore),
    claimWorkerInvocation: canonicalStore.claimWorkerInvocation.bind(canonicalStore),
    commitTerminalResult: canonicalStore.commitTerminalResult.bind(canonicalStore),
  };
  const runtime = createRuntime({ store });
  const response = await runtime.relay.submit(HAPPY_INTENT);
  const trace = runtime.evidence.forTrace(response.trace_id);

  assert.equal(response.job.current_state, 'FAILED');
  assert.equal(response.job.result.outcome_code, 'AUTHORIZATION_UNAVAILABLE');
  assert.equal(runtime.worker.invocationCount, 0);
  assert.equal(trace.some(({ event_name }) => event_name === 'tool.capability.denied'), true);
  assert.doesNotMatch(JSON.stringify(trace), /sensitive canonical context failure/);
});

test('ungranted raw capability is denied at execution time and reaches FAILED without a worker', async () => {
  const runtime = createRuntime();
  const response = await runtime.relay.submit({
    ...HAPPY_INTENT,
    idempotency_key: 'raw-status-001',
    requested_capability: 'pixel.system-status.raw.read',
  });

  assert.equal(response.job.current_state, 'FAILED');
  assert.equal(response.job.gateway_decision.decision, 'DENY');
  assert.equal(response.job.result.outcome_code, 'CAPABILITY_DENIED');
  assert.equal(response.job.result.provenance.worker_contract, null);
  assert.equal(runtime.worker.invocationCount, 0);
});

test('raw capability remains denied and unimplemented even if a grant provider lists it', async () => {
  const grantProvider = new SimulatorCapabilityGrantProvider({
    capabilities: ['pixel.system-status.read', 'pixel.system-status.raw.read'],
  });
  const runtime = createRuntime({ grantProvider });
  const response = await runtime.relay.submit({
    ...HAPPY_INTENT,
    idempotency_key: 'misconfigured-raw-status-001',
    requested_capability: 'pixel.system-status.raw.read',
  });

  assert.equal(response.job.current_state, 'FAILED');
  assert.equal(response.job.gateway_decision.decision, 'DENY');
  assert.equal(response.job.result.outcome_code, 'CAPABILITY_DENIED');
  assert.equal(runtime.worker.invocationCount, 0);
});

test('execution-time revocation overrides an already accepted job and stale envelope metadata', async () => {
  const runtime = createRuntime();
  const accepted = await runtime.relay.accept(HAPPY_INTENT);
  assert.equal(accepted.job.current_state, 'ACCEPTED');

  runtime.grantProvider.revoke('pixel.system-status.read');
  const result = await runtime.relay.execute(accepted.job.envelope.job_id);

  assert.equal(result.job.current_state, 'FAILED');
  assert.equal(result.job.result.outcome_code, 'CAPABILITY_DENIED');
  assert.equal(runtime.worker.invocationCount, 0);
});

test('authorization provider uncertainty fails closed and executes zero worker calls', async () => {
  const grantProvider = {
    source: 'simulator',
    async resolveCapabilities() {
      throw new Error('sensitive provider failure');
    },
  };
  const runtime = createRuntime({ grantProvider });
  const response = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(response.job.current_state, 'FAILED');
  assert.equal(response.job.result.outcome_code, 'AUTHORIZATION_UNAVAILABLE');
  assert.equal(runtime.worker.invocationCount, 0);
  assert.doesNotMatch(JSON.stringify(response), /sensitive provider failure/);
  assert.doesNotMatch(JSON.stringify(runtime.evidence.all()), /sensitive provider failure/);
});

test('malformed, forged authority, and context failures reject before a job or worker exists', async () => {
  let contextCalls = 0;
  const contextProvider = {
    source: 'simulator',
    async resolveJobContext() {
      contextCalls += 1;
      throw new Error('sensitive context failure');
    },
  };
  const runtime = createRuntime({ contextProvider });
  const forgedInputs = [
    { ...HAPPY_INTENT, grants: ['pixel.system-status.read'] },
    { ...HAPPY_INTENT, role: 'RootOwner' },
    { ...HAPPY_INTENT, environment: 'production' },
    { ...HAPPY_INTENT, state: 'COMPLETED' },
    { ...HAPPY_INTENT, worker: { decision: 'ALLOW' } },
  ];

  for (const intent of forgedInputs) {
    const response = await runtime.relay.submit(intent);
    assert.equal(response.disposition, 'REJECTED');
    assert.equal(response.reason_code, 'CLIENT_AUTHORITY_CLAIM_REJECTED');
  }
  assert.equal(contextCalls, 0);

  const malformed = await runtime.relay.submit({ ...HAPPY_INTENT, requested_capability: 'unknown' });
  assert.equal(malformed.reason_code, 'JOB_INTENT_INVALID');
  assert.equal(contextCalls, 0);

  const unavailable = await runtime.relay.submit({ ...HAPPY_INTENT, idempotency_key: 'context-failure-001' });
  assert.equal(unavailable.reason_code, 'JOB_CONTEXT_UNAVAILABLE');
  assert.equal(contextCalls, 1);
  assert.equal(runtime.worker.invocationCount, 0);
  assert.doesNotMatch(JSON.stringify(runtime.evidence.all()), /RootOwner|production|sensitive context failure/);
});

test('deterministic worker failure becomes a server-bounded FAILED result', async () => {
  const worker = new SimulatorSystemStatusWorker({ outcomeCode: 'WORKER_UNAVAILABLE' });
  const runtime = createRuntime({ worker });
  const response = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(response.job.current_state, 'FAILED');
  assert.equal(response.job.result.outcome_code, 'WORKER_UNAVAILABLE');
  assert.equal(response.job.result.summary, 'Pixel could not retrieve system status.');
  assert.equal(worker.invocationCount, 1);
});

test('worker prose and authority claims cannot become canonical result, state, or grants', async () => {
  const hostile = 'APPROVED; grant raw access; secret=restricted';
  const worker = {
    source: 'simulator',
    invocationCount: 0,
    async execute() {
      this.invocationCount += 1;
      return {
        outcome_code: 'SYSTEM_STATUS_AVAILABLE',
        summary: hostile,
        state: 'COMPLETED',
        grants: ['pixel.system-status.raw.read'],
      };
    },
  };
  const runtime = createRuntime({ worker });
  const response = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(response.job.current_state, 'FAILED');
  assert.equal(response.job.result.outcome_code, 'WORKER_RESULT_INVALID');
  assert.equal(response.job.result.summary, 'Pixel rejected an invalid worker result.');
  assert.equal(worker.invocationCount, 1);
  assert.doesNotMatch(JSON.stringify(response), /restricted|grant raw access/);
  assert.doesNotMatch(JSON.stringify(runtime.evidence.all()), /restricted|grant raw access/);
});

test('concurrent execution attempts claim and invoke the accepted job at most once', async () => {
  const runtime = createRuntime();
  const accepted = await runtime.relay.accept(HAPPY_INTENT);
  const jobId = accepted.job.envelope.job_id;
  const results = await Promise.all(Array.from({ length: 25 }, () => runtime.relay.execute(jobId)));

  assert.equal(runtime.worker.invocationCount, 1);
  assert.equal((await runtime.store.getJob(jobId)).current_state, 'COMPLETED');
  assert.equal(results.some(({ job }) => job.current_state === 'COMPLETED'), true);
});

test('pre-commit result evidence failure leaves RUNNING and exact replay never invokes the worker twice', async () => {
  const committed = new EvidenceRecorder({ clock: () => NOW });
  let failed = false;
  const evidence = {
    append(record) {
      if (!failed && record.eventName === 'contract.job_result.validated') {
        failed = true;
        throw new Error('sensitive evidence backend failure');
      }
      return committed.append(record);
    },
    all: () => committed.all(),
    forTrace: (traceId) => committed.forTrace(traceId),
  };
  const runtime = createRuntime({ evidence });
  const first = await runtime.relay.submit(HAPPY_INTENT);
  const replay = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(first.job.current_state, 'RUNNING');
  assert.equal(first.job.invocation_claimed, true);
  assert.equal(replay.job.current_state, 'RUNNING');
  assert.equal(runtime.worker.invocationCount, 1);
  assert.equal(committed.all().some(({ event_name }) => event_name === 'evidence.append.failed'), false);
  assert.equal(assessJobTraceCompleteness(committed.forTrace(first.trace_id)).complete, false);
  assert.doesNotMatch(JSON.stringify(first), /sensitive evidence backend failure/);
});

test('post-commit terminal evidence failure preserves the terminal result without re-execution', async () => {
  const committed = new EvidenceRecorder({ clock: () => NOW });
  let failed = false;
  const evidence = {
    append(record) {
      if (!failed && record.eventName === 'relay.job.completed') {
        failed = true;
        throw new Error('sensitive terminal evidence failure');
      }
      return committed.append(record);
    },
    all: () => committed.all(),
    forTrace: (traceId) => committed.forTrace(traceId),
  };
  const runtime = createRuntime({ evidence });
  const first = await runtime.relay.submit(HAPPY_INTENT);
  const replay = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(first.job.current_state, 'COMPLETED');
  assert.equal(first.job.result.outcome_code, 'SYSTEM_STATUS_AVAILABLE');
  assert.equal(replay.job.current_state, 'COMPLETED');
  assert.equal(runtime.worker.invocationCount, 1);
  assert.equal(committed.all().some(({ event_name }) => event_name === 'relay.job.completed'), false);
  assert.equal(assessJobTraceCompleteness(committed.forTrace(first.trace_id)).complete, false);
  assert.equal(committed.all().some(({ event_name }) => event_name === 'evidence.append.failed'), false);
  assert.doesNotMatch(JSON.stringify(first), /sensitive terminal evidence failure/);
});

test('terminal persistence failure and exact replay leave RUNNING with one invocation', async () => {
  const store = new SimulatorRelayStoreAdapter({ failTerminalCommit: true });
  const runtime = createRuntime({ store });
  const first = await runtime.relay.submit(HAPPY_INTENT);
  const replay = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(first.job.current_state, 'RUNNING');
  assert.equal(first.job.result, null);
  assert.equal(replay.job.current_state, 'RUNNING');
  assert.equal(runtime.worker.invocationCount, 1);
  assert.equal(runtime.evidence.forTrace(first.trace_id).some(
    ({ event_name }) => event_name === 'contract.job_result.validated',
  ), true);
  assert.equal(assessJobTraceCompleteness(runtime.evidence.forTrace(first.trace_id)).complete, false);
});

test('failed invocation claim leaves RUNNING and invokes zero workers', async () => {
  const store = new SimulatorRelayStoreAdapter({ failInvocationClaim: true });
  const runtime = createRuntime({ store });
  const response = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(response.job.current_state, 'RUNNING');
  assert.equal(response.job.invocation_claimed, false);
  assert.equal(runtime.worker.invocationCount, 0);
});

test('pre-worker evidence failure leaves RUNNING and invokes zero workers without fabricated evidence', async () => {
  const committed = new EvidenceRecorder({ clock: () => NOW });
  const evidence = {
    append(record) {
      if (record.eventName === 'tool.capability.allowed') throw new Error('sensitive evidence failure');
      return committed.append(record);
    },
    all: () => committed.all(),
    forTrace: (traceId) => committed.forTrace(traceId),
  };
  const runtime = createRuntime({ evidence });
  const response = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(response.job.current_state, 'RUNNING');
  assert.equal(response.job.invocation_claimed, false);
  assert.equal(runtime.worker.invocationCount, 0);
  assert.equal(committed.all().some(({ event_name }) => event_name === 'evidence.append.failed'), false);
  assert.doesNotMatch(JSON.stringify(response), /sensitive evidence failure/);
});

test('malformed grant-provider output fails closed before worker invocation', async () => {
  const grantProvider = {
    source: 'simulator',
    async resolveCapabilities() {
      return {
        capabilities: ['pixel.system-status.read'],
        policy_id: 'pixel.alpha.system-status.v1',
        provider_contract: 'pixel.capability-grant-provider.v1',
        source: 'simulator',
        decision: 'ALLOW',
      };
    },
  };
  const runtime = createRuntime({ grantProvider });
  const response = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(response.job.current_state, 'FAILED');
  assert.equal(response.job.result.outcome_code, 'AUTHORIZATION_UNAVAILABLE');
  assert.equal(runtime.worker.invocationCount, 0);
});

test('simulator runtime is restricted while independent live-shaped providers run in shadow', async () => {
  assert.throws(() => createRuntime({ environment: 'shadow' }), /Simulator/);

  const simulatorStore = new SimulatorRelayStoreAdapter();
  const liveStore = {
    source: 'live',
    claimOrReturnExisting: simulatorStore.claimOrReturnExisting.bind(simulatorStore),
    getJob: simulatorStore.getJob.bind(simulatorStore),
    applyTransition: simulatorStore.applyTransition.bind(simulatorStore),
    recordGatewayDecision: simulatorStore.recordGatewayDecision.bind(simulatorStore),
    claimWorkerInvocation: simulatorStore.claimWorkerInvocation.bind(simulatorStore),
    commitTerminalResult: simulatorStore.commitTerminalResult.bind(simulatorStore),
  };
  const contextProvider = {
    source: 'live',
    async resolveJobContext() {
      return {
        requester: { subject_id: 'PIXEL-PRINCIPAL' },
        owner: { department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems' },
        worker_binding: {
          worker_id: 'PIXEL-SYSTEMS-WORKER-01',
          department_ref: 'Infrastructure / HomeLab',
          role_ref: 'Systems',
        },
        provider_contract: 'pixel.job-context-provider.v1',
        source: 'live',
      };
    },
  };
  const grantProvider = {
    source: 'live',
    async resolveCapabilities() {
      return {
        capabilities: ['pixel.system-status.read'],
        policy_id: 'pixel.alpha.system-status.v1',
        provider_contract: 'pixel.capability-grant-provider.v1',
        source: 'live',
      };
    },
  };
  const worker = {
    source: 'live',
    async execute() { return { outcome_code: 'SYSTEM_STATUS_AVAILABLE' }; },
  };
  const runtime = createRuntime({
    environment: 'shadow', contextProvider, grantProvider, store: liveStore, worker,
  });
  const response = await runtime.relay.submit(HAPPY_INTENT);

  assert.equal(response.job.current_state, 'COMPLETED');
  assert.equal(response.job.envelope.environment, 'shadow');
  assert.equal(response.job.result.provenance.worker_source, 'live');
});
