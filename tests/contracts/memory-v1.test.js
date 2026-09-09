import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertValidMemoryContextPackageV1,
  assertValidMemoryContextRequestV1,
  assertValidMemoryIntakeIntentV1,
  assertValidMemoryRecordV1,
  MEMORY_CONTEXT_MAX_CHARS,
  MEMORY_CONTEXT_MAX_ITEMS,
  MEMORY_CONTEXT_PACKAGE_EVENT_NAME,
  MEMORY_CONTEXT_REQUEST_EVENT_NAME,
  MEMORY_INTAKE_INTENT_EVENT_NAME,
  MEMORY_QUERY_MAX_CODE_POINTS,
  MEMORY_RECORD_EVENT_NAME,
  MEMORY_SCHEMA_VERSION,
  MEMORY_TAG_MAX_CODE_POINTS,
  MEMORY_TAG_MAX_ITEMS,
  MEMORY_TEXT_MAX_CODE_POINTS,
  normalizeMemoryTag,
  tokenizeMemoryText,
  validateMemoryContextPackageV1,
  validateMemoryContextRequestV1,
  validateMemoryIntakeIntentV1,
  validateMemoryRecordV1,
} from '../../packages/contracts/src/memory-v1.js';
import {
  assertMemoryIntakeContextProvider,
  assertMemoryStoreAdapter,
  validateMemoryIntakeContext,
} from '../../packages/adapter-sdk/src/memory-runtime-adapters.js';
import { SimulatorMemoryIntakeContextProvider } from '../../adapters/simulator/src/memory-intake-context-simulator-provider.js';
import { SimulatorMemoryStoreAdapter } from '../../adapters/simulator/src/memory-store-simulator-adapter.js';

const NOW = '2026-09-08T12:00:00.000Z';
const TRACE_ID = '1234567890abcdef1234567890abcdef';
const SPAN_ID = '1234567890abcdef';

const fixtures = {
  intake: {
    event_name: 'pixel.memory.intake-intent.v1',
    schema_version: '1.0.0',
    content: {
      text: 'Synthetic storage status is ready.',
      tags: ['Storage Status', 'Rack-2'],
    },
  },
  record: {
    memory_id: 'memory-001',
    event_name: 'pixel.memory.record.v1',
    schema_version: '1.0.0',
    created_at: NOW,
    observed_at: NOW,
    environment: 'simulation',
    scope: {
      scope_type: 'DEPARTMENT',
      department_ref: 'Infrastructure / HomeLab',
    },
    memory_class: 'OPERATIONAL',
    handling: 'INTERNAL',
    lifecycle: 'ACTIVE',
    content: {
      text: 'Synthetic storage status is ready.',
      tags: ['storage-status', 'rack-2'],
    },
    provenance: {
      source_class: 'synthetic',
      source_ref: 'fixture-001',
      intake_context_contract: 'pixel.memory-intake-context-provider.v1',
      intake_source: 'simulator',
    },
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
  },
  request: {
    request_id: 'memory-request-001',
    event_name: 'pixel.memory.context-request.v1',
    schema_version: '1.0.0',
    requested_at: NOW,
    job_id: 'job-001',
    environment: 'simulation',
    query: 'storage status',
    budget: { max_items: 4, max_chars: 2048 },
    requester: { subject_id: 'PIXEL-PRINCIPAL' },
    owner: {
      department_ref: 'Infrastructure / HomeLab',
      role_ref: 'Systems',
    },
    provenance: {
      relay_contract: 'pixel.relay.v1',
      job_trace_id: TRACE_ID,
    },
  },
  package: {
    package_id: 'memory-package-001',
    event_name: 'pixel.memory.context-package.v1',
    schema_version: '1.0.0',
    created_at: NOW,
    job_id: 'job-001',
    environment: 'simulation',
    items: [{
      memory_id: 'memory-001',
      text: 'Synthetic storage status is ready.',
      source_ref: 'fixture-001',
    }],
    selection: {
      included_count: 1,
      omitted_count: 0,
      truncated: false,
    },
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
  },
};

