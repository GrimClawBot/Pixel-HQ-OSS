import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SYSTEM_STATUS_SUMMARY_TEMPLATE,
  countModelInputTokenUnits,
  hashInstructionTemplateBinding,
  hashMemoryContextPackageBinding,
} from '../../packages/contracts/src/model-v1.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { ModelGateway } from '../../services/model-gateway/src/model-gateway.js';

const NOW = '2026-09-09T12:00:00.000Z';
const TRACE_ID = '1234567890abcdef1234567890abcdef';

function makeIds() {
  let value = 8000;
  return { nextEventId: () => `event-${++value}`, nextSpanId: () => (++value).toString(16).padStart(16, '0') };
}

function packageFor(environment, items) {
  return {
    package_id: 'package-001', event_name: 'pixel.memory.context-package.v1', schema_version: '1.0.0',
    created_at: NOW, job_id: 'job-001', environment, items,
    selection: { included_count: items.length, omitted_count: 0, truncated: false },
    trace_id: TRACE_ID, span_id: '2222222222222222',
  };
}

function invocationFor(environment, pkg, capability) {
  return {
    invocation_id: 'invocation-001', event_name: 'pixel.model.invocation.v1', schema_version: '1.0.0',
    created_at: NOW, environment, trace_id: TRACE_ID, span_id: '5555555555555555',
    job_id: 'job-001', execution_id: 'execution-001', operation: 'SYSTEM_STATUS_SUMMARY',
    execution: { job_type: 'system-status', capability, tool_class: 'pixel.system-status', target: 'pixel.platform' },
    pixel_agent_binding: { agent_id: 'PIXEL-SYSTEMS-WORKER-01', department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems' },
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

function jobFor(invocation, source) {
  const binding = { worker_id: 'PIXEL-SYSTEMS-WORKER-01', department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems' };
  return {
    envelope: {
      job_id: 'job-001', event_name: 'pixel.relay.job-envelope.v1', schema_version: '1.0.0', created_at: NOW,
      environment: invocation.environment, trace_id: TRACE_ID, span_id: '1111111111111111',
      requester: { subject_id: 'PIXEL-PRINCIPAL' }, owner: { department_ref: binding.department_ref, role_ref: binding.role_ref },
      job_type: 'system-status', requested_capability: invocation.execution.capability,
      execution: {
        capability: invocation.execution.capability,
        tool_class: invocation.execution.tool_class,
        target: invocation.execution.target,
        parameter_hash: 'a'.repeat(64),
        worker_binding: binding,
      },
      state: 'SUBMITTED', idempotency: { key: 'model-status-001', fingerprint: 'b'.repeat(64) },
      provenance: { relay_contract: 'pixel.relay.v1', context_provider_contract: 'pixel.job-context-provider.v1', context_source: source },
    },
    current_state: 'RUNNING', execution_id: 'execution-001',
    transitions: [
      { transition_id: 'transition-001', event_name: 'pixel.relay.job-transition.v1', schema_version: '1.0.0', occurred_at: NOW, environment: invocation.environment, trace_id: TRACE_ID, span_id: '3333333333333333', job_id: 'job-001', execution_id: null, from_state: 'SUBMITTED', to_state: 'ACCEPTED', reason_code: 'JOB_ACCEPTED', provenance: { relay_contract: 'pixel.relay.v1' } },
      { transition_id: 'transition-002', event_name: 'pixel.relay.job-transition.v1', schema_version: '1.0.0', occurred_at: NOW, environment: invocation.environment, trace_id: TRACE_ID, span_id: '4444444444444444', job_id: 'job-001', execution_id: 'execution-001', from_state: 'ACCEPTED', to_state: 'RUNNING', reason_code: 'EXECUTION_STARTED', provenance: { relay_contract: 'pixel.relay.v1' } },
    ],
    execution_request: null, gateway_decision: null, invocation_claimed: false,
    model_invocation: invocation, model_invocation_claimed: true, result: null,
  };
}

function adapter({ calls, output = 'bounded output', claimedUnits = 2, accessor = false } = {}) {
  return {
    source: 'simulator', providerContract: 'pixel.model-runtime.adapter.v1',
    runtimeId: 'pixel.simulator.model-runtime-a', modelId: 'pixel.fake-model-a.v1',
    invoke(request) {
      calls.count += 1;
      const value = {
        provider_result_id: 'provider-result-001', schema_version: '1.0.0', invocation_id: request.invocation_id,
        provider_contract: 'pixel.model-runtime.adapter.v1', runtime_id: this.runtimeId,
        model_id: this.modelId, source: this.source, status: 'OUTPUT_AVAILABLE',
        output_text: output, output_token_units: claimedUnits,
      };
      if (!accessor) return value;
      let reads = 0;
      const unsafe = { ...value };
      delete unsafe.output_text;
      Object.defineProperty(unsafe, 'output_text', { enumerable: true, get() { reads += 1; return output; } });
      calls.accessorReads = () => reads;
      return unsafe;
    },
  };
}

function runtime({ environment = 'simulation', capability = 'pixel.system-status.read', items, adapters } = {}) {
  const pkg = packageFor(environment, items ?? [{ memory_id: 'memory-001', text: 'System status stable.', source_ref: 'fixture-1' }]);
  const invocation = invocationFor(environment, pkg, capability);
  const source = ['dev', 'simulation'].includes(environment) ? 'simulator' : 'live';
  const job = jobFor(invocation, source);
  const store = {
    source,
    getJob: () => structuredClone(job),
    claimOrReturnExisting() {}, applyTransition() {}, recordGatewayDecision() {},
    claimWorkerInvocation() {}, claimModelInvocation() {}, commitTerminalResult() {},
  };
  const evidence = new EvidenceRecorder({ clock: () => NOW });
  const gateway = new ModelGateway({
    environment, store, memory: { getApprovedContextPackage: () => structuredClone(pkg) },
    adapters: adapters ?? [], evidence, ids: makeIds(), clock: () => NOW,
  });
  return { evidence, gateway, invocation, pkg };
}

test('raw system-status capability is ineligible before routing or provider invocation', async () => {
  const calls = { count: 0 };
  const subject = runtime({ capability: 'pixel.system-status.raw.read', adapters: [adapter({ calls })] });
  const outcome = await subject.gateway.invoke({ invocation: subject.invocation, parentSpanId: subject.invocation.span_id });

  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.reason_code, 'OPERATION_INELIGIBLE');
  assert.equal(outcome.route_decision_id, null);
  assert.equal(calls.count, 0);
  assert.equal(subject.evidence.all().some(({ event_name }) => event_name === 'model.route.decided'), false);
});

test('empty and over-input-budget packages fail before provider invocation with no fallback', async () => {
  for (const [items, reason] of [
    [[], 'EMPTY_CONTEXT'],
    [[{ memory_id: 'memory-001', text: `${'x '.repeat(228)}end`, source_ref: 'fixture-1' }], 'INPUT_BUDGET_EXCEEDED'],
  ]) {
    const selected = { count: 0 };
    const fallback = { count: 0 };
    const subject = runtime({ items, adapters: [adapter({ calls: selected }), {
      ...adapter({ calls: fallback }), runtimeId: 'pixel.simulator.model-runtime-b', modelId: 'pixel.fake-model-b.v1',
    }] });
    const outcome = await subject.gateway.invoke({ invocation: subject.invocation, parentSpanId: subject.invocation.span_id });
    assert.equal(outcome.reason_code, reason);
    assert.equal(selected.count, 0);
    assert.equal(fallback.count, 0);
  }
});

test('unsupported environments fail closed without an adapter or fallback', async () => {
  const subject = runtime({ environment: 'shadow', adapters: [] });
  const outcome = await subject.gateway.invoke({ invocation: subject.invocation, parentSpanId: subject.invocation.span_id });
  assert.equal(outcome.reason_code, 'ROUTE_UNSUPPORTED');
  assert.equal(outcome.placement, null);
});

test('accessor-backed and usage-mismatched provider results fail closed without reading accessors', async () => {
  for (const options of [{ accessor: true }, { output: 'bounded output', claimedUnits: 99 }]) {
    const calls = { count: 0 };
    const subject = runtime({ adapters: [adapter({ calls, ...options })] });
    const outcome = await subject.gateway.invoke({ invocation: subject.invocation, parentSpanId: subject.invocation.span_id });
    assert.equal(outcome.reason_code, 'PROVIDER_RESULT_INVALID');
    assert.equal(calls.count, 1);
    if (options.accessor) assert.equal(calls.accessorReads(), 0);
  }
});

test('output over the selected route cap is rejected and never invokes another model', async () => {
  const selected = { count: 0 };
  const fallback = { count: 0 };
  const text = `${'word '.repeat(64)}last`;
  const subject = runtime({ adapters: [
    adapter({ calls: selected, output: text, claimedUnits: 65 }),
    { ...adapter({ calls: fallback }), runtimeId: 'pixel.simulator.model-runtime-b', modelId: 'pixel.fake-model-b.v1' },
  ] });
  const outcome = await subject.gateway.invoke({ invocation: subject.invocation, parentSpanId: subject.invocation.span_id });
  assert.equal(outcome.reason_code, 'OUTPUT_BUDGET_EXCEEDED');
  assert.equal(selected.count, 1);
  assert.equal(fallback.count, 0);
});
