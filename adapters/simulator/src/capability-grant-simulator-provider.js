import {
  CAPABILITY_GRANT_PROVIDER_CONTRACT,
  validateCapabilityAuthorizationContext,
} from '../../../packages/adapter-sdk/src/job-runtime-adapters.js';
import { getSystemsJobBinding } from '../../../packages/registry/src/organization-bindings.js';

const EMPTY_PARAMETER_HASH = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

export class SimulatorCapabilityGrantProvider {
  #capabilities;

  constructor({ capabilities = ['pixel.system-status.read'] } = {}) {
    this.#capabilities = new Set(capabilities);
  }

  get source() {
    return 'simulator';
  }

  revoke(capability) {
    this.#capabilities.delete(capability);
  }

  grant(capability) {
    this.#capabilities.add(capability);
  }

  async resolveCapabilities(context) {
    const registryBinding = getSystemsJobBinding();
    const valid = validateCapabilityAuthorizationContext(context).ok
      && context.requester.subject_id === 'PIXEL-PRINCIPAL'
      && context.owner.department_ref === registryBinding.department_ref
      && context.owner.role_ref === registryBinding.role_ref
      && context.worker_binding.worker_id === 'PIXEL-SYSTEMS-WORKER-01'
      && context.worker_binding.department_ref === registryBinding.department_ref
      && context.worker_binding.role_ref === registryBinding.role_ref
      && ['dev', 'simulation'].includes(context.environment)
      && context.parameter_hash === EMPTY_PARAMETER_HASH;
    return Object.freeze({
      capabilities: Object.freeze(valid ? [...this.#capabilities].sort() : []),
      policy_id: 'pixel.alpha.system-status.v1',
      provider_contract: CAPABILITY_GRANT_PROVIDER_CONTRACT,
      source: this.source,
    });
  }
}
