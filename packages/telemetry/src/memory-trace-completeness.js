const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
const SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SERVICE = 'pixel.memory';
const MAX_ERRORS = 32;
const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);

const EVENT_ATTRIBUTES = new Map([
  ['memory.intake.received', ['pixel.environment']],
  ['memory.intake.authority_rejected', ['pixel.memory.reason_code', 'pixel.security.authority_claim_count']],
  ['memory.intake.invalid', ['pixel.memory.reason_code', 'pixel.validation.error_count']],
  ['memory.intake.context_resolved', ['pixel.memory.department_ref', 'pixel.provider.source']],
  ['memory.record.stored', ['pixel.memory.department_ref', 'pixel.memory.id', 'pixel.memory.source_class']],
  ['memory.intake.denied', ['pixel.memory.reason_code']],
  ['memory.context.requested', ['pixel.job.id']],
  ['memory.context.job_rejected', null],
  ['memory.context.scope_resolved', ['pixel.memory.department_ref']],
  ['memory.context.candidates_validated', null],
  ['memory.context.filtered', [
    'pixel.memory.allowed_count',
    'pixel.memory.environment_mismatch_count',
    'pixel.memory.inactive_count',
    'pixel.memory.irrelevant_count',
    'pixel.memory.restricted_denied_count',
    'pixel.memory.scope_mismatch_count',
  ]],
  ['memory.context.budget_applied', [
    'pixel.memory.included_count', 'pixel.memory.included_text_chars', 'pixel.memory.omitted_count',
  ]],
  ['memory.context.package_created', ['pixel.job.id', 'pixel.memory.included_count', 'pixel.memory.omitted_count']],
  ['memory.context.package_failed', ['pixel.memory.reason_code']],
]);

const INTAKE_EVENTS = new Set([
  'memory.intake.received', 'memory.intake.authority_rejected', 'memory.intake.invalid',
  'memory.intake.context_resolved', 'memory.record.stored', 'memory.intake.denied',
]);
const CONTEXT_EVENTS = new Set([
  'memory.context.requested', 'memory.context.job_rejected', 'memory.context.scope_resolved',
  'memory.context.candidates_validated', 'memory.context.filtered',
  'memory.context.budget_applied', 'memory.context.package_created', 'memory.context.package_failed',
]);

function frozenAssessment(missing, errors) {
  const boundedMissing = Object.freeze([...new Set(missing)].slice(0, MAX_ERRORS));
  const boundedErrors = Object.freeze([...new Set(errors)]
    .map((error) => String(error).slice(0, 160))
    .slice(0, MAX_ERRORS));
  return Object.freeze({
    complete: boundedMissing.length === 0 && boundedErrors.length === 0,
    missing: boundedMissing,
    errors: boundedErrors,
  });
}

function boundedAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return false;
  return Object.values(attributes).every((value) => (
    ['string', 'number', 'boolean'].includes(typeof value)
    && (typeof value !== 'string' || value.length <= 160)
    && (typeof value !== 'number' || Number.isSafeInteger(value))
  ));
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundedText(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
}

function safeAttributes(record) {
  const attributes = record?.attributes;
  return attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? attributes : {};
}

function validTraceId(value) {
  return typeof value === 'string' && TRACE_ID.test(value);
}

function validSpanId(value) {
  return typeof value === 'string' && SPAN_ID.test(value);
}

function validIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function hasExactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validRelayParent(parent, requestedJobId, state) {
  if (!parent || parent.service_name !== 'pixel.relay') return false;
  const attributes = safeAttributes(parent);
  if (state === 'SUBMITTED') return parent.event_name === 'job.submission.received'
    && parent.outcome === 'success'
    && parent.severity === 'info'
    && hasExactKeys(attributes, ['pixel.environment', 'pixel.relay.contract'])
    && ENVIRONMENTS.has(attributes['pixel.environment'])
    && attributes['pixel.relay.contract'] === 'pixel.relay.v1';
  if (state === 'RUNNING') return parent.event_name === 'relay.job.running'
    && parent.outcome === 'success'
    && parent.severity === 'info'
    && hasExactKeys(attributes, [
      'pixel.job.id', 'pixel.job.execution_id', 'pixel.job.from_state', 'pixel.job.to_state',
    ])
    && attributes['pixel.job.id'] === requestedJobId
    && validIdentifier(attributes['pixel.job.execution_id'])
    && attributes['pixel.job.from_state'] === 'ACCEPTED'
    && attributes['pixel.job.to_state'] === 'RUNNING';
  if (state === 'COMPLETED') return parent.event_name === 'relay.job.completed'
    && parent.outcome === 'success'
    && parent.severity === 'info'
    && hasExactKeys(attributes, [
      'pixel.job.id', 'pixel.job.from_state', 'pixel.job.to_state', 'pixel.job.reason_code',
    ])
    && attributes['pixel.job.id'] === requestedJobId
    && attributes['pixel.job.from_state'] === 'RUNNING'
    && attributes['pixel.job.to_state'] === 'COMPLETED'
    && attributes['pixel.job.reason_code'] === 'EXECUTION_COMPLETED';
  if (state === 'FAILED') return parent.event_name === 'relay.job.failed'
    && parent.outcome === 'failure'
    && parent.severity === 'warning'
    && hasExactKeys(attributes, [
      'pixel.job.id', 'pixel.job.from_state', 'pixel.job.to_state', 'pixel.job.reason_code',
    ])
    && attributes['pixel.job.id'] === requestedJobId
    && attributes['pixel.job.from_state'] === 'RUNNING'
    && attributes['pixel.job.to_state'] === 'FAILED'
    && ['CAPABILITY_DENIED', 'AUTHORIZATION_UNAVAILABLE', 'WORKER_FAILED', 'WORKER_RESULT_INVALID']
      .includes(attributes['pixel.job.reason_code']);
  return parent.event_name === 'relay.job.accepted'
    && parent.outcome === 'success'
    && parent.severity === 'info'
    && hasExactKeys(attributes, ['pixel.job.id', 'pixel.job.from_state', 'pixel.job.to_state'])
    && attributes['pixel.job.id'] === requestedJobId
    && attributes['pixel.job.from_state'] === 'SUBMITTED'
    && attributes['pixel.job.to_state'] === 'ACCEPTED';
}

function exactAttributes(record) {
  let expected = EVENT_ATTRIBUTES.get(record.event_name);
  const reason = record.attributes?.['pixel.memory.reason_code'];
  if (record.event_name === 'memory.context.job_rejected') {
    expected = ['pixel.memory.reason_code'];
    if (reason === 'CLIENT_AUTHORITY_CLAIM_REJECTED') expected.push('pixel.security.authority_claim_count');
    if (reason === 'JOB_STATE_DENIED') expected.push('pixel.job.current_state');
  }
  if (record.event_name === 'memory.context.candidates_validated') {
    expected = record.outcome === 'success'
      ? ['pixel.memory.candidate_count']
      : ['pixel.memory.reason_code'];
    if (reason === 'RECORD_INVALID') expected.push('pixel.memory.invalid_count');
  }
  if (!expected) return false;
  return JSON.stringify(Object.keys(record.attributes ?? {}).sort()) === JSON.stringify([...expected].sort())
    && boundedAttributes(record.attributes);
}

function expectedOutcome(record) {
  if (record.event_name === 'memory.context.candidates_validated') {
    return record.attributes?.['pixel.memory.reason_code'] ? ['error', 'error'] : ['success', 'info'];
  }
  if (record.event_name === 'memory.context.job_rejected') {
    return record.attributes?.['pixel.memory.reason_code'] === 'RELAY_UNAVAILABLE'
      ? ['error', 'error'] : ['denied', 'warning'];
  }
  if (['memory.intake.authority_rejected', 'memory.intake.invalid'].includes(record.event_name)) {
    return ['denied', 'warning'];
  }
  if (['memory.intake.denied', 'memory.context.package_failed'].includes(record.event_name)) {
    return ['error', 'error'];
  }
  return ['success', 'info'];
}

