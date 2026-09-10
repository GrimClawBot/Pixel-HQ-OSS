const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
const SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;
const MAX_ERRORS = 32;

const RULES = new Map([
  ['job.submission.received', ['pixel.relay', ['pixel.environment', 'pixel.relay.contract']]],
  ['relay.job.accepted', ['pixel.relay', ['pixel.job.id', 'pixel.job.from_state', 'pixel.job.to_state']]],
  ['memory.context.requested', ['pixel.memory', ['pixel.job.id']]],
  ['memory.context.scope_resolved', ['pixel.memory', ['pixel.memory.department_ref']]],
  ['memory.context.candidates_validated', ['pixel.memory', ['pixel.memory.candidate_count']]],
  ['memory.context.filtered', ['pixel.memory', [
    'pixel.memory.allowed_count', 'pixel.memory.scope_mismatch_count',
    'pixel.memory.restricted_denied_count', 'pixel.memory.inactive_count',
    'pixel.memory.environment_mismatch_count', 'pixel.memory.irrelevant_count',
  ]]],
  ['memory.context.budget_applied', ['pixel.memory', [
    'pixel.memory.included_count', 'pixel.memory.omitted_count', 'pixel.memory.included_text_chars',
  ]]],
  ['memory.context.package_created', ['pixel.memory', [
    'pixel.job.id', 'pixel.memory.included_count', 'pixel.memory.omitted_count',
  ]]],
  ['relay.job.running', ['pixel.relay', [
    'pixel.job.id', 'pixel.job.execution_id', 'pixel.job.from_state', 'pixel.job.to_state',
  ]]],
  ['model.invocation.created', ['pixel.relay', [
    'pixel.job.id', 'pixel.job.execution_id', 'pixel.model.invocation_id',
    'pixel.model.operation', 'pixel.memory.package_hash',
  ]]],
  ['model.invocation.claimed', ['pixel.relay', [
    'pixel.job.id', 'pixel.job.execution_id', 'pixel.model.invocation_id',
  ]]],
  ['model.invocation.validated', ['pixel.model-gateway', [
    'pixel.job.id', 'pixel.job.execution_id', 'pixel.model.invocation_id',
    'pixel.model.operation', 'pixel.memory.package_hash',
  ]]],
  ['model.operation.eligibility_decided', ['pixel.model-gateway', [
    'pixel.model.invocation_id', 'pixel.model.operation_decision', 'pixel.model.reason_code', 'pixel.policy.id',
  ]]],
  ['model.route.decided', ['pixel.model-gateway', [
    'pixel.model.invocation_id', 'pixel.model.route_decision', 'pixel.model.reason_code',
    'pixel.model.runtime_id', 'pixel.model.model_id',
  ]]],
  ['model.input_budget.checked', ['pixel.model-gateway', [
    'pixel.model.invocation_id', 'pixel.model.input_token_units',
    'pixel.model.input_token_cap', 'pixel.model.reason_code',
  ]]],
  ['model.provider.invocation_started', ['pixel.model-gateway', [
    'pixel.model.invocation_id', 'pixel.model.runtime_id', 'pixel.model.model_id', 'pixel.provider.source',
  ]]],
  ['model.provider.result_validated', ['pixel.model-gateway', [
    'pixel.model.invocation_id', 'pixel.model.runtime_id', 'pixel.model.model_id', 'pixel.provider.result_id',
  ]]],
  ['model.output_budget.checked', ['pixel.model-gateway', [
    'pixel.model.invocation_id', 'pixel.model.output_token_units', 'pixel.model.output_token_cap',
    'pixel.model.output_chars', 'pixel.model.output_char_cap', 'pixel.model.reason_code',
  ]]],
  ['model.gateway.outcome_created', ['pixel.model-gateway', [
    'pixel.job.id', 'pixel.job.execution_id', 'pixel.model.invocation_id',
    'pixel.model.reason_code', 'pixel.model.status',
  ]]],
  ['model.gateway.outcome_accepted', ['pixel.relay', [
    'pixel.job.id', 'pixel.job.execution_id', 'pixel.model.invocation_id',
    'pixel.model.reason_code', 'pixel.model.status',
  ]]],
  ['model.gateway.outcome_rejected', ['pixel.relay', [
    'pixel.job.id', 'pixel.job.execution_id', 'pixel.model.invocation_id', 'pixel.model.reason_code',
  ]]],
  ['contract.job_result.validated', ['pixel.relay', [
    'pixel.job.id', 'pixel.job.execution_id', 'pixel.job.outcome_code',
  ]]],
  ['job.result.projected', ['pixel.relay', ['pixel.job.id', 'pixel.job.outcome_code']]],
  ['relay.job.completed', ['pixel.relay', [
    'pixel.job.id', 'pixel.job.from_state', 'pixel.job.to_state', 'pixel.job.reason_code',
  ]]],
  ['relay.job.failed', ['pixel.relay', [
    'pixel.job.id', 'pixel.job.from_state', 'pixel.job.to_state', 'pixel.job.reason_code',
  ]]],
]);

