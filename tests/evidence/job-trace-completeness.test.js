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
const INTENT = Object.freeze({
  event_name: 'pixel.job.submit-intent.v1',
  schema_version: '1.0.0',
  idempotency_key: 'status-check-001',
  job_type: 'system-status',
  requested_capability: 'pixel.system-status.read',
});

function createIds(seed = 30_000) {
  let value = seed;
  return {
    nextEventId: () => `event-${++value}`,
    nextJobId: () => `job-${++value}`,
    nextExecutionId: () => `execution-${++value}`,
    nextSpanId: () => (++value).toString(16).padStart(16, '0'),
    nextTraceId: () => (++value).toString(16).padStart(32, '0'),
  };
}

function runtime({ contextProvider, grantProvider, worker, evidence } = {}) {
  const ids = createIds();
  const recorder = evidence ?? new EvidenceRecorder({ clock: () => NOW });
  const store = new SimulatorRelayStoreAdapter();
  const gateway = new ToolGateway({
    environment: 'simulation',
    grantProvider: grantProvider ?? new SimulatorCapabilityGrantProvider(),
    store,
    worker: worker ?? new SimulatorSystemStatusWorker(),
    evidence: recorder,
    ids,
    clock: () => NOW,
  });
  const relay = new RelayService({
    environment: 'simulation',
    contextProvider: contextProvider ?? new SimulatorJobContextProvider(),
    store,
    toolGateway: gateway,
    evidence: recorder,
    ids,
    clock: () => NOW,
  });
  return { evidence: recorder, relay, store };
}

async function traceFor(options, intent = INTENT) {
  const subject = runtime(options);
  const response = await subject.relay.submit(intent);
  return {
    ...subject,
    response,
    records: subject.evidence.forTrace(response.trace_id),
  };
}

test('happy completion has one complete causal evidence family with canonical service ownership', async () => {
  const result = await traceFor();
  const assessment = assessJobTraceCompleteness(result.records);

  assert.deepEqual(assessment, { complete: true, missing: [], errors: [] });
  assert.deepEqual(result.records.map(({ event_name }) => event_name), [
    'job.submission.received',
    'relay.job.accepted',
    'relay.job.running',
    'tool.execution.requested',
    'tool_gateway.evaluation.started',
    'tool.capability.allowed',
    'worker.execution.started',
    'worker.execution.finished',
    'contract.job_result.validated',
    'job.result.projected',
    'relay.job.completed',
  ]);
  assert.equal(result.records.find(({ event_name }) => event_name === 'worker.execution.started').service_name, 'pixel.system-status-worker');
  assert.equal(result.records.find(({ event_name }) => event_name === 'relay.job.completed').service_name, 'pixel.relay');
});

test('Tool Gateway denial is a complete FAILED job trace with no worker evidence', async () => {
  const result = await traceFor({}, {
    ...INTENT,
    idempotency_key: 'raw-status-001',
    requested_capability: 'pixel.system-status.raw.read',
  });
  const assessment = assessJobTraceCompleteness(result.records);

  assert.equal(assessment.complete, true);
  assert.equal(result.records.some(({ event_name }) => event_name.startsWith('worker.')), false);
  assert.equal(result.records.at(-1).event_name, 'relay.job.failed');
});

test('worker failure is a complete FAILED trace with bounded evidence', async () => {
  const result = await traceFor({
    worker: new SimulatorSystemStatusWorker({ outcomeCode: 'WORKER_UNAVAILABLE' }),
  });

  assert.equal(assessJobTraceCompleteness(result.records).complete, true);
  assert.equal(result.records.at(-1).attributes['pixel.job.reason_code'], 'WORKER_FAILED');
});

