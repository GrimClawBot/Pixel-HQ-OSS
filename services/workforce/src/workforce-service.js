import {
  AGENTOPS_EVALUATION_EVENT_NAME,
  CAPABILITY_QUALIFICATION_EVENT_NAME,
  LIFECYCLE_STATUSES,
  MAX_EVIDENCE_REFS,
  MAX_TRANSITIONS,
  WORKFORCE_ATTRIBUTION_EVENT_NAME,
  WORKFORCE_CONTRACT,
  WORKFORCE_EVIDENCE_EVENT_NAME,
  WORKFORCE_RECORD_EVENT_NAME,
  WORKFORCE_SCHEMA_VERSION,
  assertValidAgentOpsEvaluationV1,
  assertValidCapabilityQualificationV1,
  assertValidWorkforceAttributionV1,
  assertValidWorkforceEvidenceV1,
  assertValidWorkforceRecordV1,
  derivedQualificationStatus,
  lifecycleTransitionAllowed,
  validateWorkforceOperatingFactsV1,
} from '../../../packages/contracts/src/workforce-v1.js';
import {
  assertWorkforceEvidenceIntake,
  assertWorkforceIdentityResolver,
  assertWorkforceMutationAuthorizer,
  validateAgentIdentityResolution,
  validateEvidenceIntakeDecision,
  validateEvidenceIntakeRequest,
} from '../../../packages/adapter-sdk/src/workforce-runtime-adapters.js';
import { createHash } from 'node:crypto';
import { snapshotSafePlainData } from '../../../packages/adapter-sdk/src/model-runtime-adapters.js';
import { createTrustedClock } from '../../../packages/contracts/src/trusted-time-v1.js';

const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const SIMULATOR_ENVIRONMENTS = new Set(['dev', 'simulation']);
const MAX_AGENTOPS_WINDOW_EVIDENCE = 20;
const AGENTOPS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Deterministic Alpha AgentOps thresholds. They are observation rules, never
// authority: WATCH/REVIEW cannot change lifecycle, qualification, or execution.
const AGENTOPS_FAIL_WATCH_THRESHOLD = 1;
const AGENTOPS_FAIL_REVIEW_THRESHOLD = 2;
const AGENTOPS_CONCERN_WATCH_THRESHOLD = 3;

const AUTHORIZED_MUTATIONS = new Set([
  'workforce.record.create',
  'workforce.lifecycle.change',
  'workforce.role.change',
  'workforce.qualification.create',
  'workforce.qualification.change',
]);

const INPUT_FIELDS = new Map([
  ['workforce.record.create', new Set(['agent_id', 'lifecycle_status', 'role_ref', 'department_ref', 'operation_id', 'authorization_ref'])],
  ['workforce.lifecycle.change', new Set(['agent_id', 'lifecycle_status', 'expected_revision', 'operation_id', 'authorization_ref'])],
  ['workforce.role.change', new Set(['agent_id', 'role_ref', 'department_ref', 'expected_revision', 'operation_id', 'authorization_ref'])],
  ['workforce.qualification.create', new Set(['qualification_id', 'agent_id', 'capability', 'qualification_status', 'source_ref', 'effective_at', 'expires_at', 'operation_id', 'authorization_ref'])],
  ['workforce.qualification.change', new Set(['qualification_id', 'expected_revision', 'qualification_status', 'expires_at', 'operation_id', 'authorization_ref'])],
  ['workforce.evidence.record', new Set(['evidence_id', 'agent_id', 'subject_ref', 'dimension', 'observation', 'source_ref', 'attribution_ref', 'self_report', 'operation_id'])],
  ['workforce.attribution.record', new Set(['attribution_id', 'agent_id', 'subject_ref', 'source_ref', 'primary_cause', 'contributing_causes', 'confidence', 'supporting_evidence_refs', 'related_incident_ref', 'operation_id'])],
  ['workforce.agentops.evaluate', new Set(['evaluation_id', 'agent_id', 'operation_id'])],
  ['workforce.facts.read', new Set(['agent_id', 'capability'])],
]);

// Causes that never silently count as employee-fault evidence. MIXED stays
// visible because it may legitimately include employee contribution.
const NON_EMPLOYEE_CAUSES = new Set([
  'RUNTIME_MODEL', 'CONTEXT_PACKAGE', 'TOOL', 'DEPENDENCY', 'POLICY_AUTHORIZATION',
  'INFRASTRUCTURE', 'EXTERNAL_PROVIDER', 'PROCESS_WORKFLOW',
]);

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const IDENTIFIER_MAX = 160;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Fail-closed snapshot: non-cloneable caller debris becomes bounded markers
// instead of throwing across the service boundary.
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

function hasOnlyInputFields(value, action) {
  const fields = INPUT_FIELDS.get(action);
  return isRecord(value) && fields !== undefined && Object.keys(value).every((key) => fields.has(key));
}

function boundedId(value, fallback = null) {
  if (typeof value !== 'string' || value.length === 0 || value.length > IDENTIFIER_MAX || !IDENTIFIER.test(value)) {
    return fallback;
  }
  return value;
}

function requireDependencies({ environment, store, evidence, ids, clock, authorizer, identityResolver, evidenceIntake }) {
  if (!ENVIRONMENTS.has(environment)) throw new TypeError('Workforce service requires a canonical environment');
  if (!store || typeof store.put !== 'function' || typeof store.get !== 'function'
    || typeof store.list !== 'function' || typeof store.history !== 'function'
    || typeof store.readOperation !== 'function' || typeof store.qualificationFor !== 'function'
    || typeof store.latestEvaluationFor !== 'function' || typeof store.latestEvaluationsForSummary !== 'function'
    || typeof store.workforceRecordsForSummary !== 'function' || typeof store.recordFor !== 'function') {
    throw new TypeError('Workforce service requires a workforce store');
  }
  if (!evidence || typeof evidence.append !== 'function') throw new TypeError('Workforce service requires evidence');
  const idMethods = ['nextEventId', 'nextSpanId', 'nextTraceId'];
  if (!ids || idMethods.some((method) => typeof ids[method] !== 'function')) {
    throw new TypeError('Workforce service requires event, span, and trace ID sources');
  }
  if (typeof clock !== 'function') throw new TypeError('Workforce service requires a clock');
  assertWorkforceMutationAuthorizer(authorizer);
  assertWorkforceIdentityResolver(identityResolver);
  assertWorkforceEvidenceIntake(evidenceIntake);
  if ([store, authorizer, identityResolver, evidenceIntake]
    .some((dependency) => dependency.source === 'simulator')
    && !SIMULATOR_ENVIRONMENTS.has(environment)) {
    throw new RangeError('Simulator Workforce adapters may run only in dev or simulation');
  }
}