const PREFIX = [
  'job.submission.received', 'relay.job.accepted', 'memory.context.requested',
  'memory.context.scope_resolved', 'memory.context.candidates_validated',
  'memory.context.filtered', 'memory.context.budget_applied', 'memory.context.package_created',
  'relay.job.running', 'model.invocation.created', 'model.invocation.claimed',
];

function expectedSequence(records) {
  const names = new Set(records.map(({ event_name: eventName }) => eventName));
  const suffix = ['contract.job_result.validated', 'job.result.projected', names.has('relay.job.completed') ? 'relay.job.completed' : 'relay.job.failed'];
  if (names.has('model.gateway.outcome_rejected')) return [...PREFIX, 'model.gateway.outcome_rejected', ...suffix];
  const gateway = ['model.invocation.validated', 'model.operation.eligibility_decided'];
  const reason = records.find(({ event_name: eventName }) => (
    eventName === 'model.gateway.outcome_created'
  ))?.attributes?.['pixel.model.reason_code'];
  if (reason === 'OPERATION_INELIGIBLE') return [...PREFIX, ...gateway, 'model.gateway.outcome_created', 'model.gateway.outcome_accepted', ...suffix];
  gateway.push('model.route.decided');
  if (reason === 'ROUTE_UNSUPPORTED') return [...PREFIX, ...gateway, 'model.gateway.outcome_created', 'model.gateway.outcome_accepted', ...suffix];
  gateway.push('model.input_budget.checked');
  if (['EMPTY_CONTEXT', 'INPUT_BUDGET_EXCEEDED', 'ADAPTER_UNAVAILABLE'].includes(reason)) {
    return [...PREFIX, ...gateway, 'model.gateway.outcome_created', 'model.gateway.outcome_accepted', ...suffix];
  }
  gateway.push('model.provider.invocation_started');
  if (reason !== 'PROVIDER_RESULT_INVALID' || names.has('model.provider.result_validated')) {
    gateway.push('model.provider.result_validated', 'model.output_budget.checked');
  }
  return [...PREFIX, ...gateway, 'model.gateway.outcome_created', 'model.gateway.outcome_accepted', ...suffix];
}

function expectedSignal(record) {
  const value = (key) => record.attributes?.[key];
  switch (record.event_name) {
    case 'model.operation.eligibility_decided':
      return value('pixel.model.operation_decision') === 'ALLOW' ? ['success', 'info'] : ['denied', 'warning'];
    case 'model.route.decided':
      return value('pixel.model.route_decision') === 'ROUTE' ? ['success', 'info'] : ['denied', 'warning'];
    case 'model.input_budget.checked':
      return value('pixel.model.reason_code') === 'INPUT_BUDGET_ALLOWED' ? ['success', 'info'] : ['denied', 'warning'];
    case 'model.gateway.outcome_created':
    case 'model.gateway.outcome_accepted':
      return value('pixel.model.status') === 'SUCCEEDED' ? ['success', 'info'] : ['failure', 'warning'];
    case 'model.gateway.outcome_rejected':
    case 'relay.job.failed':
      return ['failure', 'warning'];
    case 'job.result.projected':
      return value('pixel.job.outcome_code') === 'SYSTEM_STATUS_AVAILABLE'
        ? ['success', 'info'] : ['failure', 'warning'];
    default:
      return ['success', 'info'];
  }
}

function boundedAttributes(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((item) => (
      ['string', 'number', 'boolean'].includes(typeof item)
      && (typeof item !== 'string' || item.length <= 160)
      && (typeof item !== 'number' || Number.isSafeInteger(item))
    ));
}

function assessment(missing, errors) {
  const boundedMissing = Object.freeze([...new Set(missing)].slice(0, MAX_ERRORS));
  const boundedErrors = Object.freeze([...new Set(errors)].map((item) => String(item).slice(0, 160)).slice(0, MAX_ERRORS));
  return Object.freeze({ complete: boundedMissing.length === 0 && boundedErrors.length === 0, missing: boundedMissing, errors: boundedErrors });
}

