import { SimulatorAgentIdentityResolver } from '../../adapters/simulator/src/agent-identity-simulator-resolver.js';
import { workforceEvidenceRequestFingerprint } from '../../packages/adapter-sdk/src/workforce-runtime-adapters.js';
import { SimulatorOrgStateStoreAdapter } from '../../adapters/simulator/src/org-state-store-simulator-adapter.js';
import { SimulatorSchedulerStoreAdapter } from '../../adapters/simulator/src/scheduler-store-simulator-adapter.js';
import { SimulatorWorkforceStoreAdapter } from '../../adapters/simulator/src/workforce-store-simulator-adapter.js';
import { WorkforceService } from '../../services/workforce/src/workforce-service.js';
import { OrganizationalStateService } from '../../services/organizational-state/src/org-state-service.js';
import { SchedulerService } from '../../services/scheduler/src/scheduler-service.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { baseRequirement, canonicalJob, createClock, createIds, jobLookup, NOW } from './px006-runtime.js';

export { baseRequirement, canonicalJob, createClock, createIds, jobLookup, NOW } from './px006-runtime.js';

export const AGENT_ID = 'PIXEL-SYSTEMS-WORKER-01';
export const CAPABILITY = 'pixel.system-status.read';

export function allowAllAuthorizer() {
  let counter = 0;
  return {
    source: 'simulator',
    authorize() {
      counter += 1;
      return { allowed: true, authorization_ref: `authz-workforce-${counter}` };
    },
  };
}

export function denyAllAuthorizer() {
  return { source: 'simulator', authorize: () => ({ allowed: false, reason_code: 'DENY_BY_SEAM' }) };
}

export function throwingAuthorizer() {
  return { source: 'simulator', authorize: () => { throw new Error('authorizer unavailable'); } };
}

// Deterministic evidence intake seam. It authenticates a bounded set of
// synthetic sources; everything else is rejected. A caller string never
// authenticates evidence by itself.
export function authenticatingIntake({ authoritativeSources = ['sensor.rack-01', 'review.agentops-01'] } = {}) {
  return {
    source: 'simulator',
    authorizeEvidence(request) {
      return {
        authenticated: true,
        authority: authoritativeSources.includes(request.source_ref) ? 'AUTHENTICATED' : 'SELF_REPORT',
        source_ref: request.source_ref,
        request_fingerprint: workforceEvidenceRequestFingerprint(request),
      };
    },
  };
}

export function unauthenticatedIntake() {
  return { source: 'simulator', authorizeEvidence: () => ({ authenticated: false, authority: 'SELF_REPORT', source_ref: null }) };
}

export function throwingIntake() {
  return { source: 'simulator', authorizeEvidence: () => { throw new Error('intake unavailable'); } };
}

export function workforceRuntime({
  environment = 'simulation',
  clock = createClock(),
  authorizer = allowAllAuthorizer(),
  identityResolver = new SimulatorAgentIdentityResolver(),
  evidenceIntake = authenticatingIntake(),
  jobs = new Map(),
} = {}) {
  const ids = createIds(70_000);
  const evidence = new EvidenceRecorder({ clock: () => clock.now() });
  const workforceStore = new SimulatorWorkforceStoreAdapter();
  const workforce = new WorkforceService({
    environment, store: workforceStore, evidence, ids, clock: () => clock.now(),
    authorizer, identityResolver, evidenceIntake,
  });
  const orgStore = new SimulatorOrgStateStoreAdapter();
  const schedulerStore = new SimulatorSchedulerStoreAdapter();
  const orgState = new OrganizationalStateService({
    environment, store: orgStore, evidence, ids, clock: () => clock.now(), workforce,
  });
  const scheduler = new SchedulerService({
    environment, orgState, jobs: jobLookup(jobs), store: schedulerStore, evidence, ids,
    clock: () => clock.now(),
  });
  return { clock, evidence, ids, jobs, workforce, workforceStore, orgState, orgStore, scheduler, schedulerStore };
}

export function seedActiveWorkforce(runtime, { agentId = AGENT_ID, capability = CAPABILITY, lifecycle = 'ACTIVE', qualification = 'QUALIFIED' } = {}) {
  const created = runtime.workforce.createWorkforceRecord({
    agent_id: agentId,
    lifecycle_status: lifecycle,
    operation_id: `op-create-${agentId}`,
    authorization_ref: 'caller-ref-not-authority',
  });
  const qualified = runtime.workforce.createQualification({
    qualification_id: `qualification-${agentId}`,
    agent_id: agentId,
    capability,
    qualification_status: qualification,
    source_ref: 'academy.result-2026',
    operation_id: `op-qualify-${agentId}-${capability}`,
    authorization_ref: 'caller-ref-not-authority',
  });
  return { created, qualified };
}

export async function evaluateOrdinary(runtime, { job, requirement } = {}) {
  const actualJob = job ?? canonicalJob({ workerId: AGENT_ID });
  runtime.jobs.set(actualJob.envelope.job_id, actualJob);
  const actualRequirement = requirement ?? baseRequirement({ authority: {
    kind: 'simulated-capability-grant',
    ref: CAPABILITY,
    revision: 1,
    status: 'ALLOW',
    expires_at: null,
    environment: 'simulation',
  } });
  const result = await runtime.scheduler.evaluate({
    job_id: actualJob.envelope.job_id, requirement: actualRequirement,
  });
  return { job: actualJob, requirement: actualRequirement, result };
}
