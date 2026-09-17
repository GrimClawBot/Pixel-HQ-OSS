import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AGENTOPS_EVALUATION_EVENT_NAME,
  AGENTOPS_RECOMMENDATIONS,
  AGENTOPS_STATES,
  ATTRIBUTION_CAUSES,
  CAPABILITY_QUALIFICATION_EVENT_NAME,
  EVIDENCE_DIMENSIONS,
  GLOBALLY_INELIGIBLE_LIFECYCLE_STATUSES,
  LIFECYCLE_STATUSES,
  LIFECYCLE_TRANSITIONS,
  OBSERVATION_VALUES,
  QUALIFICATION_STATUSES,
  SCOPE_ELIGIBLE_LIFECYCLE_STATUSES,
  WORKFORCE_ATTRIBUTION_EVENT_NAME,
  WORKFORCE_CONTRACT,
  WORKFORCE_EVIDENCE_EVENT_NAME,
  WORKFORCE_RECORD_EVENT_NAME,
  WORKFORCE_SCHEMA_VERSION,
  derivedQualificationStatus,
  lifecycleTransitionAllowed,
  validateAgentOpsEvaluationV1,
  validateCapabilityQualificationV1,
  validateWorkforceAttributionV1,
  validateWorkforceEvidenceV1,
  validateWorkforceOperatingFactsV1,
  validateWorkforceRecordV1,
} from '../../packages/contracts/src/workforce-v1.js';

const NOW = '2026-09-12T12:00:00.000Z';
const LATER = '2026-09-12T18:00:00.000Z';
const PROVENANCE = Object.freeze({ workforce_contract: WORKFORCE_CONTRACT });

function record(overrides = {}) {
  return {
    agent_id: 'PIXEL-SYSTEMS-WORKER-01',
    event_name: WORKFORCE_RECORD_EVENT_NAME,
    schema_version: WORKFORCE_SCHEMA_VERSION,
    lifecycle_status: 'ACTIVE',
    role_ref: 'Systems',
    department_ref: 'Infrastructure / HomeLab',
    effective_at: NOW,
    revision: 1,
    updated_at: NOW,
    history: [],
    provenance: PROVENANCE,
    ...overrides,
  };
}

function qualification(overrides = {}) {
  return {
    qualification_id: 'qualification-001',
    event_name: CAPABILITY_QUALIFICATION_EVENT_NAME,
    schema_version: WORKFORCE_SCHEMA_VERSION,
    agent_id: 'PIXEL-SYSTEMS-WORKER-01',
    capability: 'pixel.system-status.read',
    qualification_status: 'QUALIFIED',
    source_ref: 'academy.result-2026',
    effective_at: NOW,
    expires_at: null,
    revision: 1,
    updated_at: NOW,
    authorization_ref: 'authz-001',
    provenance: PROVENANCE,
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    evidence_id: 'evidence-001',
    event_name: WORKFORCE_EVIDENCE_EVENT_NAME,
    schema_version: WORKFORCE_SCHEMA_VERSION,
    agent_id: 'PIXEL-SYSTEMS-WORKER-01',
    subject_ref: 'job-001',
    dimension: 'QUALITY',
    observation: 'POSITIVE',
    source_ref: 'sensor.rack-01',
    attribution_ref: null,
    authority: 'AUTHENTICATED',
    observed_at: NOW,
    provenance: PROVENANCE,
    ...overrides,
  };
}

function attribution(overrides = {}) {
  return {
    attribution_id: 'attribution-001',
    event_name: WORKFORCE_ATTRIBUTION_EVENT_NAME,
    schema_version: WORKFORCE_SCHEMA_VERSION,
    agent_id: 'PIXEL-SYSTEMS-WORKER-01',
    subject_ref: 'job-001',
    source_ref: 'review.agentops-01',
    primary_cause: 'UNKNOWN',
    contributing_causes: [],
    confidence: 'LOW',
    supporting_evidence_refs: ['evidence-001'],
    related_incident_ref: null,
    observed_at: NOW,
    provenance: PROVENANCE,
    ...overrides,
  };
}

