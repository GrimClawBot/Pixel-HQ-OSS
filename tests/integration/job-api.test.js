import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { SimulatorStorageAdapter } from '../../adapters/simulator/src/storage-simulator-adapter.js';
import { createMilestoneRuntime } from '../../apps/mission-control/src/server.js';
import { assessJobTraceCompleteness } from '../../packages/telemetry/src/job-trace-completeness.js';
import { createRelayHttpHandler } from '../../services/relay/src/http-handler.js';

const NOW = '2026-09-07T12:00:00.000Z';
const INTENT = Object.freeze({
  event_name: 'pixel.job.submit-intent.v1',
  schema_version: '1.0.0',
  idempotency_key: 'api-status-check-001',
  job_type: 'system-status',
  requested_capability: 'pixel.system-status.read',
});

function createIds(seed = 40_000) {
  let value = seed;
  return {
    nextEventId: () => `event-${++value}`,
    nextJobId: () => `job-${++value}`,
    nextExecutionId: () => `execution-${++value}`,
    nextSpanId: () => (++value).toString(16).padStart(16, '0'),
    nextTraceId: () => (++value).toString(16).padStart(32, '0'),
  };
}

async function startRuntime(options = {}) {
  const runtime = await createMilestoneRuntime({
    adapterFactory: (dependencies) => new SimulatorStorageAdapter(dependencies),
    clock: () => NOW,
    ids: createIds(),
    ...options,
  });
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const address = runtime.server.address();
  return {
    ...runtime,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => runtime.server.close((error) => error ? reject(error) : resolve())),
  };
}

async function submit(baseUrl, intent = INTENT, headers = { 'content-type': 'application/json' }) {
  const response = await fetch(`${baseUrl}/api/v1/jobs`, {
    method: 'POST', headers, body: JSON.stringify(intent),
  });
  return { response, body: await response.json() };
}

function asynchronouslyFailingResponse(message) {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    writeHead() { this.headersSent = true; },
    end() {
      this.writableEnded = true;
      setImmediate(() => this.emit('error', new Error(message)));
    },
    destroy() { this.destroyed = true; },
  });
}

test('versioned jobs API submits, replays, and reads one canonical completed job', async (t) => {
  const runtime = await startRuntime();
  t.after(runtime.close);

  const created = await submit(runtime.baseUrl);
  const replay = await submit(runtime.baseUrl);
  const jobId = created.body.data.envelope.job_id;
  const read = await fetch(`${runtime.baseUrl}/api/v1/jobs/${jobId}`);
  const readBody = await read.json();

  assert.equal(created.response.status, 201);
  assert.equal(replay.response.status, 200);
  assert.equal(read.status, 200);
  assert.equal(created.body.data.current_state, 'COMPLETED');
  assert.equal(replay.body.data.envelope.job_id, jobId);
  assert.equal(readBody.data.result.result_id, created.body.data.result.result_id);
  assert.equal(runtime.jobWorker.invocationCount, 1);
});

test('repeated job GETs branch from stable canonical evidence without invalidating completeness', async (t) => {
  const runtime = await startRuntime();
  t.after(runtime.close);
  const created = await submit(runtime.baseUrl);
  const jobId = created.body.data.envelope.job_id;

  for (let index = 0; index < 10; index += 1) {
    const response = await fetch(`${runtime.baseUrl}/api/v1/jobs/${jobId}`);
    assert.equal(response.status, 200);
  }

  const trace = runtime.evidence.forTrace(created.body.data.envelope.trace_id);
  assert.equal(trace.filter(({ event_name }) => event_name === 'api.job.response').length, 11);
  assert.equal(assessJobTraceCompleteness(trace).complete, true);
  const responseParents = new Set(
    trace.filter(({ event_name }) => event_name === 'api.job.response').map(({ parent_span_id }) => parent_span_id),
  );
  const prepared = trace.filter(({ event_name }) => event_name === 'api.job.response.prepared');
  assert.equal(prepared.length, 11);
  assert.equal(new Set(prepared.map(({ parent_span_id }) => parent_span_id)).size, 1);
  assert.equal(prepared.every(({ parent_span_id }) => parent_span_id === created.body.data.transitions.at(-1).span_id), true);
  assert.deepEqual(responseParents, new Set(prepared.map(({ span_id }) => span_id)));
});

