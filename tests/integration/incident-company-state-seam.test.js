import assert from 'node:assert/strict';
import test from 'node:test';

import { baseRequirement, canonicalJob, createClock, RESOURCE } from '../helpers/px006-runtime.js';
import { px007Runtime } from '../helpers/px007-runtime.js';

function incidentInput(overrides = {}) {
  return {
    incident_id: 'incident-001', operation_id: 'op-create',
    incident_class: 'INFRASTRUCTURE', severity: 'SEV-1',
    commander_ref: 'PIXEL-SYSTEMS-IC', source_ref: 'sensor', summary_code: 'X',
    affected_resource_refs: ['simulation.storage.array-01'], affected_job_refs: [],
    ...overrides,
  };
}

test('a SEV-3 infrastructure incident does not stop unrelated work', async () => {
  const runtime = px007Runtime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  runtime.incident.createIncident(incidentInput({ incident_id: 'incident-sev3', severity: 'SEV-3', operation_id: 'op-sev3' }));
  const decision = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(decision.evaluation.company_state, 'NORMAL');
  assert.equal(decision.disposition, 'ELIGIBLE');
});

test('a SEV-1 infrastructure incident contributes INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT', async () => {
  const runtime = px007Runtime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  runtime.incident.createIncident(incidentInput());
  const decision = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(decision.evaluation.company_state, 'INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT');
  assert.equal(decision.disposition, 'DENY');
  assert.equal(decision.evaluation.reason_code, 'DENY_COMPANY_STATE');
});

test('SEV-0 power/thermal/infrastructure map to SURVIVAL and deny ordinary work', async () => {
  for (const incidentClass of ['POWER', 'THERMAL', 'INFRASTRUCTURE']) {
    const runtime = px007Runtime();
    const job = canonicalJob();
    runtime.jobs.set(job.envelope.job_id, job);
    runtime.incident.createIncident(incidentInput({ incident_id: `incident-${incidentClass}`, incident_class: incidentClass, severity: 'SEV-0', operation_id: `op-${incidentClass}` }));
    const decision = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
    assert.equal(decision.evaluation.company_state, 'SURVIVAL', incidentClass);
    assert.equal(decision.disposition, 'DENY', incidentClass);
    assert.equal(decision.evaluation.reason_code, 'DENY_COMPANY_STATE', incidentClass);
  }
});

test('SEV-1 security maps to SECURITY_INCIDENT and SEV-0 security to SURVIVAL', async () => {
  const runtime = px007Runtime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  runtime.incident.createIncident(incidentInput({ incident_id: 'incident-sec1', incident_class: 'SECURITY', severity: 'SEV-1', operation_id: 'op-sec1' }));
  const sev1 = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(sev1.evaluation.company_state, 'SECURITY_INCIDENT');
  assert.equal(sev1.disposition, 'DENY');
  runtime.incident.createIncident(incidentInput({ incident_id: 'incident-sec0', incident_class: 'SECURITY', severity: 'SEV-0', operation_id: 'op-sec0' }));
  const sev0 = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(sev0.evaluation.company_state, 'SURVIVAL');
  assert.equal(sev0.disposition, 'DENY');
});

test('correctly bound, already-authorized containment/survival work remains evaluable', async () => {
  const runtime = px007Runtime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  runtime.incident.createIncident(incidentInput({ incident_id: 'incident-sev0', severity: 'SEV-0', operation_id: 'op-sev0' }));
  const survival = await runtime.scheduler.evaluate({
    job_id: job.envelope.job_id,
    requirement: baseRequirement({ execution_safety_class: 'SURVIVAL_CRITICAL', incident_ref: 'incident-sev0' }),
  });
  assert.equal(survival.evaluation.company_state, 'SURVIVAL');
  // Bound + ALLOW authority + healthy resource -> not denied by company state.
  assert.equal(survival.disposition !== 'DENY', true);

  const containmentRuntime = px007Runtime();
  const containmentJob = canonicalJob({ jobId: 'job-002' });
  containmentRuntime.jobs.set(containmentJob.envelope.job_id, containmentJob);
  containmentRuntime.incident.createIncident(incidentInput({ incident_id: 'incident-sev1' }));
  const containment = await containmentRuntime.scheduler.evaluate({
    job_id: containmentJob.envelope.job_id,
    requirement: baseRequirement({ execution_safety_class: 'INCIDENT_CONTAINMENT', incident_ref: 'incident-sev1' }),
  });
  assert.equal(containment.evaluation.company_state, 'INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT');
  assert.equal(containment.disposition !== 'DENY', true);
});

test('an unbound containment request fails closed even during SURVIVAL', async () => {
  const runtime = px007Runtime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  runtime.incident.createIncident(incidentInput({ incident_id: 'incident-sev0', severity: 'SEV-0', operation_id: 'op-sev0' }));
  const unbound = await runtime.scheduler.evaluate({
    job_id: job.envelope.job_id,
    requirement: baseRequirement({ execution_safety_class: 'SURVIVAL_CRITICAL', incident_ref: 'incident-other' }),
  });
  assert.equal(unbound.disposition, 'DENY');
  assert.equal(unbound.evaluation.reason_code, 'DENY_COMPANY_STATE');
});

