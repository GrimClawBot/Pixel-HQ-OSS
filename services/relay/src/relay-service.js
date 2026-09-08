import { createHash } from 'node:crypto';

import {
  assertJobContextProvider,
  assertRelayStoreAdapter,
  validateJobContext,
} from '../../../packages/adapter-sdk/src/job-runtime-adapters.js';
import {
  JOB_ENVELOPE_EVENT_NAME,
  JOB_SCHEMA_VERSION,
  JOB_TRANSITION_EVENT_NAME,
  TOOL_EXECUTION_REQUEST_EVENT_NAME,
  assertValidJobEnvelopeV1,
  assertValidJobTransitionV1,
  assertValidToolExecutionRequestV1,
  validateJobSubmitIntentV1,
  validateJobTransitionV1,
} from '../../../packages/contracts/src/job-v1.js';
import { getSystemsJobBinding } from '../../../packages/registry/src/organization-bindings.js';

export const RELAY_CONTRACT = 'pixel.relay.v1';

const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const SIMULATOR_ENVIRONMENTS = new Set(['dev', 'simulation']);
const JOB_STATES = new Set(['SUBMITTED', 'ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED']);
const TRANSITION_REASONS = new Set([
  'JOB_ACCEPTED', 'EXECUTION_STARTED', 'EXECUTION_COMPLETED', 'CAPABILITY_DENIED',
  'AUTHORIZATION_UNAVAILABLE', 'WORKER_FAILED', 'WORKER_RESULT_INVALID',
]);
const AUTHORITY_KEYS = new Set([
  'department', 'departmentref', 'role', 'environment', 'state', 'lifecycle', 'worker', 'workerid',
  'executor', 'executionid', 'grant', 'grants', 'permission', 'permissions', 'decision', 'policy',
  'policyid', 'provenance', 'jobid', 'requester', 'subjectid', 'owner', 'traceid', 'spanid',
]);

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

