import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarService } from '../../services/calendar/src/calendar-service.js';
import { calendarRuntime, baseTemplate, allowAllAuthorizer } from '../helpers/px008-runtime.js';
import { NOW } from '../helpers/px006-runtime.js';

function seededRuntime(overrides = {}) {
  const runtime = calendarRuntime();
  assert.equal(runtime.calendar.createTemplate(baseTemplate(overrides)).disposition, 'RECORDED');
  return runtime;
}

function secondService(runtime) {
  return new CalendarService({
    environment: 'simulation', store: runtime.store, evidence: runtime.evidence, ids: runtime.ids,
    clock: () => runtime.clock.now(), authorizer: allowAllAuthorizer(), relay: runtime.relayAdapter,
  });
}

test('one tick at the anchor creates one canonical Relay job, replay creates none', async () => {
  const r = seededRuntime();
  const first = await r.calendar.evaluateDueOccurrences();
  assert.equal(first.results[0].disposition, 'SUBMITTED');
  const [occurrence] = r.calendar.listOccurrences();
  assert.equal(occurrence.scheduled_at, NOW);
  assert.equal(occurrence.status, 'SUBMITTED');
  assert.equal(r.calendar.getOccurrence(occurrence.occurrence_id).relay_job_id, occurrence.relay_job_id);
  await r.calendar.evaluateDueOccurrences();
  assert.deepEqual(r.calendar.listOccurrences(), [occurrence]);
  const job = await r.realRelay.getJob(occurrence.relay_job_id);
  assert.equal(job.current_state, 'ACCEPTED');
  assert.equal(job.envelope.requested_capability, 'pixel.system-status.read');
  assert.equal(job.envelope.execution.tool_class, 'pixel.system-status');
  assert.equal(job.envelope.execution.target, 'pixel.platform');
  assert.equal(r.worker.invocationCount, 0);
});

test('two services sharing a store cannot submit concurrent duplicate occurrences', async () => {
  const r = seededRuntime();
  const other = secondService(r);
  const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    (i % 2 ? other : r.calendar).evaluateDueOccurrences()));
  assert.equal(outcomes.flatMap(x => x.results).filter(x => x.disposition === 'SUBMITTED').length, 1);
  assert.equal(r.calendar.listOccurrences().length, 1);
  assert.equal(r.worker.invocationCount, 0);
});

test('lost Relay response after commit retries the same key and recovers the same job', async () => {
  const r = seededRuntime();
  const accept = r.realRelay.accept.bind(r.realRelay);
  const keys = [];
  let committed;
  r.relayAdapter.accept = async intent => {
    keys.push(intent.idempotency_key);
    const result = await accept(intent);
    if (keys.length === 1) { committed = result.job.envelope.job_id; throw new Error('lost response'); }
    return result;
  };
  const first = await r.calendar.evaluateDueOccurrences();
  assert.equal(first.results[0].disposition, 'SUBMISSION_PENDING');
  assert.equal(r.calendar.listOccurrences()[0].status, 'SUBMISSION_PENDING');
  await r.calendar.evaluateDueOccurrences();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(r.calendar.listOccurrences()[0].relay_job_id, committed);
  assert.equal(r.calendar.listOccurrences()[0].attempt_count, 2);
});

test('SKIP never backfills; RUN_ONCE recovers only the latest bounded scheduled instant', async () => {
  for (const policy of ['SKIP', 'RUN_ONCE_FOR_MISSED_WINDOW']) {
    const r = seededRuntime({ missed_run_policy: policy });
    r.clock.advance(10 * 3_600_000);
    await r.calendar.evaluateDueOccurrences();
    const occurrences = r.calendar.listOccurrences();
    assert.equal(occurrences.length, policy === 'SKIP' ? 0 : 1);
    if (occurrences.length) {
      assert.equal(occurrences[0].scheduled_at, '2026-09-12T22:00:00.000Z');
      assert.equal(occurrences[0].status, 'SUBMITTED');
    }
  }
});

test('oversized missed window yields one REVIEW_REQUIRED record and halts further claims', async () => {
  for (const policy of ['SKIP', 'RUN_ONCE_FOR_MISSED_WINDOW']) {
    const r = seededRuntime({ missed_run_policy: policy });
    r.clock.advance(100 * 3_600_000);
    await r.calendar.evaluateDueOccurrences();
    assert.equal(r.calendar.listOccurrences().length, 1);
    assert.equal(r.calendar.listOccurrences()[0].status, 'REVIEW_REQUIRED');
    r.clock.advance(100 * 3_600_000);
    await r.calendar.evaluateDueOccurrences();
    assert.equal(r.calendar.listOccurrences().length, 1);
    assert.equal(r.worker.invocationCount, 0);
  }
});

test('overlap SKIP checks the prior job even after intervening skipped occurrences', async () => {
  const r = seededRuntime();
  await r.calendar.evaluateDueOccurrences();
  const jobId = r.calendar.listOccurrences()[0].relay_job_id;
  for (let i = 0; i < 2; i++) {
    r.clock.advance(3_600_000);
    const result = await r.calendar.evaluateDueOccurrences();
    assert.equal(result.results[0].disposition, 'SKIPPED');
  }
  assert.equal(r.calendar.listOccurrences().filter(x => x.relay_job_id).length, 1);
  await r.realRelay.execute(jobId);
  r.clock.advance(3_600_000);
  const result = await r.calendar.evaluateDueOccurrences();
  assert.equal(result.results[0].disposition, 'SUBMITTED');
  assert.equal(r.calendar.listOccurrences().filter(x => x.relay_job_id).length, 2);
});

