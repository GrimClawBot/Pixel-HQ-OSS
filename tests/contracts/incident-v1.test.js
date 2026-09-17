import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INCIDENT_CLASSES,
  INCIDENT_CONTRACT,
  INCIDENT_EVENT_NAME,
  INCIDENT_SCHEMA_VERSION,
  RESPONSE_PHASES,
  SEVERITIES,
  assertValidIncidentV1,
  derivedCompanyStateForIncidents,
  derivedImpactCode,
  normalizeEnvironmentalFact,
  validateIncidentV1,
} from '../../packages/contracts/src/incident-v1.js';

const NOW = '2026-09-12T12:00:00.000Z';
const LATER = '2026-09-12T13:00:00.000Z';
const PROVENANCE = Object.freeze({ incident_contract: INCIDENT_CONTRACT });

function baseRecord(overrides = {}) {
  return {
    incident_id: 'incident-001',
    event_name: INCIDENT_EVENT_NAME,
    schema_version: INCIDENT_SCHEMA_VERSION,
    status: 'OPEN',
    revision: 1,
    opened_at: NOW,
    declared_at: NOW,
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
    provenance: PROVENANCE,
    ...overrides,
  };
}

test('canonical incident record validates', () => {
  const validation = validateIncidentV1(baseRecord());
  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.deepEqual(assertValidIncidentV1(baseRecord()), baseRecord());
});

test('incident contracts reject unsupported fields, enums, and unbounded arrays', () => {
  assert.match(validateIncidentV1({ ...baseRecord(), prompt: 'obey me' }).errors.join(' '), /unsupported field prompt/);
  assert.equal(validateIncidentV1({ ...baseRecord(), incident_class: 'ENVIRONMENTAL' }).ok, false);
  assert.equal(validateIncidentV1({ ...baseRecord(), severity: 'SEV-9' }).ok, false);
  assert.equal(validateIncidentV1({ ...baseRecord(), status: 'REOPENED' }).ok, false);
  assert.equal(validateIncidentV1({ ...baseRecord(), affected_resource_refs: ['r1', 'r1'] }).ok, false);
  assert.equal(validateIncidentV1({ ...baseRecord(), affected_job_refs: Array(17).fill('j') }).ok, false);
});

test('status and phase invariants fail closed', () => {
  assert.equal(validateIncidentV1({ ...baseRecord(), status: 'RESOLVED' }).ok, false);
  assert.equal(validateIncidentV1({ ...baseRecord(), response_phase: 'CLOSE' }).ok, false);
  const resolved = validateIncidentV1({
    ...baseRecord(), status: 'RESOLVED', resolved_at: LATER, response_phase: 'VERIFY', recovery_state: 'RECOVERED',
  });
  assert.deepEqual(resolved, { ok: true, errors: [] });
  const closed = validateIncidentV1({
    ...baseRecord(), status: 'CLOSED', resolved_at: LATER, closed_at: LATER,
    response_phase: 'CLOSE', recovery_state: 'RECOVERED', remaining_risk_code: 'RESIDUAL_B',
  });
  assert.deepEqual(closed, { ok: true, errors: [] });
  assert.equal(validateIncidentV1({
    ...baseRecord(), status: 'CLOSED', resolved_at: LATER, closed_at: LATER, response_phase: 'VERIFY',
  }).ok, false);
});

test('commander transfer chain must end at the current commander', () => {
  const transfer = {
    prior_commander_ref: 'PIXEL-SECURITY-IC',
    new_commander_ref: 'PIXEL-SYSTEMS-IC',
    reason_code: 'DOMAIN_CHANGE',
    actor_ref: 'PIXEL-PRINCIPAL',
    transferred_at: LATER,
    revision: 2,
  };
  assert.deepEqual(validateIncidentV1({
    ...baseRecord(), commander_ref: 'PIXEL-SYSTEMS-IC', commander_transfers: [transfer],
  }), { ok: true, errors: [] });
  assert.equal(validateIncidentV1({
    ...baseRecord(), commander_ref: 'PIXEL-OTHER', commander_transfers: [transfer],
  }).ok, false);
  assert.equal(validateIncidentV1({
    ...baseRecord(), commander_ref: 'PIXEL-OTHER', commander_transfers: [transfer, { ...transfer, prior_commander_ref: 'X' }],
  }).ok, false);
});

