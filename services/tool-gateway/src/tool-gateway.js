import {
  assertCapabilityGrantProvider,
  assertRelayStoreAdapter,
  assertSystemStatusWorker,
  SYSTEM_STATUS_WORKER_CONTRACT,
  validateCapabilityAuthorizationContext,
  validateCapabilityGrantContext,
  validateWorkerOutcome,
} from '../../../packages/adapter-sdk/src/job-runtime-adapters.js';
import {
  JOB_RESULT_EVENT_NAME,
  JOB_SCHEMA_VERSION,
  JOB_TRANSITION_EVENT_NAME,
  TOOL_CAPABILITY_DECISION_EVENT_NAME,
  assertValidJobResultV1,
  assertValidJobTransitionV1,
  assertValidToolCapabilityDecisionV1,
  assertValidToolExecutionRequestV1,
} from '../../../packages/contracts/src/job-v1.js';

export const TOOL_GATEWAY_CONTRACT = 'pixel.tool-gateway.v1';

const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const SIMULATOR_ENVIRONMENTS = new Set(['dev', 'simulation']);
const SUMMARY_BY_OUTCOME = Object.freeze({
  SYSTEM_STATUS_AVAILABLE: 'Pixel system status is available.',
  CAPABILITY_DENIED: 'Pixel denied this job capability before tool execution.',
  AUTHORIZATION_UNAVAILABLE: 'Pixel could not verify this job capability.',
  WORKER_UNAVAILABLE: 'Pixel could not retrieve system status.',
  WORKER_RESULT_INVALID: 'Pixel rejected an invalid worker result.',
});

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

function sameBinding(request, decision) {
  return request.request_id === decision.request_id
    && request.job_id === decision.job_id
    && request.execution_id === decision.execution_id
    && request.capability === decision.capability
    && request.tool_class === decision.tool_class
    && request.target === decision.target
    && request.parameter_hash === decision.parameter_hash
    && request.environment === decision.environment
    && request.worker_binding.worker_id === decision.worker_binding.worker_id
    && request.worker_binding.department_ref === decision.worker_binding.department_ref
    && request.worker_binding.role_ref === decision.worker_binding.role_ref;
}

function sameWorkerBinding(left, right) {
  return left?.worker_id === right?.worker_id
    && left?.department_ref === right?.department_ref
    && left?.role_ref === right?.role_ref;
}

