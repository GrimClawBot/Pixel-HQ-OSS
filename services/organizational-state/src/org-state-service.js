import { snapshotSafePlainData } from '../../../packages/adapter-sdk/src/model-runtime-adapters.js';
import {
  APPROVAL_EVENT_NAME,
  CAPACITY_STATE_EVENT_NAME,
  COMPANY_STATE_EVENT_NAME,
  DELEGATION_EVENT_NAME,
  DUTY_STATE_EVENT_NAME,
  HOLD_EVENT_NAME,
  ORG_STATE_CONTRACT,
  ORG_STATE_SCHEMA_VERSION,
  assertValidApprovalV1,
  assertValidCapacityStateV1,
  assertValidCompanyStateV1,
  assertValidDelegationV1,
  assertValidDutyStateV1,
  assertValidHoldV1,
  derivedCompanyState,
  COMPANY_STATE_PRECEDENCE,
} from '../../../packages/contracts/src/organizational-state-v1.js';
import { createTrustedClock, isExpiredAt } from '../../../packages/contracts/src/trusted-time-v1.js';
import { derivedCompanyStateForIncidents, degradedResourceRefsForIncidents, validateActiveIncidentFactV1 } from '../../../packages/contracts/src/incident-v1.js';
import { validateCalendarOperatingFactsV1 } from '../../../packages/contracts/src/calendar-v1.js';
import {
  GLOBALLY_INELIGIBLE_LIFECYCLE_STATUSES,
  validateWorkforceOperatingFactsV1,
} from '../../../packages/contracts/src/workforce-v1.js';

