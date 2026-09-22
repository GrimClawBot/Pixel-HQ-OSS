import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorOrgStateStoreAdapter } from '../../adapters/simulator/src/org-state-store-simulator-adapter.js';
import { SimulatorSchedulerStoreAdapter } from '../../adapters/simulator/src/scheduler-store-simulator-adapter.js';
import { OrganizationalStateService } from '../../services/organizational-state/src/org-state-service.js';
import { SchedulerService } from '../../services/scheduler/src/scheduler-service.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { baseRequirement, canonicalJob, createClock, createIds, jobLookup } from '../helpers/px006-runtime.js';

function defaultSeam(mode) {
  return {
    activeIncidentFacts: () => {
      if (mode === 'throw') throw new Error('incident seam unavailable');
      if (mode === 'malformed') return [{ incident_id: 'incident-001' }];
      if (mode === 'healthy-empty') return [];
      return null;
    },
  };
}

function seamRuntime({ mode = 'throw', incidents, facts } = {}) {
  const clock = createClock();
  const ids = createIds(93_000);
  const evidence = new EvidenceRecorder({ clock: () => clock.now() });
  const orgStore = new SimulatorOrgStateStoreAdapter();
  const schedulerStore = new SimulatorSchedulerStoreAdapter();
  const configured = incidents === undefined
    ? (facts !== undefined
      ? { activeIncidentFacts: () => facts }
      : defaultSeam(mode))
    : incidents;
  const orgState = new OrganizationalStateService({
    environment: 'simulation', store: orgStore, evidence, ids, clock: () => clock.now(), incidents: configured,
  });
  const jobs = new Map();
  const scheduler = new SchedulerService({
    environment: 'simulation', orgState, jobs: jobLookup(jobs), store: schedulerStore,
    evidence, ids, clock: () => clock.now(),
  });
  return { orgState, scheduler, jobs, clock };
}

async function evaluateOrdinary(runtime) {
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  return { job, result, inputs: runtime.orgState.evaluateExecutionInputs({ job, requirement: baseRequirement() }) };
}

const VALID_ACTIVE_FACT = Object.freeze({
  incident_id: 'incident-001',
  incident_class: 'INFRASTRUCTURE',
  severity: 'SEV-1',
  status: 'OPEN',
  affected_resource_refs: ['simulation.storage.array-01'],
});

async function evaluateSurvivalWork(runtime, incidentRef = 'incident-001') {
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  const requirement = baseRequirement({
    execution_safety_class: 'SURVIVAL_CRITICAL',
    incident_ref: incidentRef,
  });
  const result = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement });
  const inputs = runtime.orgState.evaluateExecutionInputs({ job, requirement });
  return { job, result, inputs, requirement };
}

test('a configured incident seam that throws fails closed for eligible ordinary work', async () => {
  const runtime = seamRuntime({ mode: 'throw' });
  const { job, result, inputs } = await evaluateOrdinary(runtime);
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_COMPANY_STATE');
  assert.equal(inputs.incident_seam_unavailable, true);
  assert.equal(inputs.incident_containment_eligible, false);
  assert.equal(inputs.incident_ref, null);
  // Stored Company State remains NORMAL; the seam failure itself denies, and no
  // incident identity is fabricated to route ordinary work to eligibility.
  assert.equal(inputs.company_state, 'NORMAL');
  assert.equal(job.current_state, 'ACCEPTED');
});

test('a configured incident seam returning malformed data fails closed', async () => {
  const runtime = seamRuntime({ mode: 'malformed' });
  const { result, inputs } = await evaluateOrdinary(runtime);
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_COMPANY_STATE');
  assert.equal(inputs.incident_seam_unavailable, true);
  assert.equal(inputs.incident_containment_eligible, false);
});

test('a configured incident seam returning non-array data fails closed', async () => {
  const runtime = seamRuntime({ mode: 'null' });
  const { result, inputs } = await evaluateOrdinary(runtime);
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_COMPANY_STATE');
  assert.equal(inputs.incident_seam_unavailable, true);
  assert.equal(inputs.incident_containment_eligible, false);
});

test('a configured incident seam returning a sparse array fails closed', async () => {
  const runtime = seamRuntime({ facts: new Array(1) });
  const { result, inputs } = await evaluateOrdinary(runtime);
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_COMPANY_STATE');
  assert.equal(inputs.incident_seam_unavailable, true);
  assert.equal(inputs.incident_containment_eligible, false);
});

test('a configured healthy empty incident seam leaves ordinary work eligible', async () => {
  const runtime = seamRuntime({ mode: 'healthy-empty' });
  const { result, inputs } = await evaluateOrdinary(runtime);
  assert.equal(result.disposition, 'ELIGIBLE');
  assert.equal(inputs.incident_seam_unavailable, false);
  assert.equal(inputs.incident_containment_eligible, false);
});

test('incidents === null remains the intentional opt-out for ordinary work', async () => {
  const runtime = seamRuntime({ incidents: null });
  const { result, inputs } = await evaluateOrdinary(runtime);
  assert.equal(result.disposition, 'ELIGIBLE');
  assert.equal(inputs.incident_seam_unavailable, false);
  assert.equal(inputs.incident_containment_eligible, false);
});

