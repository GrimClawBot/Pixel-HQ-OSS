import {
  assertRelayStoreAdapter,
} from '../../../packages/adapter-sdk/src/job-runtime-adapters.js';
import {
  assertMemoryIntakeContextProvider,
  assertMemoryStoreAdapter,
  validateMemoryIntakeContext,
} from '../../../packages/adapter-sdk/src/memory-runtime-adapters.js';
import {
  MEMORY_CONTEXT_MAX_CHARS,
  MEMORY_CONTEXT_MAX_ITEMS,
  MEMORY_CONTEXT_PACKAGE_EVENT_NAME,
  MEMORY_CONTEXT_REQUEST_EVENT_NAME,
  MEMORY_RECORD_EVENT_NAME,
  MEMORY_SCHEMA_VERSION,
  assertValidMemoryContextPackageV1,
  assertValidMemoryContextRequestV1,
  assertValidMemoryRecordV1,
  normalizeMemoryTag,
  tokenizeMemoryText,
  validateMemoryIntakeIntentV1,
  validateMemoryRecordV1,
} from '../../../packages/contracts/src/memory-v1.js';
import {
  validateJobEnvelopeV1,
  validateJobTransitionV1,
} from '../../../packages/contracts/src/job-v1.js';
import { evaluateMemoryContextAccess } from '../../policy/src/memory-context-policy.js';

