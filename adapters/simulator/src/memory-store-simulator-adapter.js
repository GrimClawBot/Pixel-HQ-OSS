import { assertValidMemoryRecordV1 } from '../../../packages/contracts/src/memory-v1.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function frozenCopy(value) {
  return deepFreeze(structuredClone(value));
}

export class SimulatorMemoryStoreAdapter {
  #records = new Map();

  get source() {
    return 'simulator';
  }

  putRecord(record) {
    const stored = frozenCopy(record);
    assertValidMemoryRecordV1(stored);
    this.#records.set(stored.memory_id, stored);
    return frozenCopy(stored);
  }

  getRecord(memoryId) {
    const record = this.#records.get(memoryId);
    return record ? frozenCopy(record) : null;
  }

  listByDepartment(departmentRef) {
    return Object.freeze([...this.#records.values()]
      .filter((record) => record.scope.department_ref === departmentRef)
      .map(frozenCopy));
  }
}
