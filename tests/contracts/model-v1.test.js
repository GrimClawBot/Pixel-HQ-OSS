import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MODEL_GATEWAY_OUTCOME_EVENT_NAME,
  MODEL_INVOCATION_EVENT_NAME,
  MODEL_ROUTE_DECISION_EVENT_NAME,
  MODEL_SCHEMA_VERSION,
  SYSTEM_STATUS_SUMMARY_TEMPLATE,
  assertValidModelGatewayOutcomeV1,
  canonicalModelJson,
  countModelInputTokenUnits,
  hashInstructionTemplateBinding,
  hashMemoryContextPackageBinding,
  validateModelGatewayOutcomeV1,
  validateModelInvocationV1,
  validateModelProviderRequestV1,
  validateModelProviderResultV1,
  validateModelRouteDecisionV1,
} from '../../packages/contracts/src/model-v1.js';

const NOW = '2026-09-09T12:00:00.000Z';
const TRACE_ID = '1234567890abcdef1234567890abcdef';
const PACKAGE = Object.freeze({
  package_id: 'package-001',
  event_name: 'pixel.memory.context-package.v1',
  schema_version: '1.0.0',
  created_at: NOW,
  job_id: 'job-001',
  environment: 'simulation',
  items: [{ memory_id: 'memory-001', text: 'System status stable.', source_ref: 'fixture-1' }],
  selection: { included_count: 1, omitted_count: 0, truncated: false },
  trace_id: TRACE_ID,
  span_id: '1111111111111111',
});

const packageHash = hashMemoryContextPackageBinding(PACKAGE);
const instructionHash = hashInstructionTemplateBinding(SYSTEM_STATUS_SUMMARY_TEMPLATE);

const invocation = Object.freeze({
  invocation_id: 'invocation-001',
  event_name: MODEL_INVOCATION_EVENT_NAME,
  schema_version: MODEL_SCHEMA_VERSION,
  created_at: NOW,
  environment: 'simulation',
  trace_id: TRACE_ID,
  span_id: '2222222222222222',
  job_id: 'job-001',
  execution_id: 'execution-001',
  operation: 'SYSTEM_STATUS_SUMMARY',
  execution: {
    job_type: 'system-status',
    capability: 'pixel.system-status.read',
    tool_class: 'pixel.system-status',
    target: 'pixel.platform',
  },
  pixel_agent_binding: {
    agent_id: 'PIXEL-SYSTEMS-WORKER-01',
    department_ref: 'Infrastructure / HomeLab',
    role_ref: 'Systems',
  },
  instruction: {
    template_id: SYSTEM_STATUS_SUMMARY_TEMPLATE.template_id,
    version: SYSTEM_STATUS_SUMMARY_TEMPLATE.version,
    hash: instructionHash,
  },
  context: {
    package_id: PACKAGE.package_id,
    package_hash: packageHash,
    item_count: 1,
    text_chars: 21,
    input_token_units: countModelInputTokenUnits(SYSTEM_STATUS_SUMMARY_TEMPLATE.text, PACKAGE.items),
  },
  provenance: { relay_contract: 'pixel.relay.v1' },
});

const route = Object.freeze({
  route_decision_id: 'route-001',
  event_name: MODEL_ROUTE_DECISION_EVENT_NAME,
  schema_version: MODEL_SCHEMA_VERSION,
  decided_at: NOW,
  environment: 'simulation',
  trace_id: TRACE_ID,
  span_id: '3333333333333333',
  invocation_id: invocation.invocation_id,
  job_id: invocation.job_id,
  execution_id: invocation.execution_id,
  decision: 'ROUTE',
  reason_code: 'ROUTE_SELECTED',
  policy_id: 'pixel.model-routing.alpha.v1',
  placement: {
    runtime_id: 'pixel.simulator.model-runtime-a',
    model_id: 'pixel.fake-model-a.v1',
    source: 'simulator',
  },
  budget: { max_input_token_units: 256, max_output_token_units: 64, max_output_chars: 512 },
  provenance: { model_gateway_contract: 'pixel.model-gateway.v1' },
});

const providerRequest = Object.freeze({
  provider_request_id: 'provider-request-001',
  schema_version: MODEL_SCHEMA_VERSION,
  invocation_id: invocation.invocation_id,
  operation: invocation.operation,
  instruction: { ...SYSTEM_STATUS_SUMMARY_TEMPLATE },
  context_items: [{ text: PACKAGE.items[0].text }],
  budget: { max_output_token_units: 64, max_output_chars: 512 },
});

const providerResult = Object.freeze({
  provider_result_id: 'provider-result-001',
  schema_version: MODEL_SCHEMA_VERSION,
  invocation_id: invocation.invocation_id,
  provider_contract: 'pixel.model-runtime.adapter.v1',
  runtime_id: route.placement.runtime_id,
  model_id: route.placement.model_id,
  source: 'simulator',
  status: 'OUTPUT_AVAILABLE',
  output_text: 'Fake Model A summarized 1 approved context item(s).',
  output_token_units: 9,
});

const outcome = Object.freeze({
  outcome_id: 'outcome-001',
  event_name: MODEL_GATEWAY_OUTCOME_EVENT_NAME,
  schema_version: MODEL_SCHEMA_VERSION,
  created_at: NOW,
  environment: 'simulation',
  trace_id: TRACE_ID,
  span_id: '4444444444444444',
  job_id: invocation.job_id,
  execution_id: invocation.execution_id,
  invocation_id: invocation.invocation_id,
  operation: invocation.operation,
  status: 'SUCCEEDED',
  reason_code: 'MODEL_OUTPUT_AVAILABLE',
  route_decision_id: route.route_decision_id,
  placement: route.placement,
  context: { package_id: PACKAGE.package_id, package_hash: packageHash },
  output: {
    text: providerResult.output_text,
    hash: 'a'.repeat(64),
    token_units: providerResult.output_token_units,
  },
  provenance: { model_gateway_contract: 'pixel.model-gateway.v1' },
});