const contractCases = [
  ['intake intent', fixtures.intake, validateMemoryIntakeIntentV1, assertValidMemoryIntakeIntentV1],
  ['memory record', fixtures.record, validateMemoryRecordV1, assertValidMemoryRecordV1],
  ['context request', fixtures.request, validateMemoryContextRequestV1, assertValidMemoryContextRequestV1],
  ['context package', fixtures.package, validateMemoryContextPackageV1, assertValidMemoryContextPackageV1],
];

test('publishes the exact Memory v1 event names and Alpha bounds', () => {
  assert.equal(MEMORY_SCHEMA_VERSION, '1.0.0');
  assert.equal(MEMORY_INTAKE_INTENT_EVENT_NAME, 'pixel.memory.intake-intent.v1');
  assert.equal(MEMORY_RECORD_EVENT_NAME, 'pixel.memory.record.v1');
  assert.equal(MEMORY_CONTEXT_REQUEST_EVENT_NAME, 'pixel.memory.context-request.v1');
  assert.equal(MEMORY_CONTEXT_PACKAGE_EVENT_NAME, 'pixel.memory.context-package.v1');
  assert.equal(MEMORY_TEXT_MAX_CODE_POINTS, 1024);
  assert.equal(MEMORY_TAG_MAX_ITEMS, 8);
  assert.equal(MEMORY_TAG_MAX_CODE_POINTS, 32);
  assert.equal(MEMORY_QUERY_MAX_CODE_POINTS, 1024);
  assert.equal(MEMORY_CONTEXT_MAX_ITEMS, 4);
  assert.equal(MEMORY_CONTEXT_MAX_CHARS, 2048);
});

test('normalizes tags with NFKC, lowercase, punctuation separators, and Unicode tokens', () => {
  assert.equal(normalizeMemoryTag('  ＳＴＯＲＡＧＥ_status—Rack２  '), 'storage-status-rack2');
  assert.equal(normalizeMemoryTag('Crème 東京 版本2 123'), 'crème-東京-版本2-123');
  assert.equal(normalizeMemoryTag('!!! 🔐 ---'), '');
  assert.equal(normalizeMemoryTag(42), null);
});

test('tokenizes Memory text deterministically and returns an immutable token list', () => {
  const tokens = tokenizeMemoryText('Ｓtorage, ÉTAT! 東京42 + 123');
  assert.deepEqual(tokens, ['storage', 'état', '東京42', '123']);
  assert.equal(Object.isFrozen(tokens), true);
  assert.deepEqual(tokenizeMemoryText(null), []);
});

test('all four contracts accept complete canonical values', () => {
  for (const [label, value, validate, assertValid] of contractCases) {
    assert.deepEqual(validate(value), { ok: true, errors: [] }, label);
    assert.equal(assertValid(value), value, label);
  }
});

test('all four contracts reject unknown fields recursively', () => {
  assert.equal(validateMemoryIntakeIntentV1({
    ...fixtures.intake,
    grants: ['forged'],
    content: { ...fixtures.intake.content, policy: 'ALLOW' },
  }).ok, false);
  assert.equal(validateMemoryRecordV1({
    ...fixtures.record,
    scope: { ...fixtures.record.scope, role: 'Principal' },
    provenance: { ...fixtures.record.provenance, secret: 'not-allowed' },
  }).ok, false);
  assert.equal(validateMemoryContextRequestV1({
    ...fixtures.request,
    budget: { ...fixtures.request.budget, grant: true },
    requester: { ...fixtures.request.requester, authority: 'root' },
    owner: { ...fixtures.request.owner, state: 'ACCEPTED' },
    provenance: { ...fixtures.request.provenance, raw_job: {} },
  }).ok, false);
  assert.equal(validateMemoryContextPackageV1({
    ...fixtures.package,
    grants: ['forged'],
    items: [{ ...fixtures.package.items[0], handling: 'RESTRICTED' }],
    selection: { ...fixtures.package.selection, reason: 'hidden-policy-detail' },
  }).ok, false);
});

