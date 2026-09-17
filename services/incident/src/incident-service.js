import {
  INCIDENT_CONTRACT,
  INCIDENT_EVENT_NAME,
  INCIDENT_SCHEMA_VERSION,
  RESPONSE_PHASES,
  assertValidIncidentV1,
  derivedImpactCode,
  normalizeEnvironmentalFact,
} from '../../../packages/contracts/src/incident-v1.js';
import { createTrustedClock, isCanonicalUtcTimestamp } from '../../../packages/contracts/src/trusted-time-v1.js';

const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const SIMULATOR_ENVIRONMENTS = new Set(['dev', 'simulation']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const IDENTIFIER_MAX = 160;
const MAX_EVIDENCE = 16;
const MAX_ARRAY = 16;
const PHASE_INDEX = new Map(RESPONSE_PHASES.map((phase, index) => [phase, index]));

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function safeSnapshot(value, depth = 0) {
  if (depth > 24) return '[depth-exceeded]';
  const kind = typeof value;
  if (value === null || kind === 'string' || kind === 'boolean') return value;
  if (kind === 'number') return Number.isFinite(value) ? value : '[non-finite]';
  if (kind === 'bigint') return value.toString();
  if (kind === 'function' || kind === 'symbol' || kind === 'undefined') return '[not-serializable]';
  if (Array.isArray(value)) {
    let length;
    try { length = Number.isSafeInteger(value.length) ? Math.min(value.length, 4096) : 0; } catch { return '[not-serializable]'; }
    const out = [];
    for (let index = 0; index < length; index += 1) {
      let child;
      try { child = value[index]; } catch { out.push('[accessor-error]'); continue; }
      out.push(safeSnapshot(child, depth + 1));
    }
    return out;
  }
  if (kind === 'object') {
    const out = {};
    let count = 0;
    let keys;
    try { keys = Object.keys(value); } catch { return '[not-serializable]'; }
    for (const key of keys) {
      if (count >= 4096) break;
      let child;
      try { child = value[key]; } catch { out[key] = '[accessor-error]'; count += 1; continue; }
      out[key] = safeSnapshot(child, depth + 1);
      count += 1;
    }
    return out;
  }
  return '[not-serializable]';
}

function frozenCopy(value) {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return deepFreeze(safeSnapshot(value));
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedId(value, fallback = null) {
  if (typeof value !== 'string' || value.length === 0 || value.length > IDENTIFIER_MAX || !IDENTIFIER.test(value)) {
    return fallback;
  }
  return value;
}

function boundedRefArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const item = boundedId(entry);
    if (item === null || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_ARRAY) break;
  }
  return out;
}

function requireDependencies({ environment, store, evidence, ids, clock }) {
  if (!ENVIRONMENTS.has(environment)) throw new TypeError('Incident service requires a canonical environment');
  if (!store || typeof store.put !== 'function' || typeof store.get !== 'function'
    || typeof store.readOperation !== 'function' || typeof store.activeIncidents !== 'function') {
    throw new TypeError('Incident service requires an incident store');
  }
  if (!evidence || typeof evidence.append !== 'function') throw new TypeError('Incident service requires evidence');
  const idMethods = ['nextEventId', 'nextSpanId', 'nextTraceId'];
  if (!ids || idMethods.some((method) => typeof ids[method] !== 'function')) {
    throw new TypeError('Incident service requires event, span, and trace ID sources');
  }
  if (typeof clock !== 'function') throw new TypeError('Incident service requires a clock');
  if (store.source === 'simulator' && !SIMULATOR_ENVIRONMENTS.has(environment)) {
    throw new RangeError('Simulator incident adapters may run only in dev or simulation');
  }
}

export class IncidentService {
  #clock;
  #environment;
  #evidence;
  #ids;
  #store;

  constructor({ environment, store, evidence, ids, clock }) {
    requireDependencies({ environment, store, evidence, ids, clock });
    this.#environment = environment;
    this.#store = store;
    this.#evidence = evidence;
    this.#ids = ids;
    // Trusted Time: incident-derived state and timestamps are monotonic, so a
    // clock rollback cannot revive resolved/closed incidents or their facts.
    this.#clock = createTrustedClock({ source: clock }).now;
  }