function evaluation(overrides = {}) {
  return {
    evaluation_id: 'evaluation-001',
    event_name: AGENTOPS_EVALUATION_EVENT_NAME,
    schema_version: WORKFORCE_SCHEMA_VERSION,
    agent_id: 'PIXEL-SYSTEMS-WORKER-01',
    evaluation_state: 'NORMAL',
    window_start: NOW,
    window_end: LATER,
    reason_codes: [],
    evidence_refs: [],
    attribution_refs: [],
    recommendations: ['NO_ACTION'],
    generated_at: NOW,
    revision_token: 'a'.repeat(64),
    provenance: PROVENANCE,
    ...overrides,
  };
}

test('workforce contracts accept canonical values', () => {
  assert.deepEqual(validateWorkforceRecordV1(record()), { ok: true, errors: [] });
  assert.deepEqual(validateCapabilityQualificationV1(qualification()), { ok: true, errors: [] });
  assert.deepEqual(validateWorkforceEvidenceV1(evidence()), { ok: true, errors: [] });
  assert.deepEqual(validateWorkforceAttributionV1(attribution()), { ok: true, errors: [] });
  assert.deepEqual(validateAgentOpsEvaluationV1(evaluation()), { ok: true, errors: [] });
});

test('canonical vocabularies are exact and bounded', () => {
  assert.deepEqual(LIFECYCLE_STATUSES, ['CANDIDATE', 'ACTIVE', 'LIMITED', 'RETRAINING', 'INACTIVE', 'RETIRED']);
  assert.deepEqual(QUALIFICATION_STATUSES, ['QUALIFIED', 'LIMITED', 'RETRAINING', 'UNQUALIFIED']);
  assert.deepEqual(AGENTOPS_STATES, ['NORMAL', 'WATCH', 'REVIEW']);
  assert.equal(ATTRIBUTION_CAUSES.length, 11);
  assert.equal(EVIDENCE_DIMENSIONS.length, 7);
  assert.equal(OBSERVATION_VALUES.length, 4);
  assert.equal(AGENTOPS_RECOMMENDATIONS.length, 7);
  assert.deepEqual(GLOBALLY_INELIGIBLE_LIFECYCLE_STATUSES, ['CANDIDATE', 'INACTIVE', 'RETIRED']);
  assert.deepEqual(SCOPE_ELIGIBLE_LIFECYCLE_STATUSES, ['ACTIVE', 'LIMITED', 'RETRAINING']);
  assert.equal(validateWorkforceRecordV1(record({ lifecycle_status: 'FIRED' })).ok, false);
  assert.equal(validateCapabilityQualificationV1(qualification({ qualification_status: 'MAYBE' })).ok, false);
  assert.equal(validateAgentOpsEvaluationV1(evaluation({ evaluation_state: 'PUNISH' })).ok, false);
  assert.equal(validateWorkforceEvidenceV1(evidence({ dimension: 'VIBES' })).ok, false);
  assert.equal(validateWorkforceEvidenceV1(evidence({ observation: 'GREAT' })).ok, false);
});

test('lifecycle transition allowlist rejects every unlisted transition', () => {
  const expected = {
    CANDIDATE: ['ACTIVE', 'INACTIVE', 'RETIRED'],
    ACTIVE: ['LIMITED', 'RETRAINING', 'INACTIVE', 'RETIRED'],
    LIMITED: ['ACTIVE', 'RETRAINING', 'INACTIVE', 'RETIRED'],
    RETRAINING: ['ACTIVE', 'LIMITED', 'INACTIVE', 'RETIRED'],
    INACTIVE: ['ACTIVE', 'LIMITED', 'RETRAINING', 'RETIRED'],
    RETIRED: [],
  };
  assert.deepEqual(LIFECYCLE_TRANSITIONS, expected);
  for (const from of LIFECYCLE_STATUSES) {
    for (const to of LIFECYCLE_STATUSES) {
      assert.equal(lifecycleTransitionAllowed(from, to), expected[from].includes(to), `${from}->${to}`);
    }
  }
  assert.equal(lifecycleTransitionAllowed('RETIRED', 'ACTIVE'), false);
  assert.equal(lifecycleTransitionAllowed('ACTIVE', 'ACTIVE'), false);
});