test('API exposes authoritative Tool Gateway denial as a created FAILED job', async (t) => {
  const runtime = await startRuntime();
  t.after(runtime.close);
  const denied = await submit(runtime.baseUrl, {
    ...INTENT,
    idempotency_key: 'api-raw-status-001',
    requested_capability: 'pixel.system-status.raw.read',
  });

  assert.equal(denied.response.status, 201);
  assert.equal(denied.body.data.current_state, 'FAILED');
  assert.equal(denied.body.data.result.outcome_code, 'CAPABILITY_DENIED');
  assert.equal(runtime.jobWorker.invocationCount, 0);
});

test('HTTP boundary rejects unsupported content type and forged authority without a worker', async (t) => {
  const runtime = await startRuntime();
  t.after(runtime.close);

  const plain = await submit(runtime.baseUrl, INTENT, { 'content-type': 'text/plain' });
  const forged = await submit(runtime.baseUrl, { ...INTENT, environment: 'production' });

  assert.equal(plain.response.status, 400);
  assert.equal(plain.body.error.code, 'JOB_INTENT_INVALID');
  assert.equal(forged.response.status, 400);
  assert.equal(forged.body.error.code, 'CLIENT_AUTHORITY_CLAIM_REJECTED');
  assert.equal(runtime.jobWorker.invocationCount, 0);
  assert.doesNotMatch(JSON.stringify(runtime.evidence.all()), /production/);
});

test('HTTP response failure after committed execution is contained and replay never re-executes', async () => {
  const runtime = await createMilestoneRuntime({
    adapterFactory: (dependencies) => new SimulatorStorageAdapter(dependencies),
    clock: () => NOW,
    ids: createIds(),
  });
  const handler = createRelayHttpHandler({ relay: runtime.relay, evidence: runtime.evidence, ids: runtime.jobIds });
  const request = new PassThrough();
  request.method = 'POST';
  request.headers = { 'content-type': 'application/json' };
  const response = {
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; },
    end() { throw new Error('sensitive transport failure'); },
    destroy() { this.destroyed = true; },
  };

  assert.equal(handler(request, response, new URL('http://pixel.local/api/v1/jobs')), true);
  request.end(JSON.stringify(INTENT));
  await new Promise((resolve) => setImmediate(resolve));
  const replay = await runtime.relay.submit(INTENT);

  assert.equal(response.destroyed, true);
  assert.equal(replay.job.current_state, 'COMPLETED');
  assert.equal(runtime.jobWorker.invocationCount, 1);
  const trace = runtime.evidence.forTrace(replay.job.envelope.trace_id);
  assert.equal(trace.some(({ event_name }) => event_name === 'api.job.response'), false);
  assert.equal(trace.some(({ event_name }) => event_name === 'api.job.response.failed'), true);
  assert.equal(assessJobTraceCompleteness(trace).complete, true);
  assert.doesNotMatch(JSON.stringify(runtime.evidence.all()), /sensitive transport failure/);
});

test('asynchronous response error records failure instead of fabricated API success', async () => {
  const runtime = await createMilestoneRuntime({
    adapterFactory: (dependencies) => new SimulatorStorageAdapter(dependencies),
    clock: () => NOW,
    ids: createIds(),
  });
  const handler = createRelayHttpHandler({ relay: runtime.relay, evidence: runtime.evidence, ids: runtime.jobIds });
  const request = new PassThrough();
  request.method = 'POST';
  request.headers = { 'content-type': 'application/json' };
  const response = Object.assign(new EventEmitter(), {
    body: '',
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    writeHead() { this.headersSent = true; },
    end(body) {
      this.body = body;
      this.writableEnded = true;
      setImmediate(() => this.emit('error', new Error('sensitive asynchronous socket failure')));
    },
    destroy() { this.destroyed = true; },
  });

  assert.equal(handler(request, response, new URL('http://pixel.local/api/v1/jobs')), true);
  request.end(JSON.stringify(INTENT));
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  const job = JSON.parse(response.body).data;
  const replay = await runtime.relay.submit(INTENT);
  const trace = runtime.evidence.forTrace(job.envelope.trace_id);

  assert.equal(response.destroyed, true);
  assert.equal(replay.disposition, 'EXISTING');
  assert.equal(runtime.jobWorker.invocationCount, 1);
  assert.equal(trace.some(({ event_name }) => event_name === 'api.job.response'), false);
  assert.equal(trace.some(({ event_name }) => event_name === 'api.job.response.failed'), true);
  assert.doesNotMatch(JSON.stringify(trace), /sensitive asynchronous socket failure/);
});

