import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeModelASimulatorAdapter } from '../../adapters/simulator/src/fake-model-a-simulator-adapter.js';
import { FakeModelBSimulatorAdapter } from '../../adapters/simulator/src/fake-model-b-simulator-adapter.js';
import { SimulatorJobContextProvider } from '../../adapters/simulator/src/job-context-simulator-provider.js';
import { SimulatorMemoryIntakeContextProvider } from '../../adapters/simulator/src/memory-intake-context-simulator-provider.js';
import { SimulatorMemoryStoreAdapter } from '../../adapters/simulator/src/memory-store-simulator-adapter.js';
import { SimulatorRelayStoreAdapter } from '../../adapters/simulator/src/relay-store-simulator-adapter.js';
import {
  SYSTEM_STATUS_SUMMARY_TEMPLATE,
  countModelInputTokenUnits,
  hashInstructionTemplateBinding,
  hashMemoryContextPackageBinding,
} from '../../packages/contracts/src/model-v1.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { ModelGateway } from '../../services/model-gateway/src/model-gateway.js';
import { MemoryService } from '../../services/memory/src/memory-service.js';
import { RelayService } from '../../services/relay/src/relay-service.js';

const NOW = '2026-09-09T12:00:00.000Z';
const TRACE_ID = '1234567890abcdef1234567890abcdef';

function ids(seed = 1000) {
  let value = seed;
  return {
    nextEventId: () => `event-${++value}`,
    nextSpanId: () => (++value).toString(16).padStart(16, '0'),
  };
}

