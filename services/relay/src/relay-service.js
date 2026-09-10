import { createHash } from 'node:crypto';

import {
  assertJobContextProvider,
  assertModelRelayStoreAdapter,
  assertRelayStoreAdapter,
  validateJobContext,
} from '../../../packages/adapter-sdk/src/job-runtime-adapters.js';
import { snapshotSafePlainData } from '../../../packages/adapter-sdk/src/model-runtime-adapters.js';
import {
  JOB_ENVELOPE_EVENT_NAME,
  JOB_RESULT_EVENT_NAME,
  JOB_SCHEMA_VERSION,
  JOB_TRANSITION_EVENT_NAME,
  TOOL_EXECUTION_REQUEST_EVENT_NAME,
  assertValidJobEnvelopeV1,
  assertValidJobResultV1,
  assertValidJobTransitionV1,
  assertValidToolExecutionRequestV1,
  validateJobSubmitIntentV1,
  validateJobTransitionV1,
} from '../../../packages/contracts/src/job-v1.js';
import {
  MODEL_GATEWAY_CONTRACT,
  MODEL_INVOCATION_EVENT_NAME,
  MODEL_SCHEMA_VERSION,
  SYSTEM_STATUS_SUMMARY_TEMPLATE,
  assertValidModelInvocationV1,
  countModelInputTokenUnits,
  hashInstructionTemplateBinding,
  hashMemoryContextPackageBinding,
  validateModelGatewayOutcomeV1,
} from '../../../packages/contracts/src/model-v1.js';
import { tokenizeMemoryText } from '../../../packages/contracts/src/memory-v1.js';
import { getSystemsJobBinding } from '../../../packages/registry/src/organization-bindings.js';
import { evaluateModelOperationEligibility } from '../../policy/src/model-operation-policy.js';
import { selectAlphaModelRoute } from '../../policy/src/model-routing-policy.js';

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

