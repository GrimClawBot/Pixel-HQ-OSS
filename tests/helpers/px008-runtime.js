import { SimulatorCapabilityGrantProvider } from '../../adapters/simulator/src/capability-grant-simulator-provider.js';
import { SimulatorJobContextProvider } from '../../adapters/simulator/src/job-context-simulator-provider.js';
import { SimulatorRelayStoreAdapter } from '../../adapters/simulator/src/relay-store-simulator-adapter.js';
import { SimulatorSystemStatusWorker } from '../../adapters/simulator/src/system-status-worker-simulator-adapter.js';
import { RelayService } from '../../services/relay/src/relay-service.js';
import { ToolGateway } from '../../services/tool-gateway/src/tool-gateway.js';
import { SimulatorCalendarStoreAdapter } from '../../adapters/simulator/src/calendar-store-simulator-adapter.js';
import { SimulatorOrgStateStoreAdapter } from '../../adapters/simulator/src/org-state-store-simulator-adapter.js';
import { SimulatorSchedulerStoreAdapter } from '../../adapters/simulator/src/scheduler-store-simulator-adapter.js';
import { CalendarService } from '../../services/calendar/src/calendar-service.js';
import { OrganizationalStateService } from '../../services/organizational-state/src/org-state-service.js';
import { SchedulerService } from '../../services/scheduler/src/scheduler-service.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { createIds, createClock, jobLookup, NOW, baseRequirement } from './px006-runtime.js';

export { createClock, createIds, NOW, baseRequirement } from './px006-runtime.js';

// Deterministic server-side mutation-authorizer seam for tests. Caller strings
// are never authority; the seam's decision is the only thing that matters.
export function allowAllAuthorizer() {
  let counter = 0;
  return {
    authorize() {
      counter += 1;
      return { allowed: true, authorization_ref: `authz-calendar-${counter}` };
    },
  };
}

export function denyAllAuthorizer() {
  return { authorize: () => ({ allowed: false, reason_code: 'DENY_BY_SEAM' }) };
}

export function throwingAuthorizer() {
  return { authorize: () => { throw new Error('authorizer unavailable'); } };
}

export function defaultCompanyHours(overrides = {}) {
  return {
    company_hours_id: 'company-hours-001',
    company_timezone: 'America/New_York',
    weekly_windows: [
      { day: 'MON', starts_at: '09:00', ends_at: '17:00' },
      { day: 'TUE', starts_at: '09:00', ends_at: '17:00' },
      { day: 'WED', starts_at: '09:00', ends_at: '17:00' },
      { day: 'THU', starts_at: '09:00', ends_at: '17:00' },
      { day: 'FRI', starts_at: '09:00', ends_at: '17:00' },
    ],
    ...overrides,
  };
}

export function baseEvent(overrides = {}) {
  return {
    calendar_event_id: 'event-001',
    event_class: 'COMPANY_HOLIDAY',
    status: 'ACTIVE',
    starts_at: '2026-09-12T12:00:00.000Z',
    ends_at: '2026-09-12T20:00:00.000Z',
    timezone: 'America/New_York',
    scope_ref: null,
    summary_code: 'SEP_HOLIDAY',
    authorization_ref: 'caller-supplied-ref-not-authority',
    ...overrides,
  };
}

export function baseTemplate(overrides = {}) {
  return {
    template_id: 'template-001',
    job_type: 'system-status',
    requested_capability: 'pixel.system-status.read',
    schedule: { kind: 'FIXED_INTERVAL', anchor_at: NOW, interval_seconds: 3600 },
    missed_run_policy: 'SKIP',
    overlap_policy: 'SKIP',
    authorization_ref: 'caller-supplied-ref-not-authority',
    ...overrides,
  };
}

export function calendarRuntime({
  environment = 'simulation', clock = createClock(), authorizer = allowAllAuthorizer(), relay,
} = {}) {
  const ids = createIds();
  const evidence = new EvidenceRecorder({ clock: () => clock.now() });
  const store = new SimulatorCalendarStoreAdapter();
  const jobs = new Map();
  const relayStore = new SimulatorRelayStoreAdapter();
  const worker = new SimulatorSystemStatusWorker();
  const toolGateway = new ToolGateway({
    environment, store: relayStore, worker, grantProvider: new SimulatorCapabilityGrantProvider(),
    evidence, ids, clock: () => clock.now(),
  });
  const realRelay = new RelayService({
    environment, store: relayStore, contextProvider: new SimulatorJobContextProvider(),
    toolGateway, evidence, ids, clock: () => clock.now(),
  });
  const relayAdapter = relay ?? realRelay;
  const calendar = new CalendarService({
    environment, store, evidence, ids, clock: () => clock.now(),
    authorizer, relay: relayAdapter,
  });
  const orgStore = new SimulatorOrgStateStoreAdapter();
  const schedulerStore = new SimulatorSchedulerStoreAdapter();
  const orgState = new OrganizationalStateService({
    environment, store: orgStore, evidence, ids, clock: () => clock.now(),
    calendar,
  });
  const scheduler = new SchedulerService({
    environment, orgState, jobs: jobLookup(jobs), store: schedulerStore, evidence, ids,
    clock: () => clock.now(),
  });
  return { clock, evidence, ids, jobs, calendar, store, orgState, orgStore, scheduler, schedulerStore, relayAdapter, relayStore, worker, realRelay };
}