test('record history is strictly earlier, increasing, and never rewritten', () => {
  const history = [{ lifecycle_status: 'CANDIDATE', role_ref: 'Systems', department_ref: 'Infrastructure / HomeLab', effective_at: NOW, revision: 1 }];
  assert.equal(validateWorkforceRecordV1(record({ revision: 2, history })).ok, true);
  // A history entry at or beyond the current revision is not superseded truth.
  assert.equal(validateWorkforceRecordV1(record({ revision: 1, history })).ok, false);
  const decreasing = [
    { lifecycle_status: 'CANDIDATE', role_ref: 'Systems', department_ref: 'Infrastructure / HomeLab', effective_at: NOW, revision: 2 },
    { lifecycle_status: 'ACTIVE', role_ref: 'Systems', department_ref: 'Infrastructure / HomeLab', effective_at: NOW, revision: 1 },
  ];
  assert.equal(validateWorkforceRecordV1(record({ revision: 3, history: decreasing })).ok, false);
});

test('qualification requires canonical capability, status, and bounded source', () => {
  assert.equal(validateCapabilityQualificationV1(qualification({ capability: 'not a capability' })).ok, false);
  assert.equal(validateCapabilityQualificationV1(qualification({ source_ref: '' })).ok, false);
  assert.equal(validateCapabilityQualificationV1(qualification({ authorization_ref: 'bad ref' })).ok, false);
  assert.equal(validateCapabilityQualificationV1(qualification({ expires_at: NOW })).ok, false);
});

test('attribution requires supporting evidence and never lets UNKNOWN equal EMPLOYEE', () => {
  assert.equal(validateWorkforceAttributionV1(attribution({ supporting_evidence_refs: [] })).ok, false);
  assert.equal(validateWorkforceAttributionV1(attribution({ primary_cause: 'GHOST' })).ok, false);
  assert.equal(validateWorkforceAttributionV1(attribution({ contributing_causes: ['GHOST'] })).ok, false);
  assert.equal(validateWorkforceAttributionV1(attribution({ contributing_causes: ['UNKNOWN'] })).ok, false);
  assert.equal(validateWorkforceAttributionV1(attribution({ primary_cause: 'EMPLOYEE' })).ok, true);
});

test('self-report evidence is explicitly non-authoritative and cannot be FAIL', () => {
  assert.equal(validateWorkforceEvidenceV1(evidence({ authority: 'SELF_REPORT', observation: 'POSITIVE' })).ok, true);
  assert.equal(validateWorkforceEvidenceV1(evidence({ authority: 'SELF_REPORT', observation: 'FAIL' })).ok, false);
  assert.equal(validateWorkforceEvidenceV1(evidence({ authority: 'AUTHENTICATED', observation: 'FAIL' })).ok, true);
  assert.equal(validateWorkforceEvidenceV1(evidence({ authority: 'TRUSTED' })).ok, false);
});

test('agentops evaluation bounds reasons, refs, recommendations, and revision token', () => {
  assert.equal(validateAgentOpsEvaluationV1(evaluation({ reason_codes: Array.from({ length: 17 }, (_, i) => `reason-${i}`) })).ok, false);
  assert.equal(validateAgentOpsEvaluationV1(evaluation({ recommendations: ['QUARANTINE'] })).ok, false);
  assert.equal(validateAgentOpsEvaluationV1(evaluation({ revision_token: 'zz' })).ok, false);
  assert.equal(validateAgentOpsEvaluationV1(evaluation({ window_start: LATER, window_end: NOW })).ok, false);
});

