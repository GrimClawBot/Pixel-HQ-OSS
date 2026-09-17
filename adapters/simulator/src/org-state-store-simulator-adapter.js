import {
  APPROVAL_EVENT_NAME,
  CAPACITY_STATE_EVENT_NAME,
  COMPANY_STATE_EVENT_NAME,
  DELEGATION_EVENT_NAME,
  DUTY_STATE_EVENT_NAME,
  HOLD_EVENT_NAME,
  validateApprovalV1,
  validateCapacityStateV1,
  validateCompanyStateV1,
  validateDelegationV1,
  validateDutyStateV1,
  validateHoldV1,
} from '../../../packages/contracts/src/organizational-state-v1.js';

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

const KINDS = Object.freeze({
  approval: { idField: 'approval_id', validate: validateApprovalV1 },
  delegation: { idField: 'grant_id', validate: validateDelegationV1 },
  hold: { idField: 'hold_id', validate: validateHoldV1 },
  'company-state': { idField: 'company_state_id', validate: validateCompanyStateV1 },
  duty: { idField: 'duty_id', validate: validateDutyStateV1 },
  capacity: { idField: 'capacity_id', validate: validateCapacityStateV1 },
});

export class SimulatorOrgStateStoreAdapter {
  #store = new Map();

  get source() {
    return 'simulator';
  }

  #bucket(kind) {
    if (!this.#store.has(kind)) this.#store.set(kind, new Map());
    return this.#store.get(kind);
  }

  #project(entry) {
    return entry ? frozenCopy(entry.value) : null;
  }

  // Optimistic concurrency: the caller composes the record with its intended
  // revision. Creation requires revision 1 and no current record; an update
  // requires the current record at revision N and the candidate at N+1. A
  // mismatch returns STALE_REVISION without mutating canonical state.
  put(kind, value, { expectedRevision = null } = {}) {
    const contract = KINDS[kind];
    if (!contract) return { disposition: 'REJECTED', reason_code: 'UNKNOWN_KIND', record: null };
    const bucket = this.#bucket(kind);
    const id = value?.[contract.idField];
    if (typeof id !== 'string' || id.length === 0) {
      return { disposition: 'REJECTED', reason_code: 'RECORD_INVALID', record: null };
    }
    const validation = contract.validate(value);
    if (!validation.ok) {
      return { disposition: 'REJECTED', reason_code: 'RECORD_INVALID', record: null, errors: validation.errors };
    }
    const current = bucket.get(id);
    if (expectedRevision === null) {
      if (current || value.revision !== 1) {
        return { disposition: 'REJECTED', reason_code: 'ALREADY_EXISTS', record: this.#project(current) };
      }
    } else if (!current || current.value.revision !== expectedRevision || value.revision !== expectedRevision + 1) {
      return { disposition: 'STALE_REVISION', reason_code: 'STALE_REVISION', record: this.#project(current) };
    }
    const entry = { value: frozenCopy(value) };
    bucket.set(id, entry);
    return { disposition: current ? 'UPDATED' : 'CREATED', record: this.#project(entry) };
  }

  get(kind, id) {
    const contract = KINDS[kind];
    if (!contract || typeof id !== 'string') return null;
    return this.#project(this.#bucket(kind).get(id));
  }

  list(kind) {
    const contract = KINDS[kind];
    if (!contract) return [];
    return [...this.#bucket(kind).values()]
      .map((entry) => this.#project(entry))
      .sort((left, right) => String(left[contract.idField]).localeCompare(String(right[contract.idField])));
  }

  listHoldsForJob(jobId) {
    return this.list('hold').filter((hold) => hold.job_id === jobId);
  }

  currentCompanyState() {
    const records = this.list('company-state');
    if (records.length === 0) return null;
    return records.reduce((latest, candidate) => (
      candidate.revision > latest.revision ? candidate : latest
    ));
  }

  // Duty/capacity resolution prefers the newest fact: highest revision first,
  // then the most recently updated record, so a later higher-severity fact is
  // never hidden behind an older one (including at equal revisions).
  #newest(records) {
    return records.reduce((latest, candidate) => {
      if (latest === null) return candidate;
      if (candidate.revision !== latest.revision) {
        return candidate.revision > latest.revision ? candidate : latest;
      }
      return Date.parse(candidate.updated_at) >= Date.parse(latest.updated_at) ? candidate : latest;
    }, null);
  }

  dutyFor(agentId) {
    return this.#newest(this.list('duty').filter((record) => record.agent_id === agentId));
  }

  capacityFor(resourceRef) {
    return this.#newest(this.list('capacity').filter((record) => record.resource_ref === resourceRef));
  }
}