const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const SIMULATOR_ENVIRONMENTS = new Set(['dev', 'simulation']);
const INPUT_FIELDS = new Set(['job_id', 'query']);
const AUTHORITY_SCAN_MAX_ENTRIES = 1024;
const AUTHORITY_KEYS = new Set([
  'budget', 'capability', 'capabilities', 'classification', 'department', 'departmentref',
  'environment', 'grant', 'grants', 'handling', 'lifecycle', 'memoryclass', 'memoryid',
  'owner', 'permission', 'permissions', 'policy', 'policyid', 'provenance', 'requester',
  'role', 'roleref', 'scope', 'sensitivity', 'source', 'spanid', 'state', 'subjectid',
  'timestamp', 'traceid', 'createdat', 'observedat', 'requestedat', 'sourceclass',
  'sourceref', 'intakesource',
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

function scanAuthorityCategories(value) {
  const categories = new Set();
  const pending = [value];
  const visited = new Set();
  let examinedEntries = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      if (examinedEntries === AUTHORITY_SCAN_MAX_ENTRIES) {
        return { categories, exhausted: true };
      }
      examinedEntries += 1;
      const normalized = normalizedKey(key);
      if (AUTHORITY_KEYS.has(normalized)) categories.add(normalized);
      const child = current[key];
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return { categories, exhausted: false };
}

function countCodePoints(value) {
  return Array.from(value).length;
}

function compareOrdinal(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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

function latestJobSpan(job) {
  return job.transitions.at(-1)?.span_id ?? job.envelope.span_id;
}

function requireDependencies({ environment, intakeContextProvider, memoryStore, relayStore, evidence, ids, clock }) {
  if (!ENVIRONMENTS.has(environment)) throw new TypeError('Memory requires a canonical environment');
  assertMemoryIntakeContextProvider(intakeContextProvider);
  assertMemoryStoreAdapter(memoryStore);
  assertRelayStoreAdapter(relayStore);
  if (!evidence || typeof evidence.append !== 'function') throw new TypeError('Memory requires evidence');
  const idMethods = ['nextMemoryId', 'nextRequestId', 'nextPackageId', 'nextSpanId', 'nextTraceId'];
  if (!ids || idMethods.some((method) => typeof ids[method] !== 'function')) {
    throw new TypeError('Memory requires memory, request, package, span, and trace ID sources');
  }
  if (typeof clock !== 'function') throw new TypeError('Memory requires a clock');
  if ([intakeContextProvider, memoryStore, relayStore].some(({ source }) => source === 'simulator')
    && !SIMULATOR_ENVIRONMENTS.has(environment)) {
    throw new RangeError('Simulator Memory adapters may run only in dev or simulation');
  }
}

export class MemoryService {
  #clock;
  #environment;
  #evidence;
  #ids;
  #intakeContextProvider;
  #memoryStore;
  #relayStore;

  constructor({ environment, intakeContextProvider, memoryStore, relayStore, evidence, ids, clock }) {
    requireDependencies({ environment, intakeContextProvider, memoryStore, relayStore, evidence, ids, clock });
    this.#environment = environment;
    this.#intakeContextProvider = intakeContextProvider;
    this.#memoryStore = memoryStore;
    this.#relayStore = relayStore;
    this.#evidence = evidence;
    this.#ids = ids;
    this.#clock = clock;
  }

  #append({ traceId, spanId, parentSpanId = null, eventName, outcome = 'success', severity = 'info', attributes = {} }) {
    this.#evidence.append({
      traceId,
      spanId,
      parentSpanId,
      serviceName: 'pixel.memory',
      eventName,
      outcome,
      severity,
      attributes,
    });
    return spanId;
  }

  #intakeFailure({ traceId, parentSpanId, disposition, reasonCode, eventName, attributes = {} }) {
    this.#append({
      traceId,
      spanId: this.#ids.nextSpanId(),
      parentSpanId,
      eventName,
      outcome: disposition === 'UNAVAILABLE' ? 'error' : 'denied',
      severity: disposition === 'UNAVAILABLE' ? 'error' : 'warning',
      attributes: { 'pixel.memory.reason_code': reasonCode, ...attributes },
    });
    return frozenCopy({ disposition, reason_code: reasonCode, record: null, trace_id: traceId });
  }

  async intake(intent) {
    const traceId = this.#ids.nextTraceId();
    const rootSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId,
      spanId: rootSpanId,
      eventName: 'memory.intake.received',
      attributes: { 'pixel.environment': this.#environment },
    });

    const authorityScan = scanAuthorityCategories(intent);
    if (authorityScan.exhausted) {
      return this.#intakeFailure({
        traceId,
        parentSpanId: rootSpanId,
        disposition: 'REJECTED',
        reasonCode: 'INTAKE_INVALID',
        eventName: 'memory.intake.invalid',
        attributes: { 'pixel.validation.error_count': 1 },
      });
    }
    if (authorityScan.categories.size > 0) {
      return this.#intakeFailure({
        traceId,
        parentSpanId: rootSpanId,
        disposition: 'REJECTED',
        reasonCode: 'CLIENT_AUTHORITY_CLAIM_REJECTED',
        eventName: 'memory.intake.authority_rejected',
        attributes: { 'pixel.security.authority_claim_count': authorityScan.categories.size },
      });
    }
    const validation = validateMemoryIntakeIntentV1(intent);
    if (!validation.ok) {
      return this.#intakeFailure({
        traceId,
        parentSpanId: rootSpanId,
        disposition: 'REJECTED',
        reasonCode: 'INTAKE_INVALID',
        eventName: 'memory.intake.invalid',
        attributes: { 'pixel.validation.error_count': validation.errors.length },
      });
    }

    let context;
    try {
      context = frozenCopy(await this.#intakeContextProvider.resolveMemoryIntakeContext());
      if (!validateMemoryIntakeContext(context).ok
        || context.source !== this.#intakeContextProvider.source) throw new TypeError('Invalid intake context');
    } catch {
      return this.#intakeFailure({
        traceId,
        parentSpanId: rootSpanId,
        disposition: 'UNAVAILABLE',
        reasonCode: 'INTAKE_CONTEXT_UNAVAILABLE',
        eventName: 'memory.intake.denied',
      });
    }

    const contextSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId,
      spanId: contextSpanId,
      parentSpanId: rootSpanId,
      eventName: 'memory.intake.context_resolved',
      attributes: {
        'pixel.memory.department_ref': context.scope.department_ref,
        'pixel.provider.source': context.source,
      },
    });
    const recordSpanId = this.#ids.nextSpanId();
    const now = this.#clock();
    const record = frozenCopy({
      memory_id: this.#ids.nextMemoryId(),
      event_name: MEMORY_RECORD_EVENT_NAME,
      schema_version: MEMORY_SCHEMA_VERSION,
      created_at: now,
      observed_at: now,
      environment: this.#environment,
      scope: context.scope,
      memory_class: context.memory_class,
      handling: context.handling,
      lifecycle: 'ACTIVE',
      content: {
        text: intent.content.text,
        tags: (intent.content.tags ?? []).map(normalizeMemoryTag),
      },
      provenance: context.provenance,
      trace_id: traceId,
      span_id: recordSpanId,
    });

    try {
      assertValidMemoryRecordV1(record);
    } catch {
      return this.#intakeFailure({
        traceId,
        parentSpanId: contextSpanId,
        disposition: 'UNAVAILABLE',
        reasonCode: 'RECORD_INVALID',
        eventName: 'memory.intake.denied',
      });
    }

    let stored;
    try {
      stored = frozenCopy(await this.#memoryStore.putRecord(record));
    } catch {
      return this.#intakeFailure({
        traceId,
        parentSpanId: contextSpanId,
        disposition: 'UNAVAILABLE',
        reasonCode: 'MEMORY_STORE_UNAVAILABLE',
        eventName: 'memory.intake.denied',
      });
    }
    if (!validateMemoryRecordV1(stored).ok || JSON.stringify(stored) !== JSON.stringify(record)) {
      return this.#intakeFailure({
        traceId,
        parentSpanId: contextSpanId,
        disposition: 'UNAVAILABLE',
        reasonCode: 'RECORD_INVALID',
        eventName: 'memory.intake.denied',
      });
    }
    this.#append({
      traceId,
      spanId: recordSpanId,
      parentSpanId: contextSpanId,
      eventName: 'memory.record.stored',
      attributes: {
        'pixel.memory.id': record.memory_id,
        'pixel.memory.department_ref': record.scope.department_ref,
        'pixel.memory.source_class': record.provenance.source_class,
      },
    });
    return frozenCopy({ disposition: 'STORED', record, trace_id: traceId });
  }

  #contextFailure({ traceId, parentSpanId, disposition, reasonCode, eventName, attributes = {} }) {
    this.#append({
      traceId,
      spanId: this.#ids.nextSpanId(),
      parentSpanId,
      eventName,
      outcome: disposition === 'UNAVAILABLE' ? 'error' : 'denied',
      severity: disposition === 'UNAVAILABLE' ? 'error' : 'warning',
      attributes: { 'pixel.memory.reason_code': reasonCode, ...attributes },
    });
    return frozenCopy({ disposition, reason_code: reasonCode, package: null, trace_id: traceId });
  }

  async buildContext(input) {
    const inputIsObject = input !== null && typeof input === 'object' && !Array.isArray(input);
    const authorityScan = inputIsObject
      ? scanAuthorityCategories(input)
      : { categories: new Set(), exhausted: false };
    const exactInput = !authorityScan.exhausted
      && inputIsObject
      && Object.keys(input).every((key) => INPUT_FIELDS.has(key))
      && Object.keys(input).length === INPUT_FIELDS.size
      && typeof input.job_id === 'string'
      && input.job_id.length > 0
      && typeof input.query === 'string';
    if (!exactInput || authorityScan.exhausted || authorityScan.categories.size > 0) {
      const traceId = this.#ids.nextTraceId();
      const authorityRejected = !authorityScan.exhausted && authorityScan.categories.size > 0;
      return this.#contextFailure({
        traceId,
        parentSpanId: null,
        disposition: 'DENIED',
        reasonCode: authorityRejected ? 'CLIENT_AUTHORITY_CLAIM_REJECTED' : 'CONTEXT_INPUT_INVALID',
        eventName: 'memory.context.job_rejected',
        attributes: authorityRejected
          ? { 'pixel.security.authority_claim_count': authorityScan.categories.size }
          : {},
      });
    }

    let job;
    try {
      job = frozenCopy(await this.#relayStore.getJob(input.job_id));
    } catch {
      const traceId = this.#ids.nextTraceId();
      return this.#contextFailure({
        traceId,
        parentSpanId: null,
        disposition: 'UNAVAILABLE',
        reasonCode: 'RELAY_UNAVAILABLE',
        eventName: 'memory.context.job_rejected',
      });
    }
    const jobIsValid = validJobProjection(job);
    const jobMatchesRequest = jobIsValid && job.envelope.job_id === input.job_id;
    const traceId = jobMatchesRequest ? job.envelope.trace_id : this.#ids.nextTraceId();
    if (!jobMatchesRequest) {
      return this.#contextFailure({
        traceId,
        parentSpanId: null,
        disposition: 'DENIED',
        reasonCode: job
          ? (jobIsValid ? 'JOB_ID_MISMATCH' : 'JOB_INVALID')
          : 'JOB_NOT_FOUND',
        eventName: 'memory.context.job_rejected',
      });
    }
    const parentSpanId = latestJobSpan(job);
    const requestedSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId,
      spanId: requestedSpanId,
      parentSpanId,
      eventName: 'memory.context.requested',
      attributes: { 'pixel.job.id': job.envelope.job_id },
    });
    if (job.envelope.environment !== this.#environment) {
      return this.#contextFailure({
        traceId,
        parentSpanId: requestedSpanId,
        disposition: 'DENIED',
        reasonCode: 'JOB_ENVIRONMENT_DENIED',
        eventName: 'memory.context.job_rejected',
      });
    }
    if (job.current_state !== 'ACCEPTED') {
      return this.#contextFailure({
        traceId,
        parentSpanId: requestedSpanId,
        disposition: 'DENIED',
        reasonCode: 'JOB_STATE_DENIED',
        eventName: 'memory.context.job_rejected',
        attributes: { 'pixel.job.current_state': job.current_state },
      });
    }

    const request = frozenCopy({
      request_id: this.#ids.nextRequestId(),
      event_name: MEMORY_CONTEXT_REQUEST_EVENT_NAME,
      schema_version: MEMORY_SCHEMA_VERSION,
      requested_at: this.#clock(),
      job_id: job.envelope.job_id,
      environment: job.envelope.environment,
      query: input.query,
      budget: { max_items: MEMORY_CONTEXT_MAX_ITEMS, max_chars: MEMORY_CONTEXT_MAX_CHARS },
      requester: job.envelope.requester,
      owner: job.envelope.owner,
      provenance: {
        relay_contract: job.envelope.provenance.relay_contract,
        job_trace_id: job.envelope.trace_id,
      },
    });
    try {
      assertValidMemoryContextRequestV1(request);
    } catch {
      return this.#contextFailure({
        traceId,
        parentSpanId: requestedSpanId,
        disposition: 'DENIED',
        reasonCode: 'CONTEXT_REQUEST_INVALID',
        eventName: 'memory.context.job_rejected',
      });
    }

    const scopeSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId,
      spanId: scopeSpanId,
      parentSpanId: requestedSpanId,
      eventName: 'memory.context.scope_resolved',
      attributes: { 'pixel.memory.department_ref': request.owner.department_ref },
    });

    let candidates;
    try {
      candidates = await this.#memoryStore.listByDepartment(request.owner.department_ref);
    } catch {
      return this.#contextFailure({
        traceId,
        parentSpanId: scopeSpanId,
        disposition: 'UNAVAILABLE',
        reasonCode: 'MEMORY_STORE_UNAVAILABLE',
        eventName: 'memory.context.candidates_validated',
      });
    }
    if (!Array.isArray(candidates)) {
      return this.#contextFailure({
        traceId,
        parentSpanId: scopeSpanId,
        disposition: 'UNAVAILABLE',
        reasonCode: 'RECORD_INVALID',
        eventName: 'memory.context.candidates_validated',
        attributes: { 'pixel.memory.invalid_count': 1 },
      });
    }
    try {
      candidates = candidates.map(frozenCopy);
    } catch {
      return this.#contextFailure({
        traceId,
        parentSpanId: scopeSpanId,
        disposition: 'UNAVAILABLE',
        reasonCode: 'RECORD_INVALID',
        eventName: 'memory.context.candidates_validated',
        attributes: { 'pixel.memory.invalid_count': 1 },
      });
    }
    const validations = candidates.map(validateMemoryRecordV1);
    const invalidCount = validations.filter(({ ok }) => !ok).length;
    if (invalidCount > 0) {
      return this.#contextFailure({
        traceId,
        parentSpanId: scopeSpanId,
        disposition: 'UNAVAILABLE',
        reasonCode: 'RECORD_INVALID',
        eventName: 'memory.context.candidates_validated',
        attributes: { 'pixel.memory.invalid_count': invalidCount },
      });
    }

    const validatedSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId,
      spanId: validatedSpanId,
      parentSpanId: scopeSpanId,
      eventName: 'memory.context.candidates_validated',
      attributes: { 'pixel.memory.candidate_count': candidates.length },
    });

    const excluded = new Map();
    const allowed = [];
    const increment = (code) => excluded.set(code, (excluded.get(code) ?? 0) + 1);
    for (const record of candidates) {
      if (record.environment !== request.environment) {
        increment('ENVIRONMENT_MISMATCH');
        continue;
      }
      const policy = evaluateMemoryContextAccess({
        record,
        departmentRef: request.owner.department_ref,
      });
      if (policy.decision !== 'ALLOW') {
        increment(policy.reason_code);
        continue;
      }
      if (record.lifecycle !== 'ACTIVE') {
        increment('INACTIVE_MEMORY');
        continue;
      }
      allowed.push(record);
    }

    const queryTokens = new Set(tokenizeMemoryText(request.query));
    const scored = [];
    for (const record of allowed) {
      const tagTokens = new Set(record.content.tags.flatMap((tag) => tag.split('-')));
      const textTokens = new Set(tokenizeMemoryText(record.content.text));
      let score = 0;
      for (const token of queryTokens) {
        if (tagTokens.has(token)) score += 2;
        if (textTokens.has(token)) score += 1;
      }
      if (score === 0) increment('IRRELEVANT');
      else scored.push({ record, score });
    }
    scored.sort((left, right) => right.score - left.score
      || compareOrdinal(right.record.observed_at, left.record.observed_at)
      || compareOrdinal(left.record.memory_id, right.record.memory_id));

    const filteredSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId,
      spanId: filteredSpanId,
      parentSpanId: validatedSpanId,
      eventName: 'memory.context.filtered',
      attributes: {
        'pixel.memory.allowed_count': scored.length,
        'pixel.memory.scope_mismatch_count': excluded.get('SCOPE_MISMATCH') ?? 0,
        'pixel.memory.restricted_denied_count': excluded.get('RESTRICTED_SCOPE_DENIED') ?? 0,
        'pixel.memory.inactive_count': excluded.get('INACTIVE_MEMORY') ?? 0,
        'pixel.memory.environment_mismatch_count': excluded.get('ENVIRONMENT_MISMATCH') ?? 0,
        'pixel.memory.irrelevant_count': excluded.get('IRRELEVANT') ?? 0,
      },
    });

    const items = [];
    let textCharacters = 0;
    let omittedCount = 0;
    for (const { record } of scored) {
      const textCost = countCodePoints(record.content.text);
      if (items.length >= request.budget.max_items
        || textCharacters + textCost > request.budget.max_chars) {
        omittedCount += 1;
        continue;
      }
      items.push({
        memory_id: record.memory_id,
        text: record.content.text,
        source_ref: record.provenance.source_ref,
      });
      textCharacters += textCost;
    }

    const budgetSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId,
      spanId: budgetSpanId,
      parentSpanId: filteredSpanId,
      eventName: 'memory.context.budget_applied',
      attributes: {
        'pixel.memory.included_count': items.length,
        'pixel.memory.omitted_count': omittedCount,
        'pixel.memory.included_text_chars': textCharacters,
      },
    });
    let packageSpanId;
    let contextPackage;
    try {
      packageSpanId = this.#ids.nextSpanId();
      contextPackage = frozenCopy({
        package_id: this.#ids.nextPackageId(),
        event_name: MEMORY_CONTEXT_PACKAGE_EVENT_NAME,
        schema_version: MEMORY_SCHEMA_VERSION,
        created_at: this.#clock(),
        job_id: request.job_id,
        environment: request.environment,
        items,
        selection: {
          included_count: items.length,
          omitted_count: omittedCount,
          truncated: omittedCount > 0,
        },
        trace_id: traceId,
        span_id: packageSpanId,
      });
      assertValidMemoryContextPackageV1(contextPackage);
    } catch {
      return this.#contextFailure({
        traceId,
        parentSpanId: budgetSpanId,
        disposition: 'UNAVAILABLE',
        reasonCode: 'PACKAGE_INVALID',
        eventName: 'memory.context.package_failed',
      });
    }
    this.#append({
      traceId,
      spanId: packageSpanId,
      parentSpanId: budgetSpanId,
      eventName: 'memory.context.package_created',
      attributes: {
        'pixel.job.id': request.job_id,
        'pixel.memory.included_count': items.length,
        'pixel.memory.omitted_count': omittedCount,
      },
    });
    return frozenCopy({ disposition: 'CREATED', package: contextPackage, trace_id: traceId });
  }
}