test('post-commit API evidence failure preserves the job and leaves request evidence incomplete', async () => {
  const runtime = await createMilestoneRuntime({
    adapterFactory: (dependencies) => new SimulatorStorageAdapter(dependencies),
    clock: () => NOW,
    ids: createIds(),
  });
  const evidence = {
    append(record) {
      if (record.eventName === 'api.job.response') throw new Error('sensitive API evidence failure');
      return runtime.evidence.append(record);
    },
    forTrace: (traceId) => runtime.evidence.forTrace(traceId),
  };
  const handler = createRelayHttpHandler({ relay: runtime.relay, evidence, ids: runtime.jobIds });
  const request = new PassThrough();
  request.method = 'POST';
  request.headers = { 'content-type': 'application/json' };
  const response = {
    body: '',
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; },
    end(body, callback) { this.body = body; this.writableEnded = true; callback(); },
    destroy() { this.destroyed = true; },
  };

  assert.equal(handler(request, response, new URL('http://pixel.local/api/v1/jobs')), true);
  request.end(JSON.stringify(INTENT));
  await new Promise((resolve) => setImmediate(resolve));
  const job = JSON.parse(response.body).data;
  const trace = runtime.evidence.forTrace(job.envelope.trace_id);
  const replay = await runtime.relay.submit(INTENT);

  assert.equal(job.current_state, 'COMPLETED');
  assert.equal(replay.disposition, 'EXISTING');
  assert.equal(replay.job.current_state, 'COMPLETED');
  assert.equal(runtime.jobWorker.invocationCount, 1);
  assert.equal(response.writableEnded, true);
  assert.equal(response.destroyed, false);
  assert.equal(trace.some(({ event_name }) => event_name === 'api.job.response.prepared'), true);
  assert.equal(trace.some(({ event_name }) => event_name === 'api.job.response'), false);
  assert.equal(assessJobTraceCompleteness(trace).complete, false);
  assert.doesNotMatch(JSON.stringify(trace), /sensitive API evidence failure/);
});

test('unknown and malformed job IDs return bounded responses', async (t) => {
  const runtime = await startRuntime();
  t.after(runtime.close);

  const unknown = await fetch(`${runtime.baseUrl}/api/v1/jobs/job-missing`);
  const malformed = await fetch(`${runtime.baseUrl}/api/v1/jobs/not%20valid`);

  assert.equal(unknown.status, 404);
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /not valid/);
});

test('late unknown-job response failure is contained without an unhandled rejection', async () => {
  const runtime = await createMilestoneRuntime({
    adapterFactory: (dependencies) => new SimulatorStorageAdapter(dependencies),
    clock: () => NOW,
    ids: createIds(),
  });
  const handler = createRelayHttpHandler({ relay: runtime.relay, evidence: runtime.evidence, ids: runtime.jobIds });
  const response = asynchronouslyFailingResponse('sensitive unknown-job socket failure');

  assert.equal(handler(
    { method: 'GET' }, response, new URL('http://pixel.local/api/v1/jobs/job-missing'),
  ), true);
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

  assert.equal(response.destroyed, true);
  assert.doesNotMatch(JSON.stringify(runtime.evidence.all()), /sensitive unknown-job socket failure/);
});

test('late malformed-ID response failure is contained without an unhandled rejection', async () => {
  const runtime = await createMilestoneRuntime({
    adapterFactory: (dependencies) => new SimulatorStorageAdapter(dependencies),
    clock: () => NOW,
    ids: createIds(),
  });
  const handler = createRelayHttpHandler({ relay: runtime.relay, evidence: runtime.evidence, ids: runtime.jobIds });
  const response = asynchronouslyFailingResponse('sensitive malformed-ID socket failure');

  assert.equal(handler(
    { method: 'GET' }, response, new URL('http://pixel.local/api/v1/jobs/not%20valid'),
  ), true);
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

  assert.equal(response.destroyed, true);
  assert.doesNotMatch(JSON.stringify(runtime.evidence.all()), /sensitive malformed-ID socket failure/);
});