function validateCommon(allRecords, memoryRecords, allowedEvents, errors) {
  if (allRecords.length === 0) return;
  const traceId = allRecords[0].trace_id;
  const spans = new Set();
  for (const record of allRecords) {
    if (!validTraceId(record?.trace_id) || record.trace_id !== traceId) {
      errors.push('trace identifiers must be valid and equal');
    }
    if (!validSpanId(record?.span_id) || spans.has(record.span_id)) {
      errors.push('span identifiers must be valid and unique');
    }
    spans.add(record?.span_id);
  }
  for (const record of memoryRecords) {
    if (!allowedEvents.has(record.event_name)) errors.push('unsupported Memory event');
    if (record.service_name !== SERVICE) errors.push('Memory event has the wrong service owner');
    if (!exactAttributes(record)) errors.push('Memory event has unbounded or unsupported attributes');
    const [outcome, severity] = expectedOutcome(record);
    if (record.outcome !== outcome || record.severity !== severity) {
      errors.push('Memory event has contradictory outcome or severity');
    }
  }
  const bySpan = new Map(allRecords.map((record) => [record.span_id, record]));
  const indexBySpan = new Map(allRecords.map((record, index) => [record.span_id, index]));
  for (const record of memoryRecords) {
    if (record.parent_span_id !== null && !bySpan.has(record.parent_span_id)) {
      errors.push('Memory event has broken parentage');
    } else if (record.parent_span_id !== null
      && indexBySpan.get(record.parent_span_id) >= indexBySpan.get(record.span_id)) {
      errors.push('Memory event is parented to a non-earlier span');
    }
  }
}

function validateNoDuplicateEvents(records, allowedEvents, errors) {
  for (const eventName of allowedEvents) {
    if (records.filter((record) => record.event_name === eventName).length > 1) {
      errors.push('trace contains a duplicate Memory event');
    }
  }
}

function groupContextAttempts(memoryRecords, errors) {
  const bySpan = new Map(memoryRecords.map((record) => [record.span_id, record]));
  const attemptsByRoot = new Map();

  for (const record of memoryRecords) {
    let current = record;
    const visited = new Set();
    while (current && current.event_name !== 'memory.context.requested'
      && !(current.event_name === 'memory.context.job_rejected' && current.parent_span_id === null)) {
      if (visited.has(current)) {
        current = null;
        break;
      }
      visited.add(current);
      current = bySpan.get(current.parent_span_id);
    }
    if (!current) {
      errors.push('context evidence is not attached to a request root');
      continue;
    }
    if (!attemptsByRoot.has(current)) attemptsByRoot.set(current, []);
    attemptsByRoot.get(current).push(record);
  }

  return [...attemptsByRoot].map(([root, attemptRecords]) => ({
    root,
    records: attemptRecords,
  }));
}

function validateSequence(records, required, errors) {
  const missing = required.filter((eventName) => !records.some((record) => record.event_name === eventName));
  let priorIndex = -1;
  const canonical = [];
  for (const eventName of required) {
    const index = records.findIndex((record) => record.event_name === eventName);
    if (index !== -1 && index <= priorIndex) errors.push('canonical Memory evidence is out of order');
    if (index !== -1) {
      priorIndex = index;
      canonical.push(records[index]);
    }
  }
  for (let index = 1; index < canonical.length; index += 1) {
    if (canonical[index].parent_span_id !== canonical[index - 1].span_id) {
      errors.push(`${canonical[index].event_name} is not parented to its canonical predecessor`);
    }
  }
  if (records.some((record) => !required.includes(record.event_name))) {
    errors.push('trace contains an impossible Memory stage');
  }
  return missing;
}

