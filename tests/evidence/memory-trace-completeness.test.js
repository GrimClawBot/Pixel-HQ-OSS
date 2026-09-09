import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorJobContextProvider } from '../../adapters/simulator/src/job-context-simulator-provider.js';
import { SimulatorMemoryIntakeContextProvider } from '../../adapters/simulator/src/memory-intake-context-simulator-provider.js';
import { SimulatorMemoryStoreAdapter } from '../../adapters/simulator/src/memory-store-simulator-adapter.js';
import { SimulatorRelayStoreAdapter } from '../../adapters/simulator/src/relay-store-simulator-adapter.js';
import { MEMORY_RECORD_EVENT_NAME, MEMORY_SCHEMA_VERSION } from '../../packages/contracts/src/memory-v1.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import {
  assessMemoryContextTraceCompleteness,
  assessMemoryIntakeTraceCompleteness,
} from '../../packages/telemetry/src/memory-trace-completeness.js';
import { MemoryService } from '../../services/memory/src/memory-service.js';
import { RelayService } from '../../services/relay/src/relay-service.js';

const NOW = '2026-09-08T12:00:00.000Z';
const DEPARTMENT = 'Infrastructure / HomeLab';
const JOB_INTENT = Object.freeze({
  event_name: 'pixel.job.submit-intent.v1',
  schema_version: '1.0.0',
  idempotency_key: 'memory-evidence-001',
  job_type: 'system-status',
  requested_capability: 'pixel.system-status.read',
});
const INTAKE_INTENT = Object.freeze({
  event_name: 'pixel.memory.intake-intent.v1',
  schema_version: '1.0.0',
  content: { text: 'router status stable', tags: ['router'] },
});

