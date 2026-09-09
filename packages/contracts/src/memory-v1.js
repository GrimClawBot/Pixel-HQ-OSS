export const MEMORY_SCHEMA_VERSION = '1.0.0';
export const MEMORY_INTAKE_INTENT_EVENT_NAME = 'pixel.memory.intake-intent.v1';
export const MEMORY_RECORD_EVENT_NAME = 'pixel.memory.record.v1';
export const MEMORY_CONTEXT_REQUEST_EVENT_NAME = 'pixel.memory.context-request.v1';
export const MEMORY_CONTEXT_PACKAGE_EVENT_NAME = 'pixel.memory.context-package.v1';

export const MEMORY_TEXT_MAX_CODE_POINTS = 1024;
export const MEMORY_TAG_MAX_ITEMS = 8;
export const MEMORY_TAG_MAX_CODE_POINTS = 32;
export const MEMORY_QUERY_MAX_CODE_POINTS = 1024;
export const MEMORY_CONTEXT_MAX_ITEMS = 4;
export const MEMORY_CONTEXT_MAX_CHARS = 2048;
export const MEMORY_VALIDATION_MAX_ERRORS = 32;

export const MEMORY_CLASSES = Object.freeze(['OPERATIONAL', 'PROJECT_SAFE']);
export const MEMORY_HANDLING_CLASSES = Object.freeze(['INTERNAL', 'RESTRICTED']);
export const MEMORY_LIFECYCLE_STATES = Object.freeze(['ACTIVE', 'SUPERSEDED']);

const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const MEMORY_CLASS_VALUES = new Set(MEMORY_CLASSES);
const HANDLING_VALUES = new Set(MEMORY_HANDLING_CLASSES);
const LIFECYCLE_VALUES = new Set(MEMORY_LIFECYCLE_STATES);
const SOURCES = new Set(['simulator', 'live']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const MEMORY_TOKEN_PATTERN = /\p{L}[\p{L}\p{N}]*|\p{N}+/gu;

const INTAKE_FIELDS = new Set(['event_name', 'schema_version', 'content']);
const RECORD_FIELDS = new Set([
  'memory_id', 'event_name', 'schema_version', 'created_at', 'observed_at', 'environment',
  'scope', 'memory_class', 'handling', 'lifecycle', 'content', 'provenance', 'trace_id',
  'span_id',
]);
const REQUEST_FIELDS = new Set([
  'request_id', 'event_name', 'schema_version', 'requested_at', 'job_id', 'environment',
  'query', 'budget', 'requester', 'owner', 'provenance',
]);
const PACKAGE_FIELDS = new Set([
  'package_id', 'event_name', 'schema_version', 'created_at', 'job_id', 'environment',
  'items', 'selection', 'trace_id', 'span_id',
]);
const CONTENT_FIELDS = new Set(['text', 'tags']);
const SCOPE_FIELDS = new Set(['scope_type', 'department_ref']);
const RECORD_PROVENANCE_FIELDS = new Set([
  'source_class', 'source_ref', 'intake_context_contract', 'intake_source',
]);
const BUDGET_FIELDS = new Set(['max_items', 'max_chars']);
const REQUESTER_FIELDS = new Set(['subject_id']);
const OWNER_FIELDS = new Set(['department_ref', 'role_ref']);
const REQUEST_PROVENANCE_FIELDS = new Set(['relay_contract', 'job_trace_id']);
const ITEM_FIELDS = new Set(['memory_id', 'text', 'source_ref']);
const SELECTION_FIELDS = new Set(['included_count', 'omitted_count', 'truncated']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codePointLength(value) {
  return Array.from(value).length;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function addError(errors, message) {
  if (errors.length < MEMORY_VALIDATION_MAX_ERRORS) errors.push(message);
}

function result(errors) {
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze([...errors]),
  });
}

function exactFields(value, allowed, label, errors) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) addError(errors, `${label} contains unsupported field ${field}`);
  }
}

function record(value, fields, label, errors, validate) {
  if (!isRecord(value)) {
    addError(errors, `${label} must be an object`);
    return;
  }
  exactFields(value, fields, label, errors);
  validate(value);
}