test('forgery, invalid intent, context failure, replay, and conflict traces are reconstructable', async () => {
  const forgery = await traceFor({}, { ...INTENT, grants: ['forged'] });
  const invalid = await traceFor({}, { ...INTENT, requested_capability: 'not-supported' });
  const context = await traceFor({
    contextProvider: { source: 'simulator', async resolveJobContext() { throw new Error('secret'); } },
  });

  for (const result of [forgery, invalid, context]) {
    assert.equal(assessJobTraceCompleteness(result.records).complete, true);
  }

  const replayRuntime = runtime();
  await replayRuntime.relay.submit(INTENT);
  const replay = await replayRuntime.relay.submit(INTENT);
  const conflict = await replayRuntime.relay.submit({
    ...INTENT,
    requested_capability: 'pixel.system-status.raw.read',
  });
  assert.equal(assessJobTraceCompleteness(replayRuntime.evidence.forTrace(replay.trace_id)).complete, true);
  assert.equal(assessJobTraceCompleteness(replayRuntime.evidence.forTrace(conflict.trace_id)).complete, true);
});

test('invalid lifecycle attempts are evidenced without invalidating the canonical trace', async () => {
  const subject = runtime();
  const completed = await subject.relay.submit(INTENT);
  const invalid = await subject.relay.execute(completed.job.envelope.job_id);
  const records = subject.evidence.forTrace(completed.trace_id);

  assert.equal(invalid.disposition, 'INVALID_STATE');
  assert.equal(records.some(({ event_name }) => event_name === 'relay.transition.rejected'), true);
  assert.equal(assessJobTraceCompleteness(records).complete, true);
});

test('skipped and regressive lifecycle attempts are rejected, evidenced, and never mutate the job', async () => {
  const subject = runtime();
  const accepted = await subject.relay.accept(INTENT);
  const jobId = accepted.job.envelope.job_id;

  const skipped = await subject.relay.attemptTransition(jobId, {
    toState: 'COMPLETED',
    reasonCode: 'EXECUTION_COMPLETED',
  });
  const regressive = await subject.relay.attemptTransition(jobId, {
    toState: 'SUBMITTED',
    reasonCode: 'JOB_ACCEPTED',
  });
  const completed = await subject.relay.execute(jobId);
  const records = subject.evidence.forTrace(accepted.trace_id);
  const rejections = records.filter(({ event_name }) => event_name === 'relay.transition.rejected');

  assert.equal(skipped.disposition, 'INVALID_STATE');
  assert.equal(regressive.disposition, 'INVALID_STATE');
  assert.equal(completed.job.current_state, 'COMPLETED');
  assert.equal(rejections.length, 2);
  assert.deepEqual(rejections.map(({ attributes }) => attributes['pixel.job.attempted_state']), ['COMPLETED', 'SUBMITTED']);
  assert.equal(assessJobTraceCompleteness(records).complete, true);
});

test('missing post-worker evidence remains truthfully incomplete without a fabricated failure span', async () => {
  const committed = new EvidenceRecorder({ clock: () => NOW });
  let failed = false;
  const evidence = {
    append(record) {
      if (!failed && record.eventName === 'worker.execution.finished') {
        failed = true;
        throw new Error('unavailable');
      }
      return committed.append(record);
    },
    forTrace: (traceId) => committed.forTrace(traceId),
  };
  const subject = runtime({ evidence });
  const response = await subject.relay.submit(INTENT);
  const records = committed.forTrace(response.trace_id);
  const assessment = assessJobTraceCompleteness(records);

  assert.equal(response.job.current_state, 'RUNNING');
  assert.equal(assessment.complete, false);
  assert.equal(assessment.missing.includes('worker.execution.finished'), true);
  assert.equal(records.some(({ event_name }) => event_name === 'evidence.append.failed'), false);
});

