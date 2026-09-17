import { SimulatorOrgStateStoreAdapter } from '../../adapters/simulator/src/org-state-store-simulator-adapter.js';
import { SimulatorSchedulerStoreAdapter } from '../../adapters/simulator/src/scheduler-store-simulator-adapter.js';
import { OrganizationalStateService } from '../../services/organizational-state/src/org-state-service.js';
import { SchedulerService } from '../../services/scheduler/src/scheduler-service.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';

export const NOW = '2026-09-12T12:00:00.000Z';

export function createIds(seed = 40_000) {
  let value = seed;
  return {
    nextEventId: () => `event-${++value}`,
    nextJobId: () => `job-${++value}`,
    nextExecutionId: () => `execution-${++value}`,
    nextMemoryId: () => `memory-${++value}`,
    nextRequestId: () => `request-${++value}`,
    nextPackageId: () => `package-${++value}`,
    nextSpanId: () => (++value).toString(16).padStart(16, '0'),
    nextTraceId: () => (++value).toString(16).padStart(32, '0'),
  };
}

// Deterministic mutable clock for tests that need to advance time.
export function createClock(start = NOW) {
  let current = start;
  return {
    now: () => current,
    set: (value) => { current = value; },
    advance: (milliseconds) => { current = new Date(Date.parse(current) + milliseconds).toISOString(); },
  };
}

export function canonicalJob({
  jobId = 'job-001', environment = 'simulation', state = 'ACCEPTED', revision = 2,
  workerId = 'PIXEL-SYSTEMS-WORKER-01',
} = {}) {
  return {
    envelope: {
      job_id: jobId,
      event_name: 'pixel.relay.job-envelope.v1',
      schema_version: '1.0.0',
      created_at: NOW,
      environment,
      trace_id: '1234567890abcdef1234567890abcdef',
      span_id: '1111111111111111',
      requester: { subject_id: 'PIXEL-PRINCIPAL' },
      owner: { department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems' },
      job_type: 'system-status',
      requested_capability: 'pixel.system-status.read',
      execution: {
        capability: 'pixel.system-status.read',
        tool_class: 'pixel.system-status',
        target: 'pixel.platform',
        parameter_hash: 'a'.repeat(64),
        worker_binding: {
          worker_id: workerId,
          department_ref: 'Infrastructure / HomeLab',
          role_ref: 'Systems',
        },
      },
      state: 'SUBMITTED',
      idempotency: { key: `status-${jobId}`, fingerprint: 'b'.repeat(64) },
      provenance: {
        relay_contract: 'pixel.relay.v1',
        context_provider_contract: 'pixel.job-context-provider.v1',
        context_source: 'simulator',
      },
    },
    current_state: state,
    execution_id: null,
    transitions: [],
    execution_request: null,
    gateway_decision: null,
    invocation_claimed: false,
    model_invocation: null,
    model_invocation_claimed: false,
    result: null,
    job_revision: revision,
  };
}

export const RESOURCE = 'simulation.exclusive.status-check';

// Requirement facts are explicit: a null authority/resource/dependency fact now
// fails closed in evaluation (MISSING / UNKNOWN), so tests that want a healthy
// baseline carry explicit ALLOW/HEALTHY/COMPLETE facts exactly like the
// simulator requirement provider does.
export function baseRequirement(overrides = {}) {
  return {
    requires_approval: false,
    approval_id: null,
    requires_delegation: false,
    delegation_id: null,
    not_before: null,
    resource_ref: RESOURCE,
    resource: {
      kind: 'simulated-resource-health',
      ref: RESOURCE,
      revision: 1,
      status: 'HEALTHY',
      expires_at: null,
      environment: 'simulation',
    },
    dependency: {
      kind: 'simulated-dependency',
      ref: 'dependency.none',
      revision: 1,
      status: 'COMPLETE',
      expires_at: null,
      environment: 'simulation',
    },
    authority: {
      kind: 'simulated-capability-grant',
      ref: 'pixel.system-status.read',
      revision: 1,
      status: 'ALLOW',
      expires_at: null,
      environment: 'simulation',
    },
    ...overrides,
  };
}

// Simple job lookup seam over a map of job projections.
export function jobLookup(jobs) {
  return {
    source: 'simulator',
    getJob: (jobId) => (jobs.has(jobId) ? structuredClone(jobs.get(jobId)) : null),
  };
}

export function schedulerRuntime({
  environment = 'simulation', clock = createClock(), jobs = new Map(),
} = {}) {
  const ids = createIds();
  const evidence = new EvidenceRecorder({ clock: () => clock.now() });
  const orgStore = new SimulatorOrgStateStoreAdapter();
  const schedulerStore = new SimulatorSchedulerStoreAdapter();
  const orgState = new OrganizationalStateService({
    environment, store: orgStore, evidence, ids, clock: () => clock.now(),
  });
  const scheduler = new SchedulerService({
    environment, orgState, jobs: jobLookup(jobs), store: schedulerStore, evidence, ids,
    clock: () => clock.now(),
  });
  return { clock, evidence, ids, jobs, orgState, orgStore, scheduler, schedulerStore };
}
