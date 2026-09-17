// PX-006 Alpha simulator seam for canonical execution-requirement facts.
// A requirement describes what eligibility needs to know about a job
// (approval delegation needs, not-before timing, resource, dependency and
// authority status inputs). It is resolved at composition time — callers
// cannot supply requirement facts per call, and no requirement can grant
// authority or select a model/provider.
export class SimulatorExecutionRequirementProvider {
  get source() {
    return 'simulator';
  }

  // Deterministic Alpha facts for the single system-status capability class.
  // The authority entry is a declared synthetic simulator fact, not a default:
  // a missing requirement or missing authority entry fails closed in the
  // Scheduler as DENY_AUTHORITY_MISSING.
  resolveExecutionRequirement({ job } = {}) {
    const environment = job?.envelope?.environment;
    if (typeof environment !== 'string' || environment.length === 0) {
      throw new TypeError('Execution requirement provider requires a canonical job projection');
    }
    return {
      requirement: {
        requires_approval: false,
        approval_id: null,
        requires_delegation: false,
        delegation_id: null,
        not_before: null,
        resource_ref: `${environment}.exclusive.status-check`,
        // Requirement facts are explicit: a null fact fails closed in
        // evaluation, so the Alpha baseline declares healthy/complete facts
        // rather than relying on implicit defaults.
        resource: {
          kind: 'simulated-resource-health',
          ref: `${environment}.exclusive.status-check`,
          revision: 1,
          status: 'HEALTHY',
          expires_at: null,
          environment,
        },
        dependency: {
          kind: 'simulated-dependency',
          ref: 'dependency.none',
          revision: 1,
          status: 'COMPLETE',
          expires_at: null,
          environment,
        },
        authority: {
          kind: 'simulated-capability-grant',
          ref: 'pixel.system-status.read',
          revision: 1,
          status: 'ALLOW',
          expires_at: null,
          environment,
        },
      },
      source: this.source,
    };
  }
}