test('intake counts Unicode code points and rejects duplicate, empty, oversized, and excess tags', () => {
  assert.equal(validateMemoryIntakeIntentV1({
    ...fixtures.intake,
    content: { text: '🚀'.repeat(1024), tags: ['Ａlpha', 'alpha'] },
  }).ok, false, 'duplicates after normalization are rejected');
  assert.equal(validateMemoryIntakeIntentV1({
    ...fixtures.intake,
    content: { text: '🚀'.repeat(1025), tags: ['valid'] },
  }).ok, false, 'astral code points over the text bound are rejected');
  assert.equal(validateMemoryIntakeIntentV1({
    ...fixtures.intake,
    content: { text: 'valid', tags: ['---'] },
  }).ok, false, 'empty normalized tags are rejected');
  assert.equal(validateMemoryIntakeIntentV1({
    ...fixtures.intake,
    content: { text: 'valid', tags: ['é'.repeat(33)] },
  }).ok, false, 'canonical tags over the code-point bound are rejected');
  assert.equal(validateMemoryIntakeIntentV1({
    ...fixtures.intake,
    content: { text: 'valid', tags: [`a${'.'.repeat(32)}`] },
  }).ok, false, 'raw tags over the code-point bound are rejected before normalization');
  assert.equal(validateMemoryIntakeIntentV1({
    ...fixtures.intake,
    content: { text: 'valid', tags: Array.from({ length: 9 }, (_, index) => `tag-${index}`) },
  }).ok, false, 'tag item bound is enforced');
  assert.equal(validateMemoryIntakeIntentV1({
    ...fixtures.intake,
    content: { text: '🚀'.repeat(1024), tags: ['ok'] },
  }).ok, true, 'astral code points at the text bound are accepted');
});

test('record validation independently rejects noncanonical and invalid adapter tags and text', () => {
  const invalidContents = [
    { text: 'x'.repeat(1025), tags: ['storage-status'] },
    { text: 'valid', tags: ['Storage Status'] },
    { text: 'valid', tags: ['storage-status', 'storage-status'] },
    { text: 'valid', tags: ['---'] },
    { text: 'valid', tags: ['é'.repeat(33)] },
    { text: 'valid', tags: Array.from({ length: 9 }, (_, index) => `tag-${index}`) },
  ];
  for (const content of invalidContents) {
    assert.equal(validateMemoryRecordV1({ ...fixtures.record, content }).ok, false);
  }
});

test('record validates canonical identifiers, timestamps, enums, and trace identifiers', () => {
  for (const record of [
    { ...fixtures.record, memory_id: 'bad id' },
    { ...fixtures.record, observed_at: '2026-09-08T08:00:00.000-04:00' },
    { ...fixtures.record, environment: 'local' },
    { ...fixtures.record, memory_class: 'PERSONAL' },
    { ...fixtures.record, handling: 'PUBLIC' },
    { ...fixtures.record, lifecycle: 'DELETED' },
    { ...fixtures.record, trace_id: '0'.repeat(32) },
  ]) {
    assert.equal(validateMemoryRecordV1(record).ok, false);
  }
});

test('trace identifiers reject non-string values without coercion or exceptions', () => {
  const malformedIds = [
    1234567890123456,
    ['1234567890abcdef'],
    { toString: null },
  ];

  for (const malformedId of malformedIds) {
    assert.equal(validateMemoryRecordV1({ ...fixtures.record, span_id: malformedId }).ok, false);
    assert.equal(validateMemoryRecordV1({ ...fixtures.record, trace_id: malformedId }).ok, false);
    assert.equal(validateMemoryContextPackageV1({ ...fixtures.package, span_id: malformedId }).ok, false);
    assert.equal(validateMemoryContextPackageV1({ ...fixtures.package, trace_id: malformedId }).ok, false);
    assert.equal(validateMemoryContextRequestV1({
      ...fixtures.request,
      provenance: { ...fixtures.request.provenance, job_trace_id: malformedId },
    }).ok, false);
  }
});

test('context request requires server-owned requester, owner, provenance, and bounded budgets', () => {
  assert.equal(validateMemoryContextRequestV1({
    ...fixtures.request,
    query: '🚀'.repeat(1024),
    budget: { max_items: 1, max_chars: 1 },
  }).ok, true);
  for (const request of [
    { ...fixtures.request, query: '🚀'.repeat(1025) },
    { ...fixtures.request, budget: { max_items: 0, max_chars: 100 } },
    { ...fixtures.request, budget: { max_items: 5, max_chars: 100 } },
    { ...fixtures.request, budget: { max_items: 1.5, max_chars: 100 } },
    { ...fixtures.request, budget: { max_items: 1, max_chars: 2049 } },
    { ...fixtures.request, provenance: { ...fixtures.request.provenance, job_trace_id: '0'.repeat(32) } },
  ]) {
    assert.equal(validateMemoryContextRequestV1(request).ok, false);
  }
});