test('incident-linked holds use existing authority classes and release requires the relationship', async () => {
  const runtime = px007Runtime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  runtime.incident.createIncident(incidentInput({ incident_id: 'incident-sec1', incident_class: 'SECURITY', severity: 'SEV-1', operation_id: 'op-sec1' }));
  const hold = runtime.orgState.createHold({
    hold_id: 'hold-inc', job_id: job.envelope.job_id, hold_class: 'SECURITY',
    issuer: 'PIXEL-SECURITY', reason_code: 'INCIDENT', incident_id: 'incident-sec1',
  });
  assert.equal(hold.disposition, 'RECORDED');
  assert.equal(hold.record.incident_id, 'incident-sec1');
  const wrongRelease = runtime.orgState.releaseHold({ hold_id: 'hold-inc', expected_revision: 1, incident_ref: 'incident-other' });
  assert.equal(wrongRelease.disposition, 'REJECTED');
  assert.equal(wrongRelease.reason_code, 'HOLD_INCIDENT_MISMATCH');
  const rightRelease = runtime.orgState.releaseHold({ hold_id: 'hold-inc', expected_revision: 1, incident_ref: 'incident-sec1' });
  assert.equal(rightRelease.disposition, 'RECORDED');
});

test('resolving one incident cannot clear another incident or another authority hold', async () => {
  const runtime = px007Runtime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  runtime.incident.createIncident(incidentInput({ incident_id: 'incident-a', severity: 'SEV-0', operation_id: 'op-a' }));
  runtime.incident.createIncident(incidentInput({ incident_id: 'incident-b', incident_class: 'SECURITY', severity: 'SEV-0', operation_id: 'op-b' }));
  runtime.orgState.createHold({
    hold_id: 'hold-b', job_id: job.envelope.job_id, hold_class: 'MAINTENANCE',
    issuer: 'PIXEL-OPS', reason_code: 'MAINTENANCE', incident_id: 'incident-b',
  });
  // Resolve A: B remains active and its hold remains.
  for (const phase of ['CONTAIN', 'PRESERVE_EVIDENCE', 'DIAGNOSE', 'REMEDIATE', 'RECOVER', 'VERIFY']) {
    runtime.incident.advancePhase({ incident_id: 'incident-a', operation_id: `op-a-${phase}`, expected_revision: runtime.incident.getIncident('incident-a').revision, phase });
  }
  const resolved = runtime.incident.resolveIncident({ incident_id: 'incident-a', operation_id: 'op-a-resolve', expected_revision: 7, evidence_refs: ['ev'] });
  assert.equal(resolved.disposition, 'RECORDED');
  const decision = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement() });
  assert.equal(decision.evaluation.company_state, 'SURVIVAL', 'incident B still contributes SURVIVAL');
  assert.equal(runtime.orgStore.listHoldsForJob(job.envelope.job_id).length, 1);
  assert.equal(runtime.orgStore.listHoldsForJob(job.envelope.job_id)[0].status, 'ACTIVE');
});

test('SEV-2 incidents contribute degraded resource facts without global denial', async () => {
  const runtime = px007Runtime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  runtime.incident.createIncident(incidentInput({ incident_id: 'incident-sev2', severity: 'SEV-2', operation_id: 'op-sev2' }));
  const unaffected = await runtime.scheduler.evaluate({ job_id: job.envelope.job_id, requirement: baseRequirement({ resource_ref: RESOURCE }) });
  assert.equal(unaffected.evaluation.company_state, 'NORMAL');
  assert.equal(unaffected.disposition, 'ELIGIBLE');
  const degraded = runtime.orgState.evaluateExecutionInputs({
    job,
    requirement: baseRequirement({ resource_ref: 'simulation.storage.array-01', resource: { ...baseRequirement().resource, ref: 'simulation.storage.array-01' } }),
  });
  assert.equal(degraded.resource_state, 'DEGRADED');
  assert.deepEqual([...degraded.degraded_resources], ['simulation.storage.array-01']);
});

test('unknown resource health is never treated as healthy during incidents', async () => {
  const runtime = px007Runtime();
  const job = canonicalJob();
  runtime.jobs.set(job.envelope.job_id, job);
  runtime.incident.createIncident(incidentInput({ incident_id: 'incident-sev2', severity: 'SEV-2', operation_id: 'op-sev2' }));
  const unknown = await runtime.scheduler.evaluate({
    job_id: job.envelope.job_id,
    requirement: baseRequirement({ resource: null }),
  });
  assert.equal(unknown.disposition, 'DENY');
  assert.equal(unknown.evaluation.reason_code, 'DENY_RESOURCE_INELIGIBLE');
});
