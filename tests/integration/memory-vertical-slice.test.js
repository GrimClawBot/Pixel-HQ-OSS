import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorJobContextProvider } from '../../adapters/simulator/src/job-context-simulator-provider.js';
import { SimulatorMemoryIntakeContextProvider } from '../../adapters/simulator/src/memory-intake-context-simulator-provider.js';
import { SimulatorMemoryStoreAdapter } from '../../adapters/simulator/src/memory-store-simulator-adapter.js';
import { SimulatorRelayStoreAdapter } from '../../adapters/simulator/src/relay-store-simulator-adapter.js';
import { MEMORY_RECORD_EVENT_NAME, MEMORY_SCHEMA_VERSION } from '../../packages/contracts/src/memory-v1.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { MemoryService } from '../../services/memory/src/memory-service.js';
import { RelayService } from '../../services/relay/src/relay-service.js';

const NOW = '2026-09-08T12:00:00.000Z';
const DEPARTMENT = 'Infrastructure / HomeLab';
const JOB_INTENT = Object.freeze({
  event_name: 'pixel.job.submit-intent.v1',
  schema_version: '1.0.0',
  idempotency_key: 'memory-context-001',
  job_type: 'system-status',
  requested_capability: 'pixel.system-status.read',
});

function createIds(seed = 50_000) {
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

async function runtime({ memoryStore = new SimulatorMemoryStoreAdapter(), seed } = {}) {
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
    intakeContextProvider: new SimulatorMemoryIntakeContextProvider(),
    memoryStore,
    relayStore,
    evidence,
    ids,
    clock: () => NOW,
  });
  const accepted = await relay.accept(JOB_INTENT);
  assert.equal(accepted.job.current_state, 'ACCEPTED');
  return { accepted, evidence, ids, memory, memoryStore, relayStore };
}

function canonicalRecord({
  id,
  text,
  tags = ['memory'],
  observedAt = NOW,
  department = DEPARTMENT,
  handling = 'INTERNAL',
  lifecycle = 'ACTIVE',
}) {
  const serial = Number(id.replace(/\D/g, '')) || 1;
  return {
    memory_id: id,
    event_name: MEMORY_RECORD_EVENT_NAME,
    schema_version: MEMORY_SCHEMA_VERSION,
    created_at: NOW,
    observed_at: observedAt,
    environment: 'simulation',
    scope: { scope_type: 'DEPARTMENT', department_ref: department },
    memory_class: 'OPERATIONAL',
    handling,
    lifecycle,
    content: { text, tags },
    provenance: {
      source_class: 'synthetic',
      source_ref: `fixture-${serial}`,
      intake_context_contract: 'pixel.memory-intake-context-provider.v1',
      intake_source: 'simulator',
    },
    trace_id: serial.toString(16).padStart(32, '0'),
    span_id: serial.toString(16).padStart(16, '0'),
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

test('synthetic intake and accepted Relay job produce a canonical bounded context package', async () => {
  const subject = await runtime();
  const stored = await subject.memory.intake({
    event_name: 'pixel.memory.intake-intent.v1',
    schema_version: '1.0.0',
    content: { text: 'Router 7 status is stable.', tags: ['ＲＯＵＴＥＲ 7', 'Status'] },
  });
  const result = await subject.memory.buildContext({
    job_id: subject.accepted.job.envelope.job_id,
    query: 'router 7 status',
  });

  assert.equal(stored.disposition, 'STORED');
  assert.deepEqual(stored.record.content.tags, ['router-7', 'status']);
  assert.equal(stored.record.scope.department_ref, DEPARTMENT);
  assert.equal(result.disposition, 'CREATED');
  assert.deepEqual(result.package.items, [{
    memory_id: stored.record.memory_id,
    text: stored.record.content.text,
    source_ref: 'simulator-memory-intake',
  }]);
  assert.deepEqual(result.package.selection, { included_count: 1, omitted_count: 0, truncated: false });
  assert.equal(result.trace_id, subject.accepted.trace_id);
  assert.equal(Object.isFrozen(result.package), true);
  assert.equal(Object.isFrozen(result.package.items), true);
  assert.deepEqual(subject.evidence.forTrace(result.trace_id)
    .filter(({ service_name }) => service_name === 'pixel.memory')
    .map(({ event_name }) => event_name), [
    'memory.context.requested',
    'memory.context.scope_resolved',
    'memory.context.candidates_validated',
    'memory.context.filtered',
    'memory.context.budget_applied',
    'memory.context.package_created',
  ]);

  const approved = subject.memory.getApprovedContextPackage(result.package.package_id);
  assert.deepEqual(approved, result.package);
  assert.notEqual(approved, result.package);
  assert.equal(Object.isFrozen(approved), true);
  assert.equal(Object.isFrozen(approved.items), true);
  assert.equal(subject.memory.getApprovedContextPackage('package-missing'), null);
  assert.equal(subject.memory.getApprovedContextPackage({ package_id: result.package.package_id }), null);
});

test('Memory registers no approved package when package-created evidence cannot commit', async () => {
  const ids = createIds(90_000);
  const committed = new EvidenceRecorder({ clock: () => NOW });
  const evidence = {
    append(record) {
      if (record.eventName === 'memory.context.package_created') throw new Error('private evidence failure');
      return committed.append(record);
    },
  };
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
    intakeContextProvider: new SimulatorMemoryIntakeContextProvider(),
    memoryStore: new SimulatorMemoryStoreAdapter(),
    relayStore,
    evidence,
    ids,
    clock: () => NOW,
  });
  const accepted = await relay.accept({ ...JOB_INTENT, idempotency_key: 'memory-evidence-failure' });
  await memory.intake({
    event_name: 'pixel.memory.intake-intent.v1',
    schema_version: '1.0.0',
    content: { text: 'System status stable.', tags: ['system', 'status'] },
  });

  await assert.rejects(memory.buildContext({ job_id: accepted.job.envelope.job_id, query: 'system status' }));
  assert.equal(memory.getApprovedContextPackage('package-90020'), null);
});