test('context package enforces item and text bounds plus consistent selection metadata', () => {
  const item = fixtures.package.items[0];
  assert.equal(validateMemoryContextPackageV1({
    ...fixtures.package,
    items: Array.from({ length: 4 }, (_, index) => ({ ...item, memory_id: `memory-${index}` })),
    selection: { included_count: 4, omitted_count: 1, truncated: true },
  }).ok, true);
  for (const pkg of [
    {
      ...fixtures.package,
      items: Array.from({ length: 5 }, (_, index) => ({ ...item, memory_id: `memory-${index}` })),
      selection: { included_count: 5, omitted_count: 0, truncated: false },
    },
    {
      ...fixtures.package,
      items: Array.from({ length: 3 }, (_, index) => ({
        ...item,
        memory_id: `memory-${index}`,
        text: 'x'.repeat(1024),
      })),
      selection: { included_count: 3, omitted_count: 0, truncated: false },
    },
    { ...fixtures.package, items: [{ ...item, text: 'x'.repeat(1025) }] },
    { ...fixtures.package, selection: { included_count: 0, omitted_count: 0, truncated: false } },
    { ...fixtures.package, selection: { included_count: 1, omitted_count: 1, truncated: false } },
    { ...fixtures.package, selection: { included_count: 1, omitted_count: 0, truncated: true } },
  ]) {
    assert.equal(validateMemoryContextPackageV1(pkg).ok, false);
  }
});

test('validation results and assertion errors expose bounded immutable error arrays', () => {
  const invalid = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`forged_${index}`, true]));
  const result = validateMemoryIntakeIntentV1(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length <= 32);
  assert.equal(Object.isFrozen(result.errors), true);
  assert.throws(
    () => assertValidMemoryIntakeIntentV1(invalid),
    (error) => error.name === 'PixelMemoryContractValidationError'
      && Object.isFrozen(error.errors)
      && error.errors.length <= 32,
  );
});

test('published schemas are recursively strict and expose structural constants and bounds', async () => {
  const schemaCases = [
    ['pixel-memory-intake-intent-v1.schema.json', MEMORY_INTAKE_INTENT_EVENT_NAME],
    ['pixel-memory-record-v1.schema.json', MEMORY_RECORD_EVENT_NAME],
    ['pixel-memory-context-request-v1.schema.json', MEMORY_CONTEXT_REQUEST_EVENT_NAME],
    ['pixel-memory-context-package-v1.schema.json', MEMORY_CONTEXT_PACKAGE_EVENT_NAME],
  ];

  for (const [name, eventName] of schemaCases) {
    const schema = JSON.parse(await readFile(new URL(`../../packages/contracts/schemas/${name}`, import.meta.url)));
    const serialized = JSON.stringify(schema);
    assert.equal(schema.additionalProperties, false, name);
    assert.equal(schema.properties.event_name.const, eventName, name);
    assert.equal(schema.properties.schema_version.const, MEMORY_SCHEMA_VERSION, name);
    assert.equal(
      (serialized.match(/"type":"object"/g) ?? []).length,
      (serialized.match(/"additionalProperties":false/g) ?? []).length,
      `${name} strict object count`,
    );
  }

  const intake = JSON.parse(await readFile(new URL(
    '../../packages/contracts/schemas/pixel-memory-intake-intent-v1.schema.json', import.meta.url,
  )));
  const record = JSON.parse(await readFile(new URL(
    '../../packages/contracts/schemas/pixel-memory-record-v1.schema.json', import.meta.url,
  )));
  const request = JSON.parse(await readFile(new URL(
    '../../packages/contracts/schemas/pixel-memory-context-request-v1.schema.json', import.meta.url,
  )));
  const pkg = JSON.parse(await readFile(new URL(
    '../../packages/contracts/schemas/pixel-memory-context-package-v1.schema.json', import.meta.url,
  )));

  assert.equal(intake.$defs.content.properties.text.maxLength, MEMORY_TEXT_MAX_CODE_POINTS);
  assert.equal(intake.$defs.content.properties.tags.maxItems, MEMORY_TAG_MAX_ITEMS);
  assert.equal(intake.$defs.tag.maxLength, MEMORY_TAG_MAX_CODE_POINTS);
  assert.equal(record.$defs.content.properties.text.maxLength, MEMORY_TEXT_MAX_CODE_POINTS);
  assert.equal(record.$defs.content.properties.tags.maxItems, MEMORY_TAG_MAX_ITEMS);
  assert.equal(request.properties.query.maxLength, MEMORY_QUERY_MAX_CODE_POINTS);
  assert.equal(request.$defs.budget.properties.max_items.maximum, MEMORY_CONTEXT_MAX_ITEMS);
  assert.equal(request.$defs.budget.properties.max_chars.maximum, MEMORY_CONTEXT_MAX_CHARS);
  assert.equal(pkg.properties.items.maxItems, MEMORY_CONTEXT_MAX_ITEMS);
  assert.equal(pkg.$defs.item.properties.text.maxLength, MEMORY_TEXT_MAX_CODE_POINTS);
});