function semantics(records, errors) {
  const attrs = (name) => records.find(({ event_name: eventName }) => eventName === name)?.attributes;
  const values = (key) => new Set(records.map(({ attributes }) => attributes?.[key]).filter((value) => value !== undefined));
  if (values('pixel.job.id').size > 1) errors.push('job identifiers disagree within model trace');
  if (values('pixel.job.execution_id').size > 1) errors.push('execution identifiers disagree within model trace');
  if (values('pixel.model.invocation_id').size > 1) errors.push('model invocation identifiers disagree within trace');
  if (values('pixel.memory.package_hash').size > 1) errors.push('Memory package hashes disagree within model trace');

  const eligibility = attrs('model.operation.eligibility_decided');
  if (eligibility && !(
    (eligibility['pixel.model.operation_decision'] === 'ALLOW' && eligibility['pixel.model.reason_code'] === 'OPERATION_ELIGIBLE')
    || (eligibility['pixel.model.operation_decision'] === 'DENY' && eligibility['pixel.model.reason_code'] === 'OPERATION_INELIGIBLE')
  )) errors.push('operation eligibility evidence is contradictory');
  if (eligibility?.['pixel.model.operation_decision'] === 'DENY'
    && records.some(({ event_name: name }) => name === 'model.route.decided')) errors.push('ineligible operation reached routing');

  const route = attrs('model.route.decided');
  if (route && !(
    (route['pixel.model.route_decision'] === 'ROUTE' && route['pixel.model.reason_code'] === 'ROUTE_SELECTED')
    || (route['pixel.model.route_decision'] === 'DENY' && route['pixel.model.reason_code'] === 'ROUTE_UNSUPPORTED')
  )) errors.push('model route evidence is contradictory');
  if (route?.['pixel.model.route_decision'] === 'DENY'
    && records.some(({ event_name: name }) => name === 'model.provider.invocation_started')) errors.push('denied route invoked a provider');

  if (records.some(({ event_name: name }) => name.startsWith('worker.'))
    || records.some(({ event_name: name }) => name.startsWith('tool.'))
    || records.some(({ event_name: name }) => name.startsWith('tool_gateway.'))) {
    errors.push('model execution trace contains a mixed worker/tool branch');
  }

  const projected = attrs('job.result.projected')?.['pixel.job.outcome_code'];
  const validated = attrs('contract.job_result.validated')?.['pixel.job.outcome_code'];
  if (projected !== validated) errors.push('validated and projected model outcomes disagree');
  const terminal = attrs('relay.job.completed') ?? attrs('relay.job.failed');
  if (terminal) {
    const expectedReason = projected === 'SYSTEM_STATUS_AVAILABLE'
      ? 'EXECUTION_COMPLETED'
      : projected === 'WORKER_UNAVAILABLE' ? 'WORKER_FAILED' : 'WORKER_RESULT_INVALID';
    const expectedState = projected === 'SYSTEM_STATUS_AVAILABLE' ? 'COMPLETED' : 'FAILED';
    if (terminal['pixel.job.from_state'] !== 'RUNNING'
      || terminal['pixel.job.to_state'] !== expectedState
      || terminal['pixel.job.reason_code'] !== expectedReason) errors.push('model terminal evidence contradicts the result');
  }
}

export function assessModelTraceCompleteness(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return assessment(['job.submission.received'], ['trace has no evidence']);
  }
  const errors = [];
  const traceId = records[0]?.trace_id;
  const spans = new Set();
  for (const record of records) {
    const rule = RULES.get(record?.event_name);
    if (!rule) {
      errors.push('trace contains an unsupported model execution event');
      continue;
    }
    if (typeof record.trace_id !== 'string' || !TRACE_ID.test(record.trace_id) || record.trace_id !== traceId) errors.push('trace identifiers must be valid and equal');
    if (typeof record.span_id !== 'string' || !SPAN_ID.test(record.span_id) || spans.has(record.span_id)) errors.push('span identifiers must be valid and unique');
    spans.add(record.span_id);
    if (record.service_name !== rule[0]) errors.push(`${record.event_name} has the wrong service owner`);
    const [expectedOutcome, expectedSeverity] = expectedSignal(record);
    if (record.outcome !== expectedOutcome || record.severity !== expectedSeverity) {
      errors.push(`${record.event_name} has contradictory outcome or severity`);
    }
    const keys = Object.keys(record.attributes ?? {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...rule[1]].sort()) || !boundedAttributes(record.attributes)) {
      errors.push(`${record.event_name} has unbounded or unsupported attributes`);
    }
  }

  const expected = expectedSequence(records);
  const missing = expected.filter((name) => !records.some(({ event_name: eventName }) => eventName === name));
  const canonical = records.filter(({ event_name: eventName }) => expected.includes(eventName));
  if (canonical.length !== records.length) errors.push('trace contains noncanonical or duplicate model stages');
  for (let index = 0; index < canonical.length; index += 1) {
    if (canonical[index].event_name !== expected[index]) errors.push('canonical model evidence is out of order');
    if (index === 0) {
      if (canonical[index].parent_span_id !== null) errors.push('model job trace must have one submission root');
    } else if (canonical[index].parent_span_id !== canonical[index - 1].span_id) {
      errors.push(`${canonical[index].event_name} is not parented to its canonical predecessor`);
    }
  }
  semantics(records, errors);
  return assessment(missing, errors);
}
