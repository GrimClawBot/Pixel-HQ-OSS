import assert from 'node:assert/strict';
import test from 'node:test';

import { workforceEvidenceRequestFingerprint } from '../../packages/adapter-sdk/src/workforce-runtime-adapters.js';
import { validateWorkforceRecordV1 } from '../../packages/contracts/src/workforce-v1.js';
import { SimulatorAgentIdentityResolver } from '../../adapters/simulator/src/agent-identity-simulator-resolver.js';
import { WorkforceService } from '../../services/workforce/src/workforce-service.js';
import { OrganizationalStateService } from '../../services/organizational-state/src/org-state-service.js';

import {
  AGENT_ID, CAPABILITY, allowAllAuthorizer, authenticatingIntake, createClock,
  denyAllAuthorizer, seedActiveWorkforce, throwingAuthorizer, throwingIntake, unauthenticatedIntake,
  workforceRuntime,
} from '../helpers/px009-runtime.js';

function created(runtime, overrides = {}) {
  return runtime.workforce.createWorkforceRecord({
    agent_id: AGENT_ID,
    lifecycle_status: 'CANDIDATE',
    operation_id: 'op-create',
    ...overrides,
  });
}

function qualify(runtime, overrides = {}) {
  return runtime.workforce.createQualification({
    qualification_id: 'qualification-001',
    agent_id: AGENT_ID,
    capability: CAPABILITY,
    qualification_status: 'QUALIFIED',
    source_ref: 'academy.result-2026',
    operation_id: 'op-qualify',
    ...overrides,
  });
}

function evidence(runtime, overrides = {}) {
  return runtime.workforce.recordEvidence({
    evidence_id: 'evidence-001',
    agent_id: AGENT_ID,
    subject_ref: 'job-001',
    dimension: 'QUALITY',
    observation: 'POSITIVE',
    source_ref: 'sensor.rack-01',
    operation_id: 'op-evidence',
    ...overrides,
  });
}

test('only an existing canonical identity may receive a workforce record', () => {
  const r = workforceRuntime();
  assert.equal(created(r).disposition, 'RECORDED');
  const unknown = created(r, { agent_id: 'PIXEL-INVENTED-99', operation_id: 'op-create-unknown' });
  assert.equal(unknown.disposition, 'REJECTED');
  assert.equal(unknown.reason_code, 'IDENTITY_UNRESOLVED');
  assert.equal(r.workforce.getRecord('PIXEL-INVENTED-99'), null);
});

test('workforce creation fails closed when the identity resolver throws or is malformed', () => {
  for (const resolver of [
    { source: 'simulator', resolveAgentIdentity: () => { throw new Error('registry offline'); } },
    { source: 'simulator', resolveAgentIdentity: () => ({ agent_id: AGENT_ID }) },
    { source: 'simulator', resolveAgentIdentity: () => ({ agent_id: 'PIXEL-OTHER-01', department_ref: 'Content', role_ref: 'Emma - Research' }) },
    { source: 'simulator', resolveAgentIdentity: () => null },
  ]) {
    const r = workforceRuntime({ identityResolver: resolver });
    const result = created(r);
    assert.equal(result.disposition, 'REJECTED');
    assert.equal(result.reason_code, 'IDENTITY_UNRESOLVED');
  }
});

test('every persistent mutation requires server-side authority, never a caller string', () => {
  const r = workforceRuntime({ authorizer: denyAllAuthorizer() });
  assert.equal(created(r).reason_code, 'MUTATION_AUTHORIZATION_DENIED');
  const throwing = workforceRuntime({ authorizer: throwingAuthorizer() });
  assert.equal(created(throwing).reason_code, 'MUTATION_AUTHORIZATION_DENIED');
  const allowed = workforceRuntime();
  assert.equal(created(allowed).disposition, 'RECORDED');
  assert.equal(allowed.workforce.changeLifecycle({
    agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', expected_revision: 1, operation_id: 'op-2',
  }).disposition, 'RECORDED');
  const denied = workforceRuntime({ authorizer: denyAllAuthorizer() });
  // A caller-supplied authorization_ref is provenance only and cannot stand in
  // for the server decision.
  assert.equal(created(denied, { authorization_ref: 'looks-official' }).reason_code, 'MUTATION_AUTHORIZATION_DENIED');
});