test('invalid incident_class with SEV-0 cannot authorize survival-critical work', async () => {
  const runtime = seamRuntime({
    facts: [{ ...VALID_ACTIVE_FACT, incident_class: 'ENVIRONMENTAL', severity: 'SEV-0' }],
  });
  const { result, inputs } = await evaluateSurvivalWork(runtime);
  assert.equal(result.disposition, 'DENY');
  assert.equal(result.evaluation.reason_code, 'DENY_COMPANY_STATE');
  assert.equal(inputs.incident_seam_unavailable, true);
  assert.equal(inputs.incident_containment_eligible, false);
});

test('invalid severity on an active fact fails closed', async () => {
  const runtime = seamRuntime({
    facts: [{ ...VALID_ACTIVE_FACT, severity: 'SEV-9' }],
  });
  const { result, inputs } = await evaluateSurvivalWork(runtime);
  assert.equal(result.disposition, 'DENY');
  assert.equal(inputs.incident_seam_unavailable, true);
  assert.equal(inputs.incident_containment_eligible, false);
});

for (const status of ['RESOLVED', 'CLOSED']) {
  test(`RESOLVED/CLOSED fact returned through the active seam fails closed (${status})`, async () => {
    const runtime = seamRuntime({
      facts: [{ ...VALID_ACTIVE_FACT, status }],
    });
    const { result, inputs } = await evaluateSurvivalWork(runtime);
    assert.equal(result.disposition, 'DENY');
    assert.equal(inputs.incident_seam_unavailable, true);
    assert.equal(inputs.incident_containment_eligible, false);
  });
}

test('malformed affected resource ref fails closed', async () => {
  const runtime = seamRuntime({
    facts: [{ ...VALID_ACTIVE_FACT, affected_resource_refs: ['bad ref!'] }],
  });
  const { result, inputs, job } = await evaluateSurvivalWork(runtime);
  assert.equal(result.disposition, 'DENY');
  assert.equal(inputs.incident_seam_unavailable, true);
  assert.equal(inputs.incident_containment_eligible, false);
  assert.equal(job.current_state, 'ACCEPTED');
});

test('oversized affected resource ref fails closed', async () => {
  const runtime = seamRuntime({
    facts: [{ ...VALID_ACTIVE_FACT, affected_resource_refs: ['r'.repeat(161)] }],
  });
  const { result, inputs } = await evaluateSurvivalWork(runtime);
  assert.equal(result.disposition, 'DENY');
  assert.equal(inputs.incident_seam_unavailable, true);
  assert.equal(inputs.incident_containment_eligible, false);
});

test('duplicate affected resource refs fail closed', async () => {
  const runtime = seamRuntime({
    facts: [{ ...VALID_ACTIVE_FACT, affected_resource_refs: ['r1', 'r1'] }],
  });
  const { result, inputs } = await evaluateSurvivalWork(runtime);
  assert.equal(result.disposition, 'DENY');
  assert.equal(inputs.incident_seam_unavailable, true);
  assert.equal(inputs.incident_containment_eligible, false);
});

test('valid canonical active incident fact still behaves normally', async () => {
  const runtime = seamRuntime({
    facts: [{ ...VALID_ACTIVE_FACT, severity: 'SEV-0' }],
  });
  const { result, inputs } = await evaluateSurvivalWork(runtime);
  assert.equal(inputs.incident_seam_unavailable, false);
  assert.equal(inputs.incident_containment_eligible, true);
  assert.equal(result.disposition, 'ELIGIBLE');
});

test('an accessor-backed incident seam fails closed instead of validating a moving target', () => {
  // The seam hands back a record whose values are getters: pre-snapshot, the
  // validator could read one value while Company State derivation read another.
  // The snapshot-before-validation law rejects accessor-bearing data outright.
  const poisoned = {};
  Object.defineProperties(poisoned, {
    incident_id: { enumerable: true, get: () => 'incident-001' },
    incident_class: { enumerable: true, get: () => 'INFRASTRUCTURE' },
    severity: { enumerable: true, get: () => 'SEV-1' },
    status: { enumerable: true, get: () => 'OPEN' },
    affected_resource_refs: { enumerable: true, get: () => ['simulation.storage.array-01'] },
  });
  const runtime = seamRuntime({ facts: [poisoned] });
  return evaluateOrdinary(runtime).then(({ result, inputs }) => {
    assert.equal(result.disposition, 'DENY');
    assert.equal(result.evaluation.reason_code, 'DENY_COMPANY_STATE');
    assert.equal(inputs.incident_seam_unavailable, true);
    assert.equal(inputs.company_state, 'NORMAL');
  });
});

test('validated incident facts are an immutable snapshot of the seam result', async () => {
  const facts = [structuredClone(VALID_ACTIVE_FACT)];
  const runtime = seamRuntime({ facts });
  const { inputs } = await evaluateOrdinary(runtime);
  // A SEV-1 infrastructure incident drives the derived Company State...
  assert.equal(inputs.company_state, 'INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT');
  // ...from an immutable snapshot, not from the live seam array: mutating the
  // array the seam still holds can never rewrite already-derived facts.
  assert.equal(Object.isFrozen(inputs.incident_facts), true, 'projected incident facts are frozen');
  facts.push({ ...structuredClone(VALID_ACTIVE_FACT), incident_id: 'incident-evil', severity: 'SEV-0' });
  facts[0].severity = 'SEV-0';
  assert.equal(inputs.company_state, 'INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT');
});