function intakeSequence(records) {
  const names = new Set(records.map(({ event_name: eventName }) => eventName));
  if (names.has('memory.record.stored')) {
    return ['memory.intake.received', 'memory.intake.context_resolved', 'memory.record.stored'];
  }
  if (names.has('memory.intake.authority_rejected')) {
    return ['memory.intake.received', 'memory.intake.authority_rejected'];
  }
  if (names.has('memory.intake.invalid')) return ['memory.intake.received', 'memory.intake.invalid'];
  if (names.has('memory.intake.denied')) {
    const denied = records.find(({ event_name: eventName }) => eventName === 'memory.intake.denied');
    return safeAttributes(denied)['pixel.memory.reason_code'] === 'INTAKE_CONTEXT_UNAVAILABLE'
      ? ['memory.intake.received', 'memory.intake.denied']
      : ['memory.intake.received', 'memory.intake.context_resolved', 'memory.intake.denied'];
  }
  return ['memory.intake.received', 'memory.record.stored'];
}

function contextSequence(records) {
  const names = new Set(records.map(({ event_name: eventName }) => eventName));
  if (names.has('memory.context.package_created')) return [
    'memory.context.requested', 'memory.context.scope_resolved',
    'memory.context.candidates_validated', 'memory.context.filtered',
    'memory.context.budget_applied', 'memory.context.package_created',
  ];
  if (names.has('memory.context.package_failed')) return [
    'memory.context.requested', 'memory.context.scope_resolved',
    'memory.context.candidates_validated', 'memory.context.filtered',
    'memory.context.budget_applied', 'memory.context.package_failed',
  ];
  const candidates = records.find(({ event_name: eventName }) => eventName === 'memory.context.candidates_validated');
  if (candidates?.outcome === 'error') return [
    'memory.context.requested', 'memory.context.scope_resolved', 'memory.context.candidates_validated',
  ];
  if (names.has('memory.context.job_rejected')) {
    return names.has('memory.context.requested')
      ? ['memory.context.requested', 'memory.context.job_rejected']
      : ['memory.context.job_rejected'];
  }
  return [
    'memory.context.requested', 'memory.context.scope_resolved',
    'memory.context.candidates_validated', 'memory.context.filtered',
    'memory.context.budget_applied', 'memory.context.package_created',
  ];
}

function intakeSemanticErrors(records) {
  const errors = [];
  const first = (name) => records.find(({ event_name: eventName }) => eventName === name);
  const received = first('memory.intake.received');
  if (received && !ENVIRONMENTS.has(safeAttributes(received)['pixel.environment'])) {
    errors.push('intake evidence has an invalid environment');
  }
  const authority = first('memory.intake.authority_rejected');
  const authorityAttributes = safeAttributes(authority);
  if (authority && (authorityAttributes['pixel.memory.reason_code'] !== 'CLIENT_AUTHORITY_CLAIM_REJECTED'
    || !nonNegativeInteger(authorityAttributes['pixel.security.authority_claim_count'])
    || authorityAttributes['pixel.security.authority_claim_count'] === 0)) {
    errors.push('authority rejection evidence contradicts its reason');
  }
  const invalid = first('memory.intake.invalid');
  const invalidAttributes = safeAttributes(invalid);
  if (invalid && (invalidAttributes['pixel.memory.reason_code'] !== 'INTAKE_INVALID'
    || !nonNegativeInteger(invalidAttributes['pixel.validation.error_count'])
    || invalidAttributes['pixel.validation.error_count'] === 0)) {
    errors.push('invalid intake evidence contradicts its reason');
  }
  const denied = first('memory.intake.denied');
  const deniedAttributes = safeAttributes(denied);
  if (denied && ![
    'INTAKE_CONTEXT_UNAVAILABLE', 'MEMORY_STORE_UNAVAILABLE', 'RECORD_INVALID',
  ].includes(deniedAttributes['pixel.memory.reason_code'])) {
    errors.push('intake denial evidence has an unsupported reason');
  }
  const resolved = first('memory.intake.context_resolved');
  const resolvedAttributes = safeAttributes(resolved);
  if (resolved && (!['simulator', 'live'].includes(resolvedAttributes['pixel.provider.source'])
    || !boundedText(resolvedAttributes['pixel.memory.department_ref']))) {
    errors.push('intake context evidence has invalid bounded values');
  }
  const stored = first('memory.record.stored');
  const storedAttributes = safeAttributes(stored);
  if (stored && (!validIdentifier(storedAttributes['pixel.memory.id'])
    || !validIdentifier(storedAttributes['pixel.memory.source_class'])
    || !boundedText(storedAttributes['pixel.memory.department_ref']))) {
    errors.push('stored-record evidence has invalid bounded values');
  }
  if (resolved && stored
    && resolvedAttributes['pixel.memory.department_ref'] !== storedAttributes['pixel.memory.department_ref']) {
    errors.push('intake department evidence disagrees');
  }
  return errors;
}