test('the lifecycle transition allowlist is enforced; RETIRED is terminal; same-state is a no-op', () => {
  const r = workforceRuntime();
  created(r);
  assert.equal(r.workforce.changeLifecycle({
    agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', expected_revision: 1, operation_id: 'op-a',
  }).disposition, 'RECORDED');
  const noop = r.workforce.changeLifecycle({
    agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', expected_revision: 2, operation_id: 'op-noop',
  });
  assert.equal(noop.reason_code, 'NO_OP_TRANSITION');
  assert.equal(r.workforce.getRecord(AGENT_ID).revision, 2, 'no-op must not create a new revision');
  assert.equal(r.workforce.changeLifecycle({
    agent_id: AGENT_ID, lifecycle_status: 'RETIRED', expected_revision: 2, operation_id: 'op-retire',
  }).disposition, 'RECORDED');
  for (const [index, status] of ['ACTIVE', 'LIMITED', 'RETRAINING', 'INACTIVE'].entries()) {
    const outcome = r.workforce.changeLifecycle({
      agent_id: AGENT_ID, lifecycle_status: status, expected_revision: 3, operation_id: `op-revive-${index}`,
    });
    assert.equal(outcome.reason_code, 'TRANSITION_NOT_ALLOWED', status);
  }
  assert.equal(r.workforce.getRecord(AGENT_ID).lifecycle_status, 'RETIRED');
  assert.equal(r.workforce.getRecord(AGENT_ID).revision, 3);
});

