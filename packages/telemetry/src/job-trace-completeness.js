const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
const SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;

const EVENT_RULES = new Map([
  ['job.submission.received', ['pixel.relay', ['pixel.environment', 'pixel.relay.contract']]],
  ['job.submission.authority_rejected', ['pixel.relay', ['pixel.security.authority_claim_count']]],
  ['job.submission.invalid', ['pixel.relay', ['pixel.validation.error_count']]],
  ['job.context.resolution_failed', ['pixel.relay', ['pixel.provider.source']]],
  ['relay.claim.failed', ['pixel.relay', []]],
  ['relay.idempotency.conflict', ['pixel.relay', ['pixel.idempotency.outcome']]],
  ['relay.submission.replayed', ['pixel.relay', ['pixel.idempotency.outcome', 'pixel.job.id']]],
  ['relay.job.accepted', ['pixel.relay', ['pixel.job.id', 'pixel.job.from_state', 'pixel.job.to_state']]],
  ['relay.job.running', ['pixel.relay', ['pixel.job.id', 'pixel.job.execution_id', 'pixel.job.from_state', 'pixel.job.to_state']]],
  ['tool.execution.requested', ['pixel.relay', ['pixel.job.id', 'pixel.job.execution_id', 'pixel.tool.capability', 'pixel.tool.class', 'pixel.tool.target']]],
  ['tool_gateway.evaluation.started', ['pixel.tool-gateway', ['pixel.job.id', 'pixel.job.execution_id', 'pixel.tool.capability']]],
  ['tool.capability.allowed', ['pixel.tool-gateway', ['pixel.job.id', 'pixel.job.execution_id', 'pixel.tool.capability', 'pixel.tool.decision', 'pixel.tool.reason_code']]],
  ['tool.capability.denied', ['pixel.tool-gateway', ['pixel.job.id', 'pixel.job.execution_id', 'pixel.tool.capability', 'pixel.tool.decision', 'pixel.tool.reason_code']]],
  ['worker.execution.started', ['pixel.system-status-worker', ['pixel.job.id', 'pixel.job.execution_id', 'pixel.worker.id']]],
  ['worker.execution.finished', ['pixel.system-status-worker', ['pixel.job.id', 'pixel.job.execution_id', 'pixel.worker.outcome_code']]],
  ['contract.job_result.validated', ['pixel.relay', ['pixel.job.id', 'pixel.job.execution_id', 'pixel.job.outcome_code']]],
  ['job.result.projected', ['pixel.relay', ['pixel.job.id', 'pixel.job.outcome_code']]],
  ['relay.job.completed', ['pixel.relay', ['pixel.job.id', 'pixel.job.from_state', 'pixel.job.to_state', 'pixel.job.reason_code']]],
  ['relay.job.failed', ['pixel.relay', ['pixel.job.id', 'pixel.job.from_state', 'pixel.job.to_state', 'pixel.job.reason_code']]],
  ['relay.transition.rejected', ['pixel.relay', [
    'pixel.job.id', 'pixel.job.current_state', 'pixel.job.attempted_state', 'pixel.job.reason_code',
  ]]],
  ['api.job.response.failed', ['pixel.relay-api', ['http.request.method', 'http.route', 'http.response.status_code', 'pixel.job.disposition']]],
  ['api.job.response.prepared', ['pixel.relay-api', ['http.request.method', 'http.route', 'http.response.status_code', 'pixel.job.disposition']]],
  ['api.job.response', ['pixel.relay-api', ['http.request.method', 'http.route', 'http.response.status_code', 'pixel.job.disposition']]],
]);

const EARLY_TERMINALS = new Set([
  'job.submission.authority_rejected',
  'job.submission.invalid',
  'job.context.resolution_failed',
  'relay.claim.failed',
  'relay.idempotency.conflict',
  'relay.submission.replayed',
]);
const OPTIONAL_BRANCHES = new Set([
  'relay.transition.rejected', 'api.job.response.prepared', 'api.job.response', 'api.job.response.failed',
]);
const CANONICAL_PREFIX = [
  'job.submission.received',
  'relay.job.accepted',
  'relay.job.running',
  'tool.execution.requested',
  'tool_gateway.evaluation.started',
];

function expectedSequence(records) {
  const names = records.map(({ event_name: eventName }) => eventName);
  const early = names.find((name) => EARLY_TERMINALS.has(name));
  if (early) return ['job.submission.received', early];

  const decision = names.includes('tool.capability.denied')
    ? 'tool.capability.denied'
    : 'tool.capability.allowed';
  if (decision === 'tool.capability.denied') {
    return [...CANONICAL_PREFIX, decision, 'contract.job_result.validated', 'job.result.projected', 'relay.job.failed'];
  }
  const terminal = names.includes('relay.job.completed') ? 'relay.job.completed' : 'relay.job.failed';
  return [
    ...CANONICAL_PREFIX,
    decision,
    'worker.execution.started',
    'worker.execution.finished',
    'contract.job_result.validated',
    'job.result.projected',
    terminal,
  ];
}

function boundedAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return false;
  return Object.values(attributes).every((value) => (
    ['string', 'number', 'boolean'].includes(typeof value)
    && (typeof value !== 'string' || value.length <= 160)
  ));
}

function semanticErrors(records) {
  const errors = [];
  const first = (eventName) => records.find((record) => record.event_name === eventName);
  const attributesFor = (eventName) => first(eventName)?.attributes;
  const values = (key) => new Set(records
    .map(({ attributes }) => attributes?.[key])
    .filter((value) => value !== undefined));

  if (values('pixel.job.id').size > 1) errors.push('job identifiers disagree within the trace');
  if (values('pixel.job.execution_id').size > 1) errors.push('execution identifiers disagree within the trace');

  const accepted = attributesFor('relay.job.accepted');
  if (accepted && (accepted['pixel.job.from_state'] !== 'SUBMITTED' || accepted['pixel.job.to_state'] !== 'ACCEPTED')) {
    errors.push('accepted evidence contradicts the canonical lifecycle');
  }
  const running = attributesFor('relay.job.running');
  if (running && (running['pixel.job.from_state'] !== 'ACCEPTED' || running['pixel.job.to_state'] !== 'RUNNING')) {
    errors.push('running evidence contradicts the canonical lifecycle');
  }

  const request = attributesFor('tool.execution.requested');
  if (request && (request['pixel.tool.class'] !== 'pixel.system-status' || request['pixel.tool.target'] !== 'pixel.platform')) {
    errors.push('tool execution evidence has the wrong bounded target');
  }
  const capabilities = values('pixel.tool.capability');
  if (capabilities.size > 1) errors.push('tool capability evidence disagrees within the trace');

  const allowed = attributesFor('tool.capability.allowed');
  if (allowed && (
    allowed['pixel.tool.decision'] !== 'ALLOW'
    || allowed['pixel.tool.reason_code'] !== 'CAPABILITY_GRANTED'
    || allowed['pixel.tool.capability'] !== 'pixel.system-status.read'
  )) errors.push('allowed evidence contradicts its capability decision');

  const denied = attributesFor('tool.capability.denied');
  if (denied && (
    denied['pixel.tool.decision'] !== 'DENY'
    || !['CAPABILITY_NOT_GRANTED', 'AUTHORIZATION_UNAVAILABLE'].includes(denied['pixel.tool.reason_code'])
  )) errors.push('denied evidence contradicts its capability decision');

  const workerOutcome = attributesFor('worker.execution.finished')?.['pixel.worker.outcome_code'];
  if (workerOutcome !== undefined && ![
    'SYSTEM_STATUS_AVAILABLE', 'WORKER_UNAVAILABLE', 'WORKER_RESULT_INVALID',
  ].includes(workerOutcome)) errors.push('worker evidence has an unsupported outcome');

  const resultOutcome = attributesFor('job.result.projected')?.['pixel.job.outcome_code'];
  const validatedOutcome = attributesFor('contract.job_result.validated')?.['pixel.job.outcome_code'];
  const expectedDeniedOutcome = denied?.['pixel.tool.reason_code'] === 'AUTHORIZATION_UNAVAILABLE'
    ? 'AUTHORIZATION_UNAVAILABLE'
    : denied ? 'CAPABILITY_DENIED' : null;
  if (resultOutcome !== undefined) {
    const expectedOutcome = expectedDeniedOutcome ?? workerOutcome;
    if (resultOutcome !== expectedOutcome) errors.push('projected result contradicts execution evidence');
  }
  if (validatedOutcome !== undefined) {
    const expectedOutcome = expectedDeniedOutcome ?? workerOutcome;
    if (validatedOutcome !== expectedOutcome) errors.push('validated result contradicts execution evidence');
    if (resultOutcome !== undefined && validatedOutcome !== resultOutcome) {
      errors.push('validated and projected result outcomes disagree');
    }
  }

  const completed = attributesFor('relay.job.completed');
  if (completed && (
    completed['pixel.job.from_state'] !== 'RUNNING'
    || completed['pixel.job.to_state'] !== 'COMPLETED'
    || completed['pixel.job.reason_code'] !== 'EXECUTION_COMPLETED'
    || resultOutcome !== 'SYSTEM_STATUS_AVAILABLE'
  )) errors.push('completed evidence contradicts the terminal result');

  const failed = attributesFor('relay.job.failed');
  if (failed) {
    const reasonByOutcome = {
      CAPABILITY_DENIED: 'CAPABILITY_DENIED',
      AUTHORIZATION_UNAVAILABLE: 'AUTHORIZATION_UNAVAILABLE',
      WORKER_UNAVAILABLE: 'WORKER_FAILED',
      WORKER_RESULT_INVALID: 'WORKER_RESULT_INVALID',
    };
    if (
      failed['pixel.job.from_state'] !== 'RUNNING'
      || failed['pixel.job.to_state'] !== 'FAILED'
      || failed['pixel.job.reason_code'] !== reasonByOutcome[resultOutcome]
    ) errors.push('failed evidence contradicts the terminal result');
  }

  const successInfo = new Set([
    'job.submission.received', 'relay.submission.replayed', 'relay.job.accepted',
    'relay.job.running', 'tool.execution.requested', 'tool_gateway.evaluation.started',
    'tool.capability.allowed', 'worker.execution.started', 'contract.job_result.validated',
    'relay.job.completed', 'api.job.response.prepared',
  ]);
  const deniedWarning = new Set([
    'job.submission.authority_rejected', 'job.submission.invalid', 'job.context.resolution_failed',
    'relay.claim.failed', 'relay.idempotency.conflict', 'tool.capability.denied',
    'relay.transition.rejected',
  ]);
  for (const record of records) {
    let expected;
    if (successInfo.has(record.event_name)) expected = ['success', 'info'];
    if (deniedWarning.has(record.event_name)) expected = ['denied', 'warning'];
    if (record.event_name === 'worker.execution.finished') {
      expected = record.attributes?.['pixel.worker.outcome_code'] === 'SYSTEM_STATUS_AVAILABLE'
        ? ['success', 'info'] : ['failure', 'warning'];
    }
    if (record.event_name === 'job.result.projected') {
      expected = record.attributes?.['pixel.job.outcome_code'] === 'SYSTEM_STATUS_AVAILABLE'
        ? ['success', 'info'] : ['failure', 'warning'];
    }
    if (record.event_name === 'relay.job.failed') expected = ['failure', 'warning'];
    if (record.event_name === 'api.job.response') {
      expected = record.attributes?.['http.response.status_code'] < 400
        ? ['success', 'info'] : ['denied', 'warning'];
    }
    if (record.event_name === 'api.job.response.failed') expected = ['failure', 'error'];
    if (expected && (record.outcome !== expected[0] || record.severity !== expected[1])) {
      errors.push(`${record.event_name} has contradictory outcome or severity`);
    }
  }
  const preparedResponses = records.filter(({ event_name: eventName }) => eventName === 'api.job.response.prepared');
  const finishedResponses = records.filter(({ event_name: eventName }) => (
    eventName === 'api.job.response' || eventName === 'api.job.response.failed'
  ));
  if (preparedResponses.length !== finishedResponses.length) {
    errors.push('API response evidence has an unfinished request branch');
  }
  return errors;
}