function contextSemanticErrors(records) {
  const errors = [];
  const first = (name) => records.find(({ event_name: eventName }) => eventName === name);
  const requestedAttributes = safeAttributes(first('memory.context.requested'));
  if (first('memory.context.requested') && !validIdentifier(requestedAttributes['pixel.job.id'])) {
    errors.push('context request evidence has an invalid job identifier');
  }
  const scopeAttributes = safeAttributes(first('memory.context.scope_resolved'));
  if (first('memory.context.scope_resolved')
    && !boundedText(scopeAttributes['pixel.memory.department_ref'])) {
    errors.push('context scope evidence has an invalid department');
  }
  const rejected = first('memory.context.job_rejected');
  if (rejected) {
    const rejectedAttributes = safeAttributes(rejected);
    const reason = rejectedAttributes['pixel.memory.reason_code'];
    if (![
      'CLIENT_AUTHORITY_CLAIM_REJECTED', 'CONTEXT_INPUT_INVALID', 'RELAY_UNAVAILABLE',
      'JOB_INVALID', 'JOB_NOT_FOUND', 'JOB_ID_MISMATCH', 'JOB_ENVIRONMENT_DENIED',
      'JOB_STATE_DENIED', 'CONTEXT_REQUEST_INVALID',
    ].includes(reason)) errors.push('job rejection evidence has an unsupported reason');
    if (reason === 'CLIENT_AUTHORITY_CLAIM_REJECTED'
      && (!nonNegativeInteger(rejectedAttributes['pixel.security.authority_claim_count'])
        || rejectedAttributes['pixel.security.authority_claim_count'] === 0)) {
      errors.push('job authority rejection evidence has an invalid count');
    }
    if (reason === 'JOB_STATE_DENIED'
      && !['SUBMITTED', 'RUNNING', 'COMPLETED', 'FAILED'].includes(rejectedAttributes['pixel.job.current_state'])) {
      errors.push('job-state rejection evidence claims an allowed or invalid state');
    }
  }
  const candidates = first('memory.context.candidates_validated');
  const candidateAttributes = safeAttributes(candidates);
  if (candidates?.outcome === 'success'
    && !nonNegativeInteger(candidateAttributes['pixel.memory.candidate_count'])) {
    errors.push('candidate validation evidence has an invalid count');
  }
  if (candidates?.outcome === 'error') {
    const reason = candidateAttributes['pixel.memory.reason_code'];
    if (!['MEMORY_STORE_UNAVAILABLE', 'RECORD_INVALID'].includes(reason)) {
      errors.push('candidate validation evidence has an unsupported failure reason');
    }
    if (reason === 'RECORD_INVALID'
      && (!nonNegativeInteger(candidateAttributes['pixel.memory.invalid_count'])
        || candidateAttributes['pixel.memory.invalid_count'] === 0)) {
      errors.push('invalid candidate evidence has an invalid count');
    }
  }
  const filteredRecord = first('memory.context.filtered');
  const filtered = filteredRecord ? safeAttributes(filteredRecord) : null;
  if (filtered && Object.values(filtered).some((value) => !nonNegativeInteger(value))) {
    errors.push('filter evidence has an invalid aggregate count');
  }
  if (filtered && candidates?.outcome === 'success') {
    const classified = Object.values(filtered).reduce((sum, value) => sum + value, 0);
    if (classified !== candidateAttributes['pixel.memory.candidate_count']) {
      errors.push('filter aggregates do not reconcile with candidates');
    }
  }
  const budgetRecord = first('memory.context.budget_applied');
  const budget = budgetRecord ? safeAttributes(budgetRecord) : null;
  if (budget && (
    !nonNegativeInteger(budget['pixel.memory.included_count'])
    || !nonNegativeInteger(budget['pixel.memory.omitted_count'])
    || !nonNegativeInteger(budget['pixel.memory.included_text_chars'])
    || budget['pixel.memory.included_count'] > 4
    || budget['pixel.memory.included_text_chars'] > 2048
    || (budget['pixel.memory.included_count'] === 0) !== (budget['pixel.memory.included_text_chars'] === 0)
    || budget['pixel.memory.included_count'] + budget['pixel.memory.omitted_count']
      !== filtered?.['pixel.memory.allowed_count']
  )) errors.push('budget evidence contradicts filtered candidates or bounds');
  const packagedRecord = first('memory.context.package_created');
  const packaged = packagedRecord ? safeAttributes(packagedRecord) : null;
  if (packaged && budget && (
    !validIdentifier(packaged['pixel.job.id'])
    || packaged['pixel.job.id'] !== requestedAttributes['pixel.job.id']
    || packaged['pixel.memory.included_count'] !== budget['pixel.memory.included_count']
    || packaged['pixel.memory.omitted_count'] !== budget['pixel.memory.omitted_count']
  )) errors.push('package evidence contradicts request or budget');
  const packageFailed = first('memory.context.package_failed');
  const packageFailedReason = safeAttributes(packageFailed)['pixel.memory.reason_code'];
  if (packageFailed && packageFailedReason !== 'PACKAGE_INVALID') {
    errors.push('package failure evidence has an unsupported reason');
  }
  if (candidates?.outcome === 'error' && records.some((record) => [
    'memory.context.filtered', 'memory.context.budget_applied',
    'memory.context.package_created', 'memory.context.package_failed',
  ].includes(record.event_name))) errors.push('context trace continues after terminal candidate failure');
  return errors;
}

