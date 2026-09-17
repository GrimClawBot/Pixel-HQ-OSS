import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const contract = await import('../../apps/mission-control/src/overview-contract.js').catch(() => ({}));
const projectorModule = await import('../../apps/mission-control/src/overview-projector.js').catch(() => ({}));
const freshness = await import('../../apps/mission-control/src/freshness-state.js').catch(() => ({}));
const NOW = '2026-09-15T12:00:00.000Z';
const company = { state: 'NORMAL', summary: 'Pixel HQ operating state', refs: [] };
const source = (data) => ({ read: () => ({ availability: 'AVAILABLE', source_mode: 'SIMULATED', observed_at: NOW, data }) });

 test('PX010 contract normalizes NFC before code-point bounds and never clips identifiers', () => {
  assert.equal(typeof contract.text, 'function');
  assert.equal(contract.text('e\u0301'.repeat(120), 120), 'é'.repeat(120));
  assert.equal(contract.text('😀'.repeat(160), 160), '😀'.repeat(160));
  assert.throws(() => contract.text('😀'.repeat(161), 160), /PROJECTION_BOUND_EXCEEDED/);
  for (const limit of [64,120,160,256,512]) {
    assert.equal(contract.text('x'.repeat(limit), limit).length, limit);
    assert.throws(() => contract.text('x'.repeat(limit + 1), limit), /PROJECTION_BOUND_EXCEEDED/);
  }
  for (const invalid of [null, 1, '\ud800', '']) assert.throws(() => contract.text(invalid, 160));
});

test('PX010 exact decimal freshness rejects invalid, equal and older tokens', () => {
  assert.equal(typeof contract.isNewerToken, 'function');
  const token = (epoch, sequence) => ({ epoch, sequence });
  for (const bad of [1, '01', '-1', '1e2', ' 1', '18446744073709551616', '0']) {
    assert.equal(contract.isNewerToken(token('1', bad), null), false);
  }
  assert.equal(contract.isNewerToken(token('1', '9007199254740993'), token('1', '9007199254740992')), true);
  assert.equal(contract.isNewerToken(token('1', '7'), token('1', '7')), false);
  assert.equal(contract.isNewerToken(token('1', '6'), token('1', '7')), false);
  assert.equal(contract.isNewerToken(token('2', '1'), token('1', '18446744073709551615')), true);
});

