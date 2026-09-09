import { MEMORY_INTAKE_CONTEXT_PROVIDER_CONTRACT } from '../../../packages/adapter-sdk/src/memory-runtime-adapters.js';
import { getSystemsJobBinding } from '../../../packages/registry/src/organization-bindings.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export class SimulatorMemoryIntakeContextProvider {
  get source() {
    return 'simulator';
  }

  async resolveMemoryIntakeContext() {
    const owner = getSystemsJobBinding();
    return deepFreeze({
      scope: {
        scope_type: 'DEPARTMENT',
        department_ref: owner.department_ref,
      },
      memory_class: 'OPERATIONAL',
      handling: 'INTERNAL',
      provenance: {
        source_class: 'synthetic',
        source_ref: 'simulator-memory-intake',
        intake_context_contract: MEMORY_INTAKE_CONTEXT_PROVIDER_CONTRACT,
        intake_source: this.source,
      },
      provider_contract: MEMORY_INTAKE_CONTEXT_PROVIDER_CONTRACT,
      source: this.source,
    });
  }
}
