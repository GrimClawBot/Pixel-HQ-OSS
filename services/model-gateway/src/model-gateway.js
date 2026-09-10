import { createHash } from 'node:crypto';

import {
  assertModelRelayStoreAdapter,
} from '../../../packages/adapter-sdk/src/job-runtime-adapters.js';
import {
  assertModelRuntimeAdapter,
  snapshotModelProviderResult,
  snapshotSafePlainData,
} from '../../../packages/adapter-sdk/src/model-runtime-adapters.js';
import { validateJobEnvelopeV1, validateJobTransitionV1 } from '../../../packages/contracts/src/job-v1.js';
import { validateMemoryContextPackageV1 } from '../../../packages/contracts/src/memory-v1.js';
import {
  MODEL_GATEWAY_CONTRACT,
  MODEL_GATEWAY_OUTCOME_EVENT_NAME,
  MODEL_ROUTE_DECISION_EVENT_NAME,
  MODEL_SCHEMA_VERSION,
  SYSTEM_STATUS_SUMMARY_TEMPLATE,
  assertValidModelGatewayOutcomeV1,
  assertValidModelProviderRequestV1,
  assertValidModelRouteDecisionV1,
  countModelInputTokenUnits,
  hashInstructionTemplateBinding,
  hashMemoryContextPackageBinding,
  validateModelInvocationV1,
} from '../../../packages/contracts/src/model-v1.js';
import { evaluateModelOperationEligibility } from '../../policy/src/model-operation-policy.js';
import { selectAlphaModelRoute } from '../../policy/src/model-routing-policy.js';

const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const INPUT_FIELDS = new Set(['invocation', 'parentSpanId']);

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

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validJobProjection(job) {
  if (!job || !validateJobEnvelopeV1(job.envelope).ok || !Array.isArray(job.transitions)) return false;
  let state = job.envelope.state;
  for (const transition of job.transitions) {
    if (!validateJobTransitionV1(transition).ok
      || transition.job_id !== job.envelope.job_id
      || transition.trace_id !== job.envelope.trace_id
      || transition.environment !== job.envelope.environment
      || transition.from_state !== state) return false;
    state = transition.to_state;
  }
  return state === job.current_state;
}

function requireDependencies({ environment, store, memory, adapters, evidence, ids, clock }) {
  if (!ENVIRONMENTS.has(environment)) throw new TypeError('Model Gateway requires a canonical environment');
  assertModelRelayStoreAdapter(store);
  if (!memory || typeof memory.getApprovedContextPackage !== 'function') {
    throw new TypeError('Model Gateway requires approved Memory package lookup');
  }
  if (!Array.isArray(adapters)) throw new TypeError('Model Gateway requires an adapter registry array');
  for (const adapter of adapters) assertModelRuntimeAdapter(adapter);
  if (!evidence || typeof evidence.append !== 'function') throw new TypeError('Model Gateway requires evidence');
  if (!ids || typeof ids.nextEventId !== 'function' || typeof ids.nextSpanId !== 'function') {
    throw new TypeError('Model Gateway requires event and span ID sources');
  }
  if (typeof clock !== 'function') throw new TypeError('Model Gateway requires a clock');
}

export class ModelGateway {
  #adapters;
  #clock;
  #environment;
  #evidence;
  #ids;
  #memory;
  #store;