test('PX010 durable epoch survives restart and fails closed on corrupt/missing/exhausted state', () => {
  assert.equal(typeof freshness.openFreshnessState, 'function');
  const root = mkdtempSync(join(tmpdir(), 'px010-fresh-'));
  try {
    const path = join(root, 'state');
    const first = freshness.openFreshnessState(path);
    assert.deepEqual(first.next(), { epoch: '1', sequence: '1' });
    assert.deepEqual(first.next(), { epoch: '1', sequence: '2' });
    const second = freshness.openFreshnessState(path);
    assert.deepEqual(second.next(), { epoch: '2', sequence: '1' });
    assert.throws(() => first.next(), /FRESHNESS_STATE_UNAVAILABLE/);
    writeFileSync(join(path, 'epoch'), '18446744073709551615');
    assert.throws(() => freshness.openFreshnessState(path), /FRESHNESS_STATE_UNAVAILABLE/);
    writeFileSync(join(path, 'epoch'), 'broken');
    assert.throws(() => second.next(), /FRESHNESS_STATE_UNAVAILABLE/);
    rmSync(join(path, 'epoch'));
    assert.throws(() => freshness.openFreshnessState(path), /FRESHNESS_STATE_UNAVAILABLE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PX010 projector isolates failures, excludes restricted fields and never infers incident absence', async () => {
  assert.equal(typeof projectorModule.MissionControlOverviewProjector, 'function');
  let seq = 0;
  const projector = new projectorModule.MissionControlOverviewProjector({
    freshness: { next: () => ({ epoch: '1', sequence: String(++seq) }) }, clock: () => NOW,
    sources: { company: source({ ...company, raw_model_output: 'SECRET' }),
      active_incidents: { read: () => { throw new Error('SECRET'); } },
      workforce: source({ total: 2, active: 1, quarantined: 0, watch: 1, review: 1, secret: 'SECRET' }) },
  });
  const view = await projector.project();
  assert.equal(view.contract, 'pixel.mission-control-overview.v1');
  assert.equal(view.sections.company.data.state, 'NORMAL');
  assert.equal(view.sections.active_incidents.availability, 'FAILED');
  assert.equal(view.sections.recent_work.availability, 'UNAVAILABLE');
  assert.equal(view.sections.ai_compute.availability, 'UNAVAILABLE');
  assert.equal(view.sections.workforce.data.watch, 1);
  assert.doesNotMatch(JSON.stringify(view), /SECRET|revoked/);
});

test('PX010 validates every section list/counter bound and validates omitted list items', () => {
  assert.equal(typeof contract.normalizeSection, 'function');
  const normalize = (name, data) => contract.normalizeSection(name, source(data).read(), NOW);
  assert.equal(normalize('company', { ...company, refs: Array(17).fill('ref') }).reason_code, 'PROJECTION_BOUND_EXCEEDED');
  for (const count of [-1, 1.5, 1000001]) assert.equal(normalize('workforce', { total: count, active: 0, quarantined: 0, watch: 0, review: 0 }).availability, 'FAILED');
  const item = (i) => ({ id: `job-${i}`, title: 'Status check', state: 'COMPLETED', reason_code: 'EXECUTION_COMPLETED', occurred_at: new Date(Date.parse(NOW) + i).toISOString() });
  const work = normalize('recent_work', { items: Array.from({ length: 13 }, (_, i) => item(i)) });
  assert.equal(work.data.items.length, 12);
  assert.equal(work.data.items[0].id, 'job-12');
  assert.equal(work.data.truncated, true);
  assert.equal(work.data.total_count, 13);
  assert.equal(normalize('recent_work', { items: [...Array.from({ length: 12 }, (_, i) => item(i + 1)), { ...item(0), title: 'x'.repeat(121) }] }).availability, 'FAILED');
  for (const [name, items] of [
    ['active_incidents', Array(9).fill({ id: 'i', incident_class: 'POWER', severity: 'SEV-1', state: 'OPEN', summary: 'Power issue', affected_resource_count: 1 })],
    ['systems', Array(5).fill({ id: 'CORE', state: 'NORMAL', summary: 'Ready' })],
    ['ai_compute', Array(3).fill({ id: 'node', state: 'AVAILABLE', summary: 'Ready' })],
  ]) assert.equal(normalize(name, { items }).availability, 'FAILED');
  const metadata = Object.fromEntries(['location','zone','pool','service','version','window','scope','category','unit'].map(k => [k, 'safe']));
  const meta = normalize('company', { ...company, metadata });
  assert.equal(meta.data.metadata_truncated, true);
  assert.equal(Object.keys(meta.data.metadata).length, 8);
  assert.equal(normalize('company', { ...company, metadata: { location: 'x'.repeat(257) } }).availability, 'FAILED');
});

test('PX010 stale time is explicit; token failure has no fallback; whole size fails minimally', async () => {
  assert.equal(typeof contract.serializeOverview, 'function');
  assert.deepEqual(JSON.parse(contract.serializeOverview({ contract: 'pixel.mission-control-overview.v1', text: '😀'.repeat(17000) })), { contract: 'pixel.mission-control-overview.v1', availability: 'FAILED', reason_code: 'PROJECTION_TOO_LARGE' });
  const old = contract.normalizeSection('company', source(company).read(), '2026-09-15T12:01:01.000Z');
  assert.equal(old.availability, 'STALE');
  const p = new projectorModule.MissionControlOverviewProjector({ sources: {}, freshness: null });
  assert.deepEqual(await p.project(), { contract: 'pixel.mission-control-overview.v1', availability: 'FAILED', reason_code: 'FRESHNESS_STATE_UNAVAILABLE' });
});

test('PX010 reads observed after projection start remain fresh; clock rollback never orders tokens', async () => {
  let tick = Date.parse(NOW); let sequence = 0;
  const p = new projectorModule.MissionControlOverviewProjector({
    freshness: { next: () => ({ epoch: '1', sequence: String(++sequence) }) },
    clock: () => new Date(tick++).toISOString(),
    sources: { company: { read: () => ({ availability: 'AVAILABLE', source_mode: 'SIMULATED', observed_at: new Date(tick++).toISOString(), data: company }) } },
  });
  const a = await p.project(); assert.equal(a.sections.company.availability, 'AVAILABLE');
  tick -= 100_000;
  const b = await p.project(); assert.equal(contract.isNewerToken(b.freshness_token, a.freshness_token), true);
});

test('PX010 permitted activity/attention truncation is ordered and marked; unsupported inputs fail', () => {
  const normalize = (name, data) => contract.normalizeSection(name, source(data).read(), NOW);
  for (const [name, limit] of [['recent_activity',12],['needs_you',10]]) {
    const items = Array.from({ length: limit + 1 }, (_, i) => ({ id: `i-${i}`, title: 'Owner item', state: 'OPEN', occurred_at: NOW, priority: i }));
    const s = normalize(name, { items });
    assert.equal(s.data.items.length, limit); assert.equal(s.data.total_count, limit + 1); assert.equal(s.data.truncated, true);
    if (name === 'needs_you') assert.equal(s.data.items[0].priority, 0);
    assert.equal(normalize(name, { items: [{ ...items[0], occurred_at: 'invalid' }] }).availability, 'FAILED');
    assert.equal(normalize(name, { items: [items[0]], total_count: 1000001 }).reason_code, 'PROJECTION_BOUND_EXCEEDED');
  }
  for (const [name, data] of [['company',{ ...company, state: 'FABRICATED' }], ['workforce', { total: 1, active: 2, quarantined: 0, watch: 0, review: 0 }]]) assert.equal(normalize(name, data).availability, 'FAILED');
  assert.equal(contract.normalizeSection('company', { availability: 'FAILED', diagnostic: 'x'.repeat(257) }, NOW).reason_code, 'PROJECTION_BOUND_EXCEEDED');
  assert.equal(normalize('company', { ...company, refs: ['x'.repeat(161)] }).reason_code, 'PROJECTION_BOUND_EXCEEDED');
});

test('PX010 incident overflow and uncertainty never create a clear incident presentation', async () => {
  let seq = 0;
  const make = active_incidents => new projectorModule.MissionControlOverviewProjector({ freshness: { next: () => ({ epoch: '1', sequence: String(++seq) }) }, clock: () => NOW, sources: { active_incidents } });
  const incident = i => ({ id: `incident-${i}`, incident_class: 'SECURITY', severity: 'SEV-1', state: 'OPEN', summary: 'MAJOR', affected_resource_count: 1 });
  assert.equal((await make(source({ items: [incident(1)] })).project()).incident_override, true);
  assert.equal((await make(source({ items: [] })).project()).incident_override, false);
  assert.equal((await make(source({ items: Array.from({ length: 9 }, (_, i) => incident(i)) })).project()).incident_override, null);
  assert.equal((await make({ read: () => null }).project()).incident_override, null);
});

test('PX010 overlapping projections coalesce and later projections stay strictly newer', async () => {
  let finish; let calls = 0; let sequence = 0;
  const p = new projectorModule.MissionControlOverviewProjector({ freshness: { next: () => ({ epoch: '1', sequence: String(++sequence) }) }, clock: () => NOW,
    sources: { company: { read: () => { calls += 1; return calls === 1 ? new Promise(resolve => { finish = resolve; }) : source(company).read(); } } },
  });
  const earlier = p.project();
  const overlapping = p.project();
  // A burst of refreshes shares one projection: one sequence step, one source read.
  assert.equal(earlier, overlapping);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  finish(source(company).read());
  const first = await earlier;
  assert.equal(sequence, 1);
  // A projection started after the first settled must still be strictly newer.
  const later = await p.project();
  assert.equal(sequence, 2);
  assert.equal(contract.isNewerToken(later.freshness_token, first.freshness_token), true);
});

test('PX010 freshness fails closed on crash residue and never steals any lock', () => {
  assert.equal(typeof freshness.openFreshnessState, 'function');
  const root = mkdtempSync(join(tmpdir(), 'px010-crash-'));
  try {
    const path = join(root, 'state');
    const first = freshness.openFreshnessState(path);
    assert.deepEqual(first.next(), { epoch: '1', sequence: '1' });
    const epochFile = join(path, 'epoch');
    const lockFile = join(path, 'advance.lock');
    const temporary = join(path, 'epoch.next');

    // Even a dead owner's lock cannot be reclaimed safely with unlink/create:
    // another starter could acquire between those operations and duplicate an epoch.
    writeFileSync(lockFile, '999999999');
    writeFileSync(temporary, 'stale');
    assert.throws(() => freshness.openFreshnessState(path), /FRESHNESS_STATE_UNAVAILABLE/);
    assert.equal(readFileSync(lockFile, 'utf8'), '999999999');
    assert.equal(readFileSync(temporary, 'utf8'), 'stale');
    assert.equal(readFileSync(epochFile, 'utf8'), '1');
    rmSync(lockFile); rmSync(temporary);

    // This process is unambiguously live, so its lock is never reclaimed.
    writeFileSync(lockFile, String(process.pid));
    assert.throws(() => freshness.openFreshnessState(path), /FRESHNESS_STATE_UNAVAILABLE/);
    assert.equal(readFileSync(lockFile, 'utf8'), String(process.pid));

    // An unreadable owner is not proof of death either.
    writeFileSync(lockFile, 'not-a-pid');
    assert.throws(() => freshness.openFreshnessState(path), /FRESHNESS_STATE_UNAVAILABLE/);
    assert.equal(readFileSync(lockFile, 'utf8'), 'not-a-pid');
    rmSync(lockFile);
    assert.deepEqual(freshness.openFreshnessState(path).next(), { epoch: '2', sequence: '1' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