function identifier(value, label, errors) {
  if (!hasText(value) || !IDENTIFIER.test(value)) {
    addError(errors, `${label} must be a Pixel identifier`);
  }
}

function timestamp(value, label, errors) {
  if (!hasText(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    addError(errors, `${label} must be an ISO 8601 UTC timestamp`);
  }
}

function environment(value, errors) {
  if (!ENVIRONMENTS.has(value)) {
    addError(errors, 'environment must be dev, simulation, shadow, canary, or production');
  }
}

function validTraceId(value) {
  return typeof value === 'string' && TRACE_ID.test(value) && !/^0+$/.test(value);
}

function validSpanId(value) {
  return typeof value === 'string' && SPAN_ID.test(value) && !/^0+$/.test(value);
}

function traceIds(value, errors) {
  if (!validTraceId(value.trace_id)) {
    addError(errors, 'trace_id must be 32 non-zero lowercase hexadecimal characters');
  }
  if (!validSpanId(value.span_id)) {
    addError(errors, 'span_id must be 16 non-zero lowercase hexadecimal characters');
  }
}

function boundedText(value, label, maximum, errors) {
  if (typeof value !== 'string' || codePointLength(value) === 0 || codePointLength(value) > maximum) {
    addError(errors, `${label} must contain between 1 and ${maximum} Unicode code points`);
  }
}

function nonNegativeInteger(value, label, errors) {
  if (!Number.isInteger(value) || value < 0) {
    addError(errors, `${label} must be a non-negative integer`);
  }
}

export function tokenizeMemoryText(value) {
  if (typeof value !== 'string') return Object.freeze([]);
  return Object.freeze(value.normalize('NFKC').toLowerCase().match(MEMORY_TOKEN_PATTERN) ?? []);
}

export function normalizeMemoryTag(value) {
  if (typeof value !== 'string') return null;
  return tokenizeMemoryText(value).join('-');
}

function validateTags(tags, errors, { canonical }) {
  if (!Array.isArray(tags)) {
    addError(errors, 'content.tags must be an array');
    return;
  }
  if (tags.length > MEMORY_TAG_MAX_ITEMS) {
    addError(errors, `content.tags must contain at most ${MEMORY_TAG_MAX_ITEMS} tags`);
  }

  const normalizedTags = new Set();
  for (const [index, tag] of tags.entries()) {
    if (typeof tag !== 'string') {
      addError(errors, `content.tags[${index}] must be a string`);
      continue;
    }
    if (codePointLength(tag) > MEMORY_TAG_MAX_CODE_POINTS) {
      addError(errors, `content.tags[${index}] must contain at most ${MEMORY_TAG_MAX_CODE_POINTS} Unicode code points`);
      continue;
    }
    const normalized = normalizeMemoryTag(tag);
    if (normalized.length === 0) {
      addError(errors, `content.tags[${index}] must contain a Unicode letter or digit`);
      continue;
    }
    if (codePointLength(normalized) > MEMORY_TAG_MAX_CODE_POINTS) {
      addError(errors, `content.tags[${index}] must normalize to at most ${MEMORY_TAG_MAX_CODE_POINTS} Unicode code points`);
    }
    if (canonical && normalized !== tag) {
      addError(errors, `content.tags[${index}] must be canonical`);
    }
    if (normalizedTags.has(normalized)) {
      addError(errors, `content.tags[${index}] duplicates canonical tag ${normalized}`);
    }
    normalizedTags.add(normalized);
  }
}

function validateContent(value, errors, { tagsRequired, canonicalTags }) {
  record(value, CONTENT_FIELDS, 'content', errors, (content) => {
    boundedText(content.text, 'content.text', MEMORY_TEXT_MAX_CODE_POINTS, errors);
    if (content.tags === undefined && !tagsRequired) return;
    validateTags(content.tags, errors, { canonical: canonicalTags });
  });
}

function validateCommon(value, fields, label, eventName, timeField, errors) {
  exactFields(value, fields, label, errors);
  if (value.event_name !== eventName) addError(errors, `event_name must equal ${eventName}`);
  if (value.schema_version !== MEMORY_SCHEMA_VERSION) {
    addError(errors, `schema_version must equal ${MEMORY_SCHEMA_VERSION}`);
  }
  timestamp(value[timeField], timeField, errors);
  environment(value.environment, errors);
}

export class PixelMemoryContractValidationError extends Error {
  constructor(label, errors) {
    super(`${label} failed contract validation (${errors.length} error${errors.length === 1 ? '' : 's'})`);
    this.name = 'PixelMemoryContractValidationError';
    this.errors = Object.freeze([...errors].slice(0, MEMORY_VALIDATION_MAX_ERRORS));
  }
}

function assertContract(label, value, validate) {
  const validation = validate(value);
  if (!validation.ok) throw new PixelMemoryContractValidationError(label, validation.errors);
  return value;
}

export function validateMemoryIntakeIntentV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['memory intake intent must be an object']);
  exactFields(value, INTAKE_FIELDS, 'memory intake intent', errors);
  if (value.event_name !== MEMORY_INTAKE_INTENT_EVENT_NAME) {
    addError(errors, `event_name must equal ${MEMORY_INTAKE_INTENT_EVENT_NAME}`);
  }
  if (value.schema_version !== MEMORY_SCHEMA_VERSION) {
    addError(errors, `schema_version must equal ${MEMORY_SCHEMA_VERSION}`);
  }
  validateContent(value.content, errors, { tagsRequired: false, canonicalTags: false });
  return result(errors);
}

