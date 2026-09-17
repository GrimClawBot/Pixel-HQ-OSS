import { SimulatorIncidentStoreAdapter } from '../../adapters/simulator/src/incident-store-simulator-adapter.js';
import { SimulatorOrgStateStoreAdapter } from '../../adapters/simulator/src/org-state-store-simulator-adapter.js';
import { SimulatorSchedulerStoreAdapter } from '../../adapters/simulator/src/scheduler-store-simulator-adapter.js';
import { IncidentService } from '../../services/incident/src/incident-service.js';
import { OrganizationalStateService } from '../../services/organizational-state/src/org-state-service.js';
import { SchedulerService } from '../../services/scheduler/src/scheduler-service.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { createIds, createClock, jobLookup } from './px006-runtime.js';

export { baseRequirement, canonicalJob, createClock, createIds, NOW, RESOURCE } from './px006-runtime.js';

export function px007Runtime({
  environment = 'simulation', clock = createClock(), jobs = new Map(),
} = {}) {
  const ids = createIds();
  const evidence = new EvidenceRecorder({ clock: () => clock.now() });
  const incidentStore = new SimulatorIncidentStoreAdapter();
  const incidentService = new IncidentService({
    environment, store: incidentStore, evidence, ids, clock: () => clock.now(),
  });
  const orgStore = new SimulatorOrgStateStoreAdapter();
  const schedulerStore = new SimulatorSchedulerStoreAdapter();
  const orgState = new OrganizationalStateService({
    environment, store: orgStore, evidence, ids, clock: () => clock.now(), incidents: incidentService,
  });
  const scheduler = new SchedulerService({
    environment, orgState, jobs: jobLookup(jobs), store: schedulerStore, evidence, ids,
    clock: () => clock.now(),
  });
  return { clock, evidence, ids, jobs, incidentStore, incident: incidentService, incidentService, orgState, orgStore, scheduler, schedulerStore };
}

export function incidentInput(overrides = {}) {
  return {
    incident_id: 'incident-001',
    operation_id: 'op-create-incident',
    incident_class: 'INFRASTRUCTURE',
    severity: 'SEV-1',
    commander_ref: 'PIXEL-SYSTEMS-IC',
    source_ref: 'sensor.rack-01',
    summary_code: 'STORAGE_ARRAY_DEGRADED',
    affected_resource_refs: ['simulation.storage.array-01'],
    affected_job_refs: [],
    ...overrides,
  };
}