test('operating facts projection is seam-specific and fail-closed', () => {
  const facts = {
    agent_id: 'PIXEL-SYSTEMS-WORKER-01',
    lifecycle_status: 'ACTIVE',
    qualification_status: 'QUALIFIED',
    capability: 'pixel.system-status.read',
    evaluation_state: 'NORMAL',
    qualification_expires_at: null,
    observed_at: NOW,
    revision_token: 'a'.repeat(64),
  };
  assert.equal(validateWorkforceOperatingFactsV1(facts).ok, true);
  assert.equal(validateWorkforceOperatingFactsV1({ ...facts, lifecycle_status: 'SUPER_ACTIVE' }).ok, false);
  assert.equal(validateWorkforceOperatingFactsV1({ ...facts, extra: 'caller debris' }).ok, false);
  assert.equal(validateWorkforceOperatingFactsV1({ ...facts, agent_id: 'bad id' }).ok, false);
  assert.equal(validateWorkforceOperatingFactsV1({ ...facts, revision_token: null }).ok, false);
  // EXPIRED is a derived projection value: a QUALIFIED record whose Trusted
  // Time expiry has passed. It is never a persisted canonical status.
  assert.equal(validateWorkforceOperatingFactsV1({
    ...facts, qualification_status: 'EXPIRED', qualification_expires_at: '2026-09-12T11:59:59.000Z',
  }).ok, true);
  assert.equal(validateWorkforceOperatingFactsV1({
    ...facts, qualification_status: 'QUALIFIED', qualification_expires_at: facts.observed_at,
  }).ok, false);
  assert.equal(validateWorkforceOperatingFactsV1({
    ...facts, qualification_status: 'EXPIRED', qualification_expires_at: null,
  }).ok, false);
  assert.equal(validateWorkforceOperatingFactsV1({
    ...facts, qualification_status: 'EXPIRED', qualification_expires_at: facts.observed_at,
  }).ok, true);
  assert.equal(validateCapabilityQualificationV1(qualification({ qualification_status: 'EXPIRED' })).ok, false);
  assert.equal(derivedQualificationStatus(qualification({ expires_at: facts.observed_at }), facts.observed_at), 'EXPIRED');
  // A null qualification is allowed: the record exists but the requested
  // capability has no qualification, which the Scheduler fails closed on.
  assert.equal(validateWorkforceOperatingFactsV1({ ...facts, qualification_status: null }).ok, true);
});

test('derived qualification status uses Trusted Time expiry', () => {
  assert.equal(derivedQualificationStatus(qualification(), NOW), 'QUALIFIED');
  assert.equal(derivedQualificationStatus(qualification({ expires_at: '2026-09-12T13:00:00.000Z' }), NOW), 'QUALIFIED');
  assert.equal(derivedQualificationStatus(qualification({ expires_at: NOW }), NOW), 'EXPIRED');
  assert.equal(derivedQualificationStatus(qualification({ qualification_status: 'RETRAINING' }), NOW), 'RETRAINING');
  assert.equal(derivedQualificationStatus(null, NOW), null);
});

test('published workforce schemas are recursively strict and expose the canonical vocabularies', async () => {
  const names = [
    'pixel-workforce-record-v1.schema.json',
    'pixel-capability-qualification-v1.schema.json',
    'pixel-workforce-attribution-v1.schema.json',
    'pixel-workforce-evidence-v1.schema.json',
    'pixel-agentops-evaluation-v1.schema.json',
  ];
  const schemas = [];
  for (const name of names) {
    const schema = JSON.parse(await readFile(new URL(`../../packages/contracts/schemas/${name}`, import.meta.url)));
    const visit = (value) => {
      if (value === null || typeof value !== 'object') return;
      if (value.type === 'object') assert.equal(value.additionalProperties, false, name);
      for (const child of Object.values(value)) visit(child);
    };
    visit(schema);
    schemas.push(schema);
  }
  assert.deepEqual(schemas[0].properties.lifecycle_status.enum, LIFECYCLE_STATUSES);
  assert.deepEqual(schemas[1].properties.qualification_status.enum, QUALIFICATION_STATUSES);
  assert.deepEqual(schemas[2].properties.primary_cause.enum, ATTRIBUTION_CAUSES);
  assert.deepEqual(schemas[3].properties.dimension.enum, EVIDENCE_DIMENSIONS);
  assert.deepEqual(schemas[4].properties.evaluation_state.enum, AGENTOPS_STATES);
});
