import { assertValidIncidentV1 } from '../../../packages/contracts/src/incident-v1.js';

function mode(source, environment) {
  if (source === 'simulator') return 'SIMULATED';
  if (environment === 'shadow') return 'SHADOW';
  if (source === 'live') return 'LIVE';
  throw new Error('SOURCE_INVALID');
}
const CANONICAL_SOURCE_MODES = ['SIMULATED', 'SHADOW', 'LIVE'];
export function createOverviewSources({ projector, relay, orgState = null, incidents = null, workforce = null, sourceMode = null, clock }) {
  // Canonical company/incident readers stamp this configured mode on every
  // available section; an invalid configuration must fail at construction
  // instead of failing every request with SOURCE_INVALID later.
  if ((orgState !== null || incidents !== null) && !CANONICAL_SOURCE_MODES.includes(sourceMode)) {
    throw new TypeError('Canonical overview sources require a SIMULATED, SHADOW, or LIVE source mode');
  }
  const ready = (data, source_mode, observed_at = clock()) => ({ availability: 'AVAILABLE', source_mode, observed_at, data });
  return {
    storage: { read() {
      const d = projector.getDevice('PIXEL-STORAGE-01');
      if (!d) return { availability: 'UNAVAILABLE' };
      return ready(d, mode(d.source, d.environment), d.verified_at);
    } },
    recent_work: { async read() {
      const value = await relay.recentWork();
      return value === null ? { availability: 'UNAVAILABLE' } : ready(value.data, mode(value.source, value.environment));
    } },
    company: orgState === null ? null : { read() {
      const facts = orgState.evaluateExecutionInputs();
      if (facts.incident_seam_unavailable || facts.calendar_seam_unavailable) return { availability: 'UNKNOWN' };
      return ready({ state: facts.company_state, summary: 'Canonical company operating state', refs: [] }, sourceMode);
    } },
    active_incidents: incidents === null ? null : { read() {
      const values = incidents.activeIncidents();
      if (!Array.isArray(values)) throw new Error('SOURCE_INVALID');
      // No incident can be silently dropped, including malformed or oversized records.
      const items = Array.from(values, incident => {
        assertValidIncidentV1(incident);
        if (incident.status !== 'OPEN') throw new Error('SOURCE_INVALID');
        return { id: incident.incident_id, incident_class: incident.incident_class, severity: incident.severity,
          state: incident.status, phase: incident.response_phase, summary: incident.current_impact_code,
          affected_resource_count: incident.affected_resource_refs.length };
      });
      return ready({ items }, sourceMode);
    } },
    workforce: workforce === null ? null : { read() { return ready(workforce.homeSummary(), mode(workforce.source, workforce.environment)); } },
  };
}