for (const mode of ['throw', 'unknown-state', 'mismatched-job', 'missing-envelope']) {
  test(`Relay lookup ${mode} fails closed without a second job`, async () => {
    const r = seededRuntime();
    await r.calendar.evaluateDueOccurrences();
    const jobId = r.calendar.listOccurrences()[0].relay_job_id;
    const job = await r.realRelay.getJob(jobId);
    r.relayAdapter.getJob = async () => {
      if (mode === 'throw') throw new Error('unavailable');
      if (mode === 'missing-envelope') return { current_state: 'COMPLETED' };
      return { ...job, current_state: mode === 'unknown-state' ? 'DONE' : 'COMPLETED',
        envelope: { ...job.envelope, job_id: mode === 'mismatched-job' ? 'wrong-job' : jobId } };
    };
    r.clock.advance(3_600_000);
    const result = await r.calendar.evaluateDueOccurrences();
    assert.equal(result.results[0].disposition, 'REVIEW_REQUIRED');
    assert.equal(r.calendar.listOccurrences().filter(x => x.relay_job_id).length, 1);
  });
}

test('pending retry keeps the exact old template revision after an authorized edit', async () => {
  const r = seededRuntime();
  const accept = r.realRelay.accept.bind(r.realRelay);
  r.relayAdapter.accept = async () => { throw new Error('unavailable'); };
  await r.calendar.evaluateDueOccurrences();
  const before = r.calendar.listOccurrences()[0];
  assert.equal(r.calendar.changeTemplate({ template_id: 'template-001', expected_revision: 1,
    schedule: { kind: 'FIXED_INTERVAL', anchor_at: NOW, interval_seconds: 7200 } }).disposition, 'RECORDED');
  r.relayAdapter.accept = accept;
  await r.calendar.evaluateDueOccurrences();
  const after = r.calendar.listOccurrences()[0];
  assert.equal(after.template_revision, 1);
  assert.equal(after.template_fingerprint, before.template_fingerprint);
  assert.equal(after.relay_idempotency_key, before.relay_idempotency_key);
  assert.equal(after.status, 'SUBMITTED');
  assert.equal(r.calendar.listTemplates()[0].revision, 2);
});

test('stale template writes and editing a template during Relay submission reject', async () => {
  const r = seededRuntime();
  const accept = r.realRelay.accept.bind(r.realRelay);
  r.relayAdapter.accept = async intent => {
    const changed = r.calendar.changeTemplate({ template_id: 'template-001', expected_revision: 1, status: 'PAUSED' });
    assert.equal(changed.disposition, 'REJECTED');
    return accept(intent);
  };
  await r.calendar.evaluateDueOccurrences();
  assert.equal(r.calendar.changeTemplate({ template_id: 'template-001', expected_revision: 99 }).reason_code, 'STALE_REVISION');
  assert.equal(r.calendar.listTemplates()[0].revision, 1);
});

test('rollback across services cannot regenerate work or move the checkpoint backwards', async () => {
  const r = seededRuntime();
  await r.calendar.evaluateDueOccurrences();
  const checkpoint = r.store.currentCheckpoint('template-001');
  r.clock.set('2026-09-01T00:00:00.000Z');
  await secondService(r).evaluateDueOccurrences();
  assert.equal(r.calendar.listOccurrences().length, 1);
  assert.deepEqual(r.store.currentCheckpoint('template-001'), checkpoint);
});

test('caller-provided now cannot advance runtime due evaluation', async () => {
  const r = seededRuntime({ schedule: { kind: 'FIXED_INTERVAL', anchor_at: '2026-10-01T00:00:00.000Z', interval_seconds: 3600 } });
  const result = await r.calendar.evaluateDueOccurrences({ now: '2027-10-01T00:00:00.000Z' });
  assert.equal(result.disposition, 'REJECTED');
  assert.equal(r.calendar.listOccurrences().length, 0);
});

test('repeated ambiguous submissions are bounded and never permit overlapping new work', async () => {
  const r = seededRuntime();
  let calls = 0;
  r.relayAdapter.accept = async () => { calls++; throw new Error('unknown outcome'); };
  for (let i = 0; i < 10; i++) {
    await r.calendar.evaluateDueOccurrences();
    r.clock.advance(3_600_000);
  }
  assert.equal(calls, 3);
  assert.equal(r.calendar.listOccurrences().length, 1);
  assert.equal(r.calendar.listOccurrences()[0].status, 'REVIEW_REQUIRED');
});

for (const disposition of ['CONFLICT', 'REJECTED', 'CREATED']) {
  test(`Relay ${disposition} without a valid bound job cannot be reported submitted`, async () => {
    const r = seededRuntime();
    r.relayAdapter.accept = async () => ({ disposition, job: null });
    const result = await r.calendar.evaluateDueOccurrences();
    assert.notEqual(result.results[0].disposition, 'SUBMITTED');
    assert.equal(r.calendar.listOccurrences()[0].relay_job_id, null);
  });
}
