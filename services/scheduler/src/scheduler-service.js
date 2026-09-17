import {
  ELIGIBILITY_EVENT_NAME,
  RESERVATION_EVENT_NAME,
  SCHEDULER_CONTRACT,
  SCHEDULER_POLICY_ID,
  SCHEDULER_SCHEMA_VERSION,
  START_CONFIRMATION_EVENT_NAME,
  assertValidEligibilityV1,
  assertValidExecutionRequirementV1,
  assertValidReservationV1,
  assertValidStartConfirmationV1,
  decisionClassForReason,
} from '../../../packages/contracts/src/scheduler-v1.js';
import { createTrustedClock, isExpiredAt } from '../../../packages/contracts/src/trusted-time-v1.js';
import { createHash } from 'node:crypto';
import { assertSchedulerJobLookupAdapter, assertSchedulerStoreAdapter } from '../../../packages/adapter-sdk/src/scheduler-runtime-adapters.js';

const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const SIMULATOR_ENVIRONMENTS = new Set(['dev', 'simulation']);
const RESERVATION_LEASE_MS = 5 * 60 * 1000;
const USABLE_CAPACITY = new Set(['AVAILABLE', 'LIGHT', 'NORMAL', 'HIGH']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

// Bounded identifiers: caller-supplied IDs are sanitized before they can reach
// any output record, so oversized or malformed input is refused with a
// canonical bounded denial instead of throwing across the service boundary.
function boundedId(value, fallback = null) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160 || !IDENTIFIER.test(value)) {
    return fallback;
  }
  return value;
}

// Stable content hash for requirement binding. Stage 1 and stage 2 must agree
// on the exact requirement facts; a swapped/weakened requirement is refused.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function hashExecutionRequirement(requirement) {
  return createHash('sha256').update(stableStringify(requirement)).digest('hex');
}

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

function requireDependencies({ environment, orgState, jobs, store, evidence, ids, clock }) {
  if (!ENVIRONMENTS.has(environment)) throw new TypeError('Scheduler requires a canonical environment');
  if (!orgState || typeof orgState.evaluateExecutionInputs !== 'function') {
    throw new TypeError('Scheduler requires Organizational State evaluation');
  }
  assertSchedulerJobLookupAdapter(jobs);
  assertSchedulerStoreAdapter(store);
  if (!evidence || typeof evidence.append !== 'function') throw new TypeError('Scheduler requires evidence');
  const idMethods = ['nextEventId', 'nextSpanId', 'nextTraceId'];
  if (!ids || idMethods.some((method) => typeof ids[method] !== 'function')) {
    throw new TypeError('Scheduler requires event, span, and trace ID sources');
  }
  if (typeof clock !== 'function') throw new TypeError('Scheduler requires a clock');
  // Trusted Time is mandatory: the injected clock is wrapped with the monotonic
  // clamp so a backward wall-clock jump cannot revive an expired lease that was
  // already observed. (An unobserved rollback cannot be detected without a
  // trusted time source; the server-injected clock is that Alpha source.)
  if ([jobs, store].some((dependency) => dependency?.source === 'simulator')
    && !SIMULATOR_ENVIRONMENTS.has(environment)) {
    throw new RangeError('Simulator Scheduler adapters may run only in dev or simulation');
  }
}

export class SchedulerService {
  #clock;
  #environment;
  #evidence;
  #ids;
  #jobs;
  #orgState;
  #store;
  #traces = new Map();

  constructor({ environment, orgState, jobs, store, evidence, ids, clock }) {
    requireDependencies({ environment, orgState, jobs, store, evidence, ids, clock });
    this.#environment = environment;
    this.#orgState = orgState;
    this.#jobs = jobs;
    this.#store = store;
    this.#evidence = evidence;
    this.#ids = ids;
    this.#clock = createTrustedClock({ source: clock }).now;
  }