test('schema checks alone do not establish canonical tags or aggregate package bounds', async () => {
  const recordSchema = JSON.parse(await readFile(new URL(
    '../../packages/contracts/schemas/pixel-memory-record-v1.schema.json', import.meta.url,
  )));
  const packageSchema = JSON.parse(await readFile(new URL(
    '../../packages/contracts/schemas/pixel-memory-context-package-v1.schema.json', import.meta.url,
  )));

  assert.equal(typeof recordSchema.$comment, 'string');
  assert.match(recordSchema.$comment, /runtime validator/i);
  assert.equal(typeof packageSchema.$comment, 'string');
  assert.match(packageSchema.$comment, /aggregate.*2048.*runtime/i);

  const lexicallyValidButNoncanonicalTags = ['Router', 'ＲＯＵＴＥＲ'];
  const lexicalTagPattern = new RegExp(recordSchema.$defs.canonical_tag.pattern, 'u');
  assert.equal(lexicallyValidButNoncanonicalTags.every((tag) => lexicalTagPattern.test(tag)), true);
  assert.equal(new Set(lexicallyValidButNoncanonicalTags).size, 2);
  assert.equal(validateMemoryRecordV1({
    ...fixtures.record,
    content: { ...fixtures.record.content, tags: lexicallyValidButNoncanonicalTags },
  }).ok, false);

  const structurallyBoundedItems = Array.from({ length: 3 }, (_, index) => ({
    ...fixtures.package.items[0],
    memory_id: `memory-aggregate-${index}`,
    text: 'x'.repeat(700),
  }));
  assert.equal(structurallyBoundedItems.length <= packageSchema.properties.items.maxItems, true);
  assert.equal(structurallyBoundedItems.every(
    ({ text }) => Array.from(text).length <= packageSchema.$defs.item.properties.text.maxLength,
  ), true);
  assert.equal(validateMemoryContextPackageV1({
    ...fixtures.package,
    items: structurallyBoundedItems,
    selection: { included_count: 3, omitted_count: 0, truncated: false },
  }).ok, false);
});

test('intake and package schemas expose no authority or grant fields', async () => {
  for (const name of [
    'pixel-memory-intake-intent-v1.schema.json',
    'pixel-memory-context-package-v1.schema.json',
  ]) {
    const schema = JSON.parse(await readFile(new URL(`../../packages/contracts/schemas/${name}`, import.meta.url)));
    const serialized = JSON.stringify(schema);
    for (const forbidden of ['grant', 'permission', 'policy_id', 'requester', 'owner', 'department_ref']) {
      assert.equal(serialized.includes(`"${forbidden}"`), false, `${name} excludes ${forbidden}`);
    }
  }
});