  #append({ eventName, attributes = {}, outcome = 'success', severity = 'info' }) {
    const traceId = this.#ids.nextTraceId();
    this.#evidence.append({
      traceId,
      spanId: this.#ids.nextSpanId(),
      parentSpanId: null,
      serviceName: 'pixel.incident',
      eventName,
      outcome,
      severity,
      attributes,
    });
    return traceId;
  }

  #provenance() {
    return { incident_contract: INCIDENT_CONTRACT };
  }

  #recorded(kind, eventName, record, { extra = {} } = {}) {
    const traceId = this.#append({ eventName, attributes: { ...extra } });
    return frozenCopy({ disposition: 'RECORDED', record, trace_id: traceId });
  }

  #refused(kind, reasonCode, record = null, incidentId = null) {
    const traceId = this.#append({
      eventName: 'incident.refused',
      outcome: 'denied',
      severity: 'warning',
      attributes: {
        'pixel.incident.incident_id': boundedId(incidentId, 'unknown.incident'),
        'pixel.incident.reason_code': reasonCode,
      },
    });
    return frozenCopy({ disposition: 'REJECTED', reason_code: reasonCode, record, trace_id: traceId });
  }

  #validated(kind, record) {
    try {
      assertValidIncidentV1(record);
      return null;
    } catch {
      return this.#refused(kind, 'INCIDENT_INVALID', record, record?.incident_id ?? null);
    }
  }

  // Idempotent atomic commit with read-back reconciliation. The store commits
  // or refuses; an AMBIGUOUS outcome reads back the operation and only retries
  // the SAME operation id when the expected revision is unchanged.
  #commit({ kind, record, operationId, expectedRevision }) {
    const attempt = () => this.#store.put('incident', frozenCopy(record), {
      expectedRevision, operationId,
    });
    let result = attempt();
    if (result.disposition === 'AMBIGUOUS') {
      const read = this.#store.readOperation(operationId);
      if (read && read.incident_id === record.incident_id) {
        return frozenCopy({ disposition: 'RECORDED', record: read, replayed: true });
      }
      const current = this.#store.get('incident', record.incident_id);
      const revisionUnchanged = expectedRevision === null
        ? !current
        : (current?.revision ?? null) === expectedRevision;
      if (!revisionUnchanged) {
        return this.#refused(kind, 'RECONCILIATION_REQUIRED', current, record.incident_id);
      }
      // Retry the SAME operation id exactly once.
      result = attempt();
      if (result.disposition === 'AMBIGUOUS') {
        const reread = this.#store.readOperation(operationId);
        if (reread && reread.incident_id === record.incident_id) {
          return frozenCopy({ disposition: 'RECORDED', record: reread, replayed: true });
        }
        return this.#refused(kind, 'RECONCILIATION_REQUIRED', this.#store.get('incident', record.incident_id), record.incident_id);
      }
    }
    if (result.disposition === 'OP_REPLAY') {
      return frozenCopy({ disposition: 'RECORDED', record: result.record, replayed: true });
    }
    if (result.disposition === 'CREATED' || result.disposition === 'UPDATED') {
      return frozenCopy({ disposition: 'RECORDED', record: result.record, replayed: false });
    }
    if (result.disposition === 'STALE_REVISION') {
      return this.#refused(kind, 'STALE_REVISION', result.record, record.incident_id);
    }
    if (result.disposition === 'OP_CONFLICT') {
      return this.#refused(kind, 'OP_CONFLICT', result.record, record.incident_id);
    }
    return this.#refused(kind, result.reason_code ?? 'INCIDENT_INVALID', result.record, record.incident_id);
  }

  createIncident(input) {
    if (!isRecord(input)) return this.#refused('create', 'INCIDENT_INVALID');
    const now = this.#clock();
    let fields;
    try {
      fields = {
        incident_id: input.incident_id,
        operation_id: input.operation_id,
        incident_class: input.incident_class ?? null,
        environmental_fact: input.environmental_fact ?? null,
        severity: input.severity,
        commander_ref: input.commander_ref,
        source_ref: input.source_ref,
        summary_code: input.summary_code,
        affected_resource_refs: input.affected_resource_refs ?? [],
        affected_job_refs: input.affected_job_refs ?? [],
        evidence_refs: input.evidence_refs ?? [],
      };
    } catch {
      return this.#refused('create', 'INCIDENT_INVALID');
    }
    let incidentClass = boundedId(fields.incident_class);
    if (fields.environmental_fact !== null && fields.environmental_fact !== undefined) {
      const normalized = normalizeEnvironmentalFact(fields.environmental_fact);
      if (!normalized.ok) return this.#refused('create', 'ENVIRONMENTAL_FACT_UNSUPPORTED');
      if (incidentClass !== null && incidentClass !== normalized.incident_class) {
        return this.#refused('create', 'ENVIRONMENTAL_FACT_MISMATCH');
      }
      incidentClass = normalized.incident_class;
    }
    if (incidentClass === null) return this.#refused('create', 'INCIDENT_INVALID');
    const record = {
      incident_id: fields.incident_id,
      event_name: INCIDENT_EVENT_NAME,
      schema_version: INCIDENT_SCHEMA_VERSION,
      status: 'OPEN',
      revision: 1,
      opened_at: now,
      declared_at: now,
      acknowledged_at: null,
      resolved_at: null,
      closed_at: null,
      incident_class: incidentClass,
      severity: fields.severity,
      commander_ref: fields.commander_ref,
      response_phase: 'DECLARE',
      recovery_state: 'NONE',
      current_impact_code: derivedImpactCode(fields.severity),
      source_ref: fields.source_ref,
      summary_code: fields.summary_code,
      affected_resource_refs: boundedRefArray(fields.affected_resource_refs),
      affected_job_refs: boundedRefArray(fields.affected_job_refs),
      evidence_refs: boundedRefArray(fields.evidence_refs),
      remaining_risk_code: null,
      commander_transfers: [],
      provenance: this.#provenance(),
    };
    const refused = this.#validated('create', record);
    if (refused) return refused;
    const stored = this.#commit({ kind: 'create', record, operationId: fields.operation_id, expectedRevision: null });
    if (stored.disposition !== 'RECORDED') return stored;
    return this.#recorded('create', 'incident.created', stored.record, {
      extra: {
        'pixel.incident.incident_id': stored.record.incident_id,
        'pixel.incident.status': stored.record.status,
        'pixel.incident.revision': stored.record.revision,
      },
    });
  }

  getIncident(incidentId) {
    return this.#store.get('incident', incidentId);
  }

  activeIncidents() {
    return frozenCopy(this.#store.activeIncidents());
  }

  // Incident -> Organizational-State seam: bounded facts only, never
  // authority. Missing/unavailable facts fail closed in the consumer.
  activeIncidentFacts() {
    return frozenCopy(this.#store.activeIncidents().map((incident) => ({
      incident_id: incident.incident_id,
      incident_class: incident.incident_class,
      severity: incident.severity,
      status: incident.status,
      affected_resource_refs: incident.affected_resource_refs,
    })));
  }

  acknowledgeIncident(input = {}) {
    let args;
    try {
      if (!isRecord(input)) return this.#refused('acknowledge', 'INCIDENT_INVALID');
      args = {
        incident_id: input.incident_id, operation_id: input.operation_id,
        expected_revision: input.expected_revision,
      };
    } catch {
      return this.#refused('acknowledge', 'INCIDENT_INVALID');
    }
    const current = this.#store.get('incident', args.incident_id);
    if (!current) return this.#refused('acknowledge', 'NOT_FOUND', null, args.incident_id);
    if (current.status !== 'OPEN') return this.#refused('acknowledge', 'INVALID_TRANSITION', current, current.incident_id);
    if (current.acknowledged_at !== null) return this.#refused('acknowledge', 'INVALID_TRANSITION', current, current.incident_id);
    const record = { ...current, acknowledged_at: this.#clock(), revision: current.revision + 1 };
    const refused = this.#validated('acknowledge', record);
    if (refused) return refused;
    const stored = this.#commit({ kind: 'acknowledge', record, operationId: args.operation_id, expectedRevision: args.expected_revision });
    if (stored.disposition !== 'RECORDED') return stored;
    return this.#recorded('acknowledge', 'incident.acknowledged', stored.record, {
      extra: {
        'pixel.incident.incident_id': stored.record.incident_id,
        'pixel.incident.status': stored.record.status,
        'pixel.incident.revision': stored.record.revision,
      },
    });
  }

  advancePhase(input = {}) {
    let args;
    try {
      if (!isRecord(input)) return this.#refused('phase', 'INCIDENT_INVALID');
      args = {
        incident_id: input.incident_id, operation_id: input.operation_id,
        expected_revision: input.expected_revision, phase: input.phase,
      };
    } catch {
      return this.#refused('phase', 'INCIDENT_INVALID');
    }
    const current = this.#store.get('incident', args.incident_id);
    if (!current) return this.#refused('phase', 'NOT_FOUND', null, args.incident_id);
    if (current.status !== 'OPEN') return this.#refused('phase', 'INVALID_TRANSITION', current, current.incident_id);
    const nextIndex = PHASE_INDEX.get(current.response_phase) + 1;
    if (PHASE_INDEX.get(args.phase) !== nextIndex) {
      return this.#refused('phase', 'INVALID_TRANSITION', current, current.incident_id);
    }
    const record = {
      ...current,
      response_phase: args.phase,
      recovery_state: this.#recoveryState(current, args.phase),
      revision: current.revision + 1,
    };
    const refused = this.#validated('phase', record);
    if (refused) return refused;
    const stored = this.#commit({ kind: 'phase', record, operationId: args.operation_id, expectedRevision: args.expected_revision });
    if (stored.disposition !== 'RECORDED') return stored;
    return this.#recorded('phase', 'incident.phase.advanced', stored.record, {
      extra: {
        'pixel.incident.incident_id': stored.record.incident_id,
        'pixel.incident.status': stored.record.status,
        'pixel.incident.phase': stored.record.response_phase,
        'pixel.incident.revision': stored.record.revision,
      },
    });
  }

  #recoveryState(current, phase) {
    if (phase === 'CONTAIN') return 'CONTAINED';
    if (phase === 'RECOVER') return 'RECOVERING';
    if (phase === 'VERIFY') return 'RECOVERED';
    return current.recovery_state;
  }

  transferCommand(input = {}) {
    let args;
    try {
      if (!isRecord(input)) return this.#refused('transfer', 'INCIDENT_INVALID');
      args = {
        incident_id: input.incident_id, operation_id: input.operation_id,
        expected_revision: input.expected_revision,
        new_commander_ref: input.new_commander_ref,
        reason_code: input.reason_code,
        actor_ref: input.actor_ref,
      };
    } catch {
      return this.#refused('transfer', 'INCIDENT_INVALID');
    }
    const current = this.#store.get('incident', args.incident_id);
    if (!current) return this.#refused('transfer', 'NOT_FOUND', null, args.incident_id);
    if (current.status !== 'OPEN') return this.#refused('transfer', 'INVALID_TRANSITION', current, current.incident_id);
    const newCommander = boundedId(args.new_commander_ref);
    const reason = boundedId(args.reason_code);
    const actor = boundedId(args.actor_ref);
    if (newCommander === null || reason === null || actor === null) {
      return this.#refused('transfer', 'INCIDENT_INVALID', current, current.incident_id);
    }
    if (newCommander === current.commander_ref) {
      return this.#refused('transfer', 'SAME_COMMANDER', current, current.incident_id);
    }
    const transfer = {
      prior_commander_ref: current.commander_ref,
      new_commander_ref: newCommander,
      reason_code: reason,
      actor_ref: actor,
      transferred_at: this.#clock(),
      revision: current.revision + 1,
    };
    const record = {
      ...current,
      commander_ref: newCommander,
      commander_transfers: [...current.commander_transfers, transfer],
      revision: current.revision + 1,
    };
    const refused = this.#validated('transfer', record);
    if (refused) return refused;
    const stored = this.#commit({ kind: 'transfer', record, operationId: args.operation_id, expectedRevision: args.expected_revision });
    if (stored.disposition !== 'RECORDED') return stored;
    return this.#recorded('transfer', 'incident.command.transferred', stored.record, {
      extra: {
        'pixel.incident.incident_id': stored.record.incident_id,
        'pixel.incident.commander_ref': stored.record.commander_ref,
        'pixel.incident.revision': stored.record.revision,
      },
    });
  }

  resolveIncident(input = {}) {
    const refuse = (reason, current) => this.#refused('resolve', reason, current, current?.incident_id ?? input?.incident_id ?? null);
    let args;
    try {
      if (!isRecord(input)) return this.#refused('resolve', 'INCIDENT_INVALID');
      args = {
        incident_id: input.incident_id, operation_id: input.operation_id,
        expected_revision: input.expected_revision,
        evidence_refs: input.evidence_refs ?? [],
      };
    } catch {
      return this.#refused('resolve', 'INCIDENT_INVALID');
    }
    const current = this.#store.get('incident', args.incident_id);
    if (!current) return refuse('NOT_FOUND', null);
    if (current.status !== 'OPEN') return refuse('INVALID_TRANSITION', current);
    if (current.response_phase !== 'VERIFY' || current.recovery_state !== 'RECOVERED') {
      return refuse('INVALID_TRANSITION', current);
    }
    const evidenceRefs = boundedRefArray(args.evidence_refs);
    if (evidenceRefs.length === 0) return refuse('EVIDENCE_REQUIRED', current);
    const record = {
      ...current,
      status: 'RESOLVED',
      resolved_at: this.#clock(),
      evidence_refs: [...new Set([...current.evidence_refs, ...evidenceRefs])].slice(0, MAX_EVIDENCE),
      revision: current.revision + 1,
    };
    const refused = this.#validated('resolve', record);
    if (refused) return refused;
    const stored = this.#commit({ kind: 'resolve', record, operationId: args.operation_id, expectedRevision: args.expected_revision });
    if (stored.disposition !== 'RECORDED') return stored;
    return this.#recorded('resolve', 'incident.resolved', stored.record, {
      extra: {
        'pixel.incident.incident_id': stored.record.incident_id,
        'pixel.incident.status': stored.record.status,
        'pixel.incident.revision': stored.record.revision,
      },
    });
  }

  closeIncident(input = {}) {
    let args;
    try {
      if (!isRecord(input)) return this.#refused('close', 'INCIDENT_INVALID');
      args = {
        incident_id: input.incident_id, operation_id: input.operation_id,
        expected_revision: input.expected_revision,
        remaining_risk_code: input.remaining_risk_code ?? null,
        evidence_refs: input.evidence_refs ?? [],
      };
    } catch {
      return this.#refused('close', 'INCIDENT_INVALID');
    }
    const current = this.#store.get('incident', args.incident_id);
    if (!current) return this.#refused('close', 'NOT_FOUND', null, args.incident_id);
    if (current.status !== 'RESOLVED') return this.#refused('close', 'INVALID_TRANSITION', current, current.incident_id);
    if (current.response_phase !== 'VERIFY') return this.#refused('close', 'INVALID_TRANSITION', current, current.incident_id);
    if (typeof args.remaining_risk_code !== 'string' || args.remaining_risk_code.trim().length === 0 || args.remaining_risk_code.length > 80) {
      return this.#refused('close', 'RISK_REQUIRED', current, current.incident_id);
    }
    const evidenceRefs = boundedRefArray(args.evidence_refs);
    if (evidenceRefs.length === 0) return this.#refused('close', 'EVIDENCE_REQUIRED', current, current.incident_id);
    const record = {
      ...current,
      status: 'CLOSED',
      response_phase: 'CLOSE',
      closed_at: this.#clock(),
      remaining_risk_code: args.remaining_risk_code,
      evidence_refs: [...new Set([...current.evidence_refs, ...evidenceRefs])].slice(0, MAX_EVIDENCE),
      revision: current.revision + 1,
    };
    const refused = this.#validated('close', record);
    if (refused) return refused;
    const stored = this.#commit({ kind: 'close', record, operationId: args.operation_id, expectedRevision: args.expected_revision });
    if (stored.disposition !== 'RECORDED') return stored;
    return this.#recorded('close', 'incident.closed', stored.record, {
      extra: {
        'pixel.incident.incident_id': stored.record.incident_id,
        'pixel.incident.status': stored.record.status,
        'pixel.incident.revision': stored.record.revision,
      },
    });
  }

  postIncidentReview(input = {}) {
    let args;
    try {
      if (!isRecord(input)) return this.#refused('review', 'INCIDENT_INVALID');
      args = {
        incident_id: input.incident_id, operation_id: input.operation_id,
        expected_revision: input.expected_revision,
        evidence_refs: input.evidence_refs ?? [],
      };
    } catch {
      return this.#refused('review', 'INCIDENT_INVALID');
    }
    const current = this.#store.get('incident', args.incident_id);
    if (!current) return this.#refused('review', 'NOT_FOUND', null, args.incident_id);
    if (current.status !== 'CLOSED' || current.response_phase !== 'CLOSE') {
      return this.#refused('review', 'INVALID_TRANSITION', current, current.incident_id);
    }
    const evidenceRefs = boundedRefArray(args.evidence_refs);
    if (evidenceRefs.length === 0) return this.#refused('review', 'EVIDENCE_REQUIRED', current, current.incident_id);
    const record = {
      ...current,
      response_phase: 'POST_INCIDENT_REVIEW',
      evidence_refs: [...new Set([...current.evidence_refs, ...evidenceRefs])].slice(0, MAX_EVIDENCE),
      revision: current.revision + 1,
    };
    const refused = this.#validated('review', record);
    if (refused) return refused;
    const stored = this.#commit({ kind: 'review', record, operationId: args.operation_id, expectedRevision: args.expected_revision });
    if (stored.disposition !== 'RECORDED') return stored;
    return this.#recorded('review', 'incident.post-review.recorded', stored.record, {
      extra: {
        'pixel.incident.incident_id': stored.record.incident_id,
        'pixel.incident.phase': stored.record.response_phase,
        'pixel.incident.revision': stored.record.revision,
      },
    });
  }
}