function normalizedKey(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function authorityCategories(value, categories = new Set()) {
  if (Array.isArray(value)) {
    for (const child of value) authorityCategories(child, categories);
    return categories;
  }
  if (!value || typeof value !== 'object') return categories;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (AUTHORITY_KEYS.has(normalized)) categories.add(normalized);
    authorityCategories(child, categories);
  }
  return categories;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sameRegistryBinding(context) {
  const binding = getSystemsJobBinding();
  return context.owner.department_ref === binding.department_ref
    && context.owner.role_ref === binding.role_ref
    && context.worker_binding.department_ref === binding.department_ref
    && context.worker_binding.role_ref === binding.role_ref;
}

function requireDependencies({ environment, contextProvider, store, toolGateway, evidence, ids, clock }) {
  if (!ENVIRONMENTS.has(environment)) throw new TypeError('Relay requires a canonical environment');
  assertJobContextProvider(contextProvider);
  assertRelayStoreAdapter(store);
  if (!toolGateway || typeof toolGateway.execute !== 'function') throw new TypeError('Relay requires ToolGateway');
  if (!evidence || typeof evidence.append !== 'function') throw new TypeError('Relay requires evidence');
  const idMethods = ['nextEventId', 'nextJobId', 'nextExecutionId', 'nextSpanId', 'nextTraceId'];
  if (!ids || idMethods.some((method) => typeof ids[method] !== 'function')) {
    throw new TypeError('Relay requires job, execution, event, span, and trace ID sources');
  }
  if (typeof clock !== 'function') throw new TypeError('Relay requires a clock');
  if ([contextProvider, store, toolGateway].some(({ source }) => source === 'simulator') && !SIMULATOR_ENVIRONMENTS.has(environment)) {
    throw new RangeError('Simulator Relay adapters may run only in dev or simulation');
  }
}

export class RelayService {
  #clock;
  #contextProvider;
  #contextSource;
  #environment;
  #evidence;
  #ids;
  #store;
  #toolGateway;

  constructor({ environment, contextProvider, store, toolGateway, evidence, ids, clock }) {
    requireDependencies({ environment, contextProvider, store, toolGateway, evidence, ids, clock });
    this.#environment = environment;
    this.#contextProvider = contextProvider;
    this.#contextSource = contextProvider.source;
    this.#store = store;
    this.#toolGateway = toolGateway;
    this.#evidence = evidence;
    this.#ids = ids;
    this.#clock = clock;
  }

  #append({ traceId, spanId, parentSpanId = null, eventName, outcome = 'success', severity = 'info', attributes = {} }) {
    return this.#evidence.append({
      traceId,
      spanId,
      parentSpanId,
      serviceName: 'pixel.relay',
      eventName,
      outcome,
      severity,
      attributes,
    });
  }

  #rejection(traceId, parentSpanId, reasonCode, eventName, attributes = {}) {
    this.#append({
      traceId,
      spanId: this.#ids.nextSpanId(),
      parentSpanId,
      eventName,
      outcome: 'denied',
      severity: 'warning',
      attributes,
    });
    return frozenCopy({ disposition: 'REJECTED', reason_code: reasonCode, job: null, trace_id: traceId });
  }

  #recordTransitionRejection(job, attemptedState, reasonCode) {
    this.#append({
      traceId: job.envelope.trace_id,
      spanId: this.#ids.nextSpanId(),
      parentSpanId: job.transitions.at(-1)?.span_id ?? job.envelope.span_id,
      eventName: 'relay.transition.rejected',
      outcome: 'denied',
      severity: 'warning',
      attributes: {
        'pixel.job.id': job.envelope.job_id,
        'pixel.job.current_state': job.current_state,
        'pixel.job.attempted_state': JOB_STATES.has(attemptedState) ? attemptedState : 'UNKNOWN',
        'pixel.job.reason_code': TRANSITION_REASONS.has(reasonCode) ? reasonCode : 'UNKNOWN',
      },
    });
  }

  async accept(intent) {
    const traceId = this.#ids.nextTraceId();
    const rootSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId,
      spanId: rootSpanId,
      eventName: 'job.submission.received',
      attributes: {
        'pixel.environment': this.#environment,
        'pixel.relay.contract': RELAY_CONTRACT,
      },
    });

    const authority = authorityCategories(intent);
    if (authority.size > 0) {
      return this.#rejection(
        traceId,
        rootSpanId,
        'CLIENT_AUTHORITY_CLAIM_REJECTED',
        'job.submission.authority_rejected',
        { 'pixel.security.authority_claim_count': authority.size },
      );
    }
    const validation = validateJobSubmitIntentV1(intent);
    if (!validation.ok) {
      return this.#rejection(
        traceId,
        rootSpanId,
        'JOB_INTENT_INVALID',
        'job.submission.invalid',
        { 'pixel.validation.error_count': validation.errors.length },
      );
    }

    let context;
    try {
      context = frozenCopy(await this.#contextProvider.resolveJobContext());
      if (!validateJobContext(context).ok || context.source !== this.#contextSource || !sameRegistryBinding(context)) {
        throw new TypeError('Invalid job context');
      }
    } catch {
      return this.#rejection(
        traceId,
        rootSpanId,
        'JOB_CONTEXT_UNAVAILABLE',
        'job.context.resolution_failed',
        { 'pixel.provider.source': this.#contextSource },
      );
    }

    const execution = frozenCopy({
      capability: intent.requested_capability,
      tool_class: 'pixel.system-status',
      target: 'pixel.platform',
      parameter_hash: hash({}),
      worker_binding: context.worker_binding,
    });
    const fingerprint = hash({
      requester: context.requester,
      environment: this.#environment,
      organization: context.owner,
      job_type: intent.job_type,
      requested_capability: intent.requested_capability,
      tool_class: execution.tool_class,
      target: execution.target,
      parameter_hash: execution.parameter_hash,
    });
    const envelope = frozenCopy({
      job_id: this.#ids.nextJobId(),
      event_name: JOB_ENVELOPE_EVENT_NAME,
      schema_version: JOB_SCHEMA_VERSION,
      created_at: this.#clock(),
      environment: this.#environment,
      trace_id: traceId,
      span_id: rootSpanId,
      requester: context.requester,
      owner: context.owner,
      job_type: intent.job_type,
      requested_capability: intent.requested_capability,
      execution,
      state: 'SUBMITTED',
      idempotency: { key: intent.idempotency_key, fingerprint },
      provenance: {
        relay_contract: RELAY_CONTRACT,
        context_provider_contract: context.provider_contract,
        context_source: context.source,
      },
    });
    assertValidJobEnvelopeV1(envelope);
    const namespace = hash([context.requester.subject_id, this.#environment, intent.idempotency_key]);
    const claim = await this.#store.claimOrReturnExisting({
      namespace,
      fingerprint,
      candidateJob: envelope,
    });
    if (claim.disposition === 'CONFLICT') {
      this.#append({
        traceId,
        spanId: this.#ids.nextSpanId(),
        parentSpanId: rootSpanId,
        eventName: 'relay.idempotency.conflict',
        outcome: 'denied',
        severity: 'warning',
        attributes: { 'pixel.idempotency.outcome': 'CONFLICT' },
      });
      return frozenCopy({ disposition: 'CONFLICT', reason_code: 'IDEMPOTENCY_CONFLICT', job: null, trace_id: traceId });
    }
    if (claim.disposition === 'EXISTING') {
      this.#append({
        traceId,
        spanId: this.#ids.nextSpanId(),
        parentSpanId: rootSpanId,
        eventName: 'relay.submission.replayed',
        attributes: {
          'pixel.idempotency.outcome': 'EXISTING',
          'pixel.job.id': claim.job.envelope.job_id,
        },
      });
      return frozenCopy({ disposition: 'EXISTING', job: claim.job, trace_id: traceId });
    }
    if (claim.disposition !== 'CREATED') {
      return this.#rejection(traceId, rootSpanId, 'RELAY_UNAVAILABLE', 'relay.claim.failed');
    }

    const acceptedSpanId = this.#ids.nextSpanId();
    const accepted = assertValidJobTransitionV1(frozenCopy({
      transition_id: this.#ids.nextEventId(),
      event_name: JOB_TRANSITION_EVENT_NAME,
      schema_version: JOB_SCHEMA_VERSION,
      occurred_at: this.#clock(),
      environment: this.#environment,
      trace_id: traceId,
      span_id: acceptedSpanId,
      job_id: envelope.job_id,
      execution_id: null,
      from_state: 'SUBMITTED',
      to_state: 'ACCEPTED',
      reason_code: 'JOB_ACCEPTED',
      provenance: { relay_contract: RELAY_CONTRACT },
    }));
    const applied = await this.#store.applyTransition(envelope.job_id, accepted);
    if (applied.disposition !== 'APPLIED') {
      return frozenCopy({ disposition: 'UNAVAILABLE', job: applied.job, trace_id: traceId });
    }
    this.#append({
      traceId,
      spanId: acceptedSpanId,
      parentSpanId: rootSpanId,
      eventName: 'relay.job.accepted',
      attributes: {
        'pixel.job.id': envelope.job_id,
        'pixel.job.from_state': 'SUBMITTED',
        'pixel.job.to_state': 'ACCEPTED',
      },
    });
    return frozenCopy({ disposition: 'CREATED', job: applied.job, trace_id: traceId });
  }

  async execute(jobId) {
    const job = await this.#store.getJob(jobId);
    if (!job || job.current_state !== 'ACCEPTED') {
      if (job) this.#recordTransitionRejection(job, 'RUNNING', 'EXECUTION_STARTED');
      return frozenCopy({ disposition: 'INVALID_STATE', job, trace_id: job?.envelope.trace_id ?? null });
    }

    const executionId = this.#ids.nextExecutionId();
    const runningSpanId = this.#ids.nextSpanId();
    const running = assertValidJobTransitionV1(frozenCopy({
      transition_id: this.#ids.nextEventId(),
      event_name: JOB_TRANSITION_EVENT_NAME,
      schema_version: JOB_SCHEMA_VERSION,
      occurred_at: this.#clock(),
      environment: this.#environment,
      trace_id: job.envelope.trace_id,
      span_id: runningSpanId,
      job_id: job.envelope.job_id,
      execution_id: executionId,
      from_state: 'ACCEPTED',
      to_state: 'RUNNING',
      reason_code: 'EXECUTION_STARTED',
      provenance: { relay_contract: RELAY_CONTRACT },
    }));
    const applied = await this.#store.applyTransition(jobId, running);
    if (applied.disposition !== 'APPLIED') {
      if (applied.job) this.#recordTransitionRejection(applied.job, 'RUNNING', 'EXECUTION_STARTED');
      return frozenCopy({ disposition: 'INVALID_STATE', job: applied.job, trace_id: job.envelope.trace_id });
    }
    this.#append({
      traceId: job.envelope.trace_id,
      spanId: runningSpanId,
      parentSpanId: job.transitions.at(-1).span_id,
      eventName: 'relay.job.running',
      attributes: {
        'pixel.job.id': jobId,
        'pixel.job.execution_id': executionId,
        'pixel.job.from_state': 'ACCEPTED',
        'pixel.job.to_state': 'RUNNING',
      },
    });

    const requestSpanId = this.#ids.nextSpanId();
    const executionRequest = assertValidToolExecutionRequestV1(frozenCopy({
      request_id: this.#ids.nextEventId(),
      event_name: TOOL_EXECUTION_REQUEST_EVENT_NAME,
      schema_version: JOB_SCHEMA_VERSION,
      occurred_at: this.#clock(),
      environment: this.#environment,
      trace_id: job.envelope.trace_id,
      span_id: requestSpanId,
      job_id: jobId,
      execution_id: executionId,
      capability: job.envelope.execution.capability,
      tool_class: job.envelope.execution.tool_class,
      target: job.envelope.execution.target,
      parameter_hash: job.envelope.execution.parameter_hash,
      worker_binding: job.envelope.execution.worker_binding,
      provenance: { tool_gateway_contract: 'pixel.tool-gateway.v1' },
    }));
    this.#append({
      traceId: job.envelope.trace_id,
      spanId: requestSpanId,
      parentSpanId: runningSpanId,
      eventName: 'tool.execution.requested',
      attributes: {
        'pixel.job.id': jobId,
        'pixel.job.execution_id': executionId,
        'pixel.tool.capability': executionRequest.capability,
        'pixel.tool.class': executionRequest.tool_class,
        'pixel.tool.target': executionRequest.target,
      },
    });

    try {
      const result = await this.#toolGateway.execute({ executionRequest, parentSpanId: requestSpanId });
      return frozenCopy({ ...result, trace_id: job.envelope.trace_id });
    } catch {
      return frozenCopy({
        disposition: 'UNAVAILABLE',
        job: await this.#store.getJob(jobId),
        trace_id: job.envelope.trace_id,
      });
    }
  }

  async submit(intent) {
    const accepted = await this.accept(intent);
    if (accepted.disposition !== 'CREATED') return accepted;
    const executed = await this.execute(accepted.job.envelope.job_id);
    if (!['COMPLETED', 'FAILED'].includes(executed.disposition)) return executed;
    return frozenCopy({ ...executed, disposition: 'CREATED' });
  }

  async attemptTransition(jobId, { toState, reasonCode } = {}) {
    const job = await this.#store.getJob(jobId);
    if (!job) return frozenCopy({ disposition: 'INVALID_STATE', job: null, trace_id: null });
    const attemptedState = JOB_STATES.has(toState) ? toState : 'UNKNOWN';
    const boundedReason = TRANSITION_REASONS.has(reasonCode) ? reasonCode : 'UNKNOWN';
    const candidate = frozenCopy({
      transition_id: this.#ids.nextEventId(),
      event_name: JOB_TRANSITION_EVENT_NAME,
      schema_version: JOB_SCHEMA_VERSION,
      occurred_at: this.#clock(),
      environment: this.#environment,
      trace_id: job.envelope.trace_id,
      span_id: this.#ids.nextSpanId(),
      job_id: job.envelope.job_id,
      execution_id: job.execution_id,
      from_state: job.current_state,
      to_state: attemptedState,
      reason_code: boundedReason,
      provenance: { relay_contract: RELAY_CONTRACT },
    });
    if (validateJobTransitionV1(candidate).ok) {
      throw new TypeError('attemptTransition is restricted to invalid lifecycle evidence');
    }
    const rejected = await this.#store.applyTransition(jobId, candidate);
    if (rejected.disposition === 'APPLIED') throw new TypeError('Relay store applied an invalid transition');
    this.#recordTransitionRejection(job, attemptedState, boundedReason);
    return frozenCopy({ disposition: 'INVALID_STATE', job: rejected.job, trace_id: job.envelope.trace_id });
  }

  async getJob(jobId) {
    return this.#store.getJob(jobId);
  }
}