  constructor({ environment, store, memory, adapters, evidence, ids, clock }) {
    requireDependencies({ environment, store, memory, adapters, evidence, ids, clock });
    this.#environment = environment;
    this.#store = store;
    this.#memory = memory;
    this.#evidence = evidence;
    this.#ids = ids;
    this.#clock = clock;
    this.#adapters = new Map();
    for (const adapter of adapters) {
      const key = `${adapter.runtimeId}\n${adapter.modelId}\n${adapter.source}`;
      if (this.#adapters.has(key)) throw new TypeError('Model Gateway adapter identity must be unique');
      this.#adapters.set(key, adapter);
    }
  }

  #append({ traceId, spanId, parentSpanId, eventName, outcome = 'success', severity = 'info', attributes }) {
    this.#evidence.append({
      traceId, spanId, parentSpanId, serviceName: 'pixel.model-gateway',
      eventName, outcome, severity, attributes,
    });
    return spanId;
  }

  #outcome(invocation, route, parentSpanId, { status, reasonCode, placement = route?.placement ?? null, output = null }) {
    const spanId = this.#ids.nextSpanId();
    const value = frozenCopy({
      outcome_id: this.#ids.nextEventId(),
      event_name: MODEL_GATEWAY_OUTCOME_EVENT_NAME,
      schema_version: MODEL_SCHEMA_VERSION,
      created_at: this.#clock(),
      environment: invocation.environment,
      trace_id: invocation.trace_id,
      span_id: spanId,
      job_id: invocation.job_id,
      execution_id: invocation.execution_id,
      invocation_id: invocation.invocation_id,
      operation: invocation.operation,
      status,
      reason_code: reasonCode,
      route_decision_id: route?.route_decision_id ?? null,
      placement,
      context: {
        package_id: invocation.context.package_id,
        package_hash: invocation.context.package_hash,
      },
      output,
      provenance: { model_gateway_contract: MODEL_GATEWAY_CONTRACT },
    });
    assertValidModelGatewayOutcomeV1(value);
    this.#append({
      traceId: invocation.trace_id,
      spanId,
      parentSpanId,
      eventName: 'model.gateway.outcome_created',
      outcome: status === 'SUCCEEDED' ? 'success' : 'failure',
      severity: status === 'SUCCEEDED' ? 'info' : 'warning',
      attributes: {
        'pixel.job.id': invocation.job_id,
        'pixel.job.execution_id': invocation.execution_id,
        'pixel.model.invocation_id': invocation.invocation_id,
        'pixel.model.reason_code': reasonCode,
        'pixel.model.status': status,
      },
    });
    return value;
  }

  async invoke(input) {
    let safeInput;
    try {
      safeInput = snapshotSafePlainData(input);
    } catch {
      throw new TypeError('Model Gateway input must be safe plain data');
    }
    if (Object.keys(safeInput).length !== INPUT_FIELDS.size
      || Object.keys(safeInput).some((key) => !INPUT_FIELDS.has(key))
      || typeof safeInput.parentSpanId !== 'string'
      || !validateModelInvocationV1(safeInput.invocation).ok) {
      throw new TypeError('Model Gateway requires an exact Relay model invocation');
    }
    const invocation = safeInput.invocation;

    let job;
    let contextPackage;
    try {
      job = snapshotSafePlainData(await this.#store.getJob(invocation.job_id));
      contextPackage = snapshotSafePlainData(await this.#memory.getApprovedContextPackage(invocation.context.package_id));
    } catch {
      throw new TypeError('Model Gateway could not resolve canonical bindings');
    }
    if (!validJobProjection(job)
      || job.current_state !== 'RUNNING'
      || job.execution_id !== invocation.execution_id
      || job.envelope.environment !== this.#environment
      || !job.model_invocation_claimed
      || !sameRecord(job.model_invocation, invocation)
      || !validateMemoryContextPackageV1(contextPackage).ok
      || contextPackage.job_id !== invocation.job_id
      || contextPackage.environment !== invocation.environment
      || contextPackage.trace_id !== invocation.trace_id
      || hashMemoryContextPackageBinding(contextPackage) !== invocation.context.package_hash
      || contextPackage.package_id !== invocation.context.package_id
      || contextPackage.items.length !== invocation.context.item_count
      || contextPackage.items.reduce((sum, item) => sum + Array.from(item.text).length, 0) !== invocation.context.text_chars
      || countModelInputTokenUnits(SYSTEM_STATUS_SUMMARY_TEMPLATE.text, contextPackage.items) !== invocation.context.input_token_units
      || hashInstructionTemplateBinding(SYSTEM_STATUS_SUMMARY_TEMPLATE) !== invocation.instruction.hash) {
      throw new TypeError('Model Gateway rejected an invalid canonical binding');
    }

    let parentSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: invocation.trace_id, spanId: parentSpanId, parentSpanId: safeInput.parentSpanId,
      eventName: 'model.invocation.validated',
      attributes: {
        'pixel.job.id': invocation.job_id,
        'pixel.job.execution_id': invocation.execution_id,
        'pixel.model.invocation_id': invocation.invocation_id,
        'pixel.model.operation': invocation.operation,
        'pixel.memory.package_hash': invocation.context.package_hash,
      },
    });

    const eligibility = evaluateModelOperationEligibility({ operation: invocation.operation, execution: invocation.execution });
    const eligibilitySpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: invocation.trace_id, spanId: eligibilitySpanId, parentSpanId,
      eventName: 'model.operation.eligibility_decided',
      outcome: eligibility.decision === 'ALLOW' ? 'success' : 'denied',
      severity: eligibility.decision === 'ALLOW' ? 'info' : 'warning',
      attributes: {
        'pixel.model.invocation_id': invocation.invocation_id,
        'pixel.model.operation_decision': eligibility.decision,
        'pixel.model.reason_code': eligibility.reason_code,
        'pixel.policy.id': eligibility.policy_id,
      },
    });
    parentSpanId = eligibilitySpanId;
    if (eligibility.decision !== 'ALLOW') {
      return this.#outcome(invocation, null, parentSpanId, {
        status: 'FAILED', reasonCode: 'OPERATION_INELIGIBLE', placement: null,
      });
    }

    const selected = selectAlphaModelRoute(invocation.environment);
    const route = assertValidModelRouteDecisionV1(frozenCopy({
      route_decision_id: this.#ids.nextEventId(),
      event_name: MODEL_ROUTE_DECISION_EVENT_NAME,
      schema_version: MODEL_SCHEMA_VERSION,
      decided_at: this.#clock(),
      environment: invocation.environment,
      trace_id: invocation.trace_id,
      span_id: this.#ids.nextSpanId(),
      invocation_id: invocation.invocation_id,
      job_id: invocation.job_id,
      execution_id: invocation.execution_id,
      decision: selected.decision,
      reason_code: selected.reason_code,
      policy_id: selected.policy_id,
      placement: selected.placement,
      budget: selected.budget,
      provenance: { model_gateway_contract: MODEL_GATEWAY_CONTRACT },
    }));
    this.#append({
      traceId: invocation.trace_id, spanId: route.span_id, parentSpanId,
      eventName: 'model.route.decided',
      outcome: route.decision === 'ROUTE' ? 'success' : 'denied',
      severity: route.decision === 'ROUTE' ? 'info' : 'warning',
      attributes: {
        'pixel.model.invocation_id': invocation.invocation_id,
        'pixel.model.route_decision': route.decision,
        'pixel.model.reason_code': route.reason_code,
        'pixel.model.runtime_id': route.placement?.runtime_id ?? 'NONE',
        'pixel.model.model_id': route.placement?.model_id ?? 'NONE',
      },
    });
    parentSpanId = route.span_id;
    if (route.decision !== 'ROUTE') {
      return this.#outcome(invocation, route, parentSpanId, {
        status: 'FAILED', reasonCode: 'ROUTE_UNSUPPORTED', placement: null,
      });
    }

    const inputAllowed = contextPackage.items.length > 0
      && invocation.context.input_token_units <= route.budget.max_input_token_units;
    const budgetReason = contextPackage.items.length === 0
      ? 'EMPTY_CONTEXT'
      : inputAllowed ? 'INPUT_BUDGET_ALLOWED' : 'INPUT_BUDGET_EXCEEDED';
    const inputSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: invocation.trace_id, spanId: inputSpanId, parentSpanId,
      eventName: 'model.input_budget.checked',
      outcome: inputAllowed ? 'success' : 'denied', severity: inputAllowed ? 'info' : 'warning',
      attributes: {
        'pixel.model.invocation_id': invocation.invocation_id,
        'pixel.model.input_token_units': invocation.context.input_token_units,
        'pixel.model.input_token_cap': route.budget.max_input_token_units,
        'pixel.model.reason_code': budgetReason,
      },
    });
    parentSpanId = inputSpanId;
    if (!inputAllowed) {
      return this.#outcome(invocation, route, parentSpanId, {
        status: 'FAILED', reasonCode: budgetReason, placement: route.placement,
      });
    }

    const providerRequest = frozenCopy({
      provider_request_id: this.#ids.nextEventId(),
      schema_version: MODEL_SCHEMA_VERSION,
      invocation_id: invocation.invocation_id,
      operation: invocation.operation,
      instruction: SYSTEM_STATUS_SUMMARY_TEMPLATE,
      context_items: contextPackage.items.map(({ text }) => ({ text })),
      budget: {
        max_output_token_units: route.budget.max_output_token_units,
        max_output_chars: route.budget.max_output_chars,
      },
    });
    assertValidModelProviderRequestV1(providerRequest);
    const adapterKey = `${route.placement.runtime_id}\n${route.placement.model_id}\n${route.placement.source}`;
    const adapter = this.#adapters.get(adapterKey);
    if (!adapter) {
      return this.#outcome(invocation, route, parentSpanId, {
        status: 'FAILED', reasonCode: 'ADAPTER_UNAVAILABLE', placement: route.placement,
      });
    }

    const providerSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: invocation.trace_id, spanId: providerSpanId, parentSpanId,
      eventName: 'model.provider.invocation_started',
      attributes: {
        'pixel.model.invocation_id': invocation.invocation_id,
        'pixel.model.runtime_id': route.placement.runtime_id,
        'pixel.model.model_id': route.placement.model_id,
        'pixel.provider.source': route.placement.source,
      },
    });
    parentSpanId = providerSpanId;

    let providerResult;
    try {
      providerResult = snapshotModelProviderResult(await adapter.invoke(providerRequest));
      if (providerResult.invocation_id !== invocation.invocation_id
        || providerResult.provider_contract !== adapter.providerContract
        || providerResult.runtime_id !== route.placement.runtime_id
        || providerResult.model_id !== route.placement.model_id
        || providerResult.source !== route.placement.source) throw new TypeError('Provider identity mismatch');
    } catch {
      return this.#outcome(invocation, route, parentSpanId, {
        status: 'FAILED', reasonCode: 'PROVIDER_RESULT_INVALID', placement: route.placement,
      });
    }

    const validatedSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: invocation.trace_id, spanId: validatedSpanId, parentSpanId,
      eventName: 'model.provider.result_validated',
      attributes: {
        'pixel.model.invocation_id': invocation.invocation_id,
        'pixel.model.runtime_id': providerResult.runtime_id,
        'pixel.model.model_id': providerResult.model_id,
        'pixel.provider.result_id': providerResult.provider_result_id,
      },
    });
    parentSpanId = validatedSpanId;

    const recomputedUnits = countModelInputTokenUnits('', [{ text: providerResult.output_text }]);
    const outputChars = Array.from(providerResult.output_text).length;
    const outputAllowed = recomputedUnits === providerResult.output_token_units
      && recomputedUnits <= route.budget.max_output_token_units
      && outputChars <= route.budget.max_output_chars;
    const outputReason = recomputedUnits !== providerResult.output_token_units
      ? 'PROVIDER_RESULT_INVALID'
      : outputAllowed ? 'OUTPUT_BUDGET_ALLOWED' : 'OUTPUT_BUDGET_EXCEEDED';
    const outputSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId: invocation.trace_id, spanId: outputSpanId, parentSpanId,
      eventName: 'model.output_budget.checked',
      outcome: outputAllowed ? 'success' : 'denied', severity: outputAllowed ? 'info' : 'warning',
      attributes: {
        'pixel.model.invocation_id': invocation.invocation_id,
        'pixel.model.output_token_units': recomputedUnits,
        'pixel.model.output_token_cap': route.budget.max_output_token_units,
        'pixel.model.output_chars': outputChars,
        'pixel.model.output_char_cap': route.budget.max_output_chars,
        'pixel.model.reason_code': outputReason,
      },
    });
    parentSpanId = outputSpanId;
    if (!outputAllowed) {
      return this.#outcome(invocation, route, parentSpanId, {
        status: 'FAILED', reasonCode: outputReason, placement: route.placement,
      });
    }

    return this.#outcome(invocation, route, parentSpanId, {
      status: 'SUCCEEDED',
      reasonCode: 'MODEL_OUTPUT_AVAILABLE',
      placement: route.placement,
      output: {
        text: providerResult.output_text,
        hash: createHash('sha256').update(providerResult.output_text, 'utf8').digest('hex'),
        token_units: recomputedUnits,
      },
    });
  }
}