  #append({ traceId, spanId = null, parentSpanId = null, eventName, outcome = 'success', severity = 'info', attributes = {} }) {
    this.#evidence.append({
      traceId,
      spanId: spanId ?? this.#ids.nextSpanId(),
      parentSpanId,
      serviceName: 'pixel.scheduler',
      eventName,
      outcome,
      severity,
      attributes,
    });
  }

  #provenance() {
    return { scheduler_contract: SCHEDULER_CONTRACT };
  }

  #buildEvaluation({ jobId, executionId, decision, reasonCode, inputs, jobRevision, traceId, requirementHash = null }) {
    const evaluation = {
      eligibility_id: this.#ids.nextEventId(),
      event_name: ELIGIBILITY_EVENT_NAME,
      schema_version: SCHEDULER_SCHEMA_VERSION,
      evaluated_at: this.#clock(),
      job_id: boundedId(jobId, 'unknown.job'),
      execution_id: boundedId(executionId, null),
      environment: this.#environment,
      decision,
      reason_code: reasonCode,
      policy_id: SCHEDULER_POLICY_ID,
      authority_state: inputs.authority_state ?? 'MISSING',
      approval_id: inputs.approval_id ?? null,
      delegation_id: inputs.delegation_id ?? null,
      hold_id: inputs.hold_id ?? null,
      company_state: inputs.company_state ?? null,
      duty: inputs.duty ?? null,
      capacity: inputs.capacity ?? null,
      resource_ref: inputs.resource_ref ?? `${this.#environment}.exclusive.status-check`,
      job_revision: jobRevision,
      provenance: this.#provenance(),
    };
    const validated = assertValidEligibilityV1(frozenCopy(evaluation));
    this.#recordIssuance(validated.eligibility_id, {
      traceId, jobId: validated.job_id, decision: validated.decision,
      reasonCode: validated.reason_code, resourceRef: validated.resource_ref,
      consumed: false, requirementHash, issuedAt: this.#clock(),
    });
    return validated;
  }

  // Issuance records bind a reservation to an evaluation this instance
  // produced, including the exact stage-1 requirement facts. An entry is
  // evicted only once it can no longer authorize anything: an unconsumed
  // evaluation beyond the one-lease reserve bound, or a consumed evaluation
  // beyond two leases (a reservation created at the latest legal instant —
  // one lease after issuance — expires one lease later, so two leases is the
  // full span in which its issuance can still be needed for confirmation).
  // A live reservation's issuance is therefore never evicted. The map's size
  // is bounded by evaluation arrival within that window rather than by a hard
  // count cap, which would evict issuances a legitimate confirmation still
  // requires.
  #recordIssuance(eligibilityId, entry) {
    this.#traces.set(eligibilityId, entry);
    const now = Date.parse(entry.issuedAt);
    for (const [key, candidate] of this.#traces) {
      const age = now - Date.parse(candidate.issuedAt);
      const limit = candidate.consumed ? RESERVATION_LEASE_MS * 2 : RESERVATION_LEASE_MS;
      if (age > limit) this.#traces.delete(key);
    }
  }

  #emitEvaluation(traceId, evaluation) {
    this.#append({
      traceId,
      parentSpanId: null,
      eventName: 'scheduler.evaluation.completed',
      outcome: evaluation.decision === 'ELIGIBLE' ? 'success' : 'denied',
      severity: evaluation.decision === 'ELIGIBLE' ? 'info' : 'warning',
      attributes: {
        'pixel.job.id': evaluation.job_id,
        'pixel.scheduler.decision': evaluation.decision,
        'pixel.scheduler.reason_code': evaluation.reason_code,
        'pixel.scheduler.job_revision': evaluation.job_revision,
      },
    });
  }

  #invalid({ jobId = 'unknown.job', jobRevision = 1, executionId = null } = {}) {
    const traceId = this.#ids.nextTraceId();
    const evaluation = this.#buildEvaluation({
      jobId, executionId, decision: 'DENY', reasonCode: 'DENY_INPUT_INVALID',
      inputs: {}, jobRevision, traceId,
    });
    this.#emitEvaluation(traceId, evaluation);
    return frozenCopy({ disposition: 'DENY', evaluation, reservation: null });
  }

  #evaluateInputs({ job, requirement }) {
    try {
      return this.#orgState.evaluateExecutionInputs(frozenCopy({ job, requirement }));
    } catch {
      return null;
    }
  }

  // Stage 1 — evaluate. The Scheduler reads canonical job state itself through
  // the Relay lookup seam; it never trusts caller-supplied job copies. It
  // never grants authority and never selects a model/provider/runtime.
  async evaluate(input = {}) {
    let args;
    try {
      args = input !== null && typeof input === 'object'
        ? { job_id: input.job_id, requirement: input.requirement, execution_id: input.execution_id ?? null }
        : {};
    } catch {
      return this.#invalid();
    }
    const { job_id, requirement, execution_id } = args;
    if (boundedId(job_id) === null) return this.#invalid();
    let job;
    try {
      job = await this.#jobs.getJob(job_id);
    } catch {
      job = null;
    }
    if (!job || !job.envelope || !Number.isSafeInteger(job.job_revision)) {
      return this.#invalid({ jobId: job_id, jobRevision: 1 });
    }
    const traceId = this.#ids.nextTraceId();
    let validation;
    try {
      validation = assertValidExecutionRequirementV1(frozenCopy(requirement));
    } catch {
      const evaluation = this.#buildEvaluation({
        jobId: job_id, executionId: execution_id, decision: 'DENY', reasonCode: 'DENY_INPUT_INVALID',
        inputs: {}, jobRevision: job.job_revision, traceId,
      });
      this.#emitEvaluation(traceId, evaluation);
      return frozenCopy({ disposition: 'DENY', evaluation, reservation: null });
    }
    const inputs = this.#evaluateInputs({ job, requirement: validation });
    if (inputs === null) {
      const evaluation = this.#buildEvaluation({
        jobId: job_id, executionId: execution_id, decision: 'WAIT', reasonCode: 'WAIT_DEPENDENCY',
        inputs: {}, jobRevision: job.job_revision, traceId,
      });
      this.#emitEvaluation(traceId, evaluation);
      return frozenCopy({ disposition: 'WAIT', evaluation, reservation: null });
    }
    const decision = this.#decide({ job, requirement: validation, inputs });
    const evaluation = this.#buildEvaluation({
      jobId: job_id, executionId: execution_id, decision: decision.decision,
      reasonCode: decision.reasonCode, inputs, jobRevision: job.job_revision, traceId,
      requirementHash: hashExecutionRequirement(validation),
    });
    this.#emitEvaluation(traceId, evaluation);
    return frozenCopy({ disposition: decision.decision, evaluation, reservation: null });
  }

  // Deterministic ordering of eligibility checks. Every failed check maps to a
  // canonical WAIT/HOLD/DENY reason; no failed dependency check implies
  // permission. WAIT/HOLD/DENY are Scheduler outcomes only — they never become
  // Relay lifecycle states.
  #decide({ job, requirement, inputs }) {
    if (this.#environment !== job.envelope.environment) {
      return { decision: 'DENY', reasonCode: 'DENY_ENVIRONMENT' };
    }
    if (job.envelope.requested_capability !== undefined
      && requirement.authority?.ref !== job.envelope.requested_capability) {
      return { decision: 'DENY', reasonCode: 'DENY_AUTHORITY_MISSING' };
    }
    if (inputs.authority_state !== 'ALLOW') {
      return { decision: 'DENY', reasonCode: 'DENY_AUTHORITY_MISSING' };
    }
    if (requirement.requires_delegation && inputs.delegation_state !== 'VALID') {
      return { decision: 'DENY', reasonCode: 'DENY_DELEGATION_INVALID' };
    }
    // PX-007 fail-closed posture: a configured incident seam that cannot
    // establish trustworthy incident state denies ordinary (and every) start.
    // Missing incident facts are never proof that Company State is safe; no
    // permission may be inferred from seam unavailability, and the caller must
    // not fabricate an incident identity to route around it.
    if (inputs.incident_seam_unavailable === true) {
      return { decision: 'DENY', reasonCode: 'DENY_COMPANY_STATE' };
    }
    // PX-008 fail-closed Calendar dependency: a configured Calendar seam that
    // cannot establish trustworthy facts delays work rather than permitting
    // an implicit NORMAL. (calendar === null remains the deliberate opt-out.)
    if (inputs.calendar_seam_unavailable === true) {
      return { decision: 'WAIT', reasonCode: 'WAIT_DEPENDENCY' };
    }
    // PX-009 Workforce gate: the Workforce projection is bound to the Relay
    // worker binding and the exact requested capability. A configured seam
    // that is unavailable, malformed, mismatched, or has no record denies;
    // CANDIDATE/INACTIVE/RETIRED are globally ineligible for ordinary work;
    // ACTIVE/LIMITED/RETRAINING still require a current QUALIFIED capability.
    // AgentOps WATCH/REVIEW is evidence only and never denies work here.
    if (inputs.workforce_seam_unavailable === true) {
      return { decision: 'DENY', reasonCode: 'DENY_WORKFORCE' };
    }
    if (inputs.workforce_globally_ineligible === true) {
      return { decision: 'DENY', reasonCode: 'DENY_WORKFORCE' };
    }
    // Workforce gating applies only when a Workforce projection exists.
    // workforce === null remains the deliberate Alpha opt-out, exactly like the
    // incident and calendar seams: no configured Workforce seam means no
    // Workforce gate, and the other Scheduler gates still apply.
    if (inputs.workforce_agent_id !== null && inputs.workforce_agent_id !== undefined
      && inputs.workforce_qualification_status !== 'QUALIFIED') {
      // Missing, LIMITED, RETRAINING, UNQUALIFIED, EXPIRED, or malformed
      // requested-capability qualification fails closed but is recoverable,
      // so the job waits rather than being permanently denied.
      return { decision: 'WAIT', reasonCode: 'WAIT_QUALIFICATION' };
    }
    // PX-007 narrow server-owned seam: correctly bound, already-authorized
    // containment/survival work may be evaluated under incident company
    // states; ordinary work remains denied.
    if (inputs.company_state === 'SURVIVAL' || inputs.company_state === 'SECURITY_INCIDENT'
      || inputs.company_state === 'INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT') {
      if (inputs.incident_containment_eligible !== true) {
        return { decision: 'DENY', reasonCode: 'DENY_COMPANY_STATE' };
      }
    }
    if (inputs.resource_state === 'UNKNOWN' || inputs.resource_state === 'UNAVAILABLE') {
      return { decision: 'DENY', reasonCode: 'DENY_RESOURCE_INELIGIBLE' };
    }
    if (inputs.capacity === 'UNAVAILABLE') {
      return { decision: 'DENY', reasonCode: 'DENY_RESOURCE_INELIGIBLE' };
    }
    if (inputs.dependency_state === 'FAILED') {
      return { decision: 'DENY', reasonCode: 'DENY_RESOURCE_INELIGIBLE' };
    }
    if (inputs.active_hold) {
      const classMap = {
        SECURITY: 'HOLD_SECURITY', POLICY: 'HOLD_POLICY', OWNER: 'HOLD_OWNER', MAINTENANCE: 'HOLD_MAINTENANCE',
      };
      return { decision: 'HOLD', reasonCode: classMap[inputs.active_hold.hold_class] ?? 'HOLD_POLICY' };
    }
    if (inputs.company_state === 'MAINTENANCE') {
      return { decision: 'WAIT', reasonCode: 'WAIT_MAINTENANCE' };
    }
    if (inputs.company_state === 'HOLIDAY') {
      return { decision: 'WAIT', reasonCode: 'WAIT_HOLIDAY' };
    }
    if (inputs.company_state === 'NIGHT') {
      return { decision: 'WAIT', reasonCode: 'WAIT_NIGHT' };
    }
    if (requirement.not_before && Date.parse(this.#clock()) < Date.parse(requirement.not_before)) {
      return { decision: 'WAIT', reasonCode: 'WAIT_NOT_BEFORE' };
    }
    if (inputs.dependency_state === 'PENDING' || inputs.dependency_state === 'BLOCKED'
      || inputs.dependency_state === 'UNKNOWN') {
      return { decision: 'WAIT', reasonCode: 'WAIT_DEPENDENCY' };
    }
    if (inputs.off_duty) {
      return { decision: 'WAIT', reasonCode: 'WAIT_OFF_DUTY' };
    }
    if (!USABLE_CAPACITY.has(inputs.capacity)) {
      return { decision: 'WAIT', reasonCode: 'WAIT_CAPACITY' };
    }
    if (requirement.requires_approval && inputs.approval_state !== 'APPROVED') {
      return { decision: 'WAIT', reasonCode: 'WAIT_APPROVAL' };
    }
    return { decision: 'ELIGIBLE', reasonCode: 'ELIGIBLE_NOW' };
  }

  getDecisionClass(reasonCode) {
    return decisionClassForReason(reasonCode);
  }

  #issuanceTraceFor(eligibilityId) {
    return this.#traces.get(eligibilityId)?.traceId ?? null;
  }

  // Reservation may be attempted only after an ELIGIBLE decision. It claims
  // capacity ownership for a bounded lease and never grants authority.
  reserve(input = {}) {
    let args;
    try {
      args = input !== null && typeof input === 'object'
        ? { evaluation: input.evaluation, job_id: input.job_id, execution_id: input.execution_id ?? null, resource_ref: input.resource_ref ?? null }
        : {};
      // Every nested evaluation read happens inside this guard: an evaluation
      // object carrying throwing accessors refuses instead of throwing.
      const evaluation = args.evaluation;
      if (evaluation !== null && evaluation !== undefined) {
        args.evalReason = evaluation.reason_code;
        args.evalDecision = evaluation.decision;
        args.evalJobId = evaluation.job_id;
        args.evalEligibilityId = evaluation.eligibility_id;
        args.evalResourceRef = evaluation.resource_ref;
      }
    } catch {
      return frozenCopy({ disposition: 'DENY', reservation: null, evaluation: null });
    }
    const { evaluation, job_id, execution_id, resource_ref } = args;
    const evalReason = args.evalReason ?? null;
    const evalDecision = args.evalDecision ?? null;
    const evalJobId = args.evalJobId ?? null;
    const evalEligibilityId = args.evalEligibilityId ?? null;
    const evalResourceRef = args.evalResourceRef ?? null;
    // Echoes carry a bounded reconstruction of the evaluation, never the raw
    // caller object: cloning caller debris cannot throw out of the service.
    const echo = {
      eligibility_id: typeof evalEligibilityId === 'string' ? evalEligibilityId : null,
      decision: typeof evalDecision === 'string' ? evalDecision : null,
      reason_code: typeof evalReason === 'string' ? evalReason : null,
      job_id: typeof evalJobId === 'string' ? evalJobId : null,
      resource_ref: typeof evalResourceRef === 'string' ? evalResourceRef : null,
    };
    const decisionClass = decisionClassForReason(evalReason) ?? 'DENY';
    if (evalDecision !== 'ELIGIBLE' || evalReason !== 'ELIGIBLE_NOW') {
      return frozenCopy({ disposition: decisionClass, reservation: null, evaluation: echo });
    }
    const issued = evalEligibilityId !== null ? this.#traces.get(evalEligibilityId) : undefined;
    if (!issued || issued.consumed || issued.jobId !== evalJobId
      || issued.decision !== evalDecision || issued.reasonCode !== evalReason
      || issued.resourceRef !== evalResourceRef) {
      // A reservation may be attempted only from an evaluation this instance
      // issued, with the same decision, reason, job, and resource, and only once.
      return frozenCopy({ disposition: 'DENY', reservation: null, evaluation: echo });
    }
    if (boundedId(job_id) === null || boundedId(job_id) !== evalJobId) {
      // A reservation may only be created for the job the evaluation assessed.
      return frozenCopy({ disposition: 'DENY', reservation: null, evaluation: echo });
    }
    if (resource_ref !== null && resource_ref !== evalResourceRef) {
      // The reserved resource must be the resource the evaluation assessed; a
      // caller cannot redirect capacity to an arbitrary resource.
      return frozenCopy({ disposition: 'DENY', reservation: null, evaluation: echo });
    }
    const now = this.#clock();
    // A stale evaluation cannot reserve: eligibility older than one lease
    // window requires re-evaluation against current facts.
    if (Date.parse(now) - Date.parse(issued.issuedAt) > RESERVATION_LEASE_MS) {
      return frozenCopy({ disposition: 'DENY', reservation: null, evaluation: echo });
    }
    const traceId = issued.traceId;
    // The reservation claims the resource the evaluation actually assessed; a
    // caller cannot redirect capacity to an arbitrary resource.
    const reservation = {
      reservation_id: this.#ids.nextEventId(),
      event_name: RESERVATION_EVENT_NAME,
      schema_version: SCHEDULER_SCHEMA_VERSION,
      state: 'ACTIVE',
      revision: 1,
      created_at: now,
      updated_at: now,
      job_id: boundedId(job_id),
      execution_id: boundedId(execution_id, null),
      resource_ref: evalResourceRef,
      eligibility_id: evalEligibilityId,
      expires_at: new Date(Date.parse(now) + RESERVATION_LEASE_MS).toISOString(),
      provenance: this.#provenance(),
    };
    const validation = assertValidReservationV1(frozenCopy(reservation));
    const stored = this.#store.reserve(validation, { now });
    if (stored.disposition !== 'RESERVED') {
      this.#append({
        traceId,
        eventName: 'scheduler.reservation.rejected',
        outcome: 'denied',
        severity: 'warning',
        attributes: {
          'pixel.job.id': job_id,
          'pixel.scheduler.reason_code': 'WAIT_CAPACITY',
          'pixel.scheduler.resource_ref': validation.resource_ref,
        },
      });
      return frozenCopy({ disposition: 'WAIT', reservation: stored.reservation, evaluation: echo });
    }
    issued.consumed = true;
    this.#append({
      traceId,
        eventName: 'scheduler.reservation.activated',
        attributes: {
          'pixel.job.id': job_id,
          'pixel.scheduler.reservation_id': stored.reservation.reservation_id,
          'pixel.scheduler.resource_ref': stored.reservation.resource_ref,
          'pixel.scheduler.revision': stored.reservation.revision,
        },
    });
    return frozenCopy({ disposition: 'RESERVED', reservation: stored.reservation, evaluation: echo });
  }

  release(input = {}) {
    let args;
    try {
      args = input !== null && typeof input === 'object'
        ? { reservation_id: input.reservation_id, expected_revision: input.expected_revision }
        : null;
    } catch {
      args = null;
    }
    if (args === null) {
      return frozenCopy({ disposition: 'REJECTED', reason_code: 'RELEASE_INPUT_INVALID', reservation: null });
    }
    const { reservation_id, expected_revision } = args;
    // The release joins the reservation's lifecycle trace so the bounded
    // evidence assessor can verify the complete reservation sequence.
    const before = this.#store.current(reservation_id, { now: this.#clock() });
    const traceId = before ? this.#issuanceTraceFor(before.eligibility_id) : null;
    const stored = this.#store.transition(reservation_id, {
      toState: 'RELEASED',
      now: this.#clock(),
      expectedRevision: expected_revision,
    });
    if (stored.disposition !== 'UPDATED') {
      return frozenCopy({ disposition: stored.disposition, reservation: stored.reservation });
    }
    this.#append({
      traceId: traceId ?? this.#ids.nextTraceId(),
      eventName: 'scheduler.reservation.released',
      attributes: {
        'pixel.job.id': stored.reservation.job_id,
        'pixel.scheduler.reservation_id': stored.reservation.reservation_id,
        'pixel.scheduler.revision': stored.reservation.revision,
      },
    });
    return frozenCopy({ disposition: 'RELEASED', reservation: stored.reservation });
  }

  // Stage 2 — re-check immediately before Relay would enter RUNNING. The job is
  // re-read from canonical state; a stale eligibility decision or expired lease
  // fails safe and the caller must keep the job in ACCEPTED.
  async confirmExecutionStart(input = {}) {
    let args;
    try {
      args = input !== null && typeof input === 'object'
        ? {
          job_id: input.job_id, requirement: input.requirement,
          reservation_id: input.reservation_id, expected_job_revision: input.expected_job_revision,
        }
        : {};
    } catch {
      args = {};
    }
    const { job_id, requirement, reservation_id, expected_job_revision } = args;
    const now = this.#clock();
    const reservation = this.#store.current(reservation_id, { now });
    // Confirmation evidence joins the reservation's lifecycle trace (the trace
    // that carries the evaluation and activation), so a complete reservation
    // lifecycle forms a single verifiable scheduler trace.
    const traceId = (reservation ? this.#issuanceTraceFor(reservation.eligibility_id) : null) ?? this.#ids.nextTraceId();
    const refuse = (reasonCode, { jobId = job_id, executionId = reservation?.execution_id ?? null } = {}) => {
      const confirmation = assertValidStartConfirmationV1(frozenCopy({
        confirmation_id: this.#ids.nextEventId(),
        event_name: START_CONFIRMATION_EVENT_NAME,
        schema_version: SCHEDULER_SCHEMA_VERSION,
        confirmed_at: now,
        // Caller identifiers are sanitized to canonical bounded forms before
        // they may reach any output record; invalid input never throws.
        job_id: boundedId(jobId, 'unknown.job'),
        execution_id: boundedId(executionId, null),
        reservation_id: boundedId(reservation_id, 'unknown.reservation'),
        outcome: 'REJECTED',
        reason_code: reasonCode,
        policy_id: SCHEDULER_POLICY_ID,
        provenance: this.#provenance(),
      }));
      this.#append({
        traceId,
        parentSpanId: null,
        eventName: 'scheduler.start.rejected',
        outcome: 'denied',
        severity: 'warning',
        attributes: {
          'pixel.job.id': confirmation.job_id,
          'pixel.scheduler.reason_code': reasonCode,
          'pixel.scheduler.reservation_id': confirmation.reservation_id,
        },
      });
      return frozenCopy({ confirmed: false, reason_code: reasonCode, confirmation });
    };

    if (boundedId(job_id) === null || !Number.isSafeInteger(expected_job_revision)) {
      return refuse('START_REJECTED_INPUT_INVALID');
    }
    let job;
    try {
      job = await this.#jobs.getJob(job_id);
    } catch {
      job = null;
    }
    if (!job || !job.envelope) return refuse('START_REJECTED_JOB_STATE');
    if (job.current_state !== 'ACCEPTED') return refuse('START_REJECTED_JOB_STATE');
    if (job.job_revision !== expected_job_revision) return refuse('START_REJECTED_REVISION');
    if (!reservation || reservation.state !== 'ACTIVE') return refuse('START_REJECTED_RESERVATION');
    if (isExpiredAt(reservation.expires_at, now)) return refuse('START_REJECTED_RESERVATION');
    if (reservation.job_id !== job_id) return refuse('START_REJECTED_RESERVATION');

    let validation;
    try {
      validation = assertValidExecutionRequirementV1(frozenCopy(requirement));
    } catch {
      return refuse('START_REJECTED_INPUT_INVALID');
    }
    // The stage-2 requirement must be the exact requirement stage 1 assessed:
    // a swapped or weakened requirement cannot authorize start. A mismatch is
    // an invalid start input (fail closed with a DENY-class rejection).
    const issued = this.#traces.get(reservation.eligibility_id);
    if (!issued || issued.jobId !== job_id
      || hashExecutionRequirement(validation) !== issued.requirementHash) {
      return refuse('START_REJECTED_INPUT_INVALID');
    }
    // The reservation must own the resource the requirement assesses; a decoy
    // reservation on another resource cannot authorize this start.
    if (validation.resource_ref !== reservation.resource_ref) {
      return refuse('START_REJECTED_RESERVATION');
    }
    const inputs = this.#evaluateInputs({ job, requirement: validation });
    if (inputs === null) return refuse('START_REJECTED_DEPENDENCY');
    const decision = this.#decide({ job, requirement: validation, inputs });
    if (decision.decision !== 'ELIGIBLE') {
      const map = {
        WAIT_CAPACITY: 'START_REJECTED_CAPACITY',
        WAIT_OFF_DUTY: 'START_REJECTED_DUTY',
        WAIT_MAINTENANCE: 'START_REJECTED_COMPANY_STATE',
        WAIT_HOLIDAY: 'START_REJECTED_COMPANY_STATE',
        WAIT_NIGHT: 'START_REJECTED_COMPANY_STATE',
        WAIT_QUALIFICATION: 'START_REJECTED_WORKFORCE',
        DENY_WORKFORCE: 'START_REJECTED_WORKFORCE',
        WAIT_APPROVAL: 'START_REJECTED_APPROVAL',
        WAIT_NOT_BEFORE: 'START_REJECTED_NOT_BEFORE',
        WAIT_DEPENDENCY: 'START_REJECTED_DEPENDENCY',
        HOLD_SECURITY: 'START_REJECTED_HOLD',
        HOLD_POLICY: 'START_REJECTED_HOLD',
        HOLD_OWNER: 'START_REJECTED_HOLD',
        HOLD_MAINTENANCE: 'START_REJECTED_HOLD',
        DENY_AUTHORITY_MISSING: 'START_REJECTED_AUTHORITY',
        DENY_DELEGATION_INVALID: 'START_REJECTED_DELEGATION',
        DENY_ENVIRONMENT: 'START_REJECTED_ENVIRONMENT',
        DENY_RESOURCE_INELIGIBLE: 'START_REJECTED_RESOURCE',
        DENY_COMPANY_STATE: 'START_REJECTED_COMPANY_STATE',
        DENY_INPUT_INVALID: 'START_REJECTED_INPUT_INVALID',
      };
      return refuse(map[decision.reasonCode] ?? 'START_REJECTED_INPUT_INVALID');
    }

    const confirmation = assertValidStartConfirmationV1(frozenCopy({
      confirmation_id: this.#ids.nextEventId(),
      event_name: START_CONFIRMATION_EVENT_NAME,
      schema_version: SCHEDULER_SCHEMA_VERSION,
      confirmed_at: now,
      job_id,
      execution_id: reservation.execution_id,
      reservation_id: reservation.reservation_id,
      outcome: 'CONFIRMED',
      reason_code: 'START_CONFIRMED',
      policy_id: SCHEDULER_POLICY_ID,
      provenance: this.#provenance(),
    }));
    this.#append({
      traceId,
      parentSpanId: null,
      eventName: 'scheduler.start.confirmed',
      attributes: {
        'pixel.job.id': job_id,
        'pixel.scheduler.reason_code': 'START_CONFIRMED',
        'pixel.scheduler.reservation_id': reservation.reservation_id,
        'pixel.scheduler.job_revision': job.job_revision,
      },
    });
    return frozenCopy({ confirmed: true, reason_code: 'START_CONFIRMED', confirmation });
  }

  reservation(reservationId) {
    return this.#store.current(reservationId, { now: this.#clock() });
  }
}