const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const SIMULATOR_ENVIRONMENTS = new Set(['dev', 'simulation']);
const ENVIRONMENT = 'environment';
const COMPANY_STATE_ID = 'company.state.alpha';
const DECIDABLE = new Set(['REQUESTED', 'PENDING']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Fail-closed snapshot: a value that cannot be cloned (a function, symbol,
// throwing accessor, poison in a nested structure) is replaced by a bounded
// marker instead of throwing across the service boundary. Internal records are
// always plain data, so this only ever substitutes caller-supplied debris.
function safeSnapshot(value, depth = 0) {
  if (depth > 24) return '[depth-exceeded]';
  const kind = typeof value;
  if (value === null || kind === 'string' || kind === 'boolean') return value;
  if (kind === 'number') return Number.isFinite(value) ? value : '[non-finite]';
  if (kind === 'bigint') return value.toString();
  if (kind === 'function' || kind === 'symbol' || kind === 'undefined') return '[not-serializable]';
  if (Array.isArray(value)) {
    // Length and index reads are both guarded: a poisoned array (accessor at an
    // index, or a throwing `length`) yields bounded markers, never a throw.
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

function requireDependencies({ environment, store, evidence, ids, clock }) {
  if (!ENVIRONMENTS.has(environment)) throw new TypeError('Organizational State requires a canonical environment');
  if (arguments[0].incidents !== undefined && arguments[0].incidents !== null
    && typeof arguments[0].incidents.activeIncidentFacts !== 'function') {
    throw new TypeError('Organizational State incidents seam must expose activeIncidentFacts');
  }
  if (arguments[0].calendar !== undefined && arguments[0].calendar !== null
    && typeof arguments[0].calendar.activeCalendarFacts !== 'function') {
    throw new TypeError('Organizational State calendar seam must expose activeCalendarFacts');
  }
  if (arguments[0].workforce !== undefined && arguments[0].workforce !== null
    && typeof arguments[0].workforce.workforceFactsFor !== 'function') {
    throw new TypeError('Organizational State workforce seam must expose workforceFactsFor');
  }
  // A simulator-backed Workforce seam must not stand in for production truth;
  // the same dev/simulation boundary the other services enforce applies here.
  if (arguments[0].workforce?.source === 'simulator' && !SIMULATOR_ENVIRONMENTS.has(environment)) {
    throw new RangeError('Simulator Workforce adapters may run only in dev or simulation');
  }
  if (!store || typeof store.put !== 'function' || typeof store.get !== 'function') {
    throw new TypeError('Organizational State requires an org state store');
  }
  if (!evidence || typeof evidence.append !== 'function') throw new TypeError('Organizational State requires evidence');
  const idMethods = ['nextEventId', 'nextSpanId', 'nextTraceId'];
  if (!ids || idMethods.some((method) => typeof ids[method] !== 'function')) {
    throw new TypeError('Organizational State requires event, span, and trace ID sources');
  }
  if (typeof clock !== 'function') throw new TypeError('Organizational State requires a clock');
  if (store.source === 'simulator' && !SIMULATOR_ENVIRONMENTS.has(environment)) {
    throw new RangeError('Simulator Organizational State adapters may run only in dev or simulation');
  }
}

export class OrganizationalStateService {
  #clock;
  #environment;
  #evidence;
  #ids;
  #incidents;
  #calendar;
  #workforce;
  #store;

  constructor({ environment, store, evidence, ids, clock, incidents = null, calendar = null, workforce = null }) {
    requireDependencies({ environment, store, evidence, ids, clock, incidents, calendar, workforce });
    this.#environment = environment;
    this.#store = store;
    this.#evidence = evidence;
    this.#ids = ids;
    this.#incidents = incidents;
    this.#calendar = calendar;
    this.#workforce = workforce;
    // Trusted Time: expiry evaluation must not let a backward wall-clock jump
    // revive an expired hold/approval/delegation that was already observed.
    this.#clock = createTrustedClock({ source: clock }).now;
  }

  #append({ eventName, attributes = {}, outcome = 'success', severity = 'info' }) {
    const traceId = this.#ids.nextTraceId();
    this.#evidence.append({
      traceId,
      spanId: this.#ids.nextSpanId(),
      parentSpanId: null,
      serviceName: 'pixel.organizational-state',
      eventName,
      outcome,
      severity,
      attributes,
    });
    return traceId;
  }

  #provenance() {
    return { org_state_contract: ORG_STATE_CONTRACT };
  }

  #recorded(kind, eventName, record, { extra = {} } = {}) {
    const traceId = this.#append({ eventName, attributes: { ...extra } });
    return frozenCopy({ disposition: 'RECORDED', record, trace_id: traceId });
  }

  #refused(kind, reasonCode, record = null) {
    const traceId = this.#append({
      eventName: `org-state.${kind}.refused`,
      outcome: 'denied',
      severity: 'warning',
      attributes: { 'pixel.org-state.reason_code': reasonCode },
    });
    return frozenCopy({ disposition: 'REJECTED', reason_code: reasonCode, record, trace_id: traceId });
  }

  // Validation is part of the fail-closed contract: an invalid write is
  // refused with bounded evidence, never thrown from the service boundary.
  #validated(kind, assertValidator, record) {
    try {
      // Validation runs on the raw composed record: any caller-derived value
      // that is not valid contract data refuses the write. Validation throws
      // are caught and converted to a bounded refusal.
      assertValidator(record);
      return null;
    } catch {
      return this.#refused(kind, `${kind.toUpperCase()}_INVALID`, record);
    }
  }

  createApproval(input) {
    if (!isRecord(input)) return this.#refused('approval', 'APPROVAL_INVALID');
    const now = this.#clock();
    let fields;
    try {
      fields = {
        approval_id: input.approval_id,
        job_id: input.job_id,
        action_type: input.action_type,
        scope: input.scope,
        requested_by: input.requested_by,
        required_authority: input.required_authority,
        expires_at: input.expires_at ?? null,
      };
    } catch {
      return this.#refused('approval', 'APPROVAL_INVALID');
    }
    const record = {
      approval_id: fields.approval_id,
      event_name: APPROVAL_EVENT_NAME,
      schema_version: ORG_STATE_SCHEMA_VERSION,
      status: 'REQUESTED',
      revision: 1,
      created_at: now,
      updated_at: now,
      job_id: fields.job_id,
      action_type: fields.action_type,
      scope: fields.scope,
      requested_by: fields.requested_by,
      required_authority: fields.required_authority,
      approver_identity: null,
      expires_at: fields.expires_at,
      decided_at: null,
      provenance: this.#provenance(),
    };
    const refused = this.#validated('approval', assertValidApprovalV1, record);
    if (refused) return refused;
    const stored = this.#store.put('approval', frozenCopy(record), { expectedRevision: null });
    if (stored.disposition === 'STALE_REVISION') return this.#refused('approval', 'STALE_REVISION', stored.record);
    if (stored.disposition !== 'CREATED') return this.#refused('approval', 'APPROVAL_INVALID', stored.record);
    return this.#recorded('approval', 'org-state.approval.recorded', stored.record, {
      extra: { 'pixel.org-state.approval_id': stored.record.approval_id, 'pixel.org-state.status': stored.record.status, 'pixel.org-state.revision': stored.record.revision },
    });
  }

  decideApproval(input = {}) {
    let args;
    try {
      if (!isRecord(input)) return this.#refused('approval', 'APPROVAL_INVALID');
      args = {
        approval_id: input.approval_id, expected_revision: input.expected_revision,
        status: input.status, approver_identity: input.approver_identity ?? null,
      };
    } catch {
      return this.#refused('approval', 'APPROVAL_INVALID');
    }
    const { approval_id, expected_revision, status, approver_identity } = args;
    const current = this.#store.get('approval', approval_id);
    if (!current) return this.#refused('approval', 'NOT_FOUND');
    if (!DECIDABLE.has(current.status)) return this.#refused('approval', 'INVALID_TRANSITION', current);
    if (!['APPROVED', 'REJECTED', 'CANCELLED'].includes(status)) {
      return this.#refused('approval', 'APPROVAL_INVALID', current);
    }
    const now = this.#clock();
    const record = {
      ...current,
      status,
      revision: current.revision + 1,
      updated_at: now,
      approver_identity: status === 'CANCELLED' ? null : approver_identity,
      decided_at: now,
    };
    const refused = this.#validated('approval', assertValidApprovalV1, record);
    if (refused) return refused;
    const stored = this.#store.put('approval', frozenCopy(record), { expectedRevision: expected_revision });
    if (stored.disposition === 'STALE_REVISION') return this.#refused('approval', 'STALE_REVISION', stored.record);
    if (stored.disposition !== 'UPDATED') return this.#refused('approval', 'APPROVAL_INVALID', stored.record);
    return this.#recorded('approval', 'org-state.approval.recorded', stored.record, {
      extra: { 'pixel.org-state.approval_id': stored.record.approval_id, 'pixel.org-state.status': stored.record.status, 'pixel.org-state.revision': stored.record.revision },
    });
  }

  getApproval(approvalId) {
    return this.#store.get('approval', approvalId);
  }

  grantDelegation(input) {
    if (!isRecord(input)) return this.#refused('delegation', 'DELEGATION_INVALID');
    const now = this.#clock();
    let fields;
    try {
      fields = {
        grant_id: input.grant_id, grantor: input.grantor, grantee: input.grantee,
        capability: input.capability, scope: input.scope, environment: input.environment,
        valid_from: input.valid_from ?? now, expires_at: input.expires_at ?? null,
        subdelegation_allowed: input.subdelegation_allowed ?? false,
      };
    } catch {
      return this.#refused('delegation', 'DELEGATION_INVALID');
    }
    const record = {
      grant_id: fields.grant_id,
      event_name: DELEGATION_EVENT_NAME,
      schema_version: ORG_STATE_SCHEMA_VERSION,
      status: 'ACTIVE',
      revision: 1,
      created_at: now,
      updated_at: now,
      grantor: fields.grantor,
      grantee: fields.grantee,
      capability: fields.capability,
      scope: fields.scope,
      environment: fields.environment,
      valid_from: fields.valid_from,
      expires_at: fields.expires_at,
      subdelegation_allowed: fields.subdelegation_allowed,
      provenance: this.#provenance(),
    };
    const refused = this.#validated('delegation', assertValidDelegationV1, record);
    if (refused) return refused;
    const stored = this.#store.put('delegation', frozenCopy(record), { expectedRevision: null });
    if (stored.disposition !== 'CREATED') return this.#refused('delegation', 'DELEGATION_INVALID', stored.record);
    return this.#recorded('delegation', 'org-state.delegation.recorded', stored.record, {
      extra: { 'pixel.org-state.grant_id': stored.record.grant_id, 'pixel.org-state.status': stored.record.status, 'pixel.org-state.revision': stored.record.revision },
    });
  }

  revokeDelegation(input = {}) {
    let args;
    try {
      if (!isRecord(input)) return this.#refused('delegation', 'DELEGATION_INVALID');
      args = { grant_id: input.grant_id, expected_revision: input.expected_revision };
    } catch {
      return this.#refused('delegation', 'DELEGATION_INVALID');
    }
    const { grant_id, expected_revision } = args;
    const current = this.#store.get('delegation', grant_id);
    if (!current) return this.#refused('delegation', 'NOT_FOUND');
    if (current.status !== 'ACTIVE') return this.#refused('delegation', 'INVALID_TRANSITION', current);
    const record = {
      ...current,
      status: 'REVOKED',
      revision: current.revision + 1,
      updated_at: this.#clock(),
    };
    const refused = this.#validated('delegation', assertValidDelegationV1, record);
    if (refused) return refused;
    const stored = this.#store.put('delegation', frozenCopy(record), { expectedRevision: expected_revision });
    if (stored.disposition === 'STALE_REVISION') return this.#refused('delegation', 'STALE_REVISION', stored.record);
    if (stored.disposition !== 'UPDATED') return this.#refused('delegation', 'DELEGATION_INVALID', stored.record);
    return this.#recorded('delegation', 'org-state.delegation.recorded', stored.record, {
      extra: { 'pixel.org-state.grant_id': stored.record.grant_id, 'pixel.org-state.status': stored.record.status, 'pixel.org-state.revision': stored.record.revision },
    });
  }

  getDelegation(grantId) {
    return this.#store.get('delegation', grantId);
  }

  createHold(input) {
    if (!isRecord(input)) return this.#refused('hold', 'HOLD_INVALID');
    const now = this.#clock();
    let fields;
    try {
      fields = {
        hold_id: input.hold_id, job_id: input.job_id, hold_class: input.hold_class,
        issuer: input.issuer, reason_code: input.reason_code, expires_at: input.expires_at ?? null,
        incident_id: input.incident_id ?? null,
      };
    } catch {
      return this.#refused('hold', 'HOLD_INVALID');
    }
    const record = {
      hold_id: fields.hold_id,
      event_name: HOLD_EVENT_NAME,
      schema_version: ORG_STATE_SCHEMA_VERSION,
      status: 'ACTIVE',
      revision: 1,
      created_at: now,
      updated_at: now,
      job_id: fields.job_id,
      hold_class: fields.hold_class,
      issuer: fields.issuer,
      reason_code: fields.reason_code,
      expires_at: fields.expires_at,
      incident_id: fields.incident_id,
      provenance: this.#provenance(),
    };
    const refused = this.#validated('hold', assertValidHoldV1, record);
    if (refused) return refused;
    const stored = this.#store.put('hold', frozenCopy(record), { expectedRevision: null });
    if (stored.disposition !== 'CREATED') return this.#refused('hold', 'HOLD_INVALID', stored.record);
    return this.#recorded('hold', 'org-state.hold.recorded', stored.record, {
      extra: { 'pixel.org-state.hold_id': stored.record.hold_id, 'pixel.org-state.status': stored.record.status, 'pixel.org-state.revision': stored.record.revision },
    });
  }

  releaseHold(input = {}) {
    let args;
    try {
      if (!isRecord(input)) return this.#refused('hold', 'HOLD_INVALID');
      args = { hold_id: input.hold_id, expected_revision: input.expected_revision, incident_ref: input.incident_ref ?? null };
    } catch {
      return this.#refused('hold', 'HOLD_INVALID');
    }
    const { hold_id, expected_revision, incident_ref } = args;
    const current = this.#store.get('hold', hold_id);
    if (!current) return this.#refused('hold', 'NOT_FOUND');
    if (current.status !== 'ACTIVE') return this.#refused('hold', 'INVALID_TRANSITION', current);
    // Clearing an incident-linked hold requires the exact incident relationship.
    const boundIncident = current.incident_id ?? null;
    if (incident_ref !== boundIncident) {
      return this.#refused('hold', 'HOLD_INCIDENT_MISMATCH', current);
    }
    const record = {
      ...current,
      status: 'RELEASED',
      revision: current.revision + 1,
      updated_at: this.#clock(),
      expires_at: null,
    };
    const refused = this.#validated('hold', assertValidHoldV1, record);
    if (refused) return refused;
    const stored = this.#store.put('hold', frozenCopy(record), { expectedRevision: expected_revision });
    if (stored.disposition === 'STALE_REVISION') return this.#refused('hold', 'STALE_REVISION', stored.record);
    if (stored.disposition !== 'UPDATED') return this.#refused('hold', 'HOLD_INVALID', stored.record);
    return this.#recorded('hold', 'org-state.hold.recorded', stored.record, {
      extra: { 'pixel.org-state.hold_id': stored.record.hold_id, 'pixel.org-state.status': stored.record.status, 'pixel.org-state.revision': stored.record.revision },
    });
  }

  holdsForJob(jobId) {
    return this.#store.listHoldsForJob(jobId);
  }

  setDuty(input = {}) {
    let args;
    try {
      if (!isRecord(input)) return this.#refused('duty', 'DUTY_INVALID');
      args = {
        duty_id: input.duty_id, agent_id: input.agent_id, duty: input.duty,
        expected_revision: input.expected_revision ?? null,
      };
    } catch {
      return this.#refused('duty', 'DUTY_INVALID');
    }
    const { duty_id, agent_id, duty, expected_revision } = args;
    const current = this.#store.get('duty', duty_id);
    if (expected_revision === null && current) return this.#refused('duty', 'ALREADY_EXISTS', current);
    const record = {
      duty_id,
      event_name: DUTY_STATE_EVENT_NAME,
      schema_version: ORG_STATE_SCHEMA_VERSION,
      revision: current ? current.revision + 1 : 1,
      updated_at: this.#clock(),
      agent_id,
      duty,
      provenance: this.#provenance(),
    };
    const refused = this.#validated('duty', assertValidDutyStateV1, record);
    if (refused) return refused;
    const stored = this.#store.put('duty', frozenCopy(record), { expectedRevision: expected_revision });
    if (stored.disposition === 'STALE_REVISION') return this.#refused('duty', 'STALE_REVISION', stored.record);
    if (!['CREATED', 'UPDATED'].includes(stored.disposition)) return this.#refused('duty', 'DUTY_INVALID', stored.record);
    return this.#recorded('duty', 'org-state.duty.recorded', stored.record, {
      extra: { 'pixel.org-state.duty_id': stored.record.duty_id, 'pixel.org-state.status': stored.record.duty, 'pixel.org-state.revision': stored.record.revision },
    });
  }

  dutyFor(agentId) {
    return this.#store.dutyFor(agentId);
  }

  setCapacity(input = {}) {
    let args;
    try {
      if (!isRecord(input)) return this.#refused('capacity', 'CAPACITY_INVALID');
      args = {
        capacity_id: input.capacity_id, resource_ref: input.resource_ref, capacity: input.capacity,
        expected_revision: input.expected_revision ?? null,
      };
    } catch {
      return this.#refused('capacity', 'CAPACITY_INVALID');
    }
    const { capacity_id, resource_ref, capacity, expected_revision } = args;
    const current = this.#store.get('capacity', capacity_id);
    if (expected_revision === null && current) return this.#refused('capacity', 'ALREADY_EXISTS', current);
    const record = {
      capacity_id,
      event_name: CAPACITY_STATE_EVENT_NAME,
      schema_version: ORG_STATE_SCHEMA_VERSION,
      revision: current ? current.revision + 1 : 1,
      updated_at: this.#clock(),
      resource_ref,
      capacity,
      provenance: this.#provenance(),
    };
    const refused = this.#validated('capacity', assertValidCapacityStateV1, record);
    if (refused) return refused;
    const stored = this.#store.put('capacity', frozenCopy(record), { expectedRevision: expected_revision });
    if (stored.disposition === 'STALE_REVISION') return this.#refused('capacity', 'STALE_REVISION', stored.record);
    if (!['CREATED', 'UPDATED'].includes(stored.disposition)) return this.#refused('capacity', 'CAPACITY_INVALID', stored.record);
    return this.#recorded('capacity', 'org-state.capacity.recorded', stored.record, {
      extra: { 'pixel.org-state.capacity_id': stored.record.capacity_id, 'pixel.org-state.status': stored.record.capacity, 'pixel.org-state.revision': stored.record.revision },
    });
  }

  capacityFor(resourceRef) {
    return this.#store.capacityFor(resourceRef);
  }

  // Company State is derived from authoritative inputs. Callers submit inputs,
  // never a target state, so no client can force a lower-precedence value.
  setCompanyState(input = {}) {
    if (!isRecord(input)) return this.#refused('company-state', 'COMPANY_STATE_INVALID');
    let inputs;
    let constraints;
    let expected_revision;
    try {
      ({ inputs = [], constraints = [], expected_revision = null } = input);
    } catch {
      return this.#refused('company-state', 'COMPANY_STATE_INVALID');
    }
    if (!Array.isArray(inputs) || !Array.isArray(constraints)) {
      return this.#refused('company-state', 'COMPANY_STATE_INVALID');
    }
    // Constraints must be strings from the caller; non-string entries (functions,
    // symbols, objects) are refused rather than silently sanitized, so caller
    // debris can never masquerade as a valid constraint. Reads are guarded so a
    // poisoned array refuses instead of throwing.
    let constraintsValid;
    let rawInputRefs;
    try {
      constraintsValid = constraints.every((constraint) => typeof constraint === 'string');
    } catch {
      constraintsValid = false;
    }
    if (!constraintsValid) {
      return this.#refused('company-state', 'COMPANY_STATE_INVALID');
    }
    // An input set must be well-formed and name canonical states. Malformed or
    // unrecognized entries are refused rather than silently skipped: silently
    // skipping can derive NORMAL and erase a higher-precedence fact. Entry
    // reads are guarded so exotic getters refuse instead of throwing.
    let recognized;
    try {
      recognized = inputs.filter((entry) => isRecord(entry) && COMPANY_STATE_PRECEDENCE.includes(entry.state));
    } catch {
      return this.#refused('company-state', 'COMPANY_STATE_INVALID');
    }
    if (recognized.length === 0 || recognized.length !== inputs.length) {
      return this.#refused('company-state', 'COMPANY_STATE_INVALID');
    }
    let state;
    let causeRefs;
    try {
      // A provided ref must be a usable string; a non-string ref is refused
      // rather than silently dropped (no silent coercion of caller debris).
      const rawRefs = [];
      for (const entry of inputs) {
        rawRefs.push(entry !== null && entry !== undefined && typeof entry === 'object' ? (entry.ref ?? null) : null);
      }
      if (rawRefs.some((ref) => ref !== null && typeof ref !== 'string')) {
        return this.#refused('company-state', 'COMPANY_STATE_INVALID');
      }
      state = derivedCompanyState(inputs);
      causeRefs = [...new Set(rawRefs.filter((ref) => typeof ref === 'string' && ref.length > 0))].slice(0, 8);
    } catch {
      return this.#refused('company-state', 'COMPANY_STATE_INVALID');
    }
    const current = this.#store.get('company-state', COMPANY_STATE_ID);
    if (expected_revision !== null && (current?.revision ?? null) !== expected_revision) {
      return this.#refused('company-state', 'STALE_REVISION', current);
    }
    // Precedence protection: no write may silently lower the canonical state.
    // A lowering write must explicitly carry the previous state's ref as a
    // recognized cause (evidence that the condition was resolved), so
    // accidental SURVIVAL -> NORMAL downgrades fail closed.
    if (current && COMPANY_STATE_PRECEDENCE.indexOf(state) > COMPANY_STATE_PRECEDENCE.indexOf(current.state)) {
      const carriesPriorCause = causeRefs.some((ref) => (current.cause_refs ?? []).includes(ref));
      if (!carriesPriorCause) return this.#refused('company-state', 'COMPANY_STATE_DOWNGRADE', current);
    }
    const record = {
      company_state_id: COMPANY_STATE_ID,
      event_name: COMPANY_STATE_EVENT_NAME,
      schema_version: ORG_STATE_SCHEMA_VERSION,
      revision: current ? current.revision + 1 : 1,
      generated_at: this.#clock(),
      state,
      cause_refs: causeRefs,
      constraints,
      provenance: this.#provenance(),
    };
    const refused = this.#validated('company-state', assertValidCompanyStateV1, record);
    if (refused) return refused;
    const stored = this.#store.put('company-state', frozenCopy(record), { expectedRevision: current?.revision ?? null });
    if (stored.disposition === 'STALE_REVISION') return this.#refused('company-state', 'STALE_REVISION', stored.record);
    if (!['CREATED', 'UPDATED'].includes(stored.disposition)) return this.#refused('company-state', 'COMPANY_STATE_INVALID', stored.record);
    return this.#recorded('company-state', 'org-state.company-state.recorded', stored.record, {
      extra: { 'pixel.org-state.status': stored.record.state, 'pixel.org-state.revision': stored.record.revision },
    });
  }

  companyState() {
    return this.#store.currentCompanyState();
  }

  // Canonical evaluation inputs for the Scheduler. This is the single place
  // where Organizational State facts (with Trusted Time expiry evaluation)
  // are reduced to bounded inputs. It returns facts, never a decision or
  // authority: the Scheduler owns eligibility, Access/Policy owns authority.
  evaluateExecutionInputs({ job, requirement } = {}) {
    const now = this.#clock();
    const agentId = job?.envelope?.execution?.worker_binding?.worker_id ?? null;
    const jobId = job?.envelope?.job_id ?? null;
    const jobEnvironment = job?.envelope?.environment ?? null;

    // PX-007 incident seam: active incident facts contribute to Company State
    // and degraded-resource facts through the same deterministic precedence,
    // and containment/survival work is bound to an active incident. incidents
    // === null is the intentional Alpha opt-out; a CONFIGURED seam that throws
    // or returns unusable data must fail closed (no NORMAL fallback, no
    // permission inferred), because missing incident facts are never proof
    // that the Company State is safe.
    let incidentFacts = [];
    let incidentSeamAvailable = false;
    let incidentSeamUnavailable = false;
    if (this.#incidents) {
      try {
        const facts = this.#incidents.activeIncidentFacts();
        let wellFormed = Array.isArray(facts);
        if (wellFormed) {
          for (let index = 0; index < facts.length; index += 1) {
            if (!Object.hasOwn(facts, index) || !validateActiveIncidentFactV1(facts[index]).ok) {
              wellFormed = false;
              break;
            }
          }
        }
        if (wellFormed) {
          incidentFacts = facts;
          incidentSeamAvailable = true;
        } else {
          incidentSeamUnavailable = true;
        }
      } catch {
        incidentSeamUnavailable = true;
      }
    }

    // PX-008 Calendar seam: planned facts never create authority, but a
    // configured Calendar seam that throws or returns malformed/unavailable
    // state must fail closed — it must never imply NORMAL. calendar === null
    // remains the deliberate Alpha opt-out for tests/simulators.
    let calendarState = null;
    let calendarEventRefs = [];
    let calendarSeamAvailable = false;
    let calendarSeamUnavailable = false;
    if (this.#calendar) {
      try {
        const facts = snapshotSafePlainData(this.#calendar.activeCalendarFacts());
        if (validateCalendarOperatingFactsV1(facts).ok) {
          calendarState = facts.calendar_state;
          calendarEventRefs = facts.active_event_refs;
          calendarSeamAvailable = true;
        } else {
          calendarSeamUnavailable = true;
        }
      } catch {
        calendarSeamUnavailable = true;
      }
    }

    // PX-009 Workforce seam: a configured Workforce seam that throws, returns
    // malformed facts, cannot resolve the exact Relay worker identity, or has
    // no workforce record must fail closed. The workforce identity comes from
    // the server-owned Relay worker binding and the exact requested capability;
    // a caller never chooses a different workforce identity here.
    // workforce === null remains the deliberate Alpha opt-out.
    let workforceFacts = null;
    let workforceSeamUnavailable = false;
    if (this.#workforce) {
      try {
        const requestedCapability = job?.envelope?.requested_capability ?? null;
        const facts = snapshotSafePlainData(this.#workforce.workforceFactsFor({
          agent_id: agentId,
          capability: requestedCapability,
        }));
        if (facts === null || !validateWorkforceOperatingFactsV1(facts).ok
          || facts.agent_id !== agentId || facts.capability !== requestedCapability
          || (facts.qualification_status === 'QUALIFIED'
            && isExpiredAt(facts.qualification_expires_at, now))) {
          workforceSeamUnavailable = true;
        } else {
          workforceFacts = facts;
        }
      } catch {
        workforceSeamUnavailable = true;
      }
    }

    let approvalState = 'NONE';
    let approvalId = requirement?.approval_id ?? null;
    if (requirement?.requires_approval) {
      const approval = approvalId ? this.#store.get('approval', approvalId) : null;
      if (!approval) {
        approvalState = 'NONE';
        approvalId = null;
      } else if (approval.job_id !== jobId) {
        approvalState = 'NONE';
      } else if (approval.status === 'APPROVED') {
        approvalState = isExpiredAt(approval.expires_at, now) ? 'EXPIRED' : 'APPROVED';
      } else if (approval.status === 'EXPIRED' || isExpiredAt(approval.expires_at, now)) {
        approvalState = 'EXPIRED';
      } else {
        approvalState = approval.status === 'REJECTED' ? 'REJECTED' : 'PENDING';
      }
    }

    let delegationState = 'MISSING';
    let delegationId = requirement?.delegation_id ?? null;
    if (requirement?.requires_delegation) {
      const delegation = delegationId ? this.#store.get('delegation', delegationId) : null;
      if (!delegation) {
        delegationState = 'MISSING';
        delegationId = null;
      } else if (delegation.status === 'REVOKED') {
        delegationState = 'REVOKED';
      } else if (delegation.status !== 'ACTIVE'
        || delegation.environment !== jobEnvironment
        || delegation.grantee !== agentId
        || Date.parse(now) < Date.parse(delegation.valid_from)) {
        delegationState = 'INVALID';
      } else {
        delegationState = isExpiredAt(delegation.expires_at, now) ? 'EXPIRED' : 'VALID';
      }
    }

    const holds = jobId ? this.#store.listHoldsForJob(jobId) : [];
    const activeHold = holds.find((hold) => hold.status === 'ACTIVE' && !isExpiredAt(hold.expires_at, now)) ?? null;

    const storedCompanyState = this.#store.currentCompanyState()?.state ?? 'NORMAL';
    const incidentDerivedStates = incidentSeamAvailable
      ? incidentFacts
        .filter((fact) => fact.status === 'OPEN')
        .map((fact) => derivedCompanyStateForIncidents([fact]))
        .filter((state) => state !== null)
      : [];
    const calendarDerivedStates = calendarSeamAvailable
      ? [{ state: calendarState }]
      : [];
    const companyState = derivedCompanyState([
      ...incidentDerivedStates.map((state) => ({ state })),
      ...calendarDerivedStates,
      { state: storedCompanyState },
    ]);
    const degradedResources = degradedResourceRefsForIncidents(incidentSeamAvailable ? incidentFacts : []);
    const dutyRecord = agentId ? this.#store.dutyFor(agentId) : null;
    const duty = dutyRecord?.duty ?? 'ON_DUTY';
    const onDuty = duty === 'ON_DUTY' || duty === 'INCIDENT_DUTY' || duty === 'MAINTENANCE_DUTY';
    const offDuty = duty === 'OFF_DUTY' || duty === 'ON_CALL';
    const resourceRef = requirement?.resource_ref ?? `${jobEnvironment}.exclusive.status-check`;
    const capacityRecord = this.#store.capacityFor(resourceRef);
    const capacity = capacityRecord?.capacity ?? 'NORMAL';

    // Null/absent requirement facts fail closed: an absent authority fact is
    // MISSING (never ALLOW), an absent resource-health fact is UNKNOWN (never
    // HEALTHY), and an absent dependency fact is UNKNOWN (never COMPLETE). The
    // requirement contract requires explicit ALLOW/HEALTHY/COMPLETE facts, so a
    // null here means the fact was not established.
    const authorityStatus = requirement?.authority?.status ?? 'MISSING';
    const dependencyStatus = requirement?.dependency?.status ?? 'UNKNOWN';
    let resourceState = requirement?.resource?.status ?? 'UNKNOWN';
    if (degradedResources.has(resourceRef) && resourceState !== 'UNKNOWN' && resourceState !== 'UNAVAILABLE') {
      // An affected resource is deterministically degraded, never upgraded to
      // healthy; unknown/unavailable health still fails closed.
      resourceState = 'DEGRADED';
    }

    // Narrow server-owned safety-class seam: only work bound to an active
    // incident and matching the derived state may continue under incident
    // company states. ORDINARY work remains denied under SURVIVAL etc.
    const requestedSafetyClass = requirement?.execution_safety_class ?? 'ORDINARY';
    const safetyClass = ['ORDINARY', 'INCIDENT_CONTAINMENT', 'SURVIVAL_CRITICAL'].includes(requestedSafetyClass)
      ? requestedSafetyClass
      : 'ORDINARY';
    const incidentRef = typeof requirement?.incident_ref === 'string' ? requirement.incident_ref : null;
    let incidentContainmentEligible = false;
    if (incidentSeamAvailable && incidentRef !== null) {
      const bound = incidentFacts.find((fact) => fact.incident_id === incidentRef && fact.status === 'OPEN');
      if (bound) {
        if (safetyClass === 'SURVIVAL_CRITICAL' && companyState === 'SURVIVAL') {
          incidentContainmentEligible = true;
        } else if (safetyClass === 'INCIDENT_CONTAINMENT'
          && ['SURVIVAL', 'SECURITY_INCIDENT', 'INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT'].includes(companyState)) {
          incidentContainmentEligible = true;
        }
      }
    }

    return frozenCopy({
      authority_state: authorityStatus,
      approval_state: approvalState,
      approval_id: approvalId,
      delegation_state: delegationState,
      delegation_id: delegationId,
      active_hold: activeHold,
      hold_id: activeHold?.hold_id ?? null,
      company_state: companyState,
      incident_state: companyState,
      incident_seam_unavailable: incidentSeamUnavailable,
      calendar_state: calendarState,
      calendar_event_refs: frozenCopy(calendarEventRefs),
      calendar_seam_unavailable: calendarSeamUnavailable,
      workforce_seam_unavailable: workforceSeamUnavailable,
      workforce_agent_id: workforceFacts?.agent_id ?? null,
      workforce_lifecycle_status: workforceFacts?.lifecycle_status ?? null,
      workforce_qualification_status: workforceFacts?.qualification_status ?? null,
      workforce_evaluation_state: workforceFacts?.evaluation_state ?? null,
      workforce_capability: workforceFacts?.capability ?? null,
      workforce_globally_ineligible: workforceFacts === null
        ? null
        : GLOBALLY_INELIGIBLE_LIFECYCLE_STATUSES.includes(workforceFacts.lifecycle_status),
      incident_ref: incidentRef,
      execution_safety_class: safetyClass,
      incident_containment_eligible: incidentContainmentEligible,
      degraded_resources: frozenCopy([...degradedResources]),
      duty,
      on_duty: onDuty,
      off_duty: offDuty,
      capacity,
      resource_ref: resourceRef,
      resource_state: resourceState,
      dependency_state: dependencyStatus,
      job_revision: job?.job_revision ?? null,
    });
  }
}
