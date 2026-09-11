import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertValidJobEnvelopeV1,
  assertValidJobResultV1,
  assertValidJobSubmitIntentV1,
  assertValidJobTransitionV1,
  assertValidToolCapabilityDecisionV1,
  assertValidToolExecutionRequestV1,
  JOB_SCHEMA_VERSION,
  validateJobEnvelopeV1,
  validateJobResultV1,
  validateJobSubmitIntentV1,
  validateJobTransitionV1,
  validateToolCapabilityDecisionV1,
  validateToolExecutionRequestV1,
} from '../../packages/contracts/src/job-v1.js';

const TRACE_ID = '1234567890abcdef1234567890abcdef';
const SPAN_ID = '1234567890abcdef';
const NOW = '2026-09-07T12:00:00.000Z';
const BINDING = Object.freeze({
  worker_id: 'PIXEL-SYSTEMS-WORKER-01',
  department_ref: 'Infrastructure / HomeLab',
  role_ref: 'Systems',
});
const EXECUTION = Object.freeze({
  capability: 'pixel.system-status.read',
  tool_class: 'pixel.system-status',
  target: 'pixel.platform',
  parameter_hash: 'a'.repeat(64),
  worker_binding: BINDING,
});

const fixtures = {
  intent: {
    event_name: 'pixel.job.submit-intent.v1',
    schema_version: JOB_SCHEMA_VERSION,
    idempotency_key: 'status-check-001',
    job_type: 'system-status',
    requested_capability: 'pixel.system-status.read',
  },
  envelope: {
    job_id: 'job-001',
    event_name: 'pixel.relay.job-envelope.v1',
    schema_version: JOB_SCHEMA_VERSION,
    created_at: NOW,
    environment: 'simulation',
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
    requester: { subject_id: 'PIXEL-PRINCIPAL' },
    owner: {
      department_ref: 'Infrastructure / HomeLab',
      role_ref: 'Systems',
    },
    job_type: 'system-status',
    requested_capability: 'pixel.system-status.read',
    execution: EXECUTION,
    state: 'SUBMITTED',
    idempotency: {
      key: 'status-check-001',
      fingerprint: 'b'.repeat(64),
    },
    provenance: {
      relay_contract: 'pixel.relay.v1',
      context_provider_contract: 'pixel.job-context-provider.v1',
      context_source: 'simulator',
    },
  },
  transition: {
    transition_id: 'transition-001',
    event_name: 'pixel.relay.job-transition.v1',
    schema_version: JOB_SCHEMA_VERSION,
    occurred_at: NOW,
    environment: 'simulation',
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
    job_id: 'job-001',
    execution_id: null,
    from_state: 'SUBMITTED',
    to_state: 'ACCEPTED',
    reason_code: 'JOB_ACCEPTED',
    provenance: { relay_contract: 'pixel.relay.v1' },
  },
  executionRequest: {
    request_id: 'execution-request-001',
    event_name: 'pixel.tool.execution-request.v1',
    schema_version: JOB_SCHEMA_VERSION,
    occurred_at: NOW,
    environment: 'simulation',
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
    job_id: 'job-001',
    execution_id: 'execution-001',
    ...EXECUTION,
    provenance: { tool_gateway_contract: 'pixel.tool-gateway.v1' },
  },
  decision: {
    decision_id: 'tool-decision-001',
    event_name: 'pixel.tool.capability-decision.v1',
    schema_version: JOB_SCHEMA_VERSION,
    decided_at: NOW,
    environment: 'simulation',
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
    request_id: 'execution-request-001',
    job_id: 'job-001',
    execution_id: 'execution-001',
    ...EXECUTION,
    decision: 'ALLOW',
    reason_code: 'CAPABILITY_GRANTED',
    policy_id: 'pixel.alpha.system-status.v1',
    provenance: {
      tool_gateway_contract: 'pixel.tool-gateway.v1',
      grant_provider_contract: 'pixel.capability-grant-provider.v1',
      grant_source: 'simulator',
    },
  },
  result: {
    result_id: 'result-001',
    event_name: 'pixel.job.result.v1',
    schema_version: JOB_SCHEMA_VERSION,
    completed_at: NOW,
    environment: 'simulation',
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
    job_id: 'job-001',
    execution_id: 'execution-001',
    state: 'COMPLETED',
    outcome_code: 'SYSTEM_STATUS_AVAILABLE',
    summary: 'Pixel system status is available.',
    provenance: {
      relay_contract: 'pixel.relay.v1',
      worker_contract: 'pixel.system-status-worker.v1',
      worker_source: 'simulator',
    },
  },
};

