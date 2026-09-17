import { validateAgentIdentityResolution } from '../../../packages/adapter-sdk/src/workforce-runtime-adapters.js';
import { getSystemsJobBinding } from '../../../packages/registry/src/organization-bindings.js';

// Simulator server-owned identity resolver. It confirms that a bounded
// synthetic Pixel identity already exists and is bound to an authoritative
// Organization Registry department/role. It cannot mint identities: an unknown
// agent_id returns null, and Workforce record creation then fails closed.
//
// ponytail: one canonical synthetic Systems employee, matching the existing
// simulator Relay worker binding. A live resolver (identity registry/PKI) is
// injected in dev/simulation tests and swaps in without touching Workforce.
const registryBinding = getSystemsJobBinding();

const CANONICAL_IDENTITIES = Object.freeze(new Map([
  ['PIXEL-SYSTEMS-WORKER-01', Object.freeze({
    agent_id: 'PIXEL-SYSTEMS-WORKER-01',
    department_ref: registryBinding.department_ref,
    role_ref: registryBinding.role_ref,
  })],
]));

export class SimulatorAgentIdentityResolver {
  get source() {
    return 'simulator';
  }

  // Returns a frozen canonical identity resolution or null. A malformed or
  // unresolved identity is never synthesized.
  resolveAgentIdentity(agentId) {
    if (typeof agentId !== 'string') return null;
    const identity = CANONICAL_IDENTITIES.get(agentId);
    if (!identity) return null;
    const resolution = Object.freeze({ ...identity });
    return validateAgentIdentityResolution(resolution).ok ? resolution : null;
  }
}
