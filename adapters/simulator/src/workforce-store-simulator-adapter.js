import {
  validateAgentOpsEvaluationV1,
  validateCapabilityQualificationV1,
  validateWorkforceAttributionV1,
  validateWorkforceEvidenceV1,
  validateWorkforceRecordV1,
} from '../../../packages/contracts/src/workforce-v1.js';

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

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

const KINDS = Object.freeze({
  'workforce-record': {
    idField: 'agent_id', validate: validateWorkforceRecordV1, revisioned: true,
  },
  qualification: {
    idField: 'qualification_id', validate: validateCapabilityQualificationV1, revisioned: true,
  },
  'workforce-evidence': {
    idField: 'evidence_id', validate: validateWorkforceEvidenceV1, revisioned: false,
  },
  'workforce-attribution': {
    idField: 'attribution_id', validate: validateWorkforceAttributionV1, revisioned: false,
  },
  'agentops-evaluation': {
    idField: 'evaluation_id', validate: validateAgentOpsEvaluationV1, revisioned: false,
  },
});

// One current qualification per (agent_id, capability): a create cannot
// shadow canonical qualification truth, so changes must go through the
// revision-bound change mutation. AgentOps evaluations are bounded append-only
// projections, so several evaluations per agent are legitimate history.
function uniquenessKey(kind, value) {
  if (kind === 'qualification') return `${value.agent_id}::${value.capability}`;
  return null;
}

export class SimulatorWorkforceStoreAdapter {
  #records = new Map();
  #history = new Map();
  #latestEvaluations = new Map();
  #operations = new Map();
  #keys = new Map();

  get source() {
    return 'simulator';
  }

  #bucket(kind) {
    if (!this.#records.has(kind)) this.#records.set(kind, new Map());
    return this.#records.get(kind);
  }

  #historyFor(kind, id) {
    const key = `${kind}::${id}`;
    if (!this.#history.has(key)) this.#history.set(key, []);
    return this.#history.get(key);
  }