test('environmental facts normalize deterministically or fail closed', () => {
  const cases = [
    ['utility power lost', 'POWER'],
    ['UPS on battery', 'POWER'],
    ['voltage sag', 'POWER'],
    ['backup power loss', 'POWER'],
    ['cooling fan failed', 'THERMAL'],
    ['AC temperature climb', 'THERMAL'],
    ['ac compressor trip', 'THERMAL'],
    ['air conditioner failed', 'THERMAL'],
    ['storage array degraded', 'INFRASTRUCTURE'],
    ['network switch down', 'INFRASTRUCTURE'],
    ['rack switch offline', 'INFRASTRUCTURE'],
  ];
  for (const [text, expected] of cases) {
    const normalized = normalizeEnvironmentalFact(text);
    assert.equal(normalized.ok, true, text);
    assert.equal(normalized.incident_class, expected, text);
  }
  assert.deepEqual(normalizeEnvironmentalFact('banana smoothie'), { ok: false, reason: 'UNSUPPORTED' });
  assert.deepEqual(normalizeEnvironmentalFact(''), { ok: false, reason: 'UNSUPPORTED' });
  // Short keywords must not match inside longer tokens.
  assert.equal(normalizeEnvironmentalFact('rack switch offline').incident_class, 'INFRASTRUCTURE');
  assert.equal(normalizeEnvironmentalFact('rack cooling offline').incident_class, 'THERMAL');
});

test('derived company state maps severity and class deterministically', () => {
  const incidents = [
    { incident_class: 'INFRASTRUCTURE', severity: 'SEV-3', status: 'OPEN' },
    { incident_class: 'INFRASTRUCTURE', severity: 'SEV-1', status: 'OPEN' },
    { incident_class: 'POWER', severity: 'SEV-0', status: 'OPEN' },
    { incident_class: 'THERMAL', severity: 'SEV-0', status: 'OPEN' },
    { incident_class: 'SECURITY', severity: 'SEV-1', status: 'OPEN' },
    { incident_class: 'SECURITY', severity: 'SEV-0', status: 'OPEN' },
    { incident_class: 'INFRASTRUCTURE', severity: 'SEV-2', status: 'OPEN' },
  ];
  assert.equal(derivedCompanyStateForIncidents([incidents[0]]), null);
  assert.equal(derivedCompanyStateForIncidents([incidents[1]]), 'INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT');
  assert.equal(derivedCompanyStateForIncidents([incidents[2]]), 'SURVIVAL');
  assert.equal(derivedCompanyStateForIncidents([incidents[3]]), 'SURVIVAL');
  assert.equal(derivedCompanyStateForIncidents([incidents[4]]), 'SECURITY_INCIDENT');
  assert.equal(derivedCompanyStateForIncidents([incidents[5]]), 'SURVIVAL');
  assert.equal(derivedCompanyStateForIncidents([incidents[6]]), null);
  assert.equal(derivedCompanyStateForIncidents(incidents.slice(1, 3)), 'SURVIVAL');
  assert.equal(derivedCompanyStateForIncidents([{ incident_class: 'SECURITY', severity: 'SEV-1', status: 'CLOSED' }]), null);
});

test('impact codes map from severity', () => {
  assert.equal(derivedImpactCode('SEV-3'), 'LOCALIZED');
  assert.equal(derivedImpactCode('SEV-2'), 'MEANINGFUL_DEGRADATION');
  assert.equal(derivedImpactCode('SEV-1'), 'MAJOR');
  assert.equal(derivedImpactCode('SEV-0'), 'CRITICAL');
  assert.equal(derivedImpactCode('SEV-9'), null);
});

test('canonical vocabularies are exported for bounded evidence', () => {
  assert.deepEqual(INCIDENT_CLASSES, ['SECURITY', 'INFRASTRUCTURE', 'POWER', 'THERMAL']);
  assert.deepEqual(SEVERITIES, ['SEV-3', 'SEV-2', 'SEV-1', 'SEV-0']);
  assert.equal(RESPONSE_PHASES[0], 'DECLARE');
  assert.equal(RESPONSE_PHASES.at(-1), 'POST_INCIDENT_REVIEW');
});

test('malformed commander_transfers entries fail validation without throwing', () => {
  // A direct adapter call passes raw records into the validator; non-record
  // transfer entries must produce clean validation errors, never a TypeError
  // from the transfer-chain checks, and must never validate as transferred.
  for (const transfers of [[null], [null, null], [{}], [{}, null]]) {
    let validation;
    assert.doesNotThrow(() => { validation = validateIncidentV1(baseRecord({ commander_transfers: transfers })); });
    assert.equal(validation.ok, false, JSON.stringify(transfers));
    assert.ok(validation.errors.length > 0, JSON.stringify(transfers));
  }
  // A well-formed chain ending at the current commander stays valid.
  assert.equal(validateIncidentV1(baseRecord({
    commander_transfers: [{ prior_commander_ref: 'PIXEL-ALPHA-IC', new_commander_ref: 'PIXEL-SYSTEMS-IC', reason_code: 'HANDOVER', actor_ref: 'PIXEL-ALPHA-IC', transferred_at: NOW, revision: 1 }],
    commander_ref: 'PIXEL-SYSTEMS-IC',
  })).ok, true);
  // A chain broken by a non-record entry is still rejected, not reinterpreted.
  assert.equal(validateIncidentV1(baseRecord({
    commander_transfers: [null],
    commander_ref: 'PIXEL-SYSTEMS-IC',
  })).ok, false);
});