test('deterministic score, timestamp, and ID ordering excludes superseded and zero-relevance records', async () => {
  const records = [
    canonicalRecord({ id: 'memory-4', text: 'router memory', tags: ['router'], observedAt: '2026-09-08T11:00:00.000Z' }),
    canonicalRecord({ id: 'memory-2', text: 'router memory', tags: ['router'], observedAt: '2026-09-08T12:00:00.000Z' }),
    canonicalRecord({ id: 'memory-1', text: 'router memory', tags: ['router'], observedAt: '2026-09-08T12:00:00.000Z' }),
    canonicalRecord({ id: 'memory-3', text: 'router unrelated', tags: ['other'], observedAt: '2026-09-08T13:00:00.000Z' }),
    canonicalRecord({ id: 'memory-5', text: 'router memory', tags: ['router'], lifecycle: 'SUPERSEDED' }),
  ];
  const subject = await runtime({ memoryStore: listingStore(records) });
  const result = await subject.memory.buildContext({
    job_id: subject.accepted.job.envelope.job_id,
    query: 'router',
  });

  assert.deepEqual(result.package.items.map(({ memory_id }) => memory_id), [
    'memory-1', 'memory-2', 'memory-4', 'memory-3',
  ]);
  assert.equal(result.package.selection.omitted_count, 0);

  const empty = await runtime({
    memoryStore: listingStore([canonicalRecord({ id: 'memory-8', text: 'switch stable', tags: ['switch'] })]),
    seed: 60_000,
  });
  const emptyResult = await empty.memory.buildContext({
    job_id: empty.accepted.job.envelope.job_id,
    query: 'router',
  });
  assert.deepEqual(emptyResult.package.items, []);
  assert.deepEqual(emptyResult.package.selection, { included_count: 0, omitted_count: 0, truncated: false });
});

test('character budget includes exact fit, omits one-over, and counts whole records only', async () => {
  const records = [
    canonicalRecord({ id: 'memory-1', text: `router ${'a'.repeat(1017)}`, tags: ['router'] }),
    canonicalRecord({ id: 'memory-2', text: `router ${'b'.repeat(1017)}`, tags: ['router'] }),
    canonicalRecord({ id: 'memory-3', text: 'router', tags: ['router'] }),
  ];
  const subject = await runtime({ memoryStore: listingStore(records) });
  const result = await subject.memory.buildContext({
    job_id: subject.accepted.job.envelope.job_id,
    query: 'router',
  });

  assert.deepEqual(result.package.items.map(({ memory_id }) => memory_id), ['memory-1', 'memory-2']);
  assert.equal(result.package.items.reduce((sum, item) => sum + Array.from(item.text).length, 0), 2048);
  assert.deepEqual(result.package.selection, { included_count: 2, omitted_count: 1, truncated: true });
  assert.equal(result.package.items.some(({ text }) => text.length < 1024), false);

  const oneOverRecords = [
    canonicalRecord({ id: 'memory-11', text: `router ${'a'.repeat(1017)}`, tags: ['router'] }),
    canonicalRecord({ id: 'memory-12', text: `router ${'b'.repeat(1016)}`, tags: ['router'] }),
    canonicalRecord({ id: 'memory-13', text: '😀x', tags: ['router'] }),
  ];
  const oneOver = await runtime({ memoryStore: listingStore(oneOverRecords), seed: 65_000 });
  const oneOverResult = await oneOver.memory.buildContext({
    job_id: oneOver.accepted.job.envelope.job_id,
    query: 'router',
  });
  assert.equal(oneOverResult.package.items
    .reduce((sum, item) => sum + Array.from(item.text).length, 0), 2047);
  assert.deepEqual(oneOverResult.package.items.map(({ memory_id }) => memory_id), ['memory-11', 'memory-12']);
  assert.deepEqual(oneOverResult.package.selection, { included_count: 2, omitted_count: 1, truncated: true });
});

test('exact item fit is allowed and a record blocked by both limits increments omission once', async () => {
  const records = Array.from({ length: 5 }, (_, index) => canonicalRecord({
    id: `memory-${index + 1}`,
    text: `router${String(index).repeat(506)}`,
    tags: ['router'],
  }));
  const subject = await runtime({ memoryStore: listingStore(records) });
  const result = await subject.memory.buildContext({
    job_id: subject.accepted.job.envelope.job_id,
    query: 'router',
  });

  assert.equal(result.package.items.length, 4);
  assert.equal(result.package.items.reduce((sum, item) => sum + Array.from(item.text).length, 0), 2048);
  assert.deepEqual(result.package.selection, { included_count: 4, omitted_count: 1, truncated: true });
});

test('final ID tie ordering is locale-independent ordinal order', async () => {
  const records = ['memory_A', 'memory.a', 'memory-A', 'memory-a'].map((id) => canonicalRecord({
    id,
    text: 'router stable',
    tags: ['router'],
  }));
  const subject = await runtime({ memoryStore: listingStore(records) });
  const result = await subject.memory.buildContext({
    job_id: subject.accepted.job.envelope.job_id,
    query: 'router',
  });

  assert.deepEqual(result.package.items.map(({ memory_id }) => memory_id), [
    'memory-A', 'memory-a', 'memory.a', 'memory_A',
  ]);
});
