import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorRelayStoreAdapter } from '../../adapters/simulator/src/relay-store-simulator-adapter.js';
import {
  validateToolCapabilityDecisionV1,
  validateToolExecutionRequestV1,
} from '../../packages/contracts/src/job-v1.js';

const TRACE_ID = '1234567890abcdef1234567890abcdef';
const NOW = '2026-09-07T12:00:00.000Z';
const BINDING = Object.freeze({
  worker_id: 'PIXEL-SYSTEMS-WORKER-01',
  department_ref: 'Infrastructure / HomeLab',
  role_ref: 'Systems',
});

function envelope(jobId = 'job-001', fingerprint = 'a'.repeat(64)) {
  return {
    job_id: jobId,
    event_name: 'pixel.relay.job-envelope.v1',
    schema_version: '1.0.0',
    created_at: NOW,
    environment: 'simulation',
    trace_id: TRACE_ID,
    span_id: '1111111111111111',
    requester: { subject_id: 'PIXEL-PRINCIPAL' },
    owner: { department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems' },
    job_type: 'system-status',
    requested_capability: 'pixel.system-status.read',
    execution: {
      capability: 'pixel.system-status.read',
      tool_class: 'pixel.system-status',
      target: 'pixel.platform',
      parameter_hash: 'b'.repeat(64),
      worker_binding: BINDING,
    },
    state: 'SUBMITTED',
    idempotency: { key: 'status-check-001', fingerprint },
    provenance: {
      relay_contract: 'pixel.relay.v1',
      context_provider_contract: 'pixel.job-context-provider.v1',
      context_source: 'simulator',
    },
  };
}

function transition({
  id = 'transition-001', from = 'SUBMITTED', to = 'ACCEPTED',
  reason = 'JOB_ACCEPTED', executionId = null, span = '2222222222222222',
} = {}) {
  return {
    transition_id: id,
    event_name: 'pixel.relay.job-transition.v1',
    schema_version: '1.0.0',
    occurred_at: NOW,
    environment: 'simulation',
    trace_id: TRACE_ID,
    span_id: span,
    job_id: 'job-001',
    execution_id: executionId,
    from_state: from,
    to_state: to,
    reason_code: reason,
    provenance: { relay_contract: 'pixel.relay.v1' },
  };
}

function executionRequest(overrides = {}) {
  return {
    request_id: 'request-001',
    event_name: 'pixel.tool.execution-request.v1',
    schema_version: '1.0.0',
    occurred_at: NOW,
    environment: 'simulation',
    trace_id: TRACE_ID,
    span_id: '4444444444444444',
    job_id: 'job-001',
    execution_id: 'execution-001',
    capability: 'pixel.system-status.read',
    tool_class: 'pixel.system-status',
    target: 'pixel.platform',
    parameter_hash: 'b'.repeat(64),
    worker_binding: BINDING,
    provenance: { tool_gateway_contract: 'pixel.tool-gateway.v1' },
    ...overrides,
  };
}

function decision(request = executionRequest(), overrides = {}) {
  return {
    decision_id: 'decision-001',
    event_name: 'pixel.tool.capability-decision.v1',
    schema_version: '1.0.0',
    decided_at: NOW,
    environment: request.environment,
    trace_id: request.trace_id,
    span_id: '5555555555555555',
    request_id: request.request_id,
    job_id: request.job_id,
    execution_id: request.execution_id,
    capability: request.capability,
    tool_class: request.tool_class,
    target: request.target,
    parameter_hash: request.parameter_hash,
    worker_binding: request.worker_binding,
    decision: 'ALLOW',
    reason_code: 'CAPABILITY_GRANTED',
    policy_id: 'pixel.alpha.system-status.v1',
    provenance: {
      tool_gateway_contract: 'pixel.tool-gateway.v1',
      grant_provider_contract: 'pixel.capability-grant-provider.v1',
      grant_source: 'simulator',
    },
    ...overrides,
  };
}

async function runningStore() {
  const store = new SimulatorRelayStoreAdapter();
  await store.claimOrReturnExisting({
    namespace: 'PIXEL-PRINCIPAL:simulation:status-check-001',
    fingerprint: 'a'.repeat(64),
    candidateJob: envelope(),
  });
  await store.applyTransition('job-001', transition());
  await store.applyTransition('job-001', transition({
    id: 'transition-002', from: 'ACCEPTED', to: 'RUNNING',
    reason: 'EXECUTION_STARTED', executionId: 'execution-001', span: '3333333333333333',
  }));
  return store;
}

test('claimOrReturnExisting atomically creates one job for concurrent identical claims', async () => {
  const store = new SimulatorRelayStoreAdapter();
  const claims = await Promise.all(Array.from({ length: 50 }, (_, index) => store.claimOrReturnExisting({
    namespace: 'PIXEL-PRINCIPAL:simulation:status-check-001',
    fingerprint: 'a'.repeat(64),
    candidateJob: envelope(`job-${String(index + 1).padStart(3, '0')}`),
  })));

  assert.equal(claims.filter(({ disposition }) => disposition === 'CREATED').length, 1);
  assert.equal(claims.filter(({ disposition }) => disposition === 'EXISTING').length, 49);
  assert.equal(new Set(claims.map(({ job }) => job.envelope.job_id)).size, 1);
  assert.equal((await store.getJob('job-001')).current_state, 'SUBMITTED');
});

test('same idempotency namespace with a different fingerprint conflicts without a second job', async () => {
  const store = new SimulatorRelayStoreAdapter();
  await store.claimOrReturnExisting({
    namespace: 'PIXEL-PRINCIPAL:simulation:status-check-001',
    fingerprint: 'a'.repeat(64),
    candidateJob: envelope(),
  });
  const conflict = await store.claimOrReturnExisting({
    namespace: 'PIXEL-PRINCIPAL:simulation:status-check-001',
    fingerprint: 'c'.repeat(64),
    candidateJob: envelope('job-002', 'c'.repeat(64)),
  });

  assert.deepEqual(conflict, { disposition: 'CONFLICT', job: null });
  assert.equal(await store.getJob('job-002'), null);
});

test('SUBMITTED to ACCEPTED rejects a non-null execution identity without mutating the job', async () => {
  const store = new SimulatorRelayStoreAdapter();
  await store.claimOrReturnExisting({
    namespace: 'PIXEL-PRINCIPAL:simulation:status-check-001',
    fingerprint: 'a'.repeat(64),
    candidateJob: envelope(),
  });

  const rejected = await store.applyTransition('job-001', transition({ executionId: 'execution-early' }));

  assert.equal(rejected.disposition, 'REJECTED');
  assert.equal(rejected.job.current_state, 'SUBMITTED');
  assert.equal(rejected.job.execution_id, null);
  assert.deepEqual(rejected.job.transitions, []);
});

test('store accepts only every legal lifecycle edge exactly once', async () => {
  const store = await runningStore();
  const request = executionRequest();
  const allow = decision(request);
  await store.recordGatewayDecision('job-001', request, allow);
  assert.equal((await store.claimWorkerInvocation('job-001', request, allow)).disposition, 'INVOKE_NOW');
  const terminal = transition({
    id: 'transition-003', from: 'RUNNING', to: 'COMPLETED',
    reason: 'EXECUTION_COMPLETED', executionId: 'execution-001', span: '6666666666666666',
  });
  const result = {
    result_id: 'result-001', event_name: 'pixel.job.result.v1', schema_version: '1.0.0',
    completed_at: NOW, environment: 'simulation', trace_id: TRACE_ID, span_id: '7777777777777777',
    job_id: 'job-001', execution_id: 'execution-001', state: 'COMPLETED',
    outcome_code: 'SYSTEM_STATUS_AVAILABLE', summary: 'Pixel system status is available.',
    provenance: {
      relay_contract: 'pixel.relay.v1', worker_contract: 'pixel.system-status-worker.v1', worker_source: 'simulator',
    },
  };

  assert.equal((await store.commitTerminalResult('job-001', terminal, result)).disposition, 'COMMITTED');
  const job = await store.getJob('job-001');
  assert.equal(job.current_state, 'COMPLETED');
  assert.equal(job.transitions.length, 3);
  assert.deepEqual(job.result, result);
});

test('illegal, skipped, regressive, duplicate, and post-terminal transitions are rejected', async () => {
  const store = new SimulatorRelayStoreAdapter();
  await store.claimOrReturnExisting({
    namespace: 'PIXEL-PRINCIPAL:simulation:status-check-001',
    fingerprint: 'a'.repeat(64),
    candidateJob: envelope(),
  });

  for (const invalid of [
    transition({ from: 'SUBMITTED', to: 'RUNNING', reason: 'EXECUTION_STARTED', executionId: 'execution-001' }),
    transition({ from: 'RUNNING', to: 'ACCEPTED', reason: 'JOB_ACCEPTED', executionId: 'execution-001' }),
    transition({ from: 'SUBMITTED', to: 'COMPLETED', reason: 'EXECUTION_COMPLETED', executionId: 'execution-001' }),
  ]) {
    assert.equal((await store.applyTransition('job-001', invalid)).disposition, 'REJECTED');
  }

  assert.equal((await store.applyTransition('job-001', transition())).disposition, 'APPLIED');
  assert.equal((await store.applyTransition('job-001', transition())).disposition, 'REJECTED');
  assert.equal((await store.applyTransition('job-001', transition({
    id: 'transition-002', from: 'ACCEPTED', to: 'RUNNING', reason: 'EXECUTION_STARTED',
    executionId: 'execution-001', span: '3333333333333333',
  }))).disposition, 'APPLIED');

  const request = executionRequest();
  const allow = decision(request);
  await store.recordGatewayDecision('job-001', request, allow);
  await store.claimWorkerInvocation('job-001', request, allow);
  const completed = transition({
    id: 'transition-003', from: 'RUNNING', to: 'COMPLETED',
    reason: 'EXECUTION_COMPLETED', executionId: 'execution-001', span: '6666666666666666',
  });
  const result = {
    result_id: 'result-001', event_name: 'pixel.job.result.v1', schema_version: '1.0.0',
    completed_at: NOW, environment: 'simulation', trace_id: TRACE_ID, span_id: '7777777777777777',
    job_id: 'job-001', execution_id: 'execution-001', state: 'COMPLETED',
    outcome_code: 'SYSTEM_STATUS_AVAILABLE', summary: 'Pixel system status is available.',
    provenance: {
      relay_contract: 'pixel.relay.v1', worker_contract: 'pixel.system-status-worker.v1', worker_source: 'simulator',
    },
  };
  assert.equal((await store.commitTerminalResult('job-001', completed, result)).disposition, 'COMMITTED');

  const postTerminal = transition({
    id: 'transition-004', from: 'COMPLETED', to: 'FAILED',
    reason: 'WORKER_FAILED', executionId: 'execution-001', span: '8888888888888888',
  });
  const rejected = await store.applyTransition('job-001', postTerminal);
  assert.equal(rejected.disposition, 'REJECTED');
  assert.equal(rejected.job.current_state, 'COMPLETED');
  assert.equal(rejected.job.transitions.length, 3);
});

test('execution claim is atomic and bound to the exact ALLOW decision and request', async () => {
  const store = await runningStore();
  const request = executionRequest();
  const allow = decision(request);
  assert.deepEqual(validateToolExecutionRequestV1(request), { ok: true, errors: [] });
  assert.deepEqual(validateToolCapabilityDecisionV1(allow), { ok: true, errors: [] });
  const stored = await store.getJob('job-001');
  assert.equal(stored.current_state, 'RUNNING');
  assert.equal(stored.execution_id, request.execution_id);
  assert.equal(stored.envelope.trace_id, request.trace_id);
  assert.deepEqual(stored.envelope.execution, {
    capability: request.capability,
    tool_class: request.tool_class,
    target: request.target,
    parameter_hash: request.parameter_hash,
    worker_binding: request.worker_binding,
  });
  assert.equal((await store.recordGatewayDecision('job-001', request, allow)).disposition, 'RECORDED');
  const claims = await Promise.all(Array.from({ length: 25 }, () => (
    store.claimWorkerInvocation('job-001', request, allow)
  )));

  assert.equal(claims.filter(({ disposition }) => disposition === 'INVOKE_NOW').length, 1);
  assert.equal(claims.filter(({ disposition }) => disposition === 'ALREADY_CLAIMED').length, 24);
  const mismatch = executionRequest({ target: 'pixel.other' });
  assert.equal((await store.claimWorkerInvocation('job-001', mismatch, allow)).disposition, 'REJECTED');
});

test('execution claim rejects a substituted decision even when its execution tuple matches', async () => {
  const store = await runningStore();
  const request = executionRequest();
  const allow = decision(request);
  await store.recordGatewayDecision('job-001', request, allow);

  for (const substituted of [
    { ...allow, decision_id: 'decision-substituted' },
    { ...allow, policy_id: 'pixel.other-policy.v1' },
    { ...allow, trace_id: 'f'.repeat(32) },
  ]) {
    assert.equal(
      (await store.claimWorkerInvocation('job-001', request, substituted)).disposition,
      'REJECTED',
    );
  }
  assert.equal((await store.getJob('job-001')).invocation_claimed, false);
});

test('failed invocation claim and terminal persistence leave the last durable state intact', async () => {
  const claimFailingStore = new SimulatorRelayStoreAdapter({ failInvocationClaim: true });
  await claimFailingStore.claimOrReturnExisting({
    namespace: 'PIXEL-PRINCIPAL:simulation:status-check-001', fingerprint: 'a'.repeat(64), candidateJob: envelope(),
  });
  await claimFailingStore.applyTransition('job-001', transition());
  await claimFailingStore.applyTransition('job-001', transition({
    id: 'transition-002', from: 'ACCEPTED', to: 'RUNNING', reason: 'EXECUTION_STARTED',
    executionId: 'execution-001', span: '3333333333333333',
  }));
  const request = executionRequest();
  const allow = decision(request);
  await claimFailingStore.recordGatewayDecision('job-001', request, allow);
  assert.equal((await claimFailingStore.claimWorkerInvocation('job-001', request, allow)).disposition, 'REJECTED');
  assert.equal((await claimFailingStore.getJob('job-001')).current_state, 'RUNNING');

  const terminalFailingStore = new SimulatorRelayStoreAdapter({ failTerminalCommit: true });
  assert.equal(terminalFailingStore.source, 'simulator');
});

test('a DENY decision cannot be used to commit a completed result', async () => {
  const store = await runningStore();
  const request = executionRequest();
  const denied = decision(request, {
    decision: 'DENY',
    reason_code: 'CAPABILITY_NOT_GRANTED',
  });
  await store.recordGatewayDecision('job-001', request, denied);
  const completedTransition = transition({
    id: 'transition-003', from: 'RUNNING', to: 'COMPLETED',
    reason: 'EXECUTION_COMPLETED', executionId: 'execution-001', span: '6666666666666666',
  });
  const completedResult = {
    result_id: 'result-001', event_name: 'pixel.job.result.v1', schema_version: '1.0.0',
    completed_at: NOW, environment: 'simulation', trace_id: TRACE_ID, span_id: '7777777777777777',
    job_id: 'job-001', execution_id: 'execution-001', state: 'COMPLETED',
    outcome_code: 'SYSTEM_STATUS_AVAILABLE', summary: 'Pixel system status is available.',
    provenance: {
      relay_contract: 'pixel.relay.v1', worker_contract: 'pixel.system-status-worker.v1', worker_source: 'simulator',
    },
  };

  assert.equal((await store.commitTerminalResult(
    'job-001', completedTransition, completedResult,
  )).disposition, 'REJECTED');
  assert.equal((await store.getJob('job-001')).current_state, 'RUNNING');
});