  #project(entry) {
    return entry ? frozenCopy(entry.value) : null;
  }

  // Atomic write + operation record, mirroring the PX-007 incident store.
  // Exact replay returns the prior committed result; conflicting reuse of an
  // operation ID rejects; stale revisions reject without mutation; a duplicate
  // current record for a unique key rejects except exact replay.
  put(kind, value, {
    expectedRevision = null, operationId = null, operationFingerprint = null, historyEntry = null,
  } = {}) {
    const contract = KINDS[kind];
    if (!contract) return { disposition: 'REJECTED', reason_code: 'UNKNOWN_KIND', record: null };
    const id = value?.[contract.idField];
    if (typeof id !== 'string' || id.length === 0) {
      return { disposition: 'REJECTED', reason_code: 'RECORD_INVALID', record: null };
    }
    const validation = contract.validate(value);
    if (!validation.ok) {
      return { disposition: 'REJECTED', reason_code: 'RECORD_INVALID', record: null, errors: validation.errors };
    }
    if (typeof operationId !== 'string' || operationId.length > 160 || !OPERATION_ID.test(operationId)
      || typeof operationFingerprint !== 'string' || !FINGERPRINT.test(operationFingerprint)) {
      return { disposition: 'REJECTED', reason_code: 'OPERATION_INVALID', record: null };
    }
    if (this.#operations.has(operationId)) {
      const previous = this.#operations.get(operationId);
      if (previous.fingerprint === operationFingerprint && previous.kind === kind && previous.id === id) {
        return { disposition: 'OP_REPLAY', record: this.#project(previous.entry) };
      }
      return { disposition: 'OP_CONFLICT', reason_code: 'OP_CONFLICT', record: null };
    }
    const bucket = this.#bucket(kind);
    const current = bucket.get(id);

    // Unique-key enforcement: a create cannot shadow an existing current
    // record for the same (agent, capability) / agent pair.
    const unique = uniquenessKey(kind, value);
    const uniqueIndex = this.#keys.get(kind) ?? new Map();
    this.#keys.set(kind, uniqueIndex);
    if (unique !== null) {
      const holder = uniqueIndex.get(unique);
      if (holder !== undefined && holder !== id && (contract.revisioned ? value.revision === 1 : current === undefined)) {
        return { disposition: 'REJECTED', reason_code: 'ALREADY_EXISTS', record: this.#project(bucket.get(holder)) };
      }
    }

    if (contract.revisioned) {
      if (expectedRevision === null) {
        if (current || value.revision !== 1) {
          return { disposition: 'REJECTED', reason_code: 'ALREADY_EXISTS', record: this.#project(current) };
        }
      } else if (!current || current.value.revision !== expectedRevision || value.revision !== expectedRevision + 1) {
        return { disposition: 'STALE_REVISION', reason_code: 'STALE_REVISION', record: this.#project(current) };
      }
    } else if (current || expectedRevision !== null) {
      // Append-only kinds never update in place.
      return { disposition: 'REJECTED', reason_code: 'ALREADY_EXISTS', record: this.#project(current) };
    }

    if (current && historyEntry !== null) {
      this.#historyFor(kind, id).push(frozenCopy(historyEntry));
    }
    const entry = { value: frozenCopy(value) };
    bucket.set(id, entry);
    if (kind === 'agentops-evaluation') {
      const currentLatest = this.#latestEvaluations.get(value.agent_id);
      if (currentLatest === undefined
        || Date.parse(value.generated_at) > Date.parse(currentLatest.value.generated_at)
        || (value.generated_at === currentLatest.value.generated_at
          && value.evaluation_id.localeCompare(currentLatest.value.evaluation_id) >= 0)) {
        this.#latestEvaluations.set(value.agent_id, entry);
      }
    }
    if (unique !== null) uniqueIndex.set(unique, id);
    this.#operations.set(operationId, {
      kind, id, fingerprint: operationFingerprint, entry,
    });
    return { disposition: current ? 'UPDATED' : 'CREATED', record: this.#project(entry) };
  }

  get(kind, id) {
    if (!KINDS[kind] || typeof id !== 'string') return null;
    return this.#project(this.#records.get(kind)?.get(id));
  }

  #materialize(kind) {
    return [...(this.#records.get(kind)?.values() ?? [])]
      .map((entry) => this.#project(entry))
      .sort((left, right) => String(left[KINDS[kind].idField]).localeCompare(String(right[KINDS[kind].idField])));
  }

  list(kind) {
    if (!KINDS[kind]) return [];
    return this.#materialize(kind);
  }

  // Bounded summary read for the Home aggregate. The limit is checked against
  // the live bucket size before a single record is cloned or sorted, so an
  // oversized workforce bucket fails closed without being materialized.
  workforceRecordsForSummary(limit) {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError('PROJECTION_BOUND_EXCEEDED');
    if ((this.#records.get('workforce-record')?.size ?? 0) > limit) {
      throw new RangeError('PROJECTION_BOUND_EXCEEDED');
    }
    return this.#materialize('workforce-record');
  }

  // Immutable superseded truth, oldest first.
  history(kind, id) {
    if (!KINDS[kind] || typeof id !== 'string') return [];
    return frozenCopy(this.#historyFor(kind, id));
  }

  recordFor(agentId) {
    return this.get('workforce-record', agentId);
  }

  qualificationFor(agentId, capability) {
    return this.list('qualification').find((record) => (
      record.agent_id === agentId && record.capability === capability
    )) ?? null;
  }

  latestEvaluationFor(agentId) {
    return this.#project(this.#latestEvaluations.get(agentId));
  }

  latestEvaluationsForSummary(limit) {
    if (!Number.isInteger(limit) || limit < 0 || this.#latestEvaluations.size > limit) {
      throw new RangeError('PROJECTION_BOUND_EXCEEDED');
    }
    return Array.from(this.#latestEvaluations.values(), entry => this.#project(entry));
  }

  // Read-back by operation_id for ambiguous-write reconciliation.
  readOperation(operationId, operationFingerprint = null) {
    if (typeof operationId !== 'string') return null;
    const previous = this.#operations.get(operationId);
    if (!previous) return null;
    if (operationFingerprint === null) return this.#project(previous.entry);
    if (previous.fingerprint === operationFingerprint) {
      return { disposition: 'OP_REPLAY', record: this.#project(previous.entry) };
    }
    return { disposition: 'OP_CONFLICT', reason_code: 'OP_CONFLICT', record: null };
  }
}
