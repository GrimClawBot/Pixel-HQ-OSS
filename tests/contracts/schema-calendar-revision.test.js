import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';

import { isCanonicalUtcTimestamp } from '../../packages/contracts/src/trusted-time-v1.js';
import { validateIncidentV1 } from '../../packages/contracts/src/incident-v1.js';

// Published-schema invariants that must agree with the runtime contracts:
// canonical UTC millisecond timestamps are real calendar instants, and
// revision integers stay inside JavaScript's safe-integer range.
const CALENDAR_UTC_PATTERN = '^(?:(?:\\d{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|02-(?:0[1-9]|1\\d|2[0-8])))T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}Z$';
const MAX_SAFE = 9007199254740991;

const CASES = [
  ['2026-09-12T12:00:00.000Z', true],
  ['2024-02-29T00:00:00.000Z', true],
  ['2000-02-29T12:00:00.000Z', true],
  ['2026-02-29T12:00:00.000Z', false],
  ['1900-02-29T12:00:00.000Z', false],
  ['2026-02-30T12:00:00.000Z', false],
  ['2026-13-01T12:00:00.000Z', false],
  ['2026-00-15T12:00:00.000Z', false],
  ['2026-04-31T12:00:00.000Z', false],
  ['2026-09-32T12:00:00.000Z', false],
  ['2026-09-07T12:00:00Z', false],
  ['2026-09-07T08:00:00.000-04:00', false],
];

async function loadSchemas() {
  const names = (await readdir(new URL('../../packages/contracts/schemas/', import.meta.url)))
    .filter((name) => name.endsWith('.schema.json'));
  const schemas = [];
  for (const name of names) {
    schemas.push([name, JSON.parse(await readFile(new URL(`../../packages/contracts/schemas/${name}`, import.meta.url)))]);
  }
  return schemas;
}

function patternStrings(node, found) {
  if (Array.isArray(node)) {
    for (const value of node) patternStrings(value, found);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      // Canonical timestamp patterns are the only ones anchored at a literal
      // UTC designator: they require the trailing "T..." millisecond "Z$".
      if (key === 'pattern' && typeof value === 'string' && value.includes('\\d{3}Z$')) found.push(value);
      else patternStrings(value, found);
    }
  }
}

function revisionNodes(node, found) {
  if (Array.isArray(node)) {
    for (const value of node) revisionNodes(value, found);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'revision' && value !== null && typeof value === 'object' && value.type === 'integer') found.push(value);
      else revisionNodes(value, found);
    }
  }
}

test('every published timestamp pattern is the calendar-valid canonical UTC pattern', async () => {
  const schemas = await loadSchemas();
  assert.ok(schemas.length >= 30);
  let patternCount = 0;
  for (const [name, schema] of schemas) {
    const found = [];
    patternStrings(schema, found);
    for (const pattern of found) {
      patternCount += 1;
      assert.equal(pattern, CALENDAR_UTC_PATTERN, `${name} must publish the calendar-valid canonical UTC pattern`);
    }
  }
  assert.ok(patternCount >= 48, `expected the canonical timestamp sweep to cover every schema (found ${patternCount})`);
});

test('the published timestamp pattern agrees with the trusted-time runtime law on every case', async () => {
  const pattern = new RegExp(CALENDAR_UTC_PATTERN);
  for (const [value, expected] of CASES) {
    assert.equal(pattern.test(value), expected, `pattern verdict for ${value}`);
    const runtime = Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    assert.equal(runtime, expected, `runtime verdict for ${value}`);
    assert.equal(pattern.test(value), runtime, `schema/runtime agreement for ${value}`);
  }
});

test('every published revision field is capped at the safe-integer maximum', async () => {
  const schemas = await loadSchemas();
  let revisionCount = 0;
  for (const [name, schema] of schemas) {
    const found = [];
    revisionNodes(schema, found);
    for (const revision of found) {
      revisionCount += 1;
      assert.equal(revision.minimum, 1, `${name} revision keeps minimum 1`);
      assert.equal(revision.maximum, MAX_SAFE, `${name} revision is capped at MAX_SAFE_INTEGER`);
    }
  }
  assert.ok(revisionCount >= 15, `expected the revision sweep to cover every schema (found ${revisionCount})`);
});

test('runtime revision validation accepts MAX_SAFE_INTEGER and rejects MAX_SAFE_INTEGER + 1', () => {
  const base = {
    incident_id: 'incident-001',
    event_name: 'pixel.incident.v1',
    schema_version: '1.0.0',
    status: 'OPEN',
    revision: 1,
    opened_at: '2026-09-12T12:00:00.000Z',
    declared_at: '2026-09-12T12:00:00.000Z',
    acknowledged_at: null,
    resolved_at: null,
    closed_at: null,
    incident_class: 'INFRASTRUCTURE',
    severity: 'SEV-2',
    commander_ref: 'PIXEL-SYSTEMS-IC',
    response_phase: 'DECLARE',
    recovery_state: 'NONE',
    current_impact_code: 'MEANINGFUL_DEGRADATION',
    source_ref: 'sensor.rack-01',
    summary_code: 'STORAGE_ARRAY_DEGRADED',
    affected_resource_refs: [],
    affected_job_refs: [],
    evidence_refs: [],
    remaining_risk_code: null,
    commander_transfers: [],
    provenance: { incident_contract: 'pixel.incident.v1' },
  };
  assert.equal(validateIncidentV1({ ...base, revision: MAX_SAFE }).ok, true, 'MAX_SAFE_INTEGER is a valid revision');
  assert.equal(validateIncidentV1({ ...base, revision: MAX_SAFE + 1 }).ok, false, 'MAX_SAFE_INTEGER + 1 collapses in Number and must be rejected');
  assert.equal(validateIncidentV1({
    ...base,
    commander_transfers: [{ prior_commander_ref: 'PIXEL-ALPHA-IC', new_commander_ref: 'PIXEL-SYSTEMS-IC', reason_code: 'HANDOVER', actor_ref: 'PIXEL-ALPHA-IC', transferred_at: '2026-09-12T12:00:00.000Z', revision: MAX_SAFE + 1 }],
    commander_ref: 'PIXEL-SYSTEMS-IC',
  }).ok, false, 'transfer revisions beyond MAX_SAFE_INTEGER are rejected');
});