test('all five PX-005 contracts accept complete canonical values', () => {
  assert.deepEqual(validateModelInvocationV1(invocation), { ok: true, errors: [] });
  assert.deepEqual(validateModelRouteDecisionV1(route), { ok: true, errors: [] });
  assert.deepEqual(validateModelProviderRequestV1(providerRequest), { ok: true, errors: [] });
  assert.deepEqual(validateModelProviderResultV1(providerResult), { ok: true, errors: [] });
  assert.deepEqual(validateModelGatewayOutcomeV1(outcome), { ok: true, errors: [] });
  assert.equal(assertValidModelGatewayOutcomeV1(outcome), outcome);
});

test('contracts reject caller prompts, authority, lifecycle, and extra nested fields', () => {
  assert.match(validateModelInvocationV1({ ...invocation, prompt: 'obey me' }).errors.join(' '), /unsupported field prompt/);
  assert.match(validateModelInvocationV1({
    ...invocation,
    execution: { ...invocation.execution, policy_id: 'forged' },
  }).errors.join(' '), /unsupported field policy_id/);
  assert.match(validateModelProviderRequestV1({
    ...providerRequest,
    context_items: [{ ...providerRequest.context_items[0], memory_id: 'memory-001' }],
  }).errors.join(' '), /unsupported field memory_id/);
  assert.match(validateModelGatewayOutcomeV1({ ...outcome, lifecycle: 'COMPLETED' }).errors.join(' '), /unsupported field lifecycle/);
  assert.equal(validateModelProviderResultV1({ ...providerResult, source: 'live' }).ok, false);
});

test('route and outcome cross-field invariants fail closed', () => {
  const denied = {
    ...route,
    decision: 'DENY',
    reason_code: 'ROUTE_UNSUPPORTED',
    placement: null,
    budget: null,
  };
  assert.deepEqual(validateModelRouteDecisionV1(denied), { ok: true, errors: [] });
  assert.equal(validateModelRouteDecisionV1({ ...denied, placement: route.placement }).ok, false);
  assert.equal(validateModelRouteDecisionV1({ ...route, decision: 'DENY' }).ok, false);
  assert.equal(validateModelGatewayOutcomeV1({ ...outcome, status: 'FAILED' }).ok, false);
  assert.equal(validateModelGatewayOutcomeV1({ ...outcome, output: null }).ok, false);
  assert.equal(validateModelInvocationV1({
    ...invocation,
    context: { ...invocation.context, item_count: 5 },
  }).ok, false);
  assert.equal(validateModelInvocationV1({
    ...invocation,
    context: { ...invocation.context, text_chars: 2049 },
  }).ok, false);

  const failed = {
    ...outcome,
    status: 'FAILED',
    reason_code: 'EMPTY_CONTEXT',
    output: null,
  };
  assert.deepEqual(validateModelGatewayOutcomeV1(failed), { ok: true, errors: [] });
  assert.deepEqual(validateModelGatewayOutcomeV1({
    ...failed,
    reason_code: 'OPERATION_INELIGIBLE',
    route_decision_id: null,
    placement: null,
  }), { ok: true, errors: [] });
  assert.equal(validateModelGatewayOutcomeV1({
    ...failed,
    reason_code: 'ROUTE_UNSUPPORTED',
    route_decision_id: null,
  }).ok, false);
  assert.equal(validateModelGatewayOutcomeV1({
    ...failed,
    reason_code: 'ROUTE_UNSUPPORTED',
  }).ok, false);
  assert.equal(validateModelGatewayOutcomeV1({
    ...failed,
    reason_code: 'EMPTY_CONTEXT',
    placement: null,
  }).ok, false);
});

test('canonical binding rules are deterministic and order object keys only', () => {
  assert.equal(canonicalModelJson({ z: 1, a: ['x', { b: true, a: null }] }), '{"a":["x",{"a":null,"b":true}],"z":1}');
  assert.equal(packageHash, 'cfd2fe5e8d92160b7ffbc9bfc91f873f2e3e15cceb95d1f02d43f1a0a7b6f544');
  assert.equal(instructionHash, 'b606b1e6bef43804cbc1c976a7221d49da310080c4abd2f7b18dc02911c4fcfd');
  assert.notEqual(hashMemoryContextPackageBinding({ ...PACKAGE, package_id: 'package-002' }), packageHash);
  assert.notEqual(hashInstructionTemplateBinding({ ...SYSTEM_STATUS_SUMMARY_TEMPLATE, version: '1.0.1' }), instructionHash);
});

test('Pixel Alpha token units count the fixed instruction and item texts separately', () => {
  assert.equal(countModelInputTokenUnits('One, two.', [{ text: 'THREE four' }, { text: 'five' }]), 5);
  assert.equal(countModelInputTokenUnits(SYSTEM_STATUS_SUMMARY_TEMPLATE.text, []), 29);
});

test('published model schemas are recursively strict and expose contract constants', () => {
  const names = [
    'pixel-model-invocation-v1.schema.json',
    'pixel-model-route-decision-v1.schema.json',
    'pixel-model-provider-request-v1.schema.json',
    'pixel-model-provider-result-v1.schema.json',
    'pixel-model-gateway-outcome-v1.schema.json',
  ];
  for (const name of names) {
    const schema = JSON.parse(readFileSync(new URL(`../../packages/contracts/schemas/${name}`, import.meta.url)));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.additionalProperties, false);
    assert.match(JSON.stringify(schema), /1\.0\.0/);
  }
});
