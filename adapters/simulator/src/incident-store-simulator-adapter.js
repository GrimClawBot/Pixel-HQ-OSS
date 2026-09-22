import { validateIncidentV1 } from '../../../packages/contracts/src/incident-v1.js';

// Canonical operation-ID charset. #operationKey() composes delimiter-separated
// keys and readOperation() matches by prefix, so an operation ID containing
// delimiter material (":") could collide with or shadow another operation's
// key. The bounded charset keeps every composed key unambiguous.
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export class SimulatorIncidentStoreAdapter {
  #incidents = new Map();
  #operations = new Map();

  get source() {
    return 'simulator';
  }

  #project(entry) {
    return entry ? frozenCopy(entry.value) : null;
  }

  #operationKey(operationId, incidentId) {
    return `${operationId}::incident::${incidentId}`;
  }

  // Atomic write + operation record. Exact replay returns the prior committed
  // result; conflicting reuse of an operation ID rejects; stale revisions reject
  // without mutation; duplicate incident IDs reject except exact replay.
  put(kind, value, { expectedRevision = null, operationId = null } = {}) {
    const contract = kind === 'incident' ? { idField: 'incident_id', validate: validateIncidentV1 } : null;
    if (!contract) return { disposition: 'REJECTED', reason_code: 'UNKNOWN_KIND', record: null };
    const id = value?.[contract.idField];
    if (typeof id !== 'string' || id.length === 0) {
      return { disposition: 'REJECTED', reason_code: 'RECORD_INVALID', record: null };
    }
    const validation = contract.validate(value);
    if (!validation.ok) {
      return { disposition: 'REJECTED', reason_code: 'RECORD_INVALID', record: null, errors: validation.errors };
    }
    if (typeof operationId !== 'string' || operationId.length === 0 || operationId.length > 160
      || !OPERATION_ID.test(operationId)) {
      return { disposition: 'REJECTED', reason_code: 'OPERATION_INVALID', record: null };
    }
    const key = this.#operationKey(operationId, id);
    if (this.#operations.has(key)) {
      const previous = this.#operations.get(key).value;
      if (stableStringify(previous) === stableStringify(value)) {
        return { disposition: 'OP_REPLAY', record: this.#project(this.#operations.get(key)) };
      }
      return { disposition: 'OP_CONFLICT', reason_code: 'OP_CONFLICT', record: null };
    }
    const current = this.#incidents.get(id);
    if (expectedRevision === null) {
      if (current || value.revision !== 1) {
        return { disposition: 'REJECTED', reason_code: 'ALREADY_EXISTS', record: this.#project(current) };
      }
    } else if (!current || current.value.revision !== expectedRevision || value.revision !== expectedRevision + 1) {
      return { disposition: 'STALE_REVISION', reason_code: 'STALE_REVISION', record: this.#project(current) };
    }
    const entry = { value: frozenCopy(value) };
    this.#incidents.set(id, entry);
    this.#operations.set(key, entry);
    return { disposition: current ? 'UPDATED' : 'CREATED', record: this.#project(entry) };
  }

  get(kind, id) {
    if (kind !== 'incident' || typeof id !== 'string') return null;
    return this.#project(this.#incidents.get(id));
  }

  list(kind) {
    if (kind !== 'incident') return [];
    return [...this.#incidents.values()]
      .map((entry) => this.#project(entry))
      .sort((left, right) => String(left.incident_id).localeCompare(String(right.incident_id)));
  }

  activeIncidents() {
    return this.list('incident').filter((incident) => incident.status === 'OPEN');
  }

  // Read-back by operation_id. The service binds the returned record to the
  // incident_id it attempted before retrying; ambiguity never infers success.
  readOperation(operationId) {
    if (typeof operationId !== 'string') return null;
    for (const [key, entry] of this.#operations) {
      if (key.startsWith(`${operationId}::incident::`)) return this.#project(entry);
    }
    return null;
  }
}