const contractCases = [
  ['submit intent', fixtures.intent, validateJobSubmitIntentV1, assertValidJobSubmitIntentV1],
  ['job envelope', fixtures.envelope, validateJobEnvelopeV1, assertValidJobEnvelopeV1],
  ['job transition', fixtures.transition, validateJobTransitionV1, assertValidJobTransitionV1],
  ['tool execution request', fixtures.executionRequest, validateToolExecutionRequestV1, assertValidToolExecutionRequestV1],
  ['tool capability decision', fixtures.decision, validateToolCapabilityDecisionV1, assertValidToolCapabilityDecisionV1],
  ['job result', fixtures.result, validateJobResultV1, assertValidJobResultV1],
];

test('all six PX-003 v1 contracts accept complete canonical values', () => {
  for (const [label, value, validate, assertValid] of contractCases) {
    assert.deepEqual(validate(value), { ok: true, errors: [] }, label);
    assert.equal(assertValid(value), value, label);
  }
});

test('all six PX-003 v1 contracts reject unknown top-level fields', () => {
  for (const [label, value, validate] of contractCases) {
    const result = validate({ ...value, grants: ['forged'] });
    assert.equal(result.ok, false, label);
    assert.match(result.errors.join(' '), /unsupported field grants/, label);
  }
});

test('nested authority and unknown fields are rejected recursively', () => {
  assert.equal(validateJobEnvelopeV1({
    ...fixtures.envelope,
    owner: { ...fixtures.envelope.owner, grants: ['forged'] },
  }).ok, false);
  assert.equal(validateToolExecutionRequestV1({
    ...fixtures.executionRequest,
    worker_binding: { ...BINDING, policy_result: 'ALLOW' },
  }).ok, false);
  assert.equal(validateToolCapabilityDecisionV1({
    ...fixtures.decision,
    provenance: { ...fixtures.decision.provenance, token: 'secret' },
  }).ok, false);
  assert.equal(validateJobResultV1({
    ...fixtures.result,
    provenance: { ...fixtures.result.provenance, raw_output: 'restricted' },
  }).ok, false);
});

test('contracts enforce canonical states, environments, identifiers, hashes, and W3C IDs', () => {
  assert.equal(validateJobEnvelopeV1({ ...fixtures.envelope, environment: 'local' }).ok, false);
  assert.equal(validateJobEnvelopeV1({ ...fixtures.envelope, state: 'RUNNING' }).ok, false);
  assert.equal(validateJobEnvelopeV1({ ...fixtures.envelope, trace_id: '0'.repeat(32) }).ok, false);
  assert.equal(validateToolExecutionRequestV1({
    ...fixtures.executionRequest,
    parameter_hash: 'not-a-hash',
  }).ok, false);
  assert.equal(validateJobTransitionV1({
    ...fixtures.transition,
    from_state: 'SUBMITTED',
    to_state: 'COMPLETED',
  }).ok, false);
  assert.equal(validateToolCapabilityDecisionV1({
    ...fixtures.decision,
    decision: 'DENY',
    reason_code: 'CAPABILITY_GRANTED',
  }).ok, false);
});

test('result summary is server-bounded and terminal outcome combinations are consistent', () => {
  assert.equal(validateJobResultV1({ ...fixtures.result, summary: 'x'.repeat(161) }).ok, false);
  assert.equal(validateJobResultV1({
    ...fixtures.result,
    state: 'FAILED',
    outcome_code: 'SYSTEM_STATUS_AVAILABLE',
  }).ok, false);
  assert.equal(validateJobResultV1({
    ...fixtures.result,
    state: 'FAILED',
    outcome_code: 'CAPABILITY_DENIED',
    summary: 'Pixel denied this job capability before tool execution.',
    provenance: {
      relay_contract: 'pixel.relay.v1',
      worker_contract: null,
      worker_source: null,
    },
  }).ok, true);
});