function requireDependencies({ environment, contextProvider, store, toolGateway, memory, modelGateway, evidence, ids, clock }) {
  if (!ENVIRONMENTS.has(environment)) throw new TypeError('Relay requires a canonical environment');
  assertJobContextProvider(contextProvider);
  assertRelayStoreAdapter(store);
  if (!toolGateway || typeof toolGateway.execute !== 'function') throw new TypeError('Relay requires ToolGateway');
  if ((memory === undefined) !== (modelGateway === undefined)) {
    throw new TypeError('Relay model execution requires both Memory and Model Gateway');
  }
  if (memory !== undefined) {
    assertModelRelayStoreAdapter(store);
    if (!memory || typeof memory.buildContext !== 'function' || typeof memory.getApprovedContextPackage !== 'function') {
      throw new TypeError('Relay model execution requires approved Memory package construction');
    }
    if (!modelGateway || typeof modelGateway.invoke !== 'function') {
      throw new TypeError('Relay model execution requires Model Gateway');
    }
  }
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
  #memory;
  #modelGateway;
  #store;
  #toolGateway;

  constructor({ environment, contextProvider, store, toolGateway, memory, modelGateway, evidence, ids, clock }) {
    requireDependencies({ environment, contextProvider, store, toolGateway, memory, modelGateway, evidence, ids, clock });
    this.#environment = environment;
    this.#contextProvider = contextProvider;
    this.#contextSource = contextProvider.source;
    this.#store = store;
    this.#toolGateway = toolGateway;
    this.#memory = memory;
    this.#modelGateway = modelGateway;
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

  #gatewayOutcomeMatches(invocation, outcome) {
    if (!validateModelGatewayOutcomeV1(outcome).ok
      || outcome.environment !== invocation.environment
      || outcome.trace_id !== invocation.trace_id
      || outcome.job_id !== invocation.job_id
      || outcome.execution_id !== invocation.execution_id
      || outcome.invocation_id !== invocation.invocation_id
      || outcome.operation !== invocation.operation
      || outcome.context.package_id !== invocation.context.package_id
      || outcome.context.package_hash !== invocation.context.package_hash) return false;

    const eligibility = evaluateModelOperationEligibility({ operation: invocation.operation, execution: invocation.execution });
    if (eligibility.decision === 'DENY') {
      return outcome.status === 'FAILED'
        && outcome.reason_code === 'OPERATION_INELIGIBLE'
        && outcome.route_decision_id === null
        && outcome.placement === null;
    }
    const route = selectAlphaModelRoute(invocation.environment);
    if (route.decision === 'DENY') {
      return outcome.status === 'FAILED'
        && outcome.reason_code === 'ROUTE_UNSUPPORTED'
        && outcome.placement === null;
    }
    if (outcome.placement !== null && JSON.stringify(outcome.placement) !== JSON.stringify(route.placement)) return false;
    if (outcome.status === 'SUCCEEDED') {
      const outputUnits = tokenizeMemoryText(outcome.output.text).length;
      return outcome.reason_code === 'MODEL_OUTPUT_AVAILABLE'
        && outcome.output.hash === createHash('sha256').update(outcome.output.text, 'utf8').digest('hex')
        && outcome.output.token_units === outputUnits
        && outputUnits <= route.budget.max_output_token_units
        && Array.from(outcome.output.text).length <= route.budget.max_output_chars;
    }
    return outcome.output === null;
  }

  async #commitModelTerminal(invocation, outcome, parentSpanId, invalidOutcome = false) {
    const outcomeCode = invalidOutcome || ['PROVIDER_RESULT_INVALID', 'OUTPUT_BUDGET_EXCEEDED'].includes(outcome?.reason_code)
      ? 'WORKER_RESULT_INVALID'
      : outcome?.status === 'SUCCEEDED' ? 'SYSTEM_STATUS_AVAILABLE' : 'WORKER_UNAVAILABLE';
    const state = outcomeCode === 'SYSTEM_STATUS_AVAILABLE' ? 'COMPLETED' : 'FAILED';
    const summary = ({
      SYSTEM_STATUS_AVAILABLE: 'Pixel system status is available.',
      WORKER_UNAVAILABLE: 'Pixel could not retrieve system status.',
      WORKER_RESULT_INVALID: 'Pixel rejected an invalid model result.',
    })[outcomeCode];
    const placement = invalidOutcome ? null : outcome.placement;
    const resultSpanId = this.#ids.nextSpanId();
    const result = assertValidJobResultV1(frozenCopy({
      result_id: this.#ids.nextEventId(),
      event_name: JOB_RESULT_EVENT_NAME,
      schema_version: JOB_SCHEMA_VERSION,
      completed_at: this.#clock(),
      environment: invocation.environment,
      trace_id: invocation.trace_id,
      span_id: resultSpanId,
      job_id: invocation.job_id,
      execution_id: invocation.execution_id,
      state,
      outcome_code: outcomeCode,
      summary,
      provenance: {
        relay_contract: RELAY_CONTRACT,
        model_gateway_contract: MODEL_GATEWAY_CONTRACT,
        model_invocation_id: invocation.invocation_id,
        model_runtime_id: placement?.runtime_id ?? null,
        model_id: placement?.model_id ?? null,
        model_source: placement?.source ?? null,
      },
    }));
    const reasonCode = state === 'COMPLETED'
      ? 'EXECUTION_COMPLETED'
      : outcomeCode === 'WORKER_UNAVAILABLE' ? 'WORKER_FAILED' : 'WORKER_RESULT_INVALID';
    const transition = assertValidJobTransitionV1(frozenCopy({
      transition_id: this.#ids.nextEventId(),
      event_name: JOB_TRANSITION_EVENT_NAME,
      schema_version: JOB_SCHEMA_VERSION,
      occurred_at: this.#clock(),
      environment: invocation.environment,
      trace_id: invocation.trace_id,
      span_id: this.#ids.nextSpanId(),
      job_id: invocation.job_id,
      execution_id: invocation.execution_id,
      from_state: 'RUNNING',
      to_state: state,
      reason_code: reasonCode,
      provenance: { relay_contract: RELAY_CONTRACT },
    }));

    const validationSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: invocation.trace_id, spanId: validationSpanId, parentSpanId,
      eventName: 'contract.job_result.validated',
      attributes: {
        'pixel.job.id': invocation.job_id,
        'pixel.job.execution_id': invocation.execution_id,
        'pixel.job.outcome_code': outcomeCode,
      },
    });
    const committed = await this.#store.commitTerminalResult(invocation.job_id, transition, result);
    if (committed.disposition !== 'COMMITTED') {
      return frozenCopy({
        disposition: 'UNAVAILABLE', job: await this.#store.getJob(invocation.job_id),
        model_output: null, trace_id: invocation.trace_id,
      });
    }
    this.#append({
      traceId: invocation.trace_id, spanId: resultSpanId, parentSpanId: validationSpanId,
      eventName: 'job.result.projected', outcome: state === 'COMPLETED' ? 'success' : 'failure',
      severity: state === 'COMPLETED' ? 'info' : 'warning',
      attributes: { 'pixel.job.id': invocation.job_id, 'pixel.job.outcome_code': outcomeCode },
    });
    this.#append({
      traceId: invocation.trace_id, spanId: transition.span_id, parentSpanId: resultSpanId,
      eventName: state === 'COMPLETED' ? 'relay.job.completed' : 'relay.job.failed',
      outcome: state === 'COMPLETED' ? 'success' : 'failure', severity: state === 'COMPLETED' ? 'info' : 'warning',
      attributes: {
        'pixel.job.id': invocation.job_id,
        'pixel.job.from_state': 'RUNNING',
        'pixel.job.to_state': state,
        'pixel.job.reason_code': reasonCode,
      },
    });
    return frozenCopy({
      disposition: state,
      job: committed.job,
      model_output: state === 'COMPLETED' ? outcome.output : null,
      trace_id: invocation.trace_id,
    });
  }

  async executeModelSummary(jobId) {
    const job = await this.#store.getJob(jobId);
    if (!this.#memory || !this.#modelGateway) {
      return frozenCopy({ disposition: 'UNAVAILABLE', job, model_output: null, trace_id: job?.envelope.trace_id ?? null });
    }
    if (!job || job.current_state !== 'ACCEPTED') {
      if (job) this.#recordTransitionRejection(job, 'RUNNING', 'EXECUTION_STARTED');
      return frozenCopy({ disposition: 'INVALID_STATE', job, model_output: null, trace_id: job?.envelope.trace_id ?? null });
    }

    let context;
    try {
      context = await this.#memory.buildContext({ job_id: jobId, query: 'system status' });
    } catch {
      return frozenCopy({ disposition: 'UNAVAILABLE', job: await this.#store.getJob(jobId), model_output: null, trace_id: job.envelope.trace_id });
    }
    if (context?.disposition !== 'CREATED' || !context.package) {
      return frozenCopy({ disposition: 'UNAVAILABLE', job: await this.#store.getJob(jobId), model_output: null, trace_id: job.envelope.trace_id });
    }

    const executionId = this.#ids.nextExecutionId();
    const runningSpanId = this.#ids.nextSpanId();
    const running = assertValidJobTransitionV1(frozenCopy({
      transition_id: this.#ids.nextEventId(), event_name: JOB_TRANSITION_EVENT_NAME,
      schema_version: JOB_SCHEMA_VERSION, occurred_at: this.#clock(), environment: this.#environment,
      trace_id: job.envelope.trace_id, span_id: runningSpanId, job_id: jobId,
      execution_id: executionId, from_state: 'ACCEPTED', to_state: 'RUNNING',
      reason_code: 'EXECUTION_STARTED', provenance: { relay_contract: RELAY_CONTRACT },
    }));
    const applied = await this.#store.applyTransition(jobId, running);
    if (applied.disposition !== 'APPLIED') {
      if (applied.job) this.#recordTransitionRejection(applied.job, 'RUNNING', 'EXECUTION_STARTED');
      return frozenCopy({ disposition: 'INVALID_STATE', job: applied.job, model_output: null, trace_id: job.envelope.trace_id });
    }
    this.#append({
      traceId: job.envelope.trace_id, spanId: runningSpanId, parentSpanId: context.package.span_id,
      eventName: 'relay.job.running',
      attributes: {
        'pixel.job.id': jobId, 'pixel.job.execution_id': executionId,
        'pixel.job.from_state': 'ACCEPTED', 'pixel.job.to_state': 'RUNNING',
      },
    });

    const packageHash = hashMemoryContextPackageBinding(context.package);
    const invocationSpanId = this.#ids.nextSpanId();
    const invocation = assertValidModelInvocationV1(frozenCopy({
      invocation_id: this.#ids.nextEventId(),
      event_name: MODEL_INVOCATION_EVENT_NAME,
      schema_version: MODEL_SCHEMA_VERSION,
      created_at: this.#clock(),
      environment: job.envelope.environment,
      trace_id: job.envelope.trace_id,
      span_id: invocationSpanId,
      job_id: jobId,
      execution_id: executionId,
      operation: 'SYSTEM_STATUS_SUMMARY',
      execution: {
        job_type: job.envelope.job_type,
        capability: job.envelope.execution.capability,
        tool_class: job.envelope.execution.tool_class,
        target: job.envelope.execution.target,
      },
      pixel_agent_binding: {
        agent_id: job.envelope.execution.worker_binding.worker_id,
        department_ref: job.envelope.execution.worker_binding.department_ref,
        role_ref: job.envelope.execution.worker_binding.role_ref,
      },
      instruction: {
        template_id: SYSTEM_STATUS_SUMMARY_TEMPLATE.template_id,
        version: SYSTEM_STATUS_SUMMARY_TEMPLATE.version,
        hash: hashInstructionTemplateBinding(SYSTEM_STATUS_SUMMARY_TEMPLATE),
      },
      context: {
        package_id: context.package.package_id,
        package_hash: packageHash,
        item_count: context.package.items.length,
        text_chars: context.package.items.reduce((sum, item) => sum + Array.from(item.text).length, 0),
        input_token_units: countModelInputTokenUnits(SYSTEM_STATUS_SUMMARY_TEMPLATE.text, context.package.items),
      },
      provenance: { relay_contract: RELAY_CONTRACT },
    }));
    this.#append({
      traceId: invocation.trace_id, spanId: invocationSpanId, parentSpanId: runningSpanId,
      eventName: 'model.invocation.created',
      attributes: {
        'pixel.job.id': jobId, 'pixel.job.execution_id': executionId,
        'pixel.model.invocation_id': invocation.invocation_id,
        'pixel.model.operation': invocation.operation,
        'pixel.memory.package_hash': packageHash,
      },
    });
    const claim = await this.#store.claimModelInvocation(jobId, invocation);
    if (claim.disposition !== 'INVOKE_NOW') {
      return frozenCopy({ disposition: 'UNAVAILABLE', job: claim.job, model_output: null, trace_id: invocation.trace_id });
    }
    const claimedSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: invocation.trace_id, spanId: claimedSpanId, parentSpanId: invocationSpanId,
      eventName: 'model.invocation.claimed',
      attributes: {
        'pixel.job.id': jobId, 'pixel.job.execution_id': executionId,
        'pixel.model.invocation_id': invocation.invocation_id,
      },
    });

    let outcome;
    try {
      outcome = snapshotSafePlainData(await this.#modelGateway.invoke({ invocation, parentSpanId: claimedSpanId }));
    } catch {
      const rejectedSpanId = this.#ids.nextSpanId();
      this.#append({
        traceId: invocation.trace_id, spanId: rejectedSpanId, parentSpanId: claimedSpanId,
        eventName: 'model.gateway.outcome_rejected', outcome: 'failure', severity: 'warning',
        attributes: {
          'pixel.job.id': jobId, 'pixel.job.execution_id': executionId,
          'pixel.model.invocation_id': invocation.invocation_id,
          'pixel.model.reason_code': 'GATEWAY_OUTCOME_INVALID',
        },
      });
      return this.#commitModelTerminal(invocation, null, rejectedSpanId, true);
    }
    if (!this.#gatewayOutcomeMatches(invocation, outcome)) {
      const rejectedSpanId = this.#ids.nextSpanId();
      this.#append({
        traceId: invocation.trace_id, spanId: rejectedSpanId, parentSpanId: claimedSpanId,
        eventName: 'model.gateway.outcome_rejected', outcome: 'failure', severity: 'warning',
        attributes: {
          'pixel.job.id': jobId, 'pixel.job.execution_id': executionId,
          'pixel.model.invocation_id': invocation.invocation_id,
          'pixel.model.reason_code': 'GATEWAY_OUTCOME_INVALID',
        },
      });
      return this.#commitModelTerminal(invocation, null, rejectedSpanId, true);
    }
    const acceptedSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: invocation.trace_id, spanId: acceptedSpanId, parentSpanId: outcome.span_id,
      eventName: 'model.gateway.outcome_accepted',
      outcome: outcome.status === 'SUCCEEDED' ? 'success' : 'failure',
      severity: outcome.status === 'SUCCEEDED' ? 'info' : 'warning',
      attributes: {
        'pixel.job.id': jobId, 'pixel.job.execution_id': executionId,
        'pixel.model.invocation_id': invocation.invocation_id,
        'pixel.model.reason_code': outcome.reason_code,
        'pixel.model.status': outcome.status,
      },
    });
    return this.#commitModelTerminal(invocation, outcome, acceptedSpanId);
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