export function assertValidMemoryIntakeIntentV1(value) {
  return assertContract('Memory intake intent', value, validateMemoryIntakeIntentV1);
}

export function validateMemoryRecordV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['memory record must be an object']);
  validateCommon(value, RECORD_FIELDS, 'memory record', MEMORY_RECORD_EVENT_NAME, 'created_at', errors);
  identifier(value.memory_id, 'memory_id', errors);
  timestamp(value.observed_at, 'observed_at', errors);
  traceIds(value, errors);
  record(value.scope, SCOPE_FIELDS, 'scope', errors, (scope) => {
    if (scope.scope_type !== 'DEPARTMENT') addError(errors, 'scope.scope_type must equal DEPARTMENT');
    if (!hasText(scope.department_ref)) addError(errors, 'scope.department_ref is required');
  });
  if (!MEMORY_CLASS_VALUES.has(value.memory_class)) {
    addError(errors, 'memory_class must be OPERATIONAL or PROJECT_SAFE');
  }
  if (!HANDLING_VALUES.has(value.handling)) {
    addError(errors, 'handling must be INTERNAL or RESTRICTED');
  }
  if (!LIFECYCLE_VALUES.has(value.lifecycle)) {
    addError(errors, 'lifecycle must be ACTIVE or SUPERSEDED');
  }
  validateContent(value.content, errors, { tagsRequired: true, canonicalTags: true });
  record(value.provenance, RECORD_PROVENANCE_FIELDS, 'provenance', errors, (provenance) => {
    identifier(provenance.source_class, 'provenance.source_class', errors);
    identifier(provenance.source_ref, 'provenance.source_ref', errors);
    if (provenance.intake_context_contract !== 'pixel.memory-intake-context-provider.v1') {
      addError(errors, 'provenance.intake_context_contract must equal pixel.memory-intake-context-provider.v1');
    }
    if (!SOURCES.has(provenance.intake_source)) {
      addError(errors, 'provenance.intake_source must be simulator or live');
    }
  });
  return result(errors);
}

export function assertValidMemoryRecordV1(value) {
  return assertContract('Memory record', value, validateMemoryRecordV1);
}

