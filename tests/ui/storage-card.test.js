import assert from 'node:assert/strict';
import test from 'node:test';

import { renderStorageCard } from '../../apps/mission-control/src/storage-card-view.js';

const HEALTHY_VIEW = Object.freeze({
  api_version: 'v1',
  schema_version: '1.0.0',
  event_name: 'pixel.device.snapshot.v1',
  event_id: 'evt-ui-0001',
  device_id: 'sim-storage-01',
  role_id: 'PIXEL-STORAGE-01',
  display_name: 'Storage',
  lifecycle_state: 'active',
  health_state: 'ready',
  state: 'Ready',
  summary: 'Your storage is ready and protected.',
  impact: 'Files and backups remain available.',
  action_required: false,
  recommended_action: null,
  verified_at: '2026-09-06T13:00:00.000Z',
  storage: {
    capacity_bytes: 24000000000000,
    used_bytes: 7200000000000,
    available_bytes: 16800000000000,
    protection_state: 'protected',
  },
  trace_id: '0123456789abcdef0123456789abcdef',
  source: 'simulator',
  provenance: {
    adapter_contract: 'pixel.device.adapter.v1',
    adapter_id: 'pixel.simulator.storage.v1',
    scenario: 'healthy',
  },
});

const DEGRADED_VIEW = Object.freeze({
  ...HEALTHY_VIEW,
  event_id: 'evt-ui-0002',
  health_state: 'needs_attention',
  state: 'Needs Attention',
  summary: 'Storage needs attention. Protection is at risk.',
  impact: 'Storage remains available while protection is reduced.',
  action_required: true,
  recommended_action: 'Review storage protection when convenient.',
  storage: {
    ...HEALTHY_VIEW.storage,
    used_bytes: 7800000000000,
    available_bytes: 16200000000000,
    protection_state: 'at_risk',
  },
  trace_id: 'fedcba9876543210fedcba9876543210',
  provenance: {
    ...HEALTHY_VIEW.provenance,
    scenario: 'degraded-storage',
  },
});

test('renders the healthy API view with Simple, Details, and Expert disclosure', () => {
  const html = renderStorageCard(HEALTHY_VIEW);
  const visibleText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  assert.match(html, /<article[^>]+aria-labelledby="storage-card-title"/);
  assert.match(html, /<h2 id="storage-card-title">Storage<\/h2>/);
  assert.match(html, />Ready<\/span>/);
  assert.match(html, /Your storage is ready and protected\./);
  assert.match(visibleText, /16\.8 TB available of 24 TB/);
  assert.match(html, /<summary>Details<\/summary>/);
  assert.match(html, /<summary>Expert<\/summary>/);
  assert.match(html, /pixel\.device\.snapshot\.v1/);
  assert.match(html, /href="\/api\/v1\/evidence\/0123456789abcdef0123456789abcdef"/);
});

test('renders degraded state through the same card renderer', () => {
  const html = renderStorageCard(DEGRADED_VIEW);

  assert.match(html, /data-state="needs_attention"/);
  assert.match(html, />Needs Attention<\/span>/);
  assert.match(html, /Storage needs attention\. Protection is at risk\./);
  assert.match(html, /Protection<\/dt><dd>At Risk<\/dd>/);
  assert.match(html, /Review storage protection when convenient\./);
  assert.match(html, /67\.5%/);
});

test('shows simulator provenance only as Expert data', () => {
  const html = renderStorageCard(HEALTHY_VIEW);
  const expertStart = html.indexOf('<summary>Expert</summary>');

  assert.equal(expertStart > 0, true);
  assert.equal(html.slice(0, expertStart).includes('simulator'), false);
  assert.equal(html.slice(expertStart).includes('simulator'), true);
});

test('keeps internal role identifiers below Expert disclosure', () => {
  const html = renderStorageCard(HEALTHY_VIEW);
  const expertStart = html.indexOf('<summary>Expert</summary>');

  assert.equal(html.slice(0, expertStart).includes('PIXEL-STORAGE-01'), false);
  assert.equal(html.slice(expertStart).includes('PIXEL-STORAGE-01'), true);
});

test('renders capacity without CSP-blocked inline styles', () => {
  const html = renderStorageCard(HEALTHY_VIEW);

  assert.match(html, /<progress[^>]+value="30"[^>]*>/);
  assert.doesNotMatch(html, /\sstyle=/);
});

test('escapes API text before inserting it into Mission Control HTML', () => {
  const html = renderStorageCard({
    ...HEALTHY_VIEW,
    summary: '<script>window.compromised = true</script>',
    impact: 'Files & backups remain available.',
  });

  assert.equal(html.includes('<script>window.compromised'), false);
  assert.match(html, /&lt;script&gt;window\.compromised = true&lt;\/script&gt;/);
  assert.match(html, /Files &amp; backups remain available\./);
});