function createIds(seed = 90_000) {
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

function listingStore(records) {
  return {
    source: 'simulator',
    putRecord(record) { return record; },
    getRecord() { return null; },
    listByDepartment() { return structuredClone(records); },
  };
}

function relayStoreWithGet(base, getJob) {
  return {
    source: base.source,
    claimOrReturnExisting: base.claimOrReturnExisting.bind(base),
    getJob,
    applyTransition: base.applyTransition.bind(base),
    recordGatewayDecision: base.recordGatewayDecision.bind(base),
    claimWorkerInvocation: base.claimWorkerInvocation.bind(base),
    commitTerminalResult: base.commitTerminalResult.bind(base),
  };
}

function canonicalRecord({
  id,
  text = 'router status stable',
  tags = ['router'],
  department = DEPARTMENT,
  handling = 'INTERNAL',
  lifecycle = 'ACTIVE',
  environment = 'simulation',
}) {
  const serial = Number(id.replace(/\D/g, '')) || 1;
  return {
    memory_id: id,
    event_name: MEMORY_RECORD_EVENT_NAME,
    schema_version: MEMORY_SCHEMA_VERSION,
    created_at: NOW,
    observed_at: NOW,
    environment,
    scope: { scope_type: 'DEPARTMENT', department_ref: department },
    memory_class: 'OPERATIONAL',
    handling,
    lifecycle,
    content: { text, tags },
    provenance: {
      source_class: 'synthetic',
      source_ref: `evidence-fixture-${serial}`,
      intake_context_contract: 'pixel.memory-intake-context-provider.v1',
      intake_source: 'simulator',
    },
    trace_id: serial.toString(16).padStart(32, '0'),
    span_id: serial.toString(16).padStart(16, '0'),
  };
}

async function runtime({
  memoryStore = new SimulatorMemoryStoreAdapter(),
  intakeContextProvider = new SimulatorMemoryIntakeContextProvider(),
  seed = 90_000,
} = {}) {
  const ids = createIds(seed);
  const evidence = new EvidenceRecorder({ clock: () => NOW });
  const relayStore = new SimulatorRelayStoreAdapter();
  const relay = new RelayService({
    environment: 'simulation',
    contextProvider: new SimulatorJobContextProvider(),
    store: relayStore,
    toolGateway: { source: 'simulator', async execute() { throw new Error('not used'); } },
    evidence,
    ids,
    clock: () => NOW,
  });
  const memory = new MemoryService({
    environment: 'simulation',
    intakeContextProvider,
    memoryStore,
    relayStore,
    evidence,
    ids,
    clock: () => NOW,
  });
  return { evidence, ids, memory, relay, relayStore };
}

test('successful intake trace is complete, causal, bounded, and immutable', async () => {
  const subject = await runtime();
  const result = await subject.memory.intake(INTAKE_INTENT);
  const assessment = assessMemoryIntakeTraceCompleteness(subject.evidence.forTrace(result.trace_id));

  assert.deepEqual(assessment, { complete: true, missing: [], errors: [] });
  assert.equal(Object.isFrozen(assessment), true);
  assert.equal(Object.isFrozen(assessment.missing), true);
  assert.equal(Object.isFrozen(assessment.errors), true);
});

test('intake forgery, invalid intent, and unavailable context are complete terminal families', async () => {
  const forgery = await runtime({ seed: 91_000 });
  const forged = await forgery.memory.intake({ ...INTAKE_INTENT, grants: ['forged'] });
  const invalid = await runtime({ seed: 92_000 });
  const invalidResult = await invalid.memory.intake({ ...INTAKE_INTENT, content: { text: '' } });
  const unavailable = await runtime({
    seed: 93_000,
    intakeContextProvider: {
      source: 'simulator',
      async resolveMemoryIntakeContext() { throw new Error('private details'); },
    },
  });
  const unavailableResult = await unavailable.memory.intake(INTAKE_INTENT);

  for (const [subject, result] of [
    [forgery, forged], [invalid, invalidResult], [unavailable, unavailableResult],
  ]) {
    assert.equal(assessMemoryIntakeTraceCompleteness(subject.evidence.forTrace(result.trace_id)).complete, true);
  }
});

test('successful context trace continues the accepted Relay trace and reconciles filter aggregates', async () => {
  const records = [
    canonicalRecord({ id: 'memory-1' }),
    canonicalRecord({
      id: 'memory-2', department: 'Finance & Opportunity', handling: 'RESTRICTED',
    }),
    canonicalRecord({ id: 'memory-3', lifecycle: 'SUPERSEDED' }),
    canonicalRecord({ id: 'memory-4', text: 'switch stable', tags: ['switch'] }),
    canonicalRecord({ id: 'memory-5', environment: 'production' }),
  ];
  const subject = await runtime({ memoryStore: listingStore(records) });
  const accepted = await subject.relay.accept(JOB_INTENT);
  const result = await subject.memory.buildContext({
    job_id: accepted.job.envelope.job_id,
    query: 'router',
  });
  const trace = subject.evidence.forTrace(result.trace_id);
  const assessment = assessMemoryContextTraceCompleteness(trace);

  assert.deepEqual(assessment, { complete: true, missing: [], errors: [] });
  const requested = trace.find(({ event_name }) => event_name === 'memory.context.requested');
  const acceptedSpan = trace.find(({ event_name }) => event_name === 'relay.job.accepted').span_id;
  assert.equal(requested.parent_span_id, acceptedSpan);
});

test('concurrent context attempts on one accepted Relay trace are assessed independently', async () => {
  const subject = await runtime({ seed: 104_000 });
  const accepted = await subject.relay.accept(JOB_INTENT);

  const results = await Promise.all(['router', 'storage'].map((query) => (
    subject.memory.buildContext({
      job_id: accepted.job.envelope.job_id,
      query,
    })
  )));
  for (const result of results) {
    assert.equal(result.disposition, 'CREATED');
  }

  assert.deepEqual(assessMemoryContextTraceCompleteness(
    subject.evidence.forTrace(accepted.trace_id),
  ), { complete: true, missing: [], errors: [] });
});

test('forged input, wrong job state, and malformed adapter records are complete context failures', async () => {
  const forged = await runtime({ seed: 94_000 });
  const forgedResult = await forged.memory.buildContext({ job_id: 'job-forged', query: 'router', budget: {} });
  assert.equal(assessMemoryContextTraceCompleteness(forged.evidence.forTrace(forgedResult.trace_id)).complete, true);

  const wrongState = await runtime({ seed: 95_000 });
  const accepted = await wrongState.relay.accept(JOB_INTENT);
  const submitted = structuredClone(wrongState.relayStore.getJob(accepted.job.envelope.job_id));
  submitted.current_state = 'SUBMITTED';
  submitted.transitions = [];
  const memory = new MemoryService({
    environment: 'simulation',
    intakeContextProvider: new SimulatorMemoryIntakeContextProvider(),
    memoryStore: new SimulatorMemoryStoreAdapter(),
    relayStore: relayStoreWithGet(wrongState.relayStore, () => submitted),
    evidence: wrongState.evidence,
    ids: wrongState.ids,
    clock: () => NOW,
  });
  const stateResult = await memory.buildContext({ job_id: submitted.envelope.job_id, query: 'router' });
  const stateTrace = wrongState.evidence.forTrace(stateResult.trace_id);
  assert.equal(assessMemoryContextTraceCompleteness(stateTrace).complete, true);
  const impossiblePostRequest = structuredClone(stateTrace);
  const impossibleRejection = impossiblePostRequest.find(
    ({ event_name }) => event_name === 'memory.context.job_rejected',
  );
  impossibleRejection.attributes = { 'pixel.memory.reason_code': 'RELAY_UNAVAILABLE' };
  impossibleRejection.outcome = 'error';
  impossibleRejection.severity = 'error';
  assert.equal(assessMemoryContextTraceCompleteness(impossiblePostRequest).complete, false);

  const malformed = await runtime({ memoryStore: listingStore([{ unknown: true }]), seed: 96_000 });
  const malformedJob = await malformed.relay.accept(JOB_INTENT);
  const malformedResult = await malformed.memory.buildContext({
    job_id: malformedJob.job.envelope.job_id,
    query: 'router',
  });
  assert.equal(assessMemoryContextTraceCompleteness(
    malformed.evidence.forTrace(malformedResult.trace_id),
  ).complete, true);

  const packageFailure = await runtime({ seed: 99_000 });
  const packageJob = await packageFailure.relay.accept(JOB_INTENT);
  const invalidPackageMemory = new MemoryService({
    environment: 'simulation',
    intakeContextProvider: new SimulatorMemoryIntakeContextProvider(),
    memoryStore: new SimulatorMemoryStoreAdapter(),
    relayStore: packageFailure.relayStore,
    evidence: packageFailure.evidence,
    ids: { ...packageFailure.ids, nextPackageId: () => '' },
    clock: () => NOW,
  });
  const packageResult = await invalidPackageMemory.buildContext({
    job_id: packageJob.job.envelope.job_id,
    query: 'router',
  });
  assert.equal(packageResult.reason_code, 'PACKAGE_INVALID');
  assert.equal(assessMemoryContextTraceCompleteness(
    packageFailure.evidence.forTrace(packageResult.trace_id),
  ).complete, true);
});

test('environment denial accepts the exact current non-ACCEPTED Relay lifecycle parent', async () => {
  const subject = await runtime({ seed: 101_000 });
  const accepted = await subject.relay.accept(JOB_INTENT);
  const acceptedJob = subject.relayStore.getJob(accepted.job.envelope.job_id);
  const executionId = subject.ids.nextExecutionId();
  const runningSpanId = subject.ids.nextSpanId();
  const transition = {
    transition_id: subject.ids.nextEventId(),
    event_name: 'pixel.relay.job-transition.v1',
    schema_version: '1.0.0',
    occurred_at: NOW,
    environment: 'simulation',
    trace_id: accepted.trace_id,
    span_id: runningSpanId,
    job_id: acceptedJob.envelope.job_id,
    execution_id: executionId,
    from_state: 'ACCEPTED',
    to_state: 'RUNNING',
    reason_code: 'EXECUTION_STARTED',
    provenance: { relay_contract: 'pixel.relay.v1' },
  };
  const running = subject.relayStore.applyTransition(acceptedJob.envelope.job_id, transition);
  assert.equal(running.disposition, 'APPLIED');
  subject.evidence.append({
    traceId: accepted.trace_id,
    spanId: runningSpanId,
    parentSpanId: acceptedJob.transitions.at(-1).span_id,
    serviceName: 'pixel.relay',
    eventName: 'relay.job.running',
    attributes: {
      'pixel.job.id': acceptedJob.envelope.job_id,
      'pixel.job.execution_id': executionId,
      'pixel.job.from_state': 'ACCEPTED',
      'pixel.job.to_state': 'RUNNING',
    },
  });
  const crossEnvironment = structuredClone(running.job);
  crossEnvironment.envelope.environment = 'production';
  for (const item of crossEnvironment.transitions) item.environment = 'production';
  const memory = new MemoryService({
    environment: 'simulation',
    intakeContextProvider: new SimulatorMemoryIntakeContextProvider(),
    memoryStore: new SimulatorMemoryStoreAdapter(),
    relayStore: relayStoreWithGet(subject.relayStore, () => crossEnvironment),
    evidence: subject.evidence,
    ids: subject.ids,
    clock: () => NOW,
  });
  const result = await memory.buildContext({
    job_id: crossEnvironment.envelope.job_id,
    query: 'router',
  });

  assert.equal(result.reason_code, 'JOB_ENVIRONMENT_DENIED');
  assert.equal(assessMemoryContextTraceCompleteness(
    subject.evidence.forTrace(result.trace_id),
  ).complete, true);
});

test('intake completeness rejects missing stages, broken parentage, duplicates, and leaked attributes', async () => {
  const subject = await runtime({ seed: 97_000 });
  const result = await subject.memory.intake(INTAKE_INTENT);
  const trace = structuredClone(subject.evidence.forTrace(result.trace_id));

  const missing = trace.filter(({ event_name }) => event_name !== 'memory.intake.context_resolved');
  assert.equal(assessMemoryIntakeTraceCompleteness(missing).complete, false);

  const broken = structuredClone(trace);
  broken.at(-1).parent_span_id = 'ffffffffffffffff';
  assert.equal(assessMemoryIntakeTraceCompleteness(broken).complete, false);

  const duplicate = structuredClone(trace);
  duplicate.push(structuredClone(duplicate.at(-1)));
  duplicate.at(-1).span_id = 'eeeeeeeeeeeeeeee';
  assert.equal(assessMemoryIntakeTraceCompleteness(duplicate).complete, false);

  const leaked = structuredClone(trace);
  leaked[1].attributes.raw_memory_text = 'blocked';
  assert.equal(assessMemoryIntakeTraceCompleteness(leaked).complete, false);

  const malformedAttributes = structuredClone(trace);
  malformedAttributes[0].attributes = null;
  assert.equal(assessMemoryIntakeTraceCompleteness(malformedAttributes).complete, false);
  malformedAttributes[0].attributes = 'not-an-object';
  assert.equal(assessMemoryIntakeTraceCompleteness(malformedAttributes).complete, false);

  const departmentMismatch = structuredClone(trace);
  departmentMismatch.at(-1).attributes['pixel.memory.department_ref'] = 'Finance & Opportunity';
  assert.equal(assessMemoryIntakeTraceCompleteness(departmentMismatch).complete, false);

  const attackerEventName = 'private blocked text used as an event';
  const unknown = structuredClone(trace);
  unknown.push({
    ...structuredClone(unknown.at(-1)),
    span_id: 'dddddddddddddddd',
    parent_span_id: unknown.at(-1).span_id,
    event_name: attackerEventName,
    attributes: {},
  });
  const unknownAssessment = assessMemoryIntakeTraceCompleteness(unknown);
  assert.equal(unknownAssessment.complete, false);
  assert.equal(JSON.stringify(unknownAssessment).includes(attackerEventName), false);

  const impossibleDenial = structuredClone(trace);
  const terminal = impossibleDenial.at(-1);
  terminal.event_name = 'memory.intake.denied';
  terminal.outcome = 'error';
  terminal.severity = 'error';
  terminal.attributes = { 'pixel.memory.reason_code': 'INTAKE_CONTEXT_UNAVAILABLE' };
  assert.equal(assessMemoryIntakeTraceCompleteness(impossibleDenial).complete, false);
});

test('context completeness rejects broken continuity, blocked IDs/text, and contradictory semantics', async () => {
  const subject = await runtime({ seed: 98_000 });
  const accepted = await subject.relay.accept(JOB_INTENT);
  const result = await subject.memory.buildContext({
    job_id: accepted.job.envelope.job_id,
    query: 'router',
  });
  const trace = structuredClone(subject.evidence.forTrace(result.trace_id));

  const broken = structuredClone(trace);
  broken.find(({ event_name }) => event_name === 'memory.context.requested').parent_span_id = 'ffffffffffffffff';
  assert.equal(assessMemoryContextTraceCompleteness(broken).complete, false);

  const leaked = structuredClone(trace);
  const filtered = leaked.find(({ event_name }) => event_name === 'memory.context.filtered');
  filtered.attributes['pixel.memory.blocked_id'] = 'memory-finance-blocked';
  filtered.attributes.raw_text = 'blocked content';
  assert.equal(assessMemoryContextTraceCompleteness(leaked).complete, false);

  const contradictory = structuredClone(trace);
  contradictory.find(({ event_name }) => event_name === 'memory.context.package_created').outcome = 'denied';
  assert.equal(assessMemoryContextTraceCompleteness(contradictory).complete, false);

  const counts = structuredClone(trace);
  counts.find(({ event_name }) => event_name === 'memory.context.budget_applied')
    .attributes['pixel.memory.included_count'] = 5;
  assert.equal(assessMemoryContextTraceCompleteness(counts).complete, false);

  const malformed = assessMemoryContextTraceCompleteness([null]);
  assert.equal(malformed.complete, false);
  assert.equal(malformed.errors[0], 'trace contains a malformed evidence record');

  const malformedAttributes = structuredClone(trace);
  malformedAttributes.find(({ event_name }) => event_name === 'memory.context.filtered').attributes = [];
  assert.equal(assessMemoryContextTraceCompleteness(malformedAttributes).complete, false);
  malformedAttributes.find(({ event_name }) => event_name === 'memory.context.filtered').attributes = 7;
  assert.equal(assessMemoryContextTraceCompleteness(malformedAttributes).complete, false);

  const duplicateSpan = structuredClone(trace);
  duplicateSpan.find(({ event_name }) => event_name === 'memory.context.scope_resolved').span_id = duplicateSpan[0].span_id;
  assert.equal(assessMemoryContextTraceCompleteness(duplicateSpan).complete, false);

  const laterParent = structuredClone(trace);
  laterParent.find(({ event_name }) => event_name === 'memory.context.requested').parent_span_id
    = laterParent.find(({ event_name }) => event_name === 'memory.context.package_created').span_id;
  assert.equal(assessMemoryContextTraceCompleteness(laterParent).complete, false);

  const fakeParent = structuredClone(trace);
  const requestedIndex = fakeParent.findIndex(({ event_name }) => event_name === 'memory.context.requested');
  const requested = fakeParent[requestedIndex];
  const fabricated = {
    timestamp: NOW,
    trace_id: requested.trace_id,
    span_id: 'cccccccccccccccc',
    parent_span_id: null,
    service_name: 'evil.service',
    event_name: 'fabricated.parent',
    severity: 'info',
    outcome: 'success',
    attributes: {},
  };
  requested.parent_span_id = fabricated.span_id;
  fakeParent.splice(requestedIndex, 0, fabricated);
  assert.equal(assessMemoryContextTraceCompleteness(fakeParent).complete, false);

  const terminalContradiction = structuredClone(trace);
  const candidateFailure = terminalContradiction.find(
    ({ event_name }) => event_name === 'memory.context.candidates_validated',
  );
  candidateFailure.outcome = 'error';
  candidateFailure.severity = 'error';
  candidateFailure.attributes = {
    'pixel.memory.reason_code': 'RECORD_INVALID',
    'pixel.memory.invalid_count': 1,
  };
  assert.equal(assessMemoryContextTraceCompleteness(terminalContradiction).complete, false);

  const successfulCandidateAsTerminal = trace.filter(({ event_name }) => ![
    'memory.context.filtered', 'memory.context.budget_applied', 'memory.context.package_created',
  ].includes(event_name));
  assert.equal(assessMemoryContextTraceCompleteness(successfulCandidateAsTerminal).complete, false);

  const positiveCharsWithNoItems = structuredClone(trace);
  positiveCharsWithNoItems.find(({ event_name }) => event_name === 'memory.context.budget_applied')
    .attributes['pixel.memory.included_text_chars'] = 1;
  assert.equal(assessMemoryContextTraceCompleteness(positiveCharsWithNoItems).complete, false);
});

test('trace completeness rejects non-string trace identifiers without throwing', async () => {
  const intake = await runtime({ seed: 102_000 });
  const intakeResult = await intake.memory.intake(INTAKE_INTENT);
  const intakeTrace = structuredClone(intake.evidence.forTrace(intakeResult.trace_id));
  intakeTrace[0].trace_id = { toString: null };
  assert.equal(assessMemoryIntakeTraceCompleteness(intakeTrace).complete, false);
  const intakeAttributes = structuredClone(intake.evidence.forTrace(intakeResult.trace_id));
  intakeAttributes.find(({ event_name }) => event_name === 'memory.record.stored')
    .attributes['pixel.memory.id'] = { toString: null };
  assert.equal(assessMemoryIntakeTraceCompleteness(intakeAttributes).complete, false);

  const context = await runtime({ seed: 103_000 });
  const accepted = await context.relay.accept(JOB_INTENT);
  const contextResult = await context.memory.buildContext({
    job_id: accepted.job.envelope.job_id,
    query: 'router',
  });
  const contextTrace = structuredClone(context.evidence.forTrace(contextResult.trace_id));
  contextTrace.find(({ event_name }) => event_name === 'memory.context.requested').span_id
    = { toString: null };
  assert.equal(assessMemoryContextTraceCompleteness(contextTrace).complete, false);
  const contextAttributes = structuredClone(context.evidence.forTrace(contextResult.trace_id));
  contextAttributes.find(({ event_name }) => event_name === 'memory.context.requested')
    .attributes['pixel.job.id'] = { toString: null };
  assert.equal(assessMemoryContextTraceCompleteness(contextAttributes).complete, false);
});

test('standalone state denial cannot claim ACCEPTED or bypass Relay continuity', async () => {
  const subject = await runtime({ seed: 100_000 });
  const result = await subject.memory.buildContext({ job_id: 'job-forged', query: 'router', budget: {} });
  const trace = structuredClone(subject.evidence.forTrace(result.trace_id));
  const rejection = trace[0];
  rejection.attributes = {
    'pixel.memory.reason_code': 'JOB_STATE_DENIED',
    'pixel.job.current_state': 'ACCEPTED',
  };

  assert.equal(assessMemoryContextTraceCompleteness(trace).complete, false);
});
