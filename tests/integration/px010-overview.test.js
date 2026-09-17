import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatorStorageAdapter } from '../../adapters/simulator/src/storage-simulator-adapter.js';
import { SimulatorSystemStatusWorker } from '../../adapters/simulator/src/system-status-worker-simulator-adapter.js';
import { createMilestoneRuntime } from '../../apps/mission-control/src/server.js';
import { openFreshnessState } from '../../apps/mission-control/src/freshness-state.js';
import { createOverviewSources } from '../../apps/mission-control/src/overview-sources.js';
import { AGENT_ID, workforceRuntime, seedActiveWorkforce } from '../helpers/px009-runtime.js';
import { px007Runtime, incidentInput } from '../helpers/px007-runtime.js';
const NOW = '2026-09-15T12:00:00.000Z';
const PATH = '/api/v1/mission-control/overview';
async function start(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'px010-http-'));
  const runtime = await createMilestoneRuntime({ adapterFactory: d => new SimulatorStorageAdapter(d), clock: () => NOW, overviewFreshness: openFreshnessState(join(dir, 'state')), ...options });
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  t.after(async () => { await new Promise(r => runtime.server.close(r)); rmSync(dir, { recursive: true, force: true }); });
  return { runtime, url: `http://127.0.0.1:${runtime.server.address().port}` };
}
test('PX010 overview is GET-only, rejects query/body authority and uses no-store', async t => {
  const { url } = await start(t);
  const response = await fetch(url + PATH);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const view = await response.json();
  assert.equal(view.sections.storage.source_mode, 'SIMULATED');
  assert.equal(view.sections.recent_work.availability, 'AVAILABLE');
  for (const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS']) {
    const r = await fetch(url + PATH, { method });
    assert.equal(r.status, 405); assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  for (const query of ['?role=owner','?freshness_token=9','?environment=production','?%ZZ=1','?a=1&a=2']) {
    const r = await fetch(url + PATH + query); assert.equal(r.status, 400); assert.equal(r.headers.get('cache-control'), 'no-store');
  }
});
test('PX010 Recent Work reads real Relay truth with no worker payload and no mutations', async t => {
  const { url, runtime } = await start(t);
  const submitted = await fetch(url + '/api/v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_name: 'pixel.job.submit-intent.v1', schema_version: '1.0.0', idempotency_key: 'px010-status', job_type: 'system-status', requested_capability: 'pixel.system-status.read' }) }).then(r => r.json());
  const view = await fetch(url + PATH).then(r => r.json());
  assert.equal(view.sections.recent_work.data.items[0].id, submitted.data.envelope.job_id);
  assert.equal(view.sections.recent_work.data.items[0].state, 'COMPLETED');
  assert.equal(runtime.jobWorker.invocationCount, 1);
  assert.doesNotMatch(JSON.stringify(view), /execution_request|model_invocation|gateway_decision|worker_output|idempotency/);
  const access = await fetch(url + '/api/v1/access/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: 'pixel-bench', capability: 'launch' }) });
  assert.equal(access.status, 200);
});
test('PX010 Recent Work truncates to the newest canonical jobs and marks the omission', async t => {
  // An advancing clock gives each job a distinct canonical created_at, so the
  // newest-first ordering is observable rather than falling back to job IDs.
  let tick = Date.parse(NOW);
  const { url } = await start(t, { clock: () => new Date(tick += 1000).toISOString() });
  const submit = key => fetch(url + '/api/v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_name: 'pixel.job.submit-intent.v1', schema_version: '1.0.0', idempotency_key: key, job_type: 'system-status', requested_capability: 'pixel.system-status.read' }) }).then(r => r.json());
  const ids = [];
  for (let i = 1; i <= 13; i += 1) ids.push((await submit(`px010-truncate-${i}`)).data.envelope.job_id);
  const section = (await fetch(url + PATH).then(r => r.json())).sections.recent_work;
  assert.equal(section.availability, 'AVAILABLE');
  assert.equal(section.data.items.length, 12);
  assert.equal(section.data.total_count, 13);
  assert.equal(section.data.truncated, true);
  assert.equal(section.data.order, 'newest');
  // Newest first, and the oldest job is the one omitted.
  assert.equal(section.data.items[0].id, ids.at(-1));
  assert.equal(section.data.items.some(item => item.id === ids[0]), false);
  assert.doesNotMatch(JSON.stringify(section), /execution_request|model_invocation|gateway_decision|worker_output|idempotency/);
});
test('PX010 Workforce read aggregates canonical records without model identity or authority conflation', () => {
  const r = workforceRuntime(); seedActiveWorkforce(r);
  assert.equal(typeof r.workforce.homeSummary, 'function');
  const summary = r.workforce.homeSummary();
  assert.equal(summary.total, 1); assert.equal(summary.active, 1);
  assert.equal(summary.restricted, 0);
  assert.equal(Object.hasOwn(summary, 'quarantined'), false);
  assert.doesNotMatch(JSON.stringify(summary), /agent_id|model|evidence/);
});

test('PX010 Workforce summary counts canonical LIMITED and RETRAINING as restricted', () => {
  for (const lifecycle of ['LIMITED', 'RETRAINING']) {
    const r = workforceRuntime();
    seedActiveWorkforce(r, { lifecycle });
    const summary = r.workforce.homeSummary();
    assert.equal(summary.total, 1);
    assert.equal(summary.active, 0, lifecycle);
    assert.equal(summary.restricted, 1, lifecycle);
  }
});

test('PX010 Workforce summary uses bounded store seams and validates every result', () => {
  const r = workforceRuntime(); seedActiveWorkforce(r);
  const originalList = r.workforceStore.list.bind(r.workforceStore);
  r.workforceStore.list = kind => {
    if (kind === 'agentops-evaluation' || kind === 'workforce-record') throw new Error('unbounded history read');
    return originalList(kind);
  };
  assert.equal(r.workforce.homeSummary().total, 1);
  r.workforceStore.latestEvaluationsForSummary = () => [{}];
  assert.throws(() => r.workforce.homeSummary(), /AgentOps evaluation failed contract validation/);
});

test('PX010 Workforce summary enforces the record bound before the store materializes the bucket', () => {
  const r = workforceRuntime(); seedActiveWorkforce(r);
  const store = r.workforceStore;
  const realClone = globalThis.structuredClone;
  let clones = 0;
  globalThis.structuredClone = value => { clones += 1; return realClone(value); };
  try {
    // Over the limit: the live bucket size alone rejects, so not one record is
    // cloned or sorted. A store that bound after list() would clone first.
    assert.throws(() => store.workforceRecordsForSummary(0), /PROJECTION_BOUND_EXCEEDED/);
    assert.equal(clones, 0);
    assert.deepEqual(store.workforceRecordsForSummary(1).map(record => record.agent_id), [AGENT_ID]);
    assert.equal(clones, 1);
  } finally { globalThis.structuredClone = realClone; }
});

test('PX010 source mode keeps SIMULATED ahead of SHADOW ahead of LIVE', async () => {
  const sources = (source, environment) => createOverviewSources({
    projector: { getDevice: () => ({ source, environment, verified_at: NOW }) },
    relay: { recentWork: async () => ({ source, environment, data: { items: [], total_count: 0, truncated: false } }) },
    clock: () => NOW,
  });
  for (const reader of ['storage', 'recent_work']) {
    // A live source running in a shadow environment is SHADOW, never LIVE.
    assert.equal((await sources('live', 'shadow')[reader].read()).source_mode, 'SHADOW');
    assert.equal((await sources('live', 'production')[reader].read()).source_mode, 'LIVE');
    // Simulator provenance outranks the environment: SHADOW never masks SIMULATED.
    assert.equal((await sources('simulator', 'shadow')[reader].read()).source_mode, 'SIMULATED');
  }
});

test('PX010 canonical overview sources validate their configured mode at construction', () => {
  const base = { projector: { getDevice: () => null }, relay: { recentWork: async () => null }, clock: () => NOW };
  // Canonical company/incident readers stamp the configured mode on available
  // sections, so an invalid configuration must fail at construction instead of
  // failing every request with SOURCE_INVALID at read time.
  for (const sourceMode of [null, undefined, 'SIMULATED-2', 'simulated']) {
    assert.throws(() => createOverviewSources({ ...base, orgState: { evaluateExecutionInputs: () => ({}) }, sourceMode }), TypeError);
    assert.throws(() => createOverviewSources({ ...base, incidents: { activeIncidents: () => [] }, sourceMode }), TypeError);
  }
  for (const sourceMode of ['SIMULATED', 'SHADOW', 'LIVE']) {
    assert.equal(typeof createOverviewSources({ ...base, orgState: { evaluateExecutionInputs: () => ({}) }, incidents: { activeIncidents: () => [] }, sourceMode }).company.read, 'function');
  }
  // Without canonical sources there is nothing to stamp: construction stays legal.
  assert.equal(typeof createOverviewSources(base).storage.read, 'function');
});

test('PX010 storage and Relay reads carry their applicable environment', async t => {
  const { runtime } = await start(t);
  assert.equal(runtime.projector.getDevice('PIXEL-STORAGE-01').environment, 'simulation');
  assert.equal((await runtime.relay.recentWork()).environment, 'simulation');
});

test('PX010 active incident projection exposes only the count, not resource identifiers', async t => {
  const r = px007Runtime();
  assert.equal(r.incident.createIncident(incidentInput()).disposition, 'RECORDED');
  const { url } = await start(t, { incidents: r.incident, orgState: r.orgState, overviewSourceMode: 'SIMULATED' });
  const section = (await fetch(url + PATH).then(response => response.json())).sections.active_incidents;
  assert.equal(section.data.items[0].affected_resource_count, 1);
  assert.equal(Object.hasOwn(section.data.items[0], 'refs'), false);
  assert.doesNotMatch(JSON.stringify(section), /simulation\.storage\.array-01/);
});

test('PX010 canonical Company modes and incident source uncertainty reach HTTP presentation', async t => {
  const r = workforceRuntime();
  const { url } = await start(t, { orgState: r.orgState, overviewSourceMode: 'SIMULATED' });
  for (const mode of ['NORMAL','NIGHT','HOLIDAY','MAINTENANCE']) {
    const result = r.orgState.setCompanyState({ inputs: [{ state: mode, ref: 'test-calendar' }] });
    assert.equal(result.disposition, 'RECORDED');
    const view = await fetch(url + PATH).then(r => r.json());
    assert.equal(view.sections.company.data.state, mode);
    assert.equal(view.sections.active_incidents.availability, 'UNAVAILABLE');
  }
});

test('PX010 freshness failure is a bounded 503 without a token; request headers carry no authority', async t => {
  const { url } = await start(t, { overviewFreshness: null });
  const response = await fetch(url + PATH, { headers: { 'x-role': 'owner', 'x-environment': 'production', 'x-freshness-token': '999' } });
  assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { contract: 'pixel.mission-control-overview.v1', availability: 'FAILED', reason_code: 'FRESHNESS_STATE_UNAVAILABLE' });
});


test('PX010 GET body is rejected before any source read', async t => {
  const { url } = await start(t);
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest(url + PATH, { method: 'GET', headers: { 'content-length': '16' } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end('{"role":"owner"}');
  });
  assert.equal(result.status, 400); assert.equal(JSON.parse(result.body).reason_code, 'REQUEST_INVALID');
});

test('PX010 failed worker stays FAILED in Recent Work', async t => {
  const { url } = await start(t, { jobWorker: new SimulatorSystemStatusWorker({ outcomeCode: 'WORKER_UNAVAILABLE' }) });
  await fetch(url + '/api/v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_name: 'pixel.job.submit-intent.v1', schema_version: '1.0.0', idempotency_key: 'px010-failure', job_type: 'system-status', requested_capability: 'pixel.system-status.read' }) });
  const view = await fetch(url + PATH).then(r => r.json());
  assert.equal(view.sections.recent_work.data.items[0].state, 'FAILED');
  assert.equal(view.sections.recent_work.data.items[0].reason_code, 'WORKER_FAILED');
});

test('PX010 malformed Storage identity or health cannot render Ready', async t => {
  const { runtime } = await start(t);
  const { normalizeSection } = await import('../../apps/mission-control/src/overview-contract.js');
  const data = runtime.projector.getDevice('PIXEL-STORAGE-01');
  for (const change of [{ role_id: 'OTHER' }, { health_state: 'unrecognized' }, { state: 'Fine' }]) {
    const section = normalizeSection('storage', { availability: 'AVAILABLE', source_mode: 'SIMULATED', observed_at: NOW, data: { ...data, ...change } }, NOW);
    assert.equal(section.availability, 'FAILED');
  }
});
