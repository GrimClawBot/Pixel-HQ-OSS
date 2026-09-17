import assert from 'node:assert/strict';
import test from 'node:test';
const viewModule = await import('../../apps/mission-control/src/overview-view.js').catch(() => ({}));
const controlModule = await import('../../apps/mission-control/src/overview-controller.js').catch(() => ({}));
const ready = data => ({ availability: 'AVAILABLE', source_mode: 'SIMULATED', observed_at: '2026-09-15T12:00:00.000Z', data });
const unavailable = { availability: 'UNAVAILABLE', reason_code: 'NOT_YET_CONNECTED' };
const sectionNames = ['company','storage','systems','ai_compute','facilities','workforce','needs_you','recent_work','recent_activity','active_incidents'];
function overview(sequence = '1') { return { contract: 'pixel.mission-control-overview.v1', freshness_token: { epoch: '1', sequence }, observed_at: '2026-09-15T12:00:00.000Z', incident_override: false, sections: Object.fromEntries(sectionNames.map(k => [k, unavailable])) }; }
test('PX010 Home presents all canonical company modes without time inference', () => {
  assert.equal(typeof viewModule.renderSection, 'function');
  for (const state of ['NORMAL','NIGHT','HOLIDAY','MAINTENANCE','SURVIVAL']) {
    const html = viewModule.renderSection('company', ready({ state, summary: 'Canonical briefing', refs: [] }));
    assert.match(html, new RegExp(state)); assert.match(html, /SIMULATED/);
  }
});
test('PX010 missing/failed/stale sources and WATCH/REVIEW remain explicit', () => {
  assert.equal(typeof viewModule.renderSection, 'function');
  assert.match(viewModule.renderSection('active_incidents', unavailable), /Incident state.*UNAVAILABLE/s);
  assert.doesNotMatch(viewModule.renderSection('active_incidents', unavailable), /No active incidents/);
  for (const name of ['ai_compute','facilities','recent_work']) {
    assert.match(viewModule.renderSection(name, unavailable), /NOT YET CONNECTED/);
  }
  const workforce = viewModule.renderSection('workforce', { ...ready({ total: 2, active: 1, restricted: 1, watch: 1, review: 1 }), availability: 'STALE' });
  assert.match(workforce, /STALE/); assert.match(workforce, /Observations/); assert.match(workforce, /Restricted/);
  assert.doesNotMatch(workforce, /Quarantined/); assert.doesNotMatch(workforce, /revoked|access denied/i);
  assert.doesNotMatch(viewModule.renderSection('company', ready({ state: 'NORMAL', summary: '<script>secret()</script>', refs: [] })), /<script>/);
});
test('PX010 browser rejects equal/older projections and keeps selected hero through incidents', () => {
  assert.equal(typeof controlModule.OverviewState, 'function');
  const state = new controlModule.OverviewState('ai_compute');
  assert.equal(state.accept(overview('2')), true);
  assert.equal(state.accept(overview('2')), false);
  assert.equal(state.accept(overview('1')), false);
  assert.equal(state.hero, 'ai_compute');
  assert.equal(state.accept({ ...overview('3'), incident_override: true }), true);
  assert.equal(state.hero, 'incident');
  state.accept(overview('4')); assert.equal(state.hero, 'ai_compute');
  assert.equal(state.accept({ ...overview('5'), freshness_token: { epoch: 1, sequence: 5 } }), false);
});
test('PX010 refresh failure retains explicit stale data and rejects whole-envelope failures', () => {
  assert.equal(typeof controlModule.OverviewState, 'function');
  const state = new controlModule.OverviewState();
  const value = overview(); value.sections.company = ready({ state: 'NORMAL', summary: 'Operating', refs: [] });
  state.accept(value); state.markStale();
  assert.equal(state.value.sections.company.availability, 'STALE');
  assert.equal(state.accept({ contract: 'pixel.mission-control-overview.v1', availability: 'FAILED', reason_code: 'FRESHNESS_STATE_UNAVAILABLE' }), false);
});
test('PX010 browser rejects calendar-invalid timestamps that Date.parse normalizes', () => {
  assert.equal(typeof controlModule.OverviewState, 'function');
  const state = new controlModule.OverviewState();
  assert.equal(state.accept(overview('1')), true);
  // February 30 normalizes to March 2 under Date.parse; canonical round-trip
  // equality rejects it so freshness is never computed from a shifted instant.
  assert.equal(new Date('2026-02-30T12:00:00.000Z').toISOString(), '2026-03-02T12:00:00.000Z');
  assert.equal(state.accept({ ...overview('2'), observed_at: '2026-02-30T12:00:00.000Z' }), false);
});
test('PX010 AI Compute has its own empty-state message', () => {
  assert.equal(typeof viewModule.renderSection, 'function');
  const empty = viewModule.renderSection('ai_compute', ready({ items: [] }));
  assert.match(empty, /No AI Compute records\./);
  assert.doesNotMatch(empty, /No recorded activity\./);
  const fallback = viewModule.renderSection('recent_activity', ready({ items: [] }));
  assert.match(fallback, /No recorded activity\./);
});
