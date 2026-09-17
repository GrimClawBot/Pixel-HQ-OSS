import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_ID, CAPABILITY, authenticatingIntake, seedActiveWorkforce, workforceRuntime,
} from '../helpers/px009-runtime.js';

function bounded(attributes) {
  return attributes !== null && typeof attributes === 'object' && !Array.isArray(attributes)
    && Object.values(attributes).every((value) => (
      ['string', 'number', 'boolean'].includes(typeof value)
      && (typeof value !== 'string' || value.length <= 160)
      && (typeof value !== 'number' || Number.isSafeInteger(value))
    ));
}

test('workforce evidence is bounded with canonical pixel keys only', () => {
  const r = workforceRuntime();
  seedActiveWorkforce(r);
  r.workforce.recordEvidence({
    evidence_id: 'evidence-001', agent_id: AGENT_ID, subject_ref: 'job-001', dimension: 'QUALITY',
    observation: 'POSITIVE', source_ref: 'sensor.rack-01', operation_id: 'op-evidence',
  });
  r.workforce.recordAttribution({
    attribution_id: 'attribution-001', agent_id: AGENT_ID, subject_ref: 'job-001', primary_cause: 'TOOL',
    source_ref: 'review.agentops-01',
    confidence: 'MEDIUM', supporting_evidence_refs: ['evidence-001'], operation_id: 'op-attribution',
  });
  r.workforce.evaluateAgentOps({ evaluation_id: 'eval-001', agent_id: AGENT_ID, operation_id: 'op-eval' });
  const records = r.evidence.all().filter((record) => record.service_name === 'pixel.workforce');
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.ok(Object.keys(record.attributes).every((key) => key.startsWith('pixel.workforce.')), record.event_name);
    assert.equal(bounded(record.attributes), true, record.event_name);
    assert.equal(record.parent_span_id, null);
    assert.equal(typeof record.trace_id, 'string');
    assert.equal(typeof record.span_id, 'string');
  }
});

test('refused workforce evidence carries bounded reason codes and no caller payload', () => {
  const r = workforceRuntime({ evidenceIntake: { source: 'simulator', authorizeEvidence: () => null } });
  seedActiveWorkforce(r);
  const refused = r.workforce.recordEvidence({
    evidence_id: 'evidence-001', agent_id: AGENT_ID, subject_ref: 'job-001', dimension: 'QUALITY',
    observation: 'FAIL', source_ref: 'untrusted.source', operation_id: 'op-evidence',
  });
  assert.equal(refused.disposition, 'REJECTED');
  const record = r.evidence.all().find((entry) => entry.event_name === 'workforce.refused');
  assert.ok(record);
  assert.equal(record.outcome, 'denied');
  assert.ok(record.attributes['pixel.workforce.reason_code']);
  assert.equal(bounded(record.attributes), true);
  // The refused record stores bounded identifiers only, never the caller body.
  assert.equal('source_ref' in record.attributes, false);
});

test('no chain-of-thought, secret, or raw payload field is part of a workforce record', () => {
  const r = workforceRuntime();
  seedActiveWorkforce(r);
  const record = r.workforce.getRecord(AGENT_ID);
  const keys = JSON.stringify(record);
  assert.equal(keys.includes('chain_of_thought'), false);
  assert.equal(keys.includes('prompt'), false);
  assert.equal(keys.includes('secret'), false);
  const qualification = r.workforce.getQualification(AGENT_ID, CAPABILITY);
  assert.deepEqual(Object.keys(qualification).sort(), [
    'agent_id', 'authorization_ref', 'capability', 'effective_at', 'event_name', 'expires_at',
    'provenance', 'qualification_id', 'qualification_status', 'revision', 'schema_version', 'source_ref', 'updated_at',
  ].sort());
});

test('lifecycle transition evidence binds operation, authorization, prior state, and new state', () => {
  const r = workforceRuntime();
  r.workforce.createWorkforceRecord({
    agent_id: AGENT_ID, lifecycle_status: 'CANDIDATE', operation_id: 'op-create',
  });
  r.workforce.changeLifecycle({
    agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', expected_revision: 1, operation_id: 'op-activate',
  });
  const entry = r.evidence.all().find((record) => (
    record.event_name === 'workforce.mutation.authorized'
      && record.attributes['pixel.workforce.action'] === 'workforce.lifecycle.change'
  ));
  assert.ok(entry);
  assert.equal(entry.attributes['pixel.workforce.operation_id'], 'op-activate');
  assert.match(entry.attributes['pixel.workforce.authorization_ref'], /^authz-workforce-/);
  assert.equal(entry.attributes['pixel.workforce.prior_state'], 'CANDIDATE');
  assert.equal(entry.attributes['pixel.workforce.new_state'], 'ACTIVE');
  assert.equal(entry.attributes['pixel.workforce.revision'], 2);
});