export class WorkforceService {
  #authorizer;
  #clock;
  #environment;
  #evidence;
  #evidenceIntake;
  #ids;
  #identityResolver;
  #store;

  constructor({ environment, store, evidence, ids, clock, authorizer, identityResolver, evidenceIntake }) {
    requireDependencies({ environment, store, evidence, ids, clock, authorizer, identityResolver, evidenceIntake });
    this.#environment = environment;
    this.#store = store;
    this.#evidence = evidence;
    this.#ids = ids;
    this.#authorizer = authorizer;
    this.#identityResolver = identityResolver;
    this.#evidenceIntake = evidenceIntake;
    // Trusted Time: qualification expiry is monotonic, so a wall-clock rollback
    // cannot revive an expired capability qualification.
    this.#clock = createTrustedClock({ source: clock }).now;
  }

  get environment() {
    return this.#environment;
  }

  // Declared dependency provenance, mirroring the constructor restriction.
  // Organizational State rejects a simulator seam outside dev/simulation so a
  // simulator-backed Workforce projection cannot be evaluated as production.
  get source() {
    return [this.#store, this.#authorizer, this.#identityResolver, this.#evidenceIntake]
      .some((dependency) => dependency?.source === 'simulator') ? 'simulator' : 'live';
  }

  #append({ eventName, attributes = {}, outcome = 'success', severity = 'info' }) {
    const traceId = this.#ids.nextTraceId();
    this.#evidence.append({
      traceId,
      spanId: this.#ids.nextSpanId(),
      parentSpanId: null,
      serviceName: 'pixel.workforce',
      eventName,
      outcome,
      severity,
      attributes,
    });
    return traceId;
  }

  #provenance() {
    return { workforce_contract: WORKFORCE_CONTRACT };
  }

  #operationFingerprint(action, args) {
    return createHash('sha256')
      .update(JSON.stringify([action, safeSnapshot(args)]))
      .digest('hex');
  }

  #recorded(kind, eventName, record, { replayed = false } = {}) {
    const traceId = this.#append({
      eventName,
      attributes: {
        'pixel.workforce.kind': kind,
        'pixel.workforce.revision': Number.isSafeInteger(record?.revision) ? record.revision : 1,
        'pixel.workforce.agent_id': boundedId(record?.agent_id, 'unknown.agent'),
      },
    });
    return frozenCopy({ disposition: 'RECORDED', replayed, record, trace_id: traceId });
  }

  #refused(kind, reasonCode, record = null, agentId = null) {
    const traceId = this.#append({
      eventName: 'workforce.refused',
      outcome: 'denied',
      severity: 'warning',
      attributes: {
        'pixel.workforce.kind': kind,
        'pixel.workforce.agent_id': boundedId(agentId, 'unknown.agent'),
        'pixel.workforce.reason_code': reasonCode,
      },
    });
    return frozenCopy({ disposition: 'REJECTED', reason_code: reasonCode, record, trace_id: traceId });
  }

  #replayOperation({ kind, eventName, operationId, fingerprint, agentId = null }) {
    if (boundedId(operationId) === null) return this.#refused(kind, 'OPERATION_INVALID', null, agentId);
    let prior;
    try {
      prior = this.#store.readOperation(operationId, fingerprint);
    } catch {
      return this.#refused(kind, 'RECONCILIATION_REQUIRED', null, agentId);
    }
    if (prior === null) return null;
    if (prior.disposition === 'OP_REPLAY') {
      return this.#recorded(kind, eventName, prior.record, { replayed: true });
    }
    return this.#refused(kind, 'OP_CONFLICT', null, agentId);
  }

  // Server-side mutation authority. A caller-supplied authorization string is
  // provenance only: the injected server authorizer decides, and a denied,
  // malformed, or unavailable decision prevents the mutation entirely.
  #authorize(action, { resourceRef, agentId, proposed }) {
    try {
      if (!AUTHORIZED_MUTATIONS.has(action)) return null;
      const decision = snapshotSafePlainData(this.#authorizer.authorize({
        action,
        resource_ref: boundedId(resourceRef) ?? null,
        agent_id: boundedId(agentId) ?? null,
        // Optional fields may be absent (undefined); the bounded proposal
        // snapshot must never throw and must never leak caller debris.
        proposed: frozenCopy(proposed),
      }));
      if (!isRecord(decision) || decision.allowed !== true
        || Object.keys(decision).some((key) => !['allowed', 'authorization_ref'].includes(key))) return null;
      return boundedId(decision.authorization_ref);
    } catch {
      return null;
    }
  }

  #validated(kind, record, assertValidator) {
    try {
      assertValidator(record);
      return null;
    } catch {
      return this.#refused(kind, 'WORKFORCE_INVALID', record, record?.agent_id ?? null);
    }
  }

  // Idempotent atomic commit with read-back reconciliation, matching PX-007.
  // The store commits or refuses; an AMBIGUOUS outcome reads back the operation
  // and only retries the SAME operation id when the expected revision is
  // unchanged. Exact replay never creates a second historical revision.
  #commit({
    kind, record, idField, operationId, operationFingerprint, expectedRevision,
    historyEntry = null, eventName, assertValidator, action = eventName,
    authorizationRef = null, priorState = null, newState = null,
  }) {
    const refused = this.#validated(kind, record, assertValidator);
    if (refused) return refused;
    const id = record[idField];
    // Evidence availability is a prerequisite for a persistent mutation.
    this.#append({
      eventName: 'workforce.mutation.authorized',
      attributes: {
        'pixel.workforce.kind': kind,
        'pixel.workforce.action': action,
        'pixel.workforce.operation_id': operationId,
        'pixel.workforce.agent_id': boundedId(record?.agent_id, 'unknown.agent'),
        'pixel.workforce.revision': Number.isSafeInteger(record?.revision) ? record.revision : 1,
        ...(authorizationRef === null ? {} : { 'pixel.workforce.authorization_ref': authorizationRef }),
        ...(priorState === null ? {} : { 'pixel.workforce.prior_state': priorState }),
        ...(newState === null ? {} : { 'pixel.workforce.new_state': newState }),
      },
    });
    const attempt = () => this.#store.put(kind, frozenCopy(record), {
      expectedRevision, operationId, operationFingerprint, historyEntry,
    });
    let result = attempt();
    if (result.disposition === 'AMBIGUOUS') {
      const read = this.#store.readOperation(operationId);
      if (read) return this.#recorded(kind, eventName, read, { replayed: true });
      const current = this.#store.get(kind, id);
      const revisionUnchanged = expectedRevision === null
        ? !current
        : (current?.revision ?? null) === expectedRevision;
      if (!revisionUnchanged) return this.#refused(kind, 'RECONCILIATION_REQUIRED', current, record.agent_id);
      result = attempt();
      if (result.disposition === 'AMBIGUOUS') {
        const reread = this.#store.readOperation(operationId);
        if (reread) return this.#recorded(kind, eventName, reread, { replayed: true });
        return this.#refused(kind, 'RECONCILIATION_REQUIRED', this.#store.get(kind, id), record.agent_id);
      }
    }
    if (result.disposition === 'OP_REPLAY') {
      return this.#recorded(kind, eventName, result.record, { replayed: true });
    }
    if (result.disposition === 'CREATED' || result.disposition === 'UPDATED') {
      return this.#recorded(kind, eventName, result.record, { replayed: false });
    }
    if (result.disposition === 'STALE_REVISION') {
      return this.#refused(kind, 'STALE_REVISION', result.record, record.agent_id);
    }
    if (result.disposition === 'OP_CONFLICT') {
      return this.#refused(kind, 'OP_CONFLICT', result.record, record.agent_id);
    }
    return this.#refused(kind, result.reason_code ?? 'WORKFORCE_INVALID', result.record, record.agent_id);
  }

  #resolveIdentity(agentId) {
    try {
      const resolution = snapshotSafePlainData(this.#identityResolver.resolveAgentIdentity(agentId));
      if (!validateAgentIdentityResolution(resolution).ok) return null;
      if (resolution.agent_id !== agentId) return null;
      return resolution;
    } catch {
      return null;
    }
  }

  // Aggregate display facts only. WATCH/REVIEW never imply Access revocation.
  // The owning store supplies both bounded reads, so the record bucket bound and
  // the append-only evaluation history never materialize on the overview path.
  homeSummary() {
    const records = this.#store.workforceRecordsForSummary(1_000_000);
    if (!Array.isArray(records) || records.length > 1_000_000) throw new RangeError('PROJECTION_BOUND_EXCEEDED');
    const evaluations = this.#store.latestEvaluationsForSummary(1_000_000);
    if (!Array.isArray(evaluations) || evaluations.length > 1_000_000) throw new RangeError('PROJECTION_BOUND_EXCEEDED');
    const latestByAgent = new Map();
    for (const evaluation of evaluations) {
      assertValidAgentOpsEvaluationV1(evaluation);
      if (latestByAgent.has(evaluation.agent_id)) throw new RangeError('PROJECTION_BOUND_EXCEEDED');
      latestByAgent.set(evaluation.agent_id, evaluation);
    }
    // Canonical aggregate/public-safe summary. There is no QUARANTINED
    // lifecycle status; LIMITED and RETRAINING are the canonical statuses that
    // restrict ordinary autonomous capacity, counted here as `restricted`.
    const result = { total: records.length, active: 0, restricted: 0, watch: 0, review: 0 };
    for (const record of records) {
      assertValidWorkforceRecordV1(record);
      if (record.lifecycle_status === 'ACTIVE') result.active += 1;
      if (record.lifecycle_status === 'LIMITED' || record.lifecycle_status === 'RETRAINING') result.restricted += 1;
      const evaluation = latestByAgent.get(record.agent_id) ?? null;
      if (evaluation !== null) {
        if (evaluation.evaluation_state === 'WATCH') result.watch += 1;
        if (evaluation.evaluation_state === 'REVIEW') result.review += 1;
      }
    }
    return frozenCopy(result);
  }

  getRecord(agentId) {
    return this.#store.recordFor(boundedId(agentId) ?? '');
  }

  getQualification(agentId, capability) {
    return this.#store.qualificationFor(boundedId(agentId) ?? '', boundedId(capability) ?? '');
  }

  listEvidence(agentId = null) {
    const records = this.#store.list('workforce-evidence');
    return agentId === null ? records : records.filter((record) => record.agent_id === agentId);
  }

  listAttributions(agentId = null) {
    const records = this.#store.list('workforce-attribution');
    return agentId === null ? records : records.filter((record) => record.agent_id === agentId);
  }

  latestEvaluation(agentId) {
    return this.#store.latestEvaluationFor(boundedId(agentId) ?? '');
  }

  historyFor(kind, id) {
    return ['workforce-record', 'qualification'].includes(kind)
      ? this.#store.history(kind, boundedId(id) ?? '') : [];
  }

  // Create the Workforce projection for an EXISTING canonical identity.
  // PX-009 never mints identities: an unresolved agent_id fails closed.
  createWorkforceRecord(input = {}) {
    let args;
    try {
      if (!hasOnlyInputFields(input, 'workforce.record.create')) return this.#refused('workforce-record', 'WORKFORCE_INVALID');
      args = {
        agent_id: input.agent_id,
        lifecycle_status: input.lifecycle_status,
        role_ref: input.role_ref ?? null,
        department_ref: input.department_ref ?? null,
        operation_id: input.operation_id,
        authorization_ref: input.authorization_ref ?? null,
      };
    } catch {
      return this.#refused('workforce-record', 'WORKFORCE_INVALID');
    }
    const operationFingerprint = this.#operationFingerprint('workforce.record.create', args);
    const replay = this.#replayOperation({
      kind: 'workforce-record', eventName: 'workforce.record.created',
      operationId: args.operation_id, fingerprint: operationFingerprint, agentId: boundedId(args.agent_id),
    });
    if (replay) return replay;
    const agentId = boundedId(args.agent_id);
    if (agentId === null || !LIFECYCLE_STATUSES.includes(args.lifecycle_status)) {
      return this.#refused('workforce-record', 'WORKFORCE_INVALID', null, agentId);
    }
    const resolution = this.#resolveIdentity(agentId);
    if (resolution === null) return this.#refused('workforce-record', 'IDENTITY_UNRESOLVED', null, agentId);
    const authorizationRef = this.#authorize('workforce.record.create', {
      resourceRef: agentId, agentId, proposed: args,
    });
    if (authorizationRef === null) return this.#refused('workforce-record', 'MUTATION_AUTHORIZATION_DENIED', null, agentId);
    const now = this.#clock();
    const record = {
      agent_id: agentId,
      event_name: WORKFORCE_RECORD_EVENT_NAME,
      schema_version: WORKFORCE_SCHEMA_VERSION,
      lifecycle_status: args.lifecycle_status,
      role_ref: args.role_ref ?? resolution.role_ref,
      department_ref: args.department_ref ?? resolution.department_ref,
      effective_at: now,
      revision: 1,
      updated_at: now,
      history: [],
      provenance: this.#provenance(),
    };
    return this.#commit({
      kind: 'workforce-record', record, idField: 'agent_id',
      operationId: args.operation_id, operationFingerprint, expectedRevision: null,
      eventName: 'workforce.record.created', assertValidator: assertValidWorkforceRecordV1,
      action: 'workforce.record.create', authorizationRef, newState: args.lifecycle_status,
    });
  }

  changeLifecycle(input = {}) {
    let args;
    try {
      if (!hasOnlyInputFields(input, 'workforce.lifecycle.change')) return this.#refused('workforce-record', 'WORKFORCE_INVALID');
      args = {
        agent_id: input.agent_id,
        lifecycle_status: input.lifecycle_status,
        expected_revision: input.expected_revision,
        operation_id: input.operation_id,
        authorization_ref: input.authorization_ref ?? null,
      };
    } catch {
      return this.#refused('workforce-record', 'WORKFORCE_INVALID');
    }
    const operationFingerprint = this.#operationFingerprint('workforce.lifecycle.change', args);
    const replay = this.#replayOperation({
      kind: 'workforce-record', eventName: 'workforce.lifecycle.changed',
      operationId: args.operation_id, fingerprint: operationFingerprint, agentId: boundedId(args.agent_id),
    });
    if (replay) return replay;
    const agentId = boundedId(args.agent_id);
    const current = agentId === null ? null : this.#store.recordFor(agentId);
    if (!current) return this.#refused('workforce-record', 'NOT_FOUND', null, agentId);
    if (!Number.isSafeInteger(args.expected_revision) || current.revision !== args.expected_revision) {
      return this.#refused('workforce-record', 'STALE_REVISION', current, agentId);
    }
    if (!LIFECYCLE_STATUSES.includes(args.lifecycle_status)) {
      return this.#refused('workforce-record', 'WORKFORCE_INVALID', current, agentId);
    }
    // A transition to the current state is a no-op conflict: it must not create
    // a new historical revision.
    if (args.lifecycle_status === current.lifecycle_status) {
      return this.#refused('workforce-record', 'NO_OP_TRANSITION', current, agentId);
    }
    if (!lifecycleTransitionAllowed(current.lifecycle_status, args.lifecycle_status)) {
      return this.#refused('workforce-record', 'TRANSITION_NOT_ALLOWED', current, agentId);
    }
    const authorizationRef = this.#authorize('workforce.lifecycle.change', {
      resourceRef: agentId, agentId, proposed: { ...args, from: current.lifecycle_status },
    });
    if (authorizationRef === null) return this.#refused('workforce-record', 'MUTATION_AUTHORIZATION_DENIED', current, agentId);
    const now = this.#clock();
    const historyEntry = {
      lifecycle_status: current.lifecycle_status,
      role_ref: current.role_ref,
      department_ref: current.department_ref,
      effective_at: current.effective_at,
      revision: current.revision,
    };
    const record = {
      ...current,
      lifecycle_status: args.lifecycle_status,
      effective_at: now,
      updated_at: now,
      revision: current.revision + 1,
      // The contract bound applies to the embedded superseded view; every
      // entry remains in the store's separate immutable history collection.
      history: [...current.history, historyEntry].slice(-MAX_TRANSITIONS),
    };
    return this.#commit({
      kind: 'workforce-record', record, idField: 'agent_id', operationId: args.operation_id,
      operationFingerprint, expectedRevision: args.expected_revision, historyEntry,
      eventName: 'workforce.lifecycle.changed', assertValidator: assertValidWorkforceRecordV1,
      action: 'workforce.lifecycle.change', authorizationRef,
      priorState: current.lifecycle_status, newState: args.lifecycle_status,
    });
  }

  changeRole(input = {}) {
    let args;
    try {
      if (!hasOnlyInputFields(input, 'workforce.role.change')) return this.#refused('workforce-record', 'WORKFORCE_INVALID');
      args = {
        agent_id: input.agent_id,
        role_ref: input.role_ref,
        department_ref: input.department_ref,
        expected_revision: input.expected_revision,
        operation_id: input.operation_id,
        authorization_ref: input.authorization_ref ?? null,
      };
    } catch {
      return this.#refused('workforce-record', 'WORKFORCE_INVALID');
    }
    const operationFingerprint = this.#operationFingerprint('workforce.role.change', args);
    const replay = this.#replayOperation({
      kind: 'workforce-record', eventName: 'workforce.role.changed',
      operationId: args.operation_id, fingerprint: operationFingerprint, agentId: boundedId(args.agent_id),
    });
    if (replay) return replay;
    const agentId = boundedId(args.agent_id);
    const current = agentId === null ? null : this.#store.recordFor(agentId);
    if (!current) return this.#refused('workforce-record', 'NOT_FOUND', null, agentId);
    if (!Number.isSafeInteger(args.expected_revision) || current.revision !== args.expected_revision) {
      return this.#refused('workforce-record', 'STALE_REVISION', current, agentId);
    }
    if (args.role_ref === undefined && args.department_ref === undefined) {
      return this.#refused('workforce-record', 'WORKFORCE_INVALID', current, agentId);
    }
    // A proposed value equal to current truth is a no-op: it must not create a
    // new historical revision (parity with lifecycle/qualification changes).
    if ((args.role_ref ?? current.role_ref) === current.role_ref
      && (args.department_ref ?? current.department_ref) === current.department_ref) {
      return this.#refused('workforce-record', 'NO_OP_TRANSITION', current, agentId);
    }
    const authorizationRef = this.#authorize('workforce.role.change', {
      resourceRef: agentId, agentId, proposed: args,
    });
    if (authorizationRef === null) return this.#refused('workforce-record', 'MUTATION_AUTHORIZATION_DENIED', current, agentId);
    const now = this.#clock();
    const historyEntry = {
      lifecycle_status: current.lifecycle_status,
      role_ref: current.role_ref,
      department_ref: current.department_ref,
      effective_at: current.effective_at,
      revision: current.revision,
    };
    const record = {
      ...current,
      role_ref: args.role_ref ?? current.role_ref,
      department_ref: args.department_ref ?? current.department_ref,
      effective_at: now,
      updated_at: now,
      revision: current.revision + 1,
      history: [...current.history, historyEntry].slice(-MAX_TRANSITIONS),
    };
    return this.#commit({
      kind: 'workforce-record', record, idField: 'agent_id', operationId: args.operation_id,
      operationFingerprint, expectedRevision: args.expected_revision, historyEntry,
      eventName: 'workforce.role.changed', assertValidator: assertValidWorkforceRecordV1,
      action: 'workforce.role.change', authorizationRef,
    });
  }

  createQualification(input = {}) {
    let args;
    try {
      if (!hasOnlyInputFields(input, 'workforce.qualification.create')) return this.#refused('qualification', 'WORKFORCE_INVALID');
      args = {
        qualification_id: input.qualification_id,
        agent_id: input.agent_id,
        capability: input.capability,
        qualification_status: input.qualification_status,
        source_ref: input.source_ref,
        effective_at: input.effective_at ?? null,
        expires_at: input.expires_at ?? null,
        operation_id: input.operation_id,
        authorization_ref: input.authorization_ref ?? null,
      };
    } catch {
      return this.#refused('qualification', 'WORKFORCE_INVALID');
    }
    const operationFingerprint = this.#operationFingerprint('workforce.qualification.create', args);
    const replay = this.#replayOperation({
      kind: 'qualification', eventName: 'workforce.qualification.created',
      operationId: args.operation_id, fingerprint: operationFingerprint, agentId: boundedId(args.agent_id),
    });
    if (replay) return replay;
    const agentId = boundedId(args.agent_id);
    const capability = boundedId(args.capability);
    if (agentId === null || capability === null) return this.#refused('qualification', 'WORKFORCE_INVALID', null, agentId);
    if (!this.#store.recordFor(agentId)) return this.#refused('qualification', 'NOT_FOUND', null, agentId);
    const authorizationRef = this.#authorize('workforce.qualification.create', {
      resourceRef: args.qualification_id, agentId, proposed: args,
    });
    if (authorizationRef === null) return this.#refused('qualification', 'MUTATION_AUTHORIZATION_DENIED', null, agentId);
    const now = this.#clock();
    const record = {
      qualification_id: args.qualification_id,
      event_name: CAPABILITY_QUALIFICATION_EVENT_NAME,
      schema_version: WORKFORCE_SCHEMA_VERSION,
      agent_id: agentId,
      capability,
      qualification_status: args.qualification_status,
      source_ref: args.source_ref,
      effective_at: args.effective_at ?? now,
      expires_at: args.expires_at,
      revision: 1,
      updated_at: now,
      authorization_ref: authorizationRef,
      provenance: this.#provenance(),
    };
    return this.#commit({
      kind: 'qualification', record, idField: 'qualification_id',
      operationId: args.operation_id, operationFingerprint, expectedRevision: null,
      eventName: 'workforce.qualification.created', assertValidator: assertValidCapabilityQualificationV1,
      action: 'workforce.qualification.create', authorizationRef, newState: args.qualification_status,
    });
  }

  changeQualification(input = {}) {
    let args;
    try {
      if (!hasOnlyInputFields(input, 'workforce.qualification.change')) return this.#refused('qualification', 'WORKFORCE_INVALID');
      args = {
        qualification_id: input.qualification_id,
        expected_revision: input.expected_revision,
        qualification_status: input.qualification_status ?? null,
        expires_at: input.expires_at,
        operation_id: input.operation_id,
        authorization_ref: input.authorization_ref ?? null,
      };
    } catch {
      return this.#refused('qualification', 'WORKFORCE_INVALID');
    }
    const operationFingerprint = this.#operationFingerprint('workforce.qualification.change', args);
    const replay = this.#replayOperation({
      kind: 'qualification', eventName: 'workforce.qualification.changed',
      operationId: args.operation_id, fingerprint: operationFingerprint,
    });
    if (replay) return replay;
    const qualificationId = boundedId(args.qualification_id);
    const current = qualificationId === null ? null : this.#store.get('qualification', qualificationId);
    if (!current) return this.#refused('qualification', 'NOT_FOUND', null, null);
    if (!Number.isSafeInteger(args.expected_revision) || current.revision !== args.expected_revision) {
      return this.#refused('qualification', 'STALE_REVISION', current, current.agent_id);
    }
    if (args.qualification_status === null && args.expires_at === undefined) {
      return this.#refused('qualification', 'WORKFORCE_INVALID', current, current.agent_id);
    }
    if (args.qualification_status === current.qualification_status && args.expires_at === undefined) {
      return this.#refused('qualification', 'NO_OP_TRANSITION', current, current.agent_id);
    }
    const authorizationRef = this.#authorize('workforce.qualification.change', {
      resourceRef: qualificationId, agentId: current.agent_id, proposed: args,
    });
    if (authorizationRef === null) return this.#refused('qualification', 'MUTATION_AUTHORIZATION_DENIED', current, current.agent_id);
    const now = this.#clock();
    const historyEntry = {
      qualification_status: current.qualification_status,
      source_ref: current.source_ref,
      effective_at: current.effective_at,
      expires_at: current.expires_at,
      revision: current.revision,
    };
    const record = {
      ...current,
      qualification_status: args.qualification_status ?? current.qualification_status,
      expires_at: args.expires_at === undefined ? current.expires_at : args.expires_at,
      updated_at: now,
      revision: current.revision + 1,
      authorization_ref: authorizationRef,
    };
    return this.#commit({
      kind: 'qualification', record, idField: 'qualification_id', operationId: args.operation_id,
      operationFingerprint, expectedRevision: args.expected_revision, historyEntry,
      eventName: 'workforce.qualification.changed', assertValidator: assertValidCapabilityQualificationV1,
      action: 'workforce.qualification.change', authorizationRef,
      priorState: current.qualification_status,
      newState: args.qualification_status ?? current.qualification_status,
    });
  }

  // Authoritative workforce evidence intake. The server-owned intake seam must
  // authenticate the exact source; otherwise no authoritative record exists.
  // Self-report may be stored only as explicitly non-authoritative context.
  recordEvidence(input = {}) {
    let args;
    try {
      if (!hasOnlyInputFields(input, 'workforce.evidence.record')) return this.#refused('workforce-evidence', 'WORKFORCE_INVALID');
      args = {
        evidence_id: input.evidence_id,
        agent_id: input.agent_id,
        subject_ref: input.subject_ref ?? null,
        dimension: input.dimension,
        observation: input.observation,
        source_ref: input.source_ref,
        attribution_ref: input.attribution_ref ?? null,
        self_report: input.self_report === true,
        operation_id: input.operation_id,
      };
    } catch {
      return this.#refused('workforce-evidence', 'WORKFORCE_INVALID');
    }
    const operationFingerprint = this.#operationFingerprint('workforce.evidence.record', args);
    const replay = this.#replayOperation({
      kind: 'workforce-evidence', eventName: 'workforce.evidence.recorded',
      operationId: args.operation_id, fingerprint: operationFingerprint, agentId: boundedId(args.agent_id),
    });
    if (replay) return replay;
    const agentId = boundedId(args.agent_id);
    if (agentId === null || !this.#store.recordFor(agentId)) {
      return this.#refused('workforce-evidence', 'NOT_FOUND', null, agentId);
    }
    const request = {
      source_ref: args.source_ref,
      subject_ref: args.subject_ref ?? args.evidence_id,
      agent_id: agentId,
      evidence_type: args.dimension,
      observed_result: args.observation,
      related_refs: args.attribution_ref === null ? [] : [args.attribution_ref],
    };
    if (!validateEvidenceIntakeRequest(request).ok) {
      return this.#refused('workforce-evidence', 'EVIDENCE_INVALID', null, agentId);
    }
    let decision;
    try {
      decision = snapshotSafePlainData(this.#evidenceIntake.authorizeEvidence(frozenCopy(request)));
    } catch {
      return this.#refused('workforce-evidence', 'EVIDENCE_AUTHORITY_UNAVAILABLE', null, agentId);
    }
    if (!validateEvidenceIntakeDecision(decision, request).ok) {
      return this.#refused('workforce-evidence', 'EVIDENCE_NOT_AUTHENTICATED', null, agentId);
    }
    // Self-report is never authoritative, and a self-report FAIL can never
    // independently support employee blame.
    const authority = args.self_report === true || decision.authority === 'SELF_REPORT' ? 'SELF_REPORT' : 'AUTHENTICATED';
    if (authority === 'SELF_REPORT' && args.observation === 'FAIL') {
      return this.#refused('workforce-evidence', 'SELF_REPORT_NOT_AUTHORITATIVE', null, agentId);
    }
    if (authority === 'AUTHENTICATED' && args.attribution_ref !== null) {
      const attribution = this.#store.get('workforce-attribution', args.attribution_ref);
      if (!attribution) return this.#refused('workforce-evidence', 'ATTRIBUTION_NOT_FOUND', null, agentId);
      if (attribution.agent_id !== agentId || attribution.subject_ref !== request.subject_ref) {
        return this.#refused('workforce-evidence', 'ATTRIBUTION_MISMATCH', null, agentId);
      }
    }
    const now = this.#clock();
    const record = {
      evidence_id: args.evidence_id,
      event_name: WORKFORCE_EVIDENCE_EVENT_NAME,
      schema_version: WORKFORCE_SCHEMA_VERSION,
      agent_id: agentId,
      subject_ref: request.subject_ref,
      dimension: args.dimension,
      observation: args.observation,
      source_ref: args.source_ref,
      attribution_ref: args.attribution_ref,
      authority,
      observed_at: now,
      provenance: this.#provenance(),
    };
    return this.#commit({
      kind: 'workforce-evidence', record, idField: 'evidence_id',
      operationId: args.operation_id, operationFingerprint, expectedRevision: null,
      eventName: 'workforce.evidence.recorded', assertValidator: assertValidWorkforceEvidenceV1,
    });
  }

  // Causal attribution. Every attribution references canonical supporting
  // evidence, and an EMPLOYEE attribution requires at least one independently
  // authenticated, non-self-report source.
  recordAttribution(input = {}) {
    let args;
    try {
      if (!hasOnlyInputFields(input, 'workforce.attribution.record')) return this.#refused('workforce-attribution', 'WORKFORCE_INVALID');
      args = {
        attribution_id: input.attribution_id,
        agent_id: input.agent_id,
        subject_ref: input.subject_ref,
        source_ref: input.source_ref,
        primary_cause: input.primary_cause,
        contributing_causes: input.contributing_causes ?? [],
        confidence: input.confidence,
        supporting_evidence_refs: input.supporting_evidence_refs ?? [],
        related_incident_ref: input.related_incident_ref ?? null,
        operation_id: input.operation_id,
      };
    } catch {
      return this.#refused('workforce-attribution', 'WORKFORCE_INVALID');
    }
    const operationFingerprint = this.#operationFingerprint('workforce.attribution.record', args);
    const replay = this.#replayOperation({
      kind: 'workforce-attribution', eventName: 'workforce.attribution.recorded',
      operationId: args.operation_id, fingerprint: operationFingerprint, agentId: boundedId(args.agent_id),
    });
    if (replay) return replay;
    const agentId = boundedId(args.agent_id);
    if (agentId === null || !this.#store.recordFor(agentId)) {
      return this.#refused('workforce-attribution', 'NOT_FOUND', null, agentId);
    }
    const evidence = Array.isArray(args.supporting_evidence_refs)
      ? args.supporting_evidence_refs.map((ref) => this.#store.get('workforce-evidence', boundedId(ref) ?? ''))
      : [];
    if (evidence.length === 0 || evidence.some((record) => record === null)) {
      return this.#refused('workforce-attribution', 'EVIDENCE_NOT_FOUND', null, agentId);
    }
    if (evidence.some((record) => record.agent_id !== agentId || record.subject_ref !== args.subject_ref)) {
      return this.#refused('workforce-attribution', 'EVIDENCE_MISMATCH', null, agentId);
    }
    // EMPLOYEE blame requires at least one AUTHENTICATED source; self-report
    // alone can never establish employee fault.
    if (args.primary_cause === 'EMPLOYEE' && !evidence.some((record) => record.authority === 'AUTHENTICATED')) {
      return this.#refused('workforce-attribution', 'EMPLOYEE_ATTRIBUTION_UNSUBSTANTIATED', null, agentId);
    }
    const request = {
      source_ref: args.source_ref,
      subject_ref: args.subject_ref,
      agent_id: agentId,
      evidence_type: 'CAUSAL_ATTRIBUTION',
      observed_result: args.primary_cause,
      related_refs: [
        ...args.supporting_evidence_refs,
        ...(args.related_incident_ref === null ? [] : [args.related_incident_ref]),
      ],
    };
    if (!validateEvidenceIntakeRequest(request).ok) {
      return this.#refused('workforce-attribution', 'EVIDENCE_INVALID', null, agentId);
    }
    let decision;
    try {
      decision = snapshotSafePlainData(this.#evidenceIntake.authorizeEvidence(frozenCopy(request)));
    } catch {
      return this.#refused('workforce-attribution', 'EVIDENCE_AUTHORITY_UNAVAILABLE', null, agentId);
    }
    if (!validateEvidenceIntakeDecision(decision, request).ok || decision.authority !== 'AUTHENTICATED') {
      return this.#refused('workforce-attribution', 'EVIDENCE_NOT_AUTHENTICATED', null, agentId);
    }
    const now = this.#clock();
    const record = {
      attribution_id: args.attribution_id,
      event_name: WORKFORCE_ATTRIBUTION_EVENT_NAME,
      schema_version: WORKFORCE_SCHEMA_VERSION,
      agent_id: agentId,
      subject_ref: args.subject_ref,
      source_ref: args.source_ref,
      primary_cause: args.primary_cause,
      contributing_causes: frozenCopy(args.contributing_causes),
      confidence: args.confidence,
      supporting_evidence_refs: frozenCopy(args.supporting_evidence_refs),
      related_incident_ref: args.related_incident_ref,
      observed_at: now,
      provenance: this.#provenance(),
    };
    return this.#commit({
      kind: 'workforce-attribution', record, idField: 'attribution_id',
      operationId: args.operation_id, operationFingerprint, expectedRevision: null,
      eventName: 'workforce.attribution.recorded', assertValidator: assertValidWorkforceAttributionV1,
    });
  }

  // Deterministic bounded AgentOps projection. It only reads canonical
  // evidence: it never mutates lifecycle/qualification, never grants or denies
  // execution, and never selects a runtime.
  evaluateAgentOps(input = {}) {
    let args;
    try {
      if (!hasOnlyInputFields(input, 'workforce.agentops.evaluate')) return this.#refused('agentops-evaluation', 'WORKFORCE_INVALID');
      args = {
        evaluation_id: input.evaluation_id,
        agent_id: input.agent_id,
        operation_id: input.operation_id,
      };
    } catch {
      return this.#refused('agentops-evaluation', 'WORKFORCE_INVALID');
    }
    const operationFingerprint = this.#operationFingerprint('workforce.agentops.evaluate', args);
    const replay = this.#replayOperation({
      kind: 'agentops-evaluation', eventName: 'workforce.agentops.evaluated',
      operationId: args.operation_id, fingerprint: operationFingerprint, agentId: boundedId(args.agent_id),
    });
    if (replay) return replay;
    const agentId = boundedId(args.agent_id);
    if (agentId === null || !this.#store.recordFor(agentId)) {
      return this.#refused('agentops-evaluation', 'NOT_FOUND', null, agentId);
    }
    const now = this.#clock();
    const windowStart = new Date(Date.parse(now) - AGENTOPS_WINDOW_MS).toISOString();
    const evidence = this.#store.list('workforce-evidence')
      .filter((record) => record.agent_id === agentId
        && Date.parse(record.observed_at) >= Date.parse(windowStart))
      .sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at))
      .slice(0, MAX_AGENTOPS_WINDOW_EVIDENCE);

    const attributions = this.#store.list('workforce-attribution')
      .filter((record) => record.agent_id === agentId);
    const attributionById = new Map(attributions.map((record) => [record.attribution_id, record]));
    // Reverse index: attribution -> supporting evidence. This is the canonical
    // causal link; evidence.attribution_ref is only an optional back-ref.
    const attributionByEvidence = new Map();
    for (const attribution of attributions) {
      for (const evidenceRef of attribution.supporting_evidence_refs) {
        if (!attributionByEvidence.has(evidenceRef)) attributionByEvidence.set(evidenceRef, attribution);
      }
    }

    const employeeEvidence = [];
    const investigationEvidence = [];
    for (const record of evidence) {
      if (record.authority !== 'AUTHENTICATED') continue; // self-report never drives trends
      const attribution = (record.attribution_ref === null ? null : attributionById.get(record.attribution_ref) ?? null)
        ?? attributionByEvidence.get(record.evidence_id) ?? null;
      const cause = attribution?.primary_cause ?? 'UNKNOWN';
      if (NON_EMPLOYEE_CAUSES.has(cause)) continue; // never employee blame
      if (cause === 'UNKNOWN') {
        investigationEvidence.push(record);
        continue;
      }
      employeeEvidence.push(record);
    }

    const failures = employeeEvidence.filter((record) => record.observation === 'FAIL');
    const concerns = employeeEvidence.filter((record) => record.observation === 'CONCERN');
    const policyFailures = evidence.filter((record) => record.authority === 'AUTHENTICATED'
      && record.observation === 'FAIL' && record.dimension === 'POLICY_COMPLIANCE');

    const reasonCodes = new Set();
    const recommendations = new Set();
    let evaluationState = 'NORMAL';
    if (policyFailures.length > 0) {
      // Mandatory policy failures cannot be averaged away by positive signals.
      evaluationState = 'REVIEW';
      reasonCodes.add('POLICY_COMPLIANCE_FAIL');
    }
    if (failures.length >= AGENTOPS_FAIL_REVIEW_THRESHOLD) {
      evaluationState = 'REVIEW';
      reasonCodes.add('REPEATED_FAILURES');
    } else if (failures.length >= AGENTOPS_FAIL_WATCH_THRESHOLD && evaluationState === 'NORMAL') {
      evaluationState = 'WATCH';
      reasonCodes.add('EVIDENCE_FAILURE');
    }
    if (concerns.length >= AGENTOPS_CONCERN_WATCH_THRESHOLD && evaluationState === 'NORMAL') {
      evaluationState = 'WATCH';
      reasonCodes.add('REPEATED_CONCERNS');
    }
    if (investigationEvidence.length > 0 && evaluationState === 'NORMAL') {
      // UNKNOWN attribution may support investigation, never punishment.
      evaluationState = 'WATCH';
      reasonCodes.add('UNKNOWN_ATTRIBUTION');
    }

    if (evaluationState !== 'NORMAL') {
      const causes = new Set([
        ...employeeEvidence
          .filter((record) => ['FAIL', 'CONCERN'].includes(record.observation))
          .map((record) => ((record.attribution_ref === null ? null : attributionById.get(record.attribution_ref)?.primary_cause)
            ?? attributionByEvidence.get(record.evidence_id)?.primary_cause ?? 'MIXED')),
        ...investigationEvidence.map(() => 'UNKNOWN'),
      ]);
      for (const cause of causes) {
        if (cause === 'RUNTIME_MODEL') recommendations.add('REVIEW_RUNTIME');
        if (cause === 'CONTEXT_PACKAGE') recommendations.add('REVIEW_CONTEXT');
        if (cause === 'TOOL') recommendations.add('REVIEW_TOOL');
        if (cause === 'PROCESS_WORKFLOW') recommendations.add('REVIEW_PROCESS');
        if (cause === 'UNKNOWN') recommendations.add('REVIEW_PROCESS');
      }
      if (employeeEvidence.some((record) => ['FAIL', 'CONCERN'].includes(record.observation))) {
        recommendations.add('REQUEST_WORKFORCE_REVIEW');
      }
    }
    if (recommendations.size === 0) recommendations.add('NO_ACTION');

    const revisionToken = createHash('sha256')
      .update(JSON.stringify([agentId, evaluationState, [...reasonCodes].sort(), evidence.map((record) => record.evidence_id)]))
      .digest('hex');
    const record = {
      evaluation_id: args.evaluation_id,
      event_name: AGENTOPS_EVALUATION_EVENT_NAME,
      schema_version: WORKFORCE_SCHEMA_VERSION,
      agent_id: agentId,
      evaluation_state: evaluationState,
      window_start: windowStart,
      window_end: now,
      reason_codes: [...reasonCodes].sort(),
      evidence_refs: evidence.map((record) => record.evidence_id).slice(0, MAX_EVIDENCE_REFS),
      // Same canonical resolution as the trend loop: an attribution that
      // supports evidence through the reverse index is provenance for the
      // evaluation state and must appear here.
      attribution_refs: [...new Set(evidence.map((record) => (
        (record.attribution_ref === null ? null : attributionById.get(record.attribution_ref)?.attribution_id ?? null)
        ?? attributionByEvidence.get(record.evidence_id)?.attribution_id ?? null
      )).filter((ref) => ref !== null))].slice(0, MAX_EVIDENCE_REFS),
      recommendations: [...recommendations].sort(),
      generated_at: now,
      revision_token: revisionToken,
      provenance: this.#provenance(),
    };
    return this.#commit({
      kind: 'agentops-evaluation', record, idField: 'evaluation_id',
      operationId: args.operation_id, operationFingerprint, expectedRevision: null,
      eventName: 'workforce.agentops.evaluated', assertValidator: assertValidAgentOpsEvaluationV1,
    });
  }

  // Bounded server-owned projection consumed by Organizational State. It binds
  // the exact requested capability and returns only canonical facts; it never
  // returns a decision or authority. Null means no workforce record exists.
  workforceFactsFor(input = {}) {
    let args;
    try {
      if (!hasOnlyInputFields(input, 'workforce.facts.read')) return null;
      args = { agent_id: input.agent_id, capability: input.capability };
    } catch {
      return null;
    }
    const agentId = boundedId(args.agent_id);
    const capability = boundedId(args.capability);
    if (agentId === null || capability === null) return null;
    const record = this.#store.recordFor(agentId);
    if (!record) return null;
    const now = this.#clock();
    const qualification = this.#store.qualificationFor(agentId, capability);
    const evaluation = this.#store.latestEvaluationFor(agentId);
    const facts = {
      agent_id: agentId,
      lifecycle_status: record.lifecycle_status,
      qualification_status: qualification === null ? null : derivedQualificationStatus(qualification, now),
      capability,
      evaluation_state: evaluation?.evaluation_state ?? 'NORMAL',
      qualification_expires_at: qualification?.expires_at ?? null,
      observed_at: now,
      revision_token: createHash('sha256')
        .update(JSON.stringify([record.revision, qualification?.revision ?? null, evaluation?.revision_token ?? null]))
        .digest('hex'),
    };
    return validateWorkforceOperatingFactsV1(facts).ok ? frozenCopy(facts) : null;
  }
}