test('lifecycle and role history remain readable and are never rewritten', () => {
  const r = workforceRuntime();
  created(r);
  r.workforce.changeLifecycle({ agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', expected_revision: 1, operation_id: 'op-a' });
  r.workforce.changeRole({ agent_id: AGENT_ID, role_ref: 'Reliability', expected_revision: 2, operation_id: 'op-b' });
  const current = r.workforce.getRecord(AGENT_ID);
  assert.equal(current.revision, 3);
  assert.equal(current.role_ref, 'Reliability');
  assert.deepEqual(current.history.map((entry) => [entry.revision, entry.lifecycle_status, entry.role_ref]), [
    [1, 'CANDIDATE', 'Systems'],
    [2, 'ACTIVE', 'Systems'],
  ]);
  assert.equal(r.workforce.historyFor('workforce-record', AGENT_ID).length, 2);
});

test('stale lifecycle and qualification mutations reject without changing state', () => {
  const r = workforceRuntime();
  created(r);
  r.workforce.changeLifecycle({ agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', expected_revision: 1, operation_id: 'op-a' });
  const stale = r.workforce.changeLifecycle({
    agent_id: AGENT_ID, lifecycle_status: 'LIMITED', expected_revision: 1, operation_id: 'op-stale',
  });
  assert.equal(stale.reason_code, 'STALE_REVISION');
  assert.equal(r.workforce.getRecord(AGENT_ID).lifecycle_status, 'ACTIVE');
  assert.equal(r.workforce.getRecord(AGENT_ID).revision, 2);

  qualify(r);
  const staleQualification = r.workforce.changeQualification({
    qualification_id: 'qualification-001', qualification_status: 'UNQUALIFIED',
    expected_revision: 99, operation_id: 'op-stale-q',
  });
  assert.equal(staleQualification.reason_code, 'STALE_REVISION');
  assert.equal(r.workforce.getQualification(AGENT_ID, CAPABILITY).qualification_status, 'QUALIFIED');
  assert.equal(r.workforce.getQualification(AGENT_ID, CAPABILITY).revision, 1);
});

test('exact mutation replay is idempotent and conflicting operation reuse rejects', () => {
  const r = workforceRuntime();
  assert.equal(created(r).disposition, 'RECORDED');
  const replay = created(r);
  assert.equal(replay.disposition, 'RECORDED');
  assert.equal(replay.replayed, true);
  assert.equal(r.workforce.getRecord(AGENT_ID).revision, 1, 'replay must not create a new revision');
  const conflict = r.workforce.createWorkforceRecord({
    agent_id: AGENT_ID, lifecycle_status: 'LIMITED', operation_id: 'op-create',
  });
  assert.equal(conflict.reason_code, 'OP_CONFLICT');
  assert.equal(r.workforce.getRecord(AGENT_ID).lifecycle_status, 'CANDIDATE');
});

test('exact replay survives Trusted Time advance for every authorized mutation family', () => {
  const clock = createClock();
  const r = workforceRuntime({ clock });

  const createInput = { agent_id: AGENT_ID, lifecycle_status: 'CANDIDATE', operation_id: 'op-create' };
  assert.equal(r.workforce.createWorkforceRecord(createInput).replayed, false);
  clock.advance(1_000);
  assert.equal(r.workforce.createWorkforceRecord(createInput).replayed, true);

  const lifecycleInput = {
    agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', expected_revision: 1, operation_id: 'op-lifecycle',
  };
  assert.equal(r.workforce.changeLifecycle(lifecycleInput).replayed, false);
  clock.advance(1_000);
  assert.equal(r.workforce.changeLifecycle(lifecycleInput).replayed, true);

  const roleInput = {
    agent_id: AGENT_ID, role_ref: 'Reliability', expected_revision: 2, operation_id: 'op-role',
  };
  assert.equal(r.workforce.changeRole(roleInput).replayed, false);
  clock.advance(1_000);
  assert.equal(r.workforce.changeRole(roleInput).replayed, true);

  const qualificationInput = {
    qualification_id: 'qualification-001', agent_id: AGENT_ID, capability: CAPABILITY,
    qualification_status: 'QUALIFIED', source_ref: 'academy.result-2026', operation_id: 'op-qualification',
  };
  assert.equal(r.workforce.createQualification(qualificationInput).replayed, false);
  clock.advance(1_000);
  assert.equal(r.workforce.createQualification(qualificationInput).replayed, true);

  const qualificationChangeInput = {
    qualification_id: 'qualification-001', qualification_status: 'LIMITED',
    expected_revision: 1, operation_id: 'op-qualification-change',
  };
  assert.equal(r.workforce.changeQualification(qualificationChangeInput).replayed, false);
  clock.advance(1_000);
  assert.equal(r.workforce.changeQualification(qualificationChangeInput).replayed, true);

  assert.equal(r.workforce.getRecord(AGENT_ID).revision, 3);
  assert.equal(r.workforce.historyFor('workforce-record', AGENT_ID).length, 2);
  assert.equal(r.workforce.getQualification(AGENT_ID, CAPABILITY).revision, 2);
  assert.equal(r.workforce.historyFor('qualification', 'qualification-001').length, 1);
});

test('an operation id cannot be reused across mutation families', () => {
  const r = workforceRuntime();
  assert.equal(created(r).disposition, 'RECORDED');
  const conflict = r.workforce.createQualification({
    qualification_id: 'qualification-001', agent_id: AGENT_ID, capability: CAPABILITY,
    qualification_status: 'QUALIFIED', source_ref: 'academy.result-2026', operation_id: 'op-create',
  });
  assert.equal(conflict.reason_code, 'OP_CONFLICT');
  assert.equal(r.workforce.getQualification(AGENT_ID, CAPABILITY), null);
});

test('one current qualification per (agent_id, capability); changes are revision-guarded', () => {
  const r = workforceRuntime();
  created(r);
  qualify(r);
  const second = qualify(r, { qualification_id: 'qualification-002', operation_id: 'op-q2' });
  assert.equal(second.reason_code, 'ALREADY_EXISTS');
  const changed = r.workforce.changeQualification({
    qualification_id: 'qualification-001', qualification_status: 'LIMITED',
    expected_revision: 1, operation_id: 'op-q-change',
  });
  assert.equal(changed.disposition, 'RECORDED');
  assert.equal(changed.record.revision, 2);
  assert.equal(r.workforce.getQualification(AGENT_ID, CAPABILITY).qualification_status, 'LIMITED');
  assert.equal(r.workforce.historyFor('qualification', 'qualification-001').length, 1);
});

test('qualification expiry uses Trusted Time and rollback cannot revive it', () => {
  const clock = createClock();
  const r = workforceRuntime({ clock });
  created(r);
  qualify(r, { expires_at: '2026-09-12T13:00:00.000Z' });
  assert.equal(r.workforce.workforceFactsFor({ agent_id: AGENT_ID, capability: CAPABILITY }).qualification_status, 'QUALIFIED');
  clock.set('2026-09-12T13:00:00.000Z');
  assert.equal(r.workforce.workforceFactsFor({ agent_id: AGENT_ID, capability: CAPABILITY }).qualification_status, 'EXPIRED');
  // Backward wall-clock jump must not revive the qualification.
  clock.set('2026-09-12T09:00:00.000Z');
  assert.equal(r.workforce.workforceFactsFor({ agent_id: AGENT_ID, capability: CAPABILITY }).qualification_status, 'EXPIRED');
});

test('evidence intake is server-owned: unauthenticated, throwing, and malformed seams fail closed', () => {
  for (const intake of [
    unauthenticatedIntake(),
    throwingIntake(),
    { source: 'simulator', authorizeEvidence: () => ({ authenticated: true, authority: 'AUTHENTICATED', source_ref: 'other.source' }) },
    { source: 'simulator', authorizeEvidence: () => null },
  ]) {
    const r = workforceRuntime({ evidenceIntake: intake });
    created(r);
    const outcome = evidence(r);
    assert.equal(outcome.disposition, 'REJECTED');
    assert.ok(['EVIDENCE_NOT_AUTHENTICATED', 'EVIDENCE_AUTHORITY_UNAVAILABLE', 'EVIDENCE_INVALID'].includes(outcome.reason_code), outcome.reason_code);
    assert.equal(r.workforce.listEvidence().length, 0);
  }
});

test('evidence intake decision must bind the complete canonical request', () => {
  for (const authorizeEvidence of [
    (request) => ({ authenticated: true, authority: 'AUTHENTICATED', source_ref: request.source_ref }),
    (request) => ({
      authenticated: true, authority: 'AUTHENTICATED', source_ref: request.source_ref,
      request_fingerprint: '0'.repeat(64),
    }),
  ]) {
    const r = workforceRuntime({ evidenceIntake: { source: 'simulator', authorizeEvidence } });
    created(r);
    assert.equal(evidence(r).reason_code, 'EVIDENCE_NOT_AUTHENTICATED');
    assert.equal(r.workforce.listEvidence().length, 0);
  }
});

test('evidence append failure prevents a persistent workforce mutation', () => {
  const r = workforceRuntime();
  r.evidence.append = () => { throw new Error('evidence unavailable'); };
  assert.throws(() => created(r), /evidence unavailable/);
  assert.equal(r.workforce.getRecord(AGENT_ID), null);
});

test('self-report is stored as non-authoritative context and cannot be a FAIL', () => {
  const r = workforceRuntime({ evidenceIntake: { source: 'simulator', authorizeEvidence: (request) => ({
    authenticated: true, authority: 'SELF_REPORT', source_ref: request.source_ref,
    request_fingerprint: workforceEvidenceRequestFingerprint(request),
  }) } });
  created(r);
  qualify(r);
  const positive = evidence(r, { source_ref: 'self.agent-report', observation: 'POSITIVE' });
  assert.equal(positive.disposition, 'RECORDED');
  assert.equal(positive.record.authority, 'SELF_REPORT');
  const fail = evidence(r, { evidence_id: 'evidence-002', operation_id: 'op-evidence-2', source_ref: 'self.agent-report', observation: 'FAIL' });
  assert.equal(fail.disposition, 'REJECTED');
  assert.equal(fail.reason_code, 'SELF_REPORT_NOT_AUTHORITATIVE');
});

test('EMPLOYEE attribution requires independent authenticated evidence; UNKNOWN stays UNKNOWN', () => {
  const r = workforceRuntime();
  created(r);
  qualify(r);
  const selfReport = workforceRuntime({ evidenceIntake: { source: 'simulator', authorizeEvidence: (request) => ({
    authenticated: true, authority: 'SELF_REPORT', source_ref: request.source_ref,
    request_fingerprint: workforceEvidenceRequestFingerprint(request),
  }) } });
  created(selfReport);
  qualify(selfReport);
  assert.equal(evidence(selfReport, { source_ref: 'self.agent-report', observation: 'CONCERN' }).disposition, 'RECORDED');
  const unsubstantiated = selfReport.workforce.recordAttribution({
    attribution_id: 'attribution-self', agent_id: AGENT_ID, subject_ref: 'job-001',
    source_ref: 'self.agent-report',
    primary_cause: 'EMPLOYEE', confidence: 'LOW', supporting_evidence_refs: ['evidence-001'],
    operation_id: 'op-attr-self',
  });
  assert.equal(unsubstantiated.reason_code, 'EMPLOYEE_ATTRIBUTION_UNSUBSTANTIATED');

  assert.equal(evidence(r, { observation: 'FAIL' }).disposition, 'RECORDED');
  const employee = r.workforce.recordAttribution({
    attribution_id: 'attribution-001', agent_id: AGENT_ID, subject_ref: 'job-001',
    source_ref: 'review.agentops-01',
    primary_cause: 'EMPLOYEE', confidence: 'HIGH', supporting_evidence_refs: ['evidence-001'],
    operation_id: 'op-attr',
  });
  assert.equal(employee.disposition, 'RECORDED');
  const unknown = r.workforce.recordAttribution({
    attribution_id: 'attribution-002', agent_id: AGENT_ID, subject_ref: 'job-001',
    source_ref: 'review.agentops-01',
    primary_cause: 'UNKNOWN', confidence: 'LOW', supporting_evidence_refs: ['evidence-001'],
    operation_id: 'op-attr-unknown',
  });
  assert.equal(unknown.record.primary_cause, 'UNKNOWN');
  const missingEvidence = r.workforce.recordAttribution({
    attribution_id: 'attribution-003', agent_id: AGENT_ID, subject_ref: 'job-003',
    source_ref: 'review.agentops-01',
    primary_cause: 'UNKNOWN', confidence: 'LOW', supporting_evidence_refs: ['does-not-exist'],
    operation_id: 'op-attr-missing',
  });
  assert.equal(missingEvidence.reason_code, 'EVIDENCE_NOT_FOUND');
});

test('attribution evidence must bind the same employee and subject', () => {
  const r = workforceRuntime();
  created(r);
  assert.equal(evidence(r, { subject_ref: 'job-001', observation: 'FAIL' }).disposition, 'RECORDED');
  const mismatch = r.workforce.recordAttribution({
    attribution_id: 'attribution-mismatch', agent_id: AGENT_ID, subject_ref: 'job-002',
    source_ref: 'review.agentops-01',
    primary_cause: 'EMPLOYEE', confidence: 'HIGH', supporting_evidence_refs: ['evidence-001'],
    operation_id: 'op-attribution-mismatch',
  });
  assert.equal(mismatch.reason_code, 'EVIDENCE_MISMATCH');
  assert.equal(r.workforce.listAttributions().length, 0);
});

test('evidence attribution back-references must bind the same employee and subject', () => {
  const r = workforceRuntime();
  created(r);
  assert.equal(evidence(r, { observation: 'FAIL' }).disposition, 'RECORDED');
  assert.equal(r.workforce.recordAttribution({
    attribution_id: 'attribution-001', agent_id: AGENT_ID, subject_ref: 'job-001',
    source_ref: 'review.agentops-01', primary_cause: 'EMPLOYEE', confidence: 'HIGH',
    supporting_evidence_refs: ['evidence-001'], operation_id: 'op-attribution',
  }).disposition, 'RECORDED');
  const mismatch = evidence(r, {
    evidence_id: 'evidence-002', subject_ref: 'job-002', attribution_ref: 'attribution-001',
    operation_id: 'op-evidence-002',
  });
  assert.equal(mismatch.reason_code, 'ATTRIBUTION_MISMATCH');
  assert.equal(r.workforce.listEvidence().length, 1);
});

test('role change rejects a no-op proposal without creating a revision', () => {
  const r = workforceRuntime();
  created(r);
  const before = r.workforce.getRecord(AGENT_ID);
  const noop = r.workforce.changeRole({
    agent_id: AGENT_ID, role_ref: before.role_ref, expected_revision: 1, operation_id: 'op-role-noop',
  });
  assert.equal(noop.reason_code, 'NO_OP_TRANSITION');
  assert.equal(r.workforce.getRecord(AGENT_ID).revision, 1);
  assert.equal(r.workforce.historyFor('workforce-record', AGENT_ID).length, 0);
  assert.equal(r.workforce.changeRole({
    agent_id: AGENT_ID, department_ref: before.department_ref, expected_revision: 1, operation_id: 'op-role-noop-2',
  }).reason_code, 'NO_OP_TRANSITION');
  // A real change still commits and stays readable.
  assert.equal(r.workforce.changeRole({
    agent_id: AGENT_ID, role_ref: 'Systems / Night Shift', expected_revision: 1, operation_id: 'op-role-real',
  }).disposition, 'RECORDED');
  assert.equal(r.workforce.getRecord(AGENT_ID).revision, 2);
});

test('the embedded record history stays bounded and later mutations still commit', () => {
  const r = workforceRuntime();
  created(r);
  // Drive the record to the contract bound and one step past it.
  for (let index = 0; index < 65; index += 1) {
    const current = r.workforce.getRecord(AGENT_ID);
    const next = current.lifecycle_status === 'ACTIVE' ? 'LIMITED' : 'ACTIVE';
    const outcome = r.workforce.changeLifecycle({
      agent_id: AGENT_ID, lifecycle_status: next,
      expected_revision: current.revision, operation_id: `op-cycle-${index}`,
    });
    assert.equal(outcome.disposition, 'RECORDED', `revision ${current.revision} must still commit`);
  }
  const record = r.workforce.getRecord(AGENT_ID);
  assert.equal(record.revision, 66);
  assert.equal(record.history.length, 64);
  assert.equal(r.workforce.historyFor('workforce-record', AGENT_ID).length, 65,
    'the store keeps the complete superseded ledger');
  // The record itself still validates at the contract bound.
  assert.equal(validateWorkforceRecordV1(record).ok, true);
});

test('a store without recordFor is rejected at construction, not on first mutation', () => {
  const r = workforceRuntime();
  const store = r.workforceStore;
  assert.throws(() => new WorkforceService({
    environment: 'simulation',
    store: {
      source: 'simulator',
      put: store.put.bind(store),
      get: store.get.bind(store),
      list: store.list.bind(store),
      history: store.history.bind(store),
      readOperation: store.readOperation.bind(store),
      qualificationFor: store.qualificationFor.bind(store),
      latestEvaluationFor: store.latestEvaluationFor.bind(store),
    },
    evidence: r.evidence,
    ids: r.ids,
    clock: () => r.clock.now(),
    authorizer: allowAllAuthorizer(),
    identityResolver: new SimulatorAgentIdentityResolver(),
    evidenceIntake: authenticatingIntake(),
  }), /workforce store/);
});

test('a simulator-backed Workforce seam is refused outside dev and simulation', () => {
  const r = workforceRuntime();
  assert.equal(r.workforce.source, 'simulator');
  const liveStore = {
    source: 'live',
    put() {}, get() { return null; }, list() { return []; },
  };
  assert.throws(() => new OrganizationalStateService({
    environment: 'production', store: liveStore, evidence: r.evidence, ids: r.ids,
    clock: () => r.clock.now(), workforce: r.workforce,
  }), /Simulator Workforce adapters may run only in dev or simulation/);
  assert.doesNotThrow(() => new OrganizationalStateService({
    environment: 'simulation', store: liveStore, evidence: r.evidence, ids: r.ids,
    clock: () => r.clock.now(), workforce: r.workforce,
  }));
});

test('causal attribution requires the configured canonical intake seam', () => {
  const accepted = authenticatingIntake();
  const r = workforceRuntime({ evidenceIntake: {
    source: 'simulator',
    authorizeEvidence: (request) => (
      request.evidence_type === 'CAUSAL_ATTRIBUTION' ? null : accepted.authorizeEvidence(request)
    ),
  } });
  created(r);
  assert.equal(evidence(r, { observation: 'FAIL' }).disposition, 'RECORDED');
  const outcome = r.workforce.recordAttribution({
    attribution_id: 'attribution-untrusted', agent_id: AGENT_ID, subject_ref: 'job-001',
    source_ref: 'review.agentops-01', primary_cause: 'EMPLOYEE', confidence: 'HIGH',
    supporting_evidence_refs: ['evidence-001'], operation_id: 'op-attribution-untrusted',
  });
  assert.equal(outcome.reason_code, 'EVIDENCE_NOT_AUTHENTICATED');
  assert.equal(r.workforce.listAttributions().length, 0);
});

test('unattributed evidence remains an UNKNOWN investigation signal, not employee blame', () => {
  const r = workforceRuntime();
  created(r);
  assert.equal(evidence(r, { observation: 'FAIL' }).disposition, 'RECORDED');
  const evaluated = r.workforce.evaluateAgentOps({
    evaluation_id: 'evaluation-unattributed', agent_id: AGENT_ID, operation_id: 'op-eval-unattributed',
  });
  assert.equal(evaluated.record.evaluation_state, 'WATCH');
  assert.deepEqual(evaluated.record.reason_codes, ['UNKNOWN_ATTRIBUTION']);
  assert.equal(evaluated.record.recommendations.includes('REQUEST_WORKFORCE_REVIEW'), false);
});

test('AgentOps: UNKNOWN-only evidence supports WATCH, never blame or mutation', () => {
  const r = workforceRuntime();
  created(r);
  qualify(r);
  assert.equal(evidence(r, { observation: 'FAIL' }).disposition, 'RECORDED');
  const unknown = r.workforce.recordAttribution({
    attribution_id: 'attribution-unknown', agent_id: AGENT_ID, subject_ref: 'job-001',
    source_ref: 'review.agentops-01',
    primary_cause: 'UNKNOWN', confidence: 'LOW', supporting_evidence_refs: ['evidence-001'],
    operation_id: 'op-attr',
  });
  assert.equal(unknown.disposition, 'RECORDED');
  const evaluated = r.workforce.evaluateAgentOps({ evaluation_id: 'evaluation-001', agent_id: AGENT_ID, operation_id: 'op-eval' });
  assert.equal(evaluated.disposition, 'RECORDED');
  assert.equal(evaluated.record.evaluation_state, 'WATCH');
  assert.deepEqual(evaluated.record.reason_codes, ['UNKNOWN_ATTRIBUTION']);
  assert.equal(r.workforce.getRecord(AGENT_ID).lifecycle_status, 'CANDIDATE');
  assert.equal(r.workforce.getQualification(AGENT_ID, CAPABILITY).qualification_status, 'QUALIFIED');
});

test('AgentOps: runtime/model-attributed failures never become employee blame', () => {
  const r = workforceRuntime();
  created(r);
  qualify(r);
  r.workforce.changeLifecycle({ agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', expected_revision: 1, operation_id: 'op-a' });
  for (const [index, cause] of ['RUNTIME_MODEL', 'INFRASTRUCTURE', 'TOOL', 'EXTERNAL_PROVIDER', 'PROCESS_WORKFLOW'].entries()) {
    const e = evidence(r, {
      evidence_id: `evidence-${index}`, operation_id: `op-e-${index}`,
      subject_ref: `job-${index}`, observation: 'FAIL',
    });
    assert.equal(e.disposition, 'RECORDED');
    const a = r.workforce.recordAttribution({
      attribution_id: `attribution-${index}`, agent_id: AGENT_ID, subject_ref: `job-${index}`,
      source_ref: 'review.agentops-01',
      primary_cause: cause, confidence: 'HIGH', supporting_evidence_refs: [`evidence-${index}`],
      operation_id: `op-a-${index}`,
    });
    assert.equal(a.disposition, 'RECORDED');
  }
  const evaluated = r.workforce.evaluateAgentOps({ evaluation_id: 'evaluation-001', agent_id: AGENT_ID, operation_id: 'op-eval' });
  assert.equal(evaluated.record.evaluation_state, 'NORMAL');
  assert.deepEqual(evaluated.record.recommendations, ['NO_ACTION']);
});

test('AgentOps: a mandatory POLICY_COMPLIANCE failure cannot be averaged away', () => {
  const r = workforceRuntime();
  created(r);
  qualify(r);
  r.workforce.changeLifecycle({ agent_id: AGENT_ID, lifecycle_status: 'ACTIVE', expected_revision: 1, operation_id: 'op-a' });
  for (const [index, dimension] of ['QUALITY', 'EFFICIENCY'].entries()) {
    const e = evidence(r, { evidence_id: `evidence-pos-${index}`, operation_id: `op-pos-${index}`, dimension, observation: 'POSITIVE' });
    assert.equal(e.disposition, 'RECORDED');
  }
  assert.equal(evidence(r, {
    evidence_id: 'evidence-policy', operation_id: 'op-policy', dimension: 'POLICY_COMPLIANCE', observation: 'FAIL',
  }).disposition, 'RECORDED');
  const evaluated = r.workforce.evaluateAgentOps({ evaluation_id: 'evaluation-001', agent_id: AGENT_ID, operation_id: 'op-eval' });
  assert.equal(evaluated.record.evaluation_state, 'REVIEW');
  assert.ok(evaluated.record.reason_codes.includes('POLICY_COMPLIANCE_FAIL'));
  assert.equal(r.workforce.getRecord(AGENT_ID).lifecycle_status, 'ACTIVE', 'AgentOps must not mutate lifecycle');
  assert.equal(r.workforce.getQualification(AGENT_ID, CAPABILITY).qualification_status, 'QUALIFIED');
});

test('AgentOps thresholds: one authenticated FAIL is WATCH, repeated FAILs are REVIEW', () => {
  const r = workforceRuntime();
  created(r);
  qualify(r);
  assert.equal(evidence(r, { evidence_id: 'e1', operation_id: 'op1', observation: 'FAIL' }).disposition, 'RECORDED');
  assert.equal(r.workforce.recordAttribution({
    attribution_id: 'a1', agent_id: AGENT_ID, subject_ref: 'job-001', primary_cause: 'EMPLOYEE',
    source_ref: 'review.agentops-01',
    confidence: 'HIGH', supporting_evidence_refs: ['e1'], operation_id: 'opa1',
  }).disposition, 'RECORDED');
  const first = r.workforce.evaluateAgentOps({ evaluation_id: 'eval-1', agent_id: AGENT_ID, operation_id: 'ope1' });
  assert.equal(first.record.evaluation_state, 'WATCH');
  assert.deepEqual(first.record.reason_codes, ['EVIDENCE_FAILURE']);
  // The attribution reaches the evidence through the canonical reverse index
  // (the evidence has no attribution_ref), so it must still be published.
  assert.deepEqual(first.record.attribution_refs, ['a1']);
  assert.equal(evidence(r, { evidence_id: 'e2', operation_id: 'op2', observation: 'FAIL' }).disposition, 'RECORDED');
  assert.equal(r.workforce.recordAttribution({
    attribution_id: 'a2', agent_id: AGENT_ID, subject_ref: 'job-001', primary_cause: 'EMPLOYEE',
    source_ref: 'review.agentops-01',
    confidence: 'HIGH', supporting_evidence_refs: ['e2'], operation_id: 'opa2',
  }).disposition, 'RECORDED');
  const second = r.workforce.evaluateAgentOps({ evaluation_id: 'eval-2', agent_id: AGENT_ID, operation_id: 'ope2' });
  assert.equal(second.record.evaluation_state, 'REVIEW');
  assert.ok(second.record.reason_codes.includes('REPEATED_FAILURES'));
  assert.ok(second.record.recommendations.includes('REQUEST_WORKFORCE_REVIEW'));
  assert.ok(!second.record.recommendations.includes('QUARANTINE'));
});

test('malformed and non-cloneable caller inputs never throw across the service boundary', () => {
  const r = workforceRuntime();
  created(r);
  qualify(r);
  const cyclic = {}; cyclic.self = cyclic;
  const getter = Object.defineProperty({}, 'agent_id', { enumerable: true, get() { throw new Error('getter'); } });
  const sparse = new Array(3);
  const debris = [
    null, 42, 'string', [], cyclic, getter, sparse,
    { ...{ agent_id: AGENT_ID, lifecycle_status: 'ACTIVE' }, extra: 'field' },
    { agent_id: AGENT_ID, lifecycle_status: () => 'ACTIVE' },
  ];
  for (const input of debris) {
    assert.doesNotThrow(() => {
      const outcome = r.workforce.createWorkforceRecord(input);
      assert.equal(outcome.disposition, 'REJECTED');
    });
    assert.doesNotThrow(() => {
      const outcome = r.workforce.recordEvidence(input);
      assert.equal(outcome.disposition, 'REJECTED');
    });
    assert.doesNotThrow(() => r.workforce.workforceFactsFor(input));
  }
  assert.equal(r.workforce.getRecord(AGENT_ID).lifecycle_status, 'CANDIDATE');
  const strict = workforceRuntime();
  assert.equal(created(strict, { extra: 'caller debris' }).reason_code, 'WORKFORCE_INVALID');
  assert.equal(strict.workforce.getRecord(AGENT_ID), null);
});

test('workforce facts are bound to the exact requested capability', () => {
  const r = workforceRuntime();
  created(r);
  qualify(r);
  assert.equal(r.workforce.workforceFactsFor({ agent_id: AGENT_ID, capability: 'unrelated.capability' }).qualification_status, null);
  assert.equal(r.workforce.workforceFactsFor({ agent_id: AGENT_ID, capability: 'unrelated.capability' }).capability, 'unrelated.capability');
  assert.equal(r.workforce.workforceFactsFor({ agent_id: 'PIXEL-NOBODY-01', capability: CAPABILITY }), null);
  assert.equal(r.workforce.workforceFactsFor({}), null);
});

test('a retired identity cannot be recycled: a second create rejects and history stays bound', () => {
  const r = workforceRuntime();
  created(r);
  r.workforce.changeLifecycle({ agent_id: AGENT_ID, lifecycle_status: 'RETIRED', expected_revision: 1, operation_id: 'op-retire' });
  const recreate = created(r, { lifecycle_status: 'ACTIVE', operation_id: 'op-recreate' });
  assert.equal(recreate.reason_code, 'ALREADY_EXISTS');
  const record = r.workforce.getRecord(AGENT_ID);
  assert.equal(record.lifecycle_status, 'RETIRED');
  assert.equal(record.revision, 2);
  assert.equal(record.history.length, 1);
});

test('no AgentOps API mutates lifecycle, qualification, or Access state', () => {
  const r = workforceRuntime();
  created(r);
  qualify(r);
  r.workforce.changeLifecycle({ agent_id: AGENT_ID, lifecycle_status: 'RETIRED', expected_revision: 1, operation_id: 'op-retire' });
  const evaluated = r.workforce.evaluateAgentOps({ evaluation_id: 'eval-1', agent_id: AGENT_ID, operation_id: 'ope1' });
  assert.equal(evaluated.disposition, 'RECORDED');
  assert.equal(r.workforce.getRecord(AGENT_ID).lifecycle_status, 'RETIRED');
  assert.equal(r.workforce.getQualification(AGENT_ID, CAPABILITY).qualification_status, 'QUALIFIED');
  assert.equal(typeof r.workforce.quarantine, 'undefined');
  assert.equal(typeof r.workforce.grantAccess, 'undefined');
});

test('qualification uniqueness holds for revisioned updates at the adapter boundary', () => {
  const r = workforceRuntime();
  seedActiveWorkforce(r);
  const seeded = r.workforceStore.get('qualification', `qualification-${AGENT_ID}`);
  assert.equal(seeded.agent_id, AGENT_ID);

  // A second current qualification on a different (agent, capability) pair,
  // written directly at the adapter boundary.
  const second = { ...structuredClone(seeded), qualification_id: 'qualification-second', agent_id: 'PIXEL-AGENTS-02', capability: 'pixel.other.read', revision: 1 };
  const createdSecond = r.workforceStore.put('qualification', second, {
    expectedRevision: null,
    operationId: 'op-qual-second',
    operationFingerprint: 'a'.repeat(64),
  });
  assert.equal(createdSecond.disposition, 'CREATED', JSON.stringify(createdSecond));

  // A revisioned update that moves the second qualification onto the first
  // record's canonical pair must reject instead of leaving two current
  // records for one (agent_id, capability).
  const moved = { ...second, agent_id: AGENT_ID, capability: CAPABILITY, revision: 2 };
  const shadow = r.workforceStore.put('qualification', moved, {
    expectedRevision: 1,
    operationId: 'op-qual-move-shadow',
    operationFingerprint: 'b'.repeat(64),
  });
  assert.equal(shadow.disposition, 'REJECTED');
  assert.equal(shadow.reason_code, 'ALREADY_EXISTS');
  assert.equal(shadow.record.qualification_id, `qualification-${AGENT_ID}`);
  // The original holder is still the one and only current record for the pair.
  assert.equal(r.workforceStore.qualificationFor(AGENT_ID, CAPABILITY).qualification_id, `qualification-${AGENT_ID}`);
});

test('a revisioned key-change release frees the old key for a future record', () => {
  const r = workforceRuntime();
  seedActiveWorkforce(r);
  const seeded = r.workforceStore.get('qualification', `qualification-${AGENT_ID}`);

  // Moving the record to a free pair is admitted and releases the old key.
  const moved = { ...structuredClone(seeded), agent_id: 'PIXEL-AGENTS-03', revision: seeded.revision + 1 };
  const movedResult = r.workforceStore.put('qualification', moved, {
    expectedRevision: seeded.revision,
    operationId: 'op-qual-move-free',
    operationFingerprint: 'b'.repeat(64),
  });
  assert.equal(movedResult.disposition, 'UPDATED');

  // The released old pair can now be claimed by a fresh create.
  const fresh = { ...structuredClone(seeded), qualification_id: 'qualification-new-claim', revision: 1 };
  const claim = r.workforceStore.put('qualification', fresh, {
    expectedRevision: null,
    operationId: 'op-qual-claim-released',
    operationFingerprint: 'c'.repeat(64),
  });
  assert.equal(claim.disposition, 'CREATED', JSON.stringify(claim));
  assert.equal(r.workforceStore.qualificationFor(AGENT_ID, CAPABILITY).qualification_id, 'qualification-new-claim');
});