test('model-backed terminal provenance is strict, truthful, and preserves legacy worker results', () => {
  const modelResult = {
    ...fixtures.result,
    provenance: {
      relay_contract: 'pixel.relay.v1',
      model_gateway_contract: 'pixel.model-gateway.v1',
      model_invocation_id: 'invocation-001',
      model_runtime_id: 'pixel.simulator.model-runtime-a',
      model_id: 'pixel.fake-model-a.v1',
      model_source: 'simulator',
    },
  };

  assert.deepEqual(validateJobResultV1(modelResult), { ok: true, errors: [] });
  assert.deepEqual(validateJobResultV1(fixtures.result), { ok: true, errors: [] });
  assert.equal(validateJobResultV1({
    ...modelResult,
    provenance: { ...modelResult.provenance, worker_contract: 'pixel.system-status-worker.v1' },
  }).ok, false);
  assert.equal(validateJobResultV1({
    ...modelResult,
    provenance: { ...modelResult.provenance, model_id: null },
  }).ok, false);
});

test('failed model provenance permits only a fully null unavailable placement', () => {
  const failed = {
    ...fixtures.result,
    state: 'FAILED',
    outcome_code: 'WORKER_RESULT_INVALID',
    summary: 'Pixel rejected an invalid model result.',
    provenance: {
      relay_contract: 'pixel.relay.v1',
      model_gateway_contract: 'pixel.model-gateway.v1',
      model_invocation_id: 'invocation-001',
      model_runtime_id: null,
      model_id: null,
      model_source: null,
    },
  };
  assert.deepEqual(validateJobResultV1(failed), { ok: true, errors: [] });
  assert.equal(validateJobResultV1({
    ...failed,
    provenance: { ...failed.provenance, model_runtime_id: 'pixel.simulator.model-runtime-a' },
  }).ok, false);
});

test('published schemas are strict at every declared object boundary', async () => {
  const names = [
    'pixel-job-submit-intent-v1.schema.json',
    'pixel-relay-job-envelope-v1.schema.json',
    'pixel-relay-job-transition-v1.schema.json',
    'pixel-tool-execution-request-v1.schema.json',
    'pixel-tool-capability-decision-v1.schema.json',
    'pixel-job-result-v1.schema.json',
  ];
  for (const name of names) {
    const schema = JSON.parse(await readFile(new URL(`../../packages/contracts/schemas/${name}`, import.meta.url)));
    assert.equal(schema.additionalProperties, false, name);
    const objects = JSON.stringify(schema).match(/"type":"object"/g) ?? [];
    const strictObjects = JSON.stringify(schema).match(/"additionalProperties":false/g) ?? [];
    assert.equal(strictObjects.length, objects.length, name);
  }
});

test('published lifecycle timestamps require canonical UTC ISO-8601 milliseconds', async () => {
  const timestampPattern = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
  const schemas = [
    ['pixel-relay-job-envelope-v1.schema.json', 'created_at'],
    ['pixel-relay-job-transition-v1.schema.json', 'occurred_at'],
    ['pixel-job-result-v1.schema.json', 'completed_at'],
  ];

  for (const [name, field] of schemas) {
    const schema = JSON.parse(await readFile(new URL(`../../packages/contracts/schemas/${name}`, import.meta.url)));
    assert.equal(schema.properties[field].pattern, timestampPattern, `${name} ${field}`);
    const timestamp = new RegExp(schema.properties[field].pattern);
    assert.equal(timestamp.test(NOW), true, `${name} accepts canonical timestamp`);
    assert.equal(timestamp.test('2026-09-07T12:00:00Z'), false, `${name} rejects missing milliseconds`);
    assert.equal(timestamp.test('2026-09-07T08:00:00.000-04:00'), false, `${name} rejects offsets`);
  }
});

test('published schemas encode runtime cross-field decision, transition, and result invariants', async () => {
  for (const name of [
    'pixel-relay-job-envelope-v1.schema.json',
    'pixel-relay-job-transition-v1.schema.json',
    'pixel-tool-capability-decision-v1.schema.json',
    'pixel-job-result-v1.schema.json',
  ]) {
    const schema = JSON.parse(await readFile(new URL(`../../packages/contracts/schemas/${name}`, import.meta.url)));
    assert.equal(Array.isArray(schema.allOf), true, name);
    assert.equal(schema.allOf.length > 0, true, name);
  }

  const envelope = JSON.parse(await readFile(new URL(
    '../../packages/contracts/schemas/pixel-relay-job-envelope-v1.schema.json',
    import.meta.url,
  )));
  assert.equal(envelope.allOf[0].oneOf.length, 2);
});