export function assessMemoryIntakeTraceCompleteness(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return frozenAssessment(['memory.intake.received'], ['trace has no Memory intake evidence']);
  }
  if (records.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) {
    return frozenAssessment(['memory.intake.received'], ['trace contains a malformed evidence record']);
  }
  const memoryRecords = records.filter(({ event_name: eventName, service_name: serviceName }) => (
    INTAKE_EVENTS.has(eventName)
    || (typeof eventName === 'string' && eventName.startsWith('memory.'))
    || serviceName === SERVICE
  ));
  const errors = [];
  validateCommon(records, memoryRecords, INTAKE_EVENTS, errors);
  validateNoDuplicateEvents(memoryRecords, INTAKE_EVENTS, errors);
  const roots = memoryRecords.filter(({ parent_span_id: parentSpanId }) => parentSpanId === null);
  if (roots.length !== 1 || roots[0].event_name !== 'memory.intake.received') {
    errors.push('intake trace must have one Memory intake root');
  }
  const missing = validateSequence(memoryRecords, intakeSequence(memoryRecords), errors);
  errors.push(...intakeSemanticErrors(memoryRecords));
  return frozenAssessment(missing, errors);
}

export function assessMemoryContextTraceCompleteness(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return frozenAssessment(['memory.context.requested'], ['trace has no Memory context evidence']);
  }
  if (records.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) {
    return frozenAssessment(['memory.context.requested'], ['trace contains a malformed evidence record']);
  }
  const memoryRecords = records.filter(({ event_name: eventName, service_name: serviceName }) => (
    CONTEXT_EVENTS.has(eventName)
    || (typeof eventName === 'string' && eventName.startsWith('memory.'))
    || serviceName === SERVICE
  ));
  const errors = [];
  validateCommon(records, memoryRecords, CONTEXT_EVENTS, errors);
  if (memoryRecords.length === 0) errors.push('trace has no Memory context evidence');
  const bySpan = new Map(records.map((record) => [record.span_id, record]));
  const attempts = groupContextAttempts(memoryRecords, errors);
  if (attempts.length > 1
    && attempts.some(({ root }) => root.event_name !== 'memory.context.requested')) {
    errors.push('context trace mixes standalone and Relay-linked attempts');
  }

  const missing = attempts.length === 0 ? ['memory.context.requested'] : [];
  for (const { root: first, records: contextAttempt } of attempts) {
    validateNoDuplicateEvents(contextAttempt, CONTEXT_EVENTS, errors);
    if (first?.event_name === 'memory.context.requested') {
      const parent = bySpan.get(first.parent_span_id);
      const requestedJobId = safeAttributes(first)['pixel.job.id'];
      const rejected = contextAttempt.find(
        ({ event_name: eventName }) => eventName === 'memory.context.job_rejected',
      );
      const rejectedAttributes = safeAttributes(rejected);
      const state = rejectedAttributes['pixel.job.current_state'];
      const rejectionReason = rejectedAttributes['pixel.memory.reason_code'];
      let validParent;
      if (rejectionReason === 'JOB_STATE_DENIED') {
        validParent = validRelayParent(parent, requestedJobId, state);
      } else if (rejectionReason === 'JOB_ENVIRONMENT_DENIED') {
        validParent = ['SUBMITTED', 'ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED']
          .some((candidateState) => validRelayParent(parent, requestedJobId, candidateState));
      } else {
        validParent = validRelayParent(parent, requestedJobId, 'ACCEPTED');
      }
      if (!validParent) {
        errors.push('context request must continue its canonical Relay lifecycle span');
      }
    } else if (first?.event_name === 'memory.context.job_rejected' && first.parent_span_id !== null) {
      errors.push('standalone context rejection must be a trace root');
    }
    if (first?.event_name === 'memory.context.job_rejected') {
      const standaloneReason = safeAttributes(first)['pixel.memory.reason_code'];
      if (![
        'CLIENT_AUTHORITY_CLAIM_REJECTED', 'CONTEXT_INPUT_INVALID', 'RELAY_UNAVAILABLE',
        'JOB_INVALID', 'JOB_NOT_FOUND', 'JOB_ID_MISMATCH',
      ].includes(standaloneReason)) errors.push('standalone context rejection has an impossible reason');
    }
    const requestedRejection = contextAttempt.find(
      ({ event_name: eventName }) => eventName === 'memory.context.job_rejected',
    );
    if (first?.event_name === 'memory.context.requested' && requestedRejection && ![
      'JOB_ENVIRONMENT_DENIED', 'JOB_STATE_DENIED', 'CONTEXT_REQUEST_INVALID',
    ].includes(safeAttributes(requestedRejection)['pixel.memory.reason_code'])) {
      errors.push('post-request context rejection has an impossible reason');
    }
    missing.push(...validateSequence(contextAttempt, contextSequence(contextAttempt), errors));
    errors.push(...contextSemanticErrors(contextAttempt));
  }
  return frozenAssessment(missing, errors);
}