test('Memory runtime adapters expose a Registry-bound synthetic intake context', async () => {
  const provider = assertMemoryIntakeContextProvider(new SimulatorMemoryIntakeContextProvider());
  const context = await provider.resolveMemoryIntakeContext();

  assert.deepEqual(context, {
    scope: {
      scope_type: 'DEPARTMENT',
      department_ref: 'Infrastructure / HomeLab',
    },
    memory_class: 'OPERATIONAL',
    handling: 'INTERNAL',
    provenance: {
      source_class: 'synthetic',
      source_ref: 'simulator-memory-intake',
      intake_context_contract: 'pixel.memory-intake-context-provider.v1',
      intake_source: 'simulator',
    },
    provider_contract: 'pixel.memory-intake-context-provider.v1',
    source: 'simulator',
  });
  assert.equal(validateMemoryIntakeContext(context).ok, true);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.scope), true);
  assert.equal(Object.isFrozen(context.provenance), true);
});

test('Memory runtime seams accept independently shaped live implementations', () => {
  assert.equal(assertMemoryIntakeContextProvider({ source: 'live', resolveMemoryIntakeContext() {} }).source, 'live');
  assert.equal(assertMemoryStoreAdapter({
    source: 'live',
    putRecord() {},
    getRecord() {},
    listByDepartment() {},
  }).source, 'live');
  assert.throws(() => assertMemoryIntakeContextProvider({ source: 'simulator' }), /resolveMemoryIntakeContext/);
  assert.throws(() => assertMemoryStoreAdapter({ source: 'simulator', putRecord() {} }), /getRecord/);
});

test('Memory intake context rejects mismatched root and provenance sources', () => {
  assert.equal(validateMemoryIntakeContext({
    scope: { scope_type: 'DEPARTMENT', department_ref: 'Infrastructure / HomeLab' },
    memory_class: 'OPERATIONAL',
    handling: 'INTERNAL',
    provenance: {
      source_class: 'synthetic',
      source_ref: 'simulator-memory-intake',
      intake_context_contract: 'pixel.memory-intake-context-provider.v1',
      intake_source: 'simulator',
    },
    provider_contract: 'pixel.memory-intake-context-provider.v1',
    source: 'live',
  }).ok, false);
});

test('simulator Memory storage validates writes and returns immutable isolated records in insertion order', () => {
  const store = assertMemoryStoreAdapter(new SimulatorMemoryStoreAdapter());
  const first = structuredClone(fixtures.record);
  const second = {
    ...structuredClone(fixtures.record),
    memory_id: 'memory-002',
    content: { text: 'Synthetic network status is ready.', tags: ['network-status'] },
  };

  store.putRecord(first);
  store.putRecord(second);
  first.content.text = 'forged caller mutation';

  const stored = store.getRecord('memory-001');
  const listed = store.listByDepartment('Infrastructure / HomeLab');
  assert.equal(stored.content.text, 'Synthetic storage status is ready.');
  assert.deepEqual(listed.map(({ memory_id }) => memory_id), ['memory-001', 'memory-002']);
  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Object.isFrozen(stored.content), true);
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(Object.isFrozen(listed[0]), true);
  assert.notEqual(stored, listed[0]);
  assert.equal(store.getRecord('missing-memory'), null);
  assert.deepEqual(store.listByDepartment('Finance & Opportunity'), []);
  assert.throws(() => store.putRecord({ ...fixtures.record, content: { text: 'bad tags', tags: ['Bad Tags'] } }), {
    name: 'PixelMemoryContractValidationError',
  });
  assert.equal(store.getRecord('memory-001').content.text, 'Synthetic storage status is ready.');
});

test('simulator Memory storage validates its snapshot instead of rereading accessor-backed input', () => {
  const store = new SimulatorMemoryStoreAdapter();
  const accessorRecord = structuredClone(fixtures.record);
  let memoryIdReads = 0;
  Object.defineProperty(accessorRecord, 'memory_id', {
    configurable: true,
    enumerable: true,
    get() {
      memoryIdReads += 1;
      return memoryIdReads === 1 ? 'memory-accessor-valid' : 'invalid memory id';
    },
  });

  const stored = store.putRecord(accessorRecord);

  assert.equal(memoryIdReads, 1);
  assert.equal(stored.memory_id, 'memory-accessor-valid');
  assert.equal(store.getRecord('memory-accessor-valid').memory_id, 'memory-accessor-valid');
  assert.equal(store.getRecord('invalid memory id'), null);
  assert.doesNotThrow(() => assertValidMemoryRecordV1(stored));
});