function envelope(environment, capability = 'pixel.system-status.read') {
  return {
    job_id: 'job-001', event_name: 'pixel.relay.job-envelope.v1', schema_version: '1.0.0',
    created_at: NOW, environment, trace_id: TRACE_ID, span_id: '1111111111111111',
    requester: { subject_id: 'PIXEL-PRINCIPAL' },
    owner: { department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems' },
    job_type: 'system-status', requested_capability: capability,
    execution: {
      capability, tool_class: 'pixel.system-status', target: 'pixel.platform',
      parameter_hash: 'a'.repeat(64),
      worker_binding: {
        worker_id: 'PIXEL-SYSTEMS-WORKER-01',
        department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems',
      },
    },
    state: 'SUBMITTED', idempotency: { key: 'model-status-001', fingerprint: 'b'.repeat(64) },
    provenance: {
      relay_contract: 'pixel.relay.v1', context_provider_contract: 'pixel.job-context-provider.v1',
      context_source: environment === 'dev' || environment === 'simulation' ? 'simulator' : 'live',
    },
  };
}

function transition(from, to, executionId, id, span) {
  return {
    transition_id: id, event_name: 'pixel.relay.job-transition.v1', schema_version: '1.0.0',
    occurred_at: NOW, environment: 'simulation', trace_id: TRACE_ID, span_id: span,
    job_id: 'job-001', execution_id: executionId, from_state: from, to_state: to,
    reason_code: to === 'ACCEPTED' ? 'JOB_ACCEPTED' : 'EXECUTION_STARTED',
    provenance: { relay_contract: 'pixel.relay.v1' },
  };
}

function contextPackage(environment, items = [{
  memory_id: 'memory-001', text: 'System status stable.', source_ref: 'fixture-1',
}]) {
  return {
    package_id: 'package-001', event_name: 'pixel.memory.context-package.v1', schema_version: '1.0.0',
    created_at: NOW, job_id: 'job-001', environment, items,
    selection: { included_count: items.length, omitted_count: 0, truncated: false },
    trace_id: TRACE_ID, span_id: '2222222222222222',
  };
}

function invocation(environment, pkg, capability = 'pixel.system-status.read') {
  return {
    invocation_id: 'invocation-001', event_name: 'pixel.model.invocation.v1', schema_version: '1.0.0',
    created_at: NOW, environment, trace_id: TRACE_ID, span_id: '5555555555555555',
    job_id: 'job-001', execution_id: 'execution-001', operation: 'SYSTEM_STATUS_SUMMARY',
    execution: { job_type: 'system-status', capability, tool_class: 'pixel.system-status', target: 'pixel.platform' },
    pixel_agent_binding: {
      agent_id: 'PIXEL-SYSTEMS-WORKER-01',
      department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems',
    },
    instruction: {
      template_id: SYSTEM_STATUS_SUMMARY_TEMPLATE.template_id,
      version: SYSTEM_STATUS_SUMMARY_TEMPLATE.version,
      hash: hashInstructionTemplateBinding(SYSTEM_STATUS_SUMMARY_TEMPLATE),
    },
    context: {
      package_id: pkg.package_id, package_hash: hashMemoryContextPackageBinding(pkg),
      item_count: pkg.items.length,
      text_chars: pkg.items.reduce((sum, item) => sum + Array.from(item.text).length, 0),
      input_token_units: countModelInputTokenUnits(SYSTEM_STATUS_SUMMARY_TEMPLATE.text, pkg.items),
    },
    provenance: { relay_contract: 'pixel.relay.v1' },
  };
}

async function subject(environment) {
  const pkg = contextPackage(environment);
  const inv = invocation(environment, pkg);
  const store = new SimulatorRelayStoreAdapter();
  await store.claimOrReturnExisting({ namespace: 'model-status', fingerprint: 'b'.repeat(64), candidateJob: envelope(environment) });
  const accepted = transition('SUBMITTED', 'ACCEPTED', null, 'transition-001', '3333333333333333');
  accepted.environment = environment;
  await store.applyTransition('job-001', accepted);
  const running = transition('ACCEPTED', 'RUNNING', 'execution-001', 'transition-002', '4444444444444444');
  running.environment = environment;
  await store.applyTransition('job-001', running);
  await store.claimModelInvocation('job-001', inv);
  const evidence = new EvidenceRecorder({ clock: () => NOW });
  const gateway = new ModelGateway({
    environment,
    store,
    memory: { getApprovedContextPackage: (packageId) => packageId === pkg.package_id ? structuredClone(pkg) : null },
    adapters: [new FakeModelASimulatorAdapter(), new FakeModelBSimulatorAdapter()],
    evidence,
    ids: ids(environment === 'simulation' ? 1000 : 2000),
    clock: () => NOW,
  });
  return { evidence, gateway, invocation: inv, pkg, store };
}

for (const [environment, expectedRuntime, expectedModel, expectedText] of [
  ['simulation', 'pixel.simulator.model-runtime-a', 'pixel.fake-model-a.v1', 'Fake Model A summarized 1 approved context item(s).'],
  ['dev', 'pixel.simulator.model-runtime-b', 'pixel.fake-model-b.v1', 'Fake Model B summarized 1 approved context item(s).'],
]) {
  test(`${environment} invokes its one deterministic model route with bounded context`, async () => {
    const runtime = await subject(environment);
    const outcome = await runtime.gateway.invoke({ invocation: runtime.invocation, parentSpanId: runtime.invocation.span_id });

    assert.equal(outcome.status, 'SUCCEEDED');
    assert.equal(outcome.placement.runtime_id, expectedRuntime);
    assert.equal(outcome.placement.model_id, expectedModel);
    assert.equal(outcome.output.text, expectedText);
    assert.equal(outcome.context.package_hash, runtime.invocation.context.package_hash);
    assert.equal((await runtime.store.getJob('job-001')).current_state, 'RUNNING');
    assert.equal(Object.isFrozen(outcome), true);
  });
}

test('provider receives only fixed instruction, approved item text, opaque invocation, operation, and output budget', async () => {
  const runtime = await subject('simulation');
  let received;
  const adapter = {
    source: 'simulator', providerContract: 'pixel.model-runtime.adapter.v1',
    runtimeId: 'pixel.simulator.model-runtime-a', modelId: 'pixel.fake-model-a.v1',
    invoke(request) {
      received = structuredClone(request);
      return new FakeModelASimulatorAdapter().invoke(request);
    },
  };
  const gateway = new ModelGateway({
    environment: 'simulation', store: runtime.store,
    memory: { getApprovedContextPackage: () => structuredClone(runtime.pkg) },
    adapters: [adapter], evidence: runtime.evidence, ids: ids(3000), clock: () => NOW,
  });

  await gateway.invoke({ invocation: runtime.invocation, parentSpanId: runtime.invocation.span_id });
  assert.deepEqual(Object.keys(received).sort(), [
    'budget', 'context_items', 'instruction', 'invocation_id', 'operation', 'provider_request_id', 'schema_version',
  ]);
  assert.deepEqual(received.context_items, [{ text: 'System status stable.' }]);
  assert.equal(JSON.stringify(received).includes('PIXEL-PRINCIPAL'), false);
  assert.equal(JSON.stringify(received).includes('memory-001'), false);
  assert.equal(JSON.stringify(received).includes('job-001'), false);
});

function relayIds(seed = 20_000) {
  let value = seed;
  return {
    nextEventId: () => `event-${++value}`,
    nextJobId: () => `job-${++value}`,
    nextExecutionId: () => `execution-${++value}`,
    nextMemoryId: () => `memory-${++value}`,
    nextRequestId: () => `request-${++value}`,
    nextPackageId: () => `package-${++value}`,
    nextSpanId: () => (++value).toString(16).padStart(16, '0'),
    nextTraceId: () => (++value).toString(16).padStart(32, '0'),
  };
}

function modelRelayRuntime({ capability = 'pixel.system-status.read', gatewayOverride, withMemory = true } = {}) {
  const allIds = relayIds();
  const evidence = new EvidenceRecorder({ clock: () => NOW });
  const store = new SimulatorRelayStoreAdapter();
  const memory = new MemoryService({
    environment: 'simulation',
    intakeContextProvider: new SimulatorMemoryIntakeContextProvider(),
    memoryStore: new SimulatorMemoryStoreAdapter(),
    relayStore: store,
    evidence,
    ids: allIds,
    clock: () => NOW,
  });
  const gatewayStore = {
    source: 'simulator',
    getJob: store.getJob.bind(store),
    claimOrReturnExisting() { throw new Error('Gateway cannot create jobs'); },
    applyTransition() { throw new Error('Gateway cannot transition jobs'); },
    recordGatewayDecision() { throw new Error('Gateway cannot record Tool Gateway decisions'); },
    claimWorkerInvocation() { throw new Error('Gateway cannot claim workers'); },
    claimModelInvocation() { throw new Error('Gateway cannot claim model invocations'); },
    commitTerminalResult() { throw new Error('Gateway cannot commit terminal results'); },
  };
  const gateway = gatewayOverride ?? new ModelGateway({
    environment: 'simulation',
    store: gatewayStore,
    memory,
    adapters: [new FakeModelASimulatorAdapter(), new FakeModelBSimulatorAdapter()],
    evidence,
    ids: allIds,
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
    ids: allIds,
    clock: () => NOW,
  });
  const prepare = async () => {
    if (withMemory) {
      await memory.intake({
        event_name: 'pixel.memory.intake-intent.v1', schema_version: '1.0.0',
        content: { text: 'System status stable.', tags: ['system', 'status'] },
      });
    }
    return relay.accept({
      event_name: 'pixel.job.submit-intent.v1', schema_version: '1.0.0',
      idempotency_key: `model-${capability.replaceAll('.', '-')}`,
      job_type: 'system-status', requested_capability: capability,
    });
  };
  return { evidence, gateway, memory, prepare, relay, store };
}

test('Relay owns invocation creation, terminal commit, and truthful model provenance', async () => {
  const runtime = modelRelayRuntime();
  const accepted = await runtime.prepare();
  const response = await runtime.relay.executeModelSummary(accepted.job.envelope.job_id);

  assert.equal(response.disposition, 'COMPLETED');
  assert.equal(response.job.current_state, 'COMPLETED');
  assert.equal(response.job.result.outcome_code, 'SYSTEM_STATUS_AVAILABLE');
  assert.equal(response.job.result.provenance.model_gateway_contract, 'pixel.model-gateway.v1');
  assert.equal(response.job.result.provenance.worker_contract, undefined);
  assert.equal(response.model_output.text, 'Fake Model A summarized 1 approved context item(s).');
  assert.equal(response.job.result.summary, 'Pixel system status is available.');
  assert.equal(response.job.model_invocation_claimed, true);
  assert.equal(response.job.gateway_decision, null);

  const names = runtime.evidence.forTrace(response.trace_id).map(({ event_name }) => event_name);
  assert.ok(names.indexOf('memory.context.package_created') < names.indexOf('relay.job.running'));
  assert.ok(names.indexOf('relay.job.running') < names.indexOf('model.invocation.created'));
  assert.ok(names.indexOf('model.invocation.claimed') < names.indexOf('model.invocation.validated'));
});

test('raw capability and empty package become Relay-owned WORKER_FAILED terminals without provider work', async () => {
  for (const options of [
    { capability: 'pixel.system-status.raw.read', withMemory: true },
    { capability: 'pixel.system-status.read', withMemory: false },
  ]) {
    const runtime = modelRelayRuntime(options);
    const accepted = await runtime.prepare();
    const response = await runtime.relay.executeModelSummary(accepted.job.envelope.job_id);
    assert.equal(response.job.current_state, 'FAILED');
    assert.equal(response.job.result.outcome_code, 'WORKER_UNAVAILABLE');
    assert.equal(response.job.transitions.at(-1).reason_code, 'WORKER_FAILED');
    assert.equal(runtime.evidence.forTrace(response.trace_id).some(({ event_name }) => event_name === 'model.provider.invocation_started'), false);
  }
});

test('malformed Gateway outcome becomes FAILED / WORKER_RESULT_INVALID after RUNNING', async () => {
  const malformedGateway = {
    async invoke() { return { status: 'SUCCEEDED', lifecycle: 'COMPLETED', authority: 'ALLOW' }; },
  };
  const runtime = modelRelayRuntime({ gatewayOverride: malformedGateway });
  const accepted = await runtime.prepare();
  const response = await runtime.relay.executeModelSummary(accepted.job.envelope.job_id);

  assert.equal(response.job.current_state, 'FAILED');
  assert.equal(response.job.result.outcome_code, 'WORKER_RESULT_INVALID');
  assert.equal(response.job.transitions.at(-1).reason_code, 'WORKER_RESULT_INVALID');
  assert.equal(response.model_output, null);
});

test('concurrent model execution attempts claim and invoke one canonical invocation', async () => {
  const runtime = modelRelayRuntime();
  const accepted = await runtime.prepare();
  const responses = await Promise.all(Array.from({ length: 20 }, () => (
    runtime.relay.executeModelSummary(accepted.job.envelope.job_id)
  )));
  assert.equal(responses.filter(({ disposition }) => disposition === 'COMPLETED').length, 1);
  assert.equal(runtime.evidence.forTrace(accepted.trace_id)
    .filter(({ event_name }) => event_name === 'model.provider.invocation_started').length, 1);
});