function authorizationContextFor(job, request) {
  const execution = job?.envelope?.execution;
  if (
    !job
    || job.current_state !== 'RUNNING'
    || job.execution_id !== request.execution_id
    || job.envelope.job_id !== request.job_id
    || job.envelope.trace_id !== request.trace_id
    || job.envelope.environment !== request.environment
    || execution?.capability !== request.capability
    || execution?.tool_class !== request.tool_class
    || execution?.target !== request.target
    || execution?.parameter_hash !== request.parameter_hash
    || !sameWorkerBinding(execution?.worker_binding, request.worker_binding)
  ) return null;
  const context = frozenCopy({
    job_id: job.envelope.job_id,
    execution_id: job.execution_id,
    requester: job.envelope.requester,
    owner: job.envelope.owner,
    worker_binding: execution.worker_binding,
    current_state: job.current_state,
    environment: job.envelope.environment,
    job_type: job.envelope.job_type,
    capability: execution.capability,
    tool_class: execution.tool_class,
    target: execution.target,
    parameter_hash: execution.parameter_hash,
  });
  return validateCapabilityAuthorizationContext(context).ok ? context : null;
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireDependencies({ environment, grantProvider, store, worker, evidence, ids, clock }) {
  if (!ENVIRONMENTS.has(environment)) throw new TypeError('ToolGateway requires a canonical environment');
  assertCapabilityGrantProvider(grantProvider);
  assertRelayStoreAdapter(store);
  assertSystemStatusWorker(worker);
  if (!evidence || typeof evidence.append !== 'function') throw new TypeError('ToolGateway requires evidence');
  if (!ids || typeof ids.nextEventId !== 'function' || typeof ids.nextSpanId !== 'function') {
    throw new TypeError('ToolGateway requires event and span ID sources');
  }
  if (typeof clock !== 'function') throw new TypeError('ToolGateway requires a clock');
  if ([grantProvider, store, worker].some(({ source }) => source === 'simulator') && !SIMULATOR_ENVIRONMENTS.has(environment)) {
    throw new RangeError('Simulator Tool Gateway adapters may run only in dev or simulation');
  }
}

export class ToolGateway {
  #clock;
  #environment;
  #evidence;
  #grantProvider;
  #grantSource;
  #ids;
  #store;
  #worker;
  #workerSource;

  constructor({ environment, grantProvider, store, worker, evidence, ids, clock }) {
    requireDependencies({ environment, grantProvider, store, worker, evidence, ids, clock });
    this.#environment = environment;
    this.#grantProvider = grantProvider;
    this.#grantSource = grantProvider.source;
    this.#store = store;
    this.#worker = worker;
    this.#workerSource = worker.source;
    this.#evidence = evidence;
    this.#ids = ids;
    this.#clock = clock;
  }

  get source() {
    return [this.#grantSource, this.#store.source, this.#workerSource].includes('simulator') ? 'simulator' : 'live';
  }

  #append({
    traceId, spanId, parentSpanId, eventName, outcome = 'success', severity = 'info',
    serviceName = 'pixel.tool-gateway', attributes = {},
  }) {
    return this.#evidence.append({
      traceId,
      spanId,
      parentSpanId,
      serviceName,
      eventName,
      outcome,
      severity,
      attributes,
    });
  }

  #decision(request, { decision, reasonCode, policyId }) {
    const value = frozenCopy({
      decision_id: this.#ids.nextEventId(),
      event_name: TOOL_CAPABILITY_DECISION_EVENT_NAME,
      schema_version: JOB_SCHEMA_VERSION,
      decided_at: this.#clock(),
      environment: request.environment,
      trace_id: request.trace_id,
      span_id: this.#ids.nextSpanId(),
      request_id: request.request_id,
      job_id: request.job_id,
      execution_id: request.execution_id,
      capability: request.capability,
      tool_class: request.tool_class,
      target: request.target,
      parameter_hash: request.parameter_hash,
      worker_binding: request.worker_binding,
      decision,
      reason_code: reasonCode,
      policy_id: policyId,
      provenance: {
        tool_gateway_contract: TOOL_GATEWAY_CONTRACT,
        grant_provider_contract: 'pixel.capability-grant-provider.v1',
        grant_source: this.#grantSource,
      },
    });
    return assertValidToolCapabilityDecisionV1(value);
  }

  #terminalContracts(request, { state, outcomeCode, workerSource, parentSpanId }) {
    const resultSpanId = this.#ids.nextSpanId();
    const result = frozenCopy({
      result_id: this.#ids.nextEventId(),
      event_name: JOB_RESULT_EVENT_NAME,
      schema_version: JOB_SCHEMA_VERSION,
      completed_at: this.#clock(),
      environment: request.environment,
      trace_id: request.trace_id,
      span_id: resultSpanId,
      job_id: request.job_id,
      execution_id: request.execution_id,
      state,
      outcome_code: outcomeCode,
      summary: SUMMARY_BY_OUTCOME[outcomeCode],
      provenance: {
        relay_contract: 'pixel.relay.v1',
        worker_contract: workerSource === null ? null : SYSTEM_STATUS_WORKER_CONTRACT,
        worker_source: workerSource,
      },
    });
    assertValidJobResultV1(result);

    const reasonCode = state === 'COMPLETED'
      ? 'EXECUTION_COMPLETED'
      : ({
        CAPABILITY_DENIED: 'CAPABILITY_DENIED',
        AUTHORIZATION_UNAVAILABLE: 'AUTHORIZATION_UNAVAILABLE',
        WORKER_UNAVAILABLE: 'WORKER_FAILED',
        WORKER_RESULT_INVALID: 'WORKER_RESULT_INVALID',
      })[outcomeCode];
    const transition = frozenCopy({
      transition_id: this.#ids.nextEventId(),
      event_name: JOB_TRANSITION_EVENT_NAME,
      schema_version: JOB_SCHEMA_VERSION,
      occurred_at: this.#clock(),
      environment: request.environment,
      trace_id: request.trace_id,
      span_id: this.#ids.nextSpanId(),
      job_id: request.job_id,
      execution_id: request.execution_id,
      from_state: 'RUNNING',
      to_state: state,
      reason_code: reasonCode,
      provenance: { relay_contract: 'pixel.relay.v1' },
    });
    assertValidJobTransitionV1(transition);
    return { parentSpanId, result, transition };
  }

  async #commitTerminal(request, options) {
    const { parentSpanId, result, transition } = this.#terminalContracts(request, options);
    const validationSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: request.trace_id,
      spanId: validationSpanId,
      parentSpanId,
      eventName: 'contract.job_result.validated',
      serviceName: 'pixel.relay',
      attributes: {
        'pixel.job.id': request.job_id,
        'pixel.job.execution_id': request.execution_id,
        'pixel.job.outcome_code': result.outcome_code,
      },
    });
    const committed = await this.#store.commitTerminalResult(request.job_id, transition, result);
    if (committed.disposition !== 'COMMITTED') {
      return { disposition: 'UNAVAILABLE', job: await this.#store.getJob(request.job_id) };
    }
    this.#append({
      traceId: request.trace_id,
      spanId: result.span_id,
      parentSpanId: validationSpanId,
      eventName: 'job.result.projected',
      serviceName: 'pixel.relay',
      outcome: result.state === 'COMPLETED' ? 'success' : 'failure',
      severity: result.state === 'COMPLETED' ? 'info' : 'warning',
      attributes: {
        'pixel.job.id': request.job_id,
        'pixel.job.outcome_code': result.outcome_code,
      },
    });
    this.#append({
      traceId: request.trace_id,
      spanId: transition.span_id,
      parentSpanId: result.span_id,
      eventName: result.state === 'COMPLETED' ? 'relay.job.completed' : 'relay.job.failed',
      serviceName: 'pixel.relay',
      outcome: result.state === 'COMPLETED' ? 'success' : 'failure',
      severity: result.state === 'COMPLETED' ? 'info' : 'warning',
      attributes: {
        'pixel.job.id': request.job_id,
        'pixel.job.from_state': 'RUNNING',
        'pixel.job.to_state': result.state,
        'pixel.job.reason_code': transition.reason_code,
      },
    });
    return { disposition: result.state, job: committed.job };
  }

  async execute({ executionRequest, parentSpanId }) {
    const request = assertValidToolExecutionRequestV1(executionRequest);
    if (request.environment !== this.#environment) {
      return { disposition: 'UNAVAILABLE', job: await this.#store.getJob(request.job_id) };
    }
    const gateSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: request.trace_id,
      spanId: gateSpanId,
      parentSpanId,
      eventName: 'tool_gateway.evaluation.started',
      attributes: {
        'pixel.job.id': request.job_id,
        'pixel.job.execution_id': request.execution_id,
        'pixel.tool.capability': request.capability,
      },
    });

    let grants;
    let authorizationContext = null;
    try {
      authorizationContext = authorizationContextFor(await this.#store.getJob(request.job_id), request);
    } catch {
      // An unreadable canonical job is an indeterminate authorization context.
    }
    let authorizationUnavailable = authorizationContext === null;
    if (!authorizationUnavailable) {
      try {
        grants = frozenCopy(await this.#grantProvider.resolveCapabilities(authorizationContext));
        const currentContext = authorizationContextFor(await this.#store.getJob(request.job_id), request);
        if (
          !validateCapabilityGrantContext(grants).ok
          || grants.source !== this.#grantSource
          || !sameRecord(authorizationContext, currentContext)
        ) authorizationUnavailable = true;
      } catch {
        authorizationUnavailable = true;
      }
    }

    const implemented = request.capability === 'pixel.system-status.read';
    const allowed = !authorizationUnavailable
      && implemented
      && grants.capabilities.includes(request.capability);
    const decision = this.#decision(request, {
      decision: allowed ? 'ALLOW' : 'DENY',
      reasonCode: allowed
        ? 'CAPABILITY_GRANTED'
        : authorizationUnavailable ? 'AUTHORIZATION_UNAVAILABLE' : 'CAPABILITY_NOT_GRANTED',
      policyId: authorizationUnavailable ? null : grants.policy_id,
    });
    if (!sameBinding(request, decision)) {
      return { disposition: 'UNAVAILABLE', job: await this.#store.getJob(request.job_id) };
    }
    this.#append({
      traceId: request.trace_id,
      spanId: decision.span_id,
      parentSpanId: gateSpanId,
      eventName: allowed ? 'tool.capability.allowed' : 'tool.capability.denied',
      outcome: allowed ? 'success' : 'denied',
      severity: allowed ? 'info' : 'warning',
      attributes: {
        'pixel.job.id': request.job_id,
        'pixel.job.execution_id': request.execution_id,
        'pixel.tool.capability': request.capability,
        'pixel.tool.decision': decision.decision,
        'pixel.tool.reason_code': decision.reason_code,
      },
    });

    const recorded = await this.#store.recordGatewayDecision(request.job_id, request, decision);
    if (recorded.disposition !== 'RECORDED') {
      return { disposition: 'UNAVAILABLE', job: await this.#store.getJob(request.job_id) };
    }
    if (!allowed) {
      return this.#commitTerminal(request, {
        state: 'FAILED',
        outcomeCode: authorizationUnavailable ? 'AUTHORIZATION_UNAVAILABLE' : 'CAPABILITY_DENIED',
        workerSource: null,
        parentSpanId: decision.span_id,
      });
    }

    const claim = await this.#store.claimWorkerInvocation(request.job_id, request, decision);
    if (claim.disposition !== 'INVOKE_NOW') {
      return { disposition: claim.disposition, job: claim.job };
    }

    const workerStartSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: request.trace_id,
      spanId: workerStartSpanId,
      parentSpanId: decision.span_id,
      eventName: 'worker.execution.started',
      serviceName: 'pixel.system-status-worker',
      attributes: {
        'pixel.job.id': request.job_id,
        'pixel.job.execution_id': request.execution_id,
        'pixel.worker.id': request.worker_binding.worker_id,
      },
    });

    let workerOutcome;
    let workerThrew = false;
    try {
      workerOutcome = frozenCopy(await this.#worker.execute(frozenCopy(request)));
    } catch {
      workerThrew = true;
    }
    const validWorkerOutcome = !workerThrew && validateWorkerOutcome(workerOutcome).ok;
    const outcomeCode = workerThrew
      ? 'WORKER_UNAVAILABLE'
      : validWorkerOutcome ? workerOutcome.outcome_code : 'WORKER_RESULT_INVALID';
    const workerEndSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: request.trace_id,
      spanId: workerEndSpanId,
      parentSpanId: workerStartSpanId,
      eventName: 'worker.execution.finished',
      serviceName: 'pixel.system-status-worker',
      outcome: outcomeCode === 'SYSTEM_STATUS_AVAILABLE' ? 'success' : 'failure',
      severity: outcomeCode === 'SYSTEM_STATUS_AVAILABLE' ? 'info' : 'warning',
      attributes: {
        'pixel.job.id': request.job_id,
        'pixel.job.execution_id': request.execution_id,
        'pixel.worker.outcome_code': outcomeCode,
      },
    });

    return this.#commitTerminal(request, {
      state: outcomeCode === 'SYSTEM_STATUS_AVAILABLE' ? 'COMPLETED' : 'FAILED',
      outcomeCode,
      workerSource: this.#workerSource,
      parentSpanId: workerEndSpanId,
    });
  }
}