test('completeness rejects broken parentage, duplicate IDs, unknown attributes, and leaked data', async () => {
  const result = await traceFor();
  const brokenParent = structuredClone(result.records);
  brokenParent[2].parent_span_id = 'ffffffffffffffff';
  assert.equal(assessJobTraceCompleteness(brokenParent).complete, false);

  const duplicate = structuredClone(result.records);
  duplicate[2].span_id = duplicate[1].span_id;
  assert.equal(assessJobTraceCompleteness(duplicate).complete, false);

  const leaked = structuredClone(result.records);
  leaked[5].attributes.raw_output = 'restricted';
  assert.equal(assessJobTraceCompleteness(leaked).complete, false);
});

test('completeness returns a bounded incomplete assessment when record attributes are missing', async () => {
  const result = await traceFor();
  const missingWorkerAttributes = structuredClone(result.records);
  delete missingWorkerAttributes.find(({ event_name }) => event_name === 'worker.execution.finished').attributes;
  const missingResultAttributes = structuredClone(result.records);
  delete missingResultAttributes.find(({ event_name }) => event_name === 'job.result.projected').attributes;
  const missingApiAttributes = structuredClone(result.records);
  missingApiAttributes.push({
    trace_id: result.response.trace_id,
    span_id: 'ffffffffffffffff',
    parent_span_id: missingApiAttributes.at(-1).span_id,
    service_name: 'pixel.relay-api',
    event_name: 'api.job.response',
    outcome: 'success',
    severity: 'info',
  });

  for (const [eventName, malformed] of [
    ['worker.execution.finished', missingWorkerAttributes],
    ['job.result.projected', missingResultAttributes],
    ['api.job.response', missingApiAttributes],
  ]) {
    const assessment = assessJobTraceCompleteness(malformed);
    assert.equal(assessment.complete, false, eventName);
    assert.equal(
      assessment.errors.includes(`${eventName} has unbounded or unsupported attributes`),
      true,
      eventName,
    );
    assert.equal(
      assessment.errors.every((error) => typeof error === 'string' && error.length <= 160),
      true,
      eventName,
    );
  }
});

test('completeness rejects contradictory decision, lifecycle, capability, and outcome semantics', async () => {
  const result = await traceFor();
  const contradiction = structuredClone(result.records);
  const allowed = contradiction.find(({ event_name }) => event_name === 'tool.capability.allowed');
  allowed.attributes['pixel.tool.decision'] = 'DENY';
  allowed.attributes['pixel.tool.reason_code'] = 'CAPABILITY_NOT_GRANTED';
  const terminal = contradiction.find(({ event_name }) => event_name === 'relay.job.completed');
  terminal.attributes['pixel.job.to_state'] = 'FAILED';
  terminal.attributes['pixel.job.reason_code'] = 'CAPABILITY_DENIED';

  assert.equal(assessJobTraceCompleteness(contradiction).complete, false);

  const wrongCapability = structuredClone(result.records);
  wrongCapability.find(({ event_name }) => event_name === 'tool_gateway.evaluation.started')
    .attributes['pixel.tool.capability'] = 'pixel.system-status.raw.read';
  assert.equal(assessJobTraceCompleteness(wrongCapability).complete, false);

  const wrongOutcome = structuredClone(result.records);
  wrongOutcome.find(({ event_name }) => event_name === 'job.result.projected')
    .attributes['pixel.job.outcome_code'] = 'CAPABILITY_DENIED';
  assert.equal(assessJobTraceCompleteness(wrongOutcome).complete, false);

  const impossibleRawSuccess = structuredClone(result.records);
  for (const record of impossibleRawSuccess) {
    if (record.attributes['pixel.tool.capability']) {
      record.attributes['pixel.tool.capability'] = 'pixel.system-status.raw.read';
    }
  }
  assert.equal(assessJobTraceCompleteness(impossibleRawSuccess).complete, false);

  const falseOutcome = structuredClone(result.records);
  falseOutcome.find(({ event_name }) => event_name === 'tool.capability.allowed').outcome = 'denied';
  assert.equal(assessJobTraceCompleteness(falseOutcome).complete, false);
});