export function validateMemoryContextRequestV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['memory context request must be an object']);
  validateCommon(
    value,
    REQUEST_FIELDS,
    'memory context request',
    MEMORY_CONTEXT_REQUEST_EVENT_NAME,
    'requested_at',
    errors,
  );
  identifier(value.request_id, 'request_id', errors);
  identifier(value.job_id, 'job_id', errors);
  boundedText(value.query, 'query', MEMORY_QUERY_MAX_CODE_POINTS, errors);
  record(value.budget, BUDGET_FIELDS, 'budget', errors, (budget) => {
    if (!Number.isInteger(budget.max_items) || budget.max_items < 1 || budget.max_items > MEMORY_CONTEXT_MAX_ITEMS) {
      addError(errors, `budget.max_items must be an integer between 1 and ${MEMORY_CONTEXT_MAX_ITEMS}`);
    }
    if (!Number.isInteger(budget.max_chars) || budget.max_chars < 1 || budget.max_chars > MEMORY_CONTEXT_MAX_CHARS) {
      addError(errors, `budget.max_chars must be an integer between 1 and ${MEMORY_CONTEXT_MAX_CHARS}`);
    }
  });
  record(value.requester, REQUESTER_FIELDS, 'requester', errors, (requester) => {
    identifier(requester.subject_id, 'requester.subject_id', errors);
  });
  record(value.owner, OWNER_FIELDS, 'owner', errors, (owner) => {
    if (!hasText(owner.department_ref)) addError(errors, 'owner.department_ref is required');
    if (!hasText(owner.role_ref)) addError(errors, 'owner.role_ref is required');
  });
  record(value.provenance, REQUEST_PROVENANCE_FIELDS, 'provenance', errors, (provenance) => {
    if (provenance.relay_contract !== 'pixel.relay.v1') {
      addError(errors, 'provenance.relay_contract must equal pixel.relay.v1');
    }
    if (!validTraceId(provenance.job_trace_id)) {
      addError(errors, 'provenance.job_trace_id must be 32 non-zero lowercase hexadecimal characters');
    }
  });
  return result(errors);
}

export function assertValidMemoryContextRequestV1(value) {
  return assertContract('Memory context request', value, validateMemoryContextRequestV1);
}

export function validateMemoryContextPackageV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['memory context package must be an object']);
  validateCommon(
    value,
    PACKAGE_FIELDS,
    'memory context package',
    MEMORY_CONTEXT_PACKAGE_EVENT_NAME,
    'created_at',
    errors,
  );
  identifier(value.package_id, 'package_id', errors);
  identifier(value.job_id, 'job_id', errors);
  traceIds(value, errors);

  let itemCount = null;
  let totalTextCharacters = 0;
  if (!Array.isArray(value.items)) {
    addError(errors, 'items must be an array');
  } else {
    itemCount = value.items.length;
    if (itemCount > MEMORY_CONTEXT_MAX_ITEMS) {
      addError(errors, `items must contain at most ${MEMORY_CONTEXT_MAX_ITEMS} entries`);
    }
    for (const [index, item] of value.items.entries()) {
      record(item, ITEM_FIELDS, `items[${index}]`, errors, (entry) => {
        identifier(entry.memory_id, `items[${index}].memory_id`, errors);
        boundedText(entry.text, `items[${index}].text`, MEMORY_TEXT_MAX_CODE_POINTS, errors);
        identifier(entry.source_ref, `items[${index}].source_ref`, errors);
        if (typeof entry.text === 'string') totalTextCharacters += codePointLength(entry.text);
      });
    }
    if (totalTextCharacters > MEMORY_CONTEXT_MAX_CHARS) {
      addError(errors, `items text must total at most ${MEMORY_CONTEXT_MAX_CHARS} Unicode code points`);
    }
  }

  record(value.selection, SELECTION_FIELDS, 'selection', errors, (selection) => {
    nonNegativeInteger(selection.included_count, 'selection.included_count', errors);
    nonNegativeInteger(selection.omitted_count, 'selection.omitted_count', errors);
    if (typeof selection.truncated !== 'boolean') {
      addError(errors, 'selection.truncated must be a boolean');
    }
    if (itemCount !== null && selection.included_count !== itemCount) {
      addError(errors, 'selection.included_count must equal items.length');
    }
    if (selection.truncated !== (Number.isInteger(selection.omitted_count) && selection.omitted_count > 0)) {
      addError(errors, 'selection.truncated must equal whether omitted_count is greater than zero');
    }
  });
  return result(errors);
}

export function assertValidMemoryContextPackageV1(value) {
  return assertContract('Memory context package', value, validateMemoryContextPackageV1);
}
