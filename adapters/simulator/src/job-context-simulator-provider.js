import { JOB_CONTEXT_PROVIDER_CONTRACT } from '../../../packages/adapter-sdk/src/job-runtime-adapters.js';
import { getSystemsJobBinding } from '../../../packages/registry/src/organization-bindings.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export class SimulatorJobContextProvider {
  get source() {
    return 'simulator';
  }

  async resolveJobContext() {
    const owner = getSystemsJobBinding();
    return deepFreeze({
      requester: { subject_id: 'PIXEL-PRINCIPAL' },
      owner: { ...owner },
      worker_binding: {
        worker_id: 'PIXEL-SYSTEMS-WORKER-01',
        ...owner,
      },
      provider_contract: JOB_CONTEXT_PROVIDER_CONTRACT,
      source: this.source,
    });
  }
}