export function assessJobTraceCompleteness(records) {
  const errors = [];
  if (!Array.isArray(records) || records.length === 0) {
    return { complete: false, missing: ['job.submission.received'], errors: ['trace has no evidence'] };
  }

  const traceId = records[0].trace_id;
  const spanIds = new Set();
  for (const record of records) {
    const rule = EVENT_RULES.get(record.event_name);
    if (!rule) {
      errors.push(`unsupported event ${record.event_name}`);
      continue;
    }
    if (!TRACE_ID.test(record.trace_id) || record.trace_id !== traceId) errors.push('trace identifiers must be valid and equal');
    if (!SPAN_ID.test(record.span_id) || spanIds.has(record.span_id)) errors.push('span identifiers must be valid and unique');
    spanIds.add(record.span_id);
    if (record.service_name !== rule[0]) errors.push(`${record.event_name} has the wrong service owner`);
    const keys = Object.keys(record.attributes ?? {}).sort();
    const expectedKeys = [...rule[1]].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || !boundedAttributes(record.attributes)) {
      errors.push(`${record.event_name} has unbounded or unsupported attributes`);
    }
  }

  const bySpan = new Map(records.map((record) => [record.span_id, record]));
  const roots = records.filter(({ parent_span_id: parentSpanId }) => parentSpanId === null);
  if (roots.length !== 1 || roots[0].event_name !== 'job.submission.received') {
    errors.push('trace must have one submission root');
  }
  for (const record of records) {
    if (record.parent_span_id !== null && !bySpan.has(record.parent_span_id)) {
      errors.push(`${record.event_name} has broken parentage`);
    }
  }

  const required = expectedSequence(records);
  const missing = required.filter((eventName) => !records.some((record) => record.event_name === eventName));
  let priorIndex = -1;
  for (const eventName of required) {
    const index = records.findIndex((record) => record.event_name === eventName);
    if (index !== -1 && index <= priorIndex) errors.push('canonical job evidence is out of order');
    if (index !== -1) priorIndex = index;
  }

  const canonical = records.filter(({ event_name: eventName }) => required.includes(eventName));
  for (let index = 1; index < canonical.length; index += 1) {
    if (canonical[index].parent_span_id !== canonical[index - 1].span_id) {
      errors.push(`${canonical[index].event_name} is not parented to its canonical predecessor`);
    }
  }

  const extras = records.filter(({ event_name: eventName }) => !required.includes(eventName));
  if (extras.some(({ event_name: eventName }) => !OPTIONAL_BRANCHES.has(eventName))) {
    errors.push('trace contains an impossible job stage');
  }

  errors.push(...semanticErrors(records));

  return { complete: missing.length === 0 && errors.length === 0, missing, errors };
}
