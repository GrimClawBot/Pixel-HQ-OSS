import {
  MEMORY_CLASSES,
  MEMORY_HANDLING_CLASSES,
} from '../../contracts/src/memory-v1.js';

export const MEMORY_INTAKE_CONTEXT_PROVIDER_CONTRACT = 'pixel.memory-intake-context-provider.v1';
export const MEMORY_STORE_ADAPTER_CONTRACT = 'pixel.memory-store.adapter.v1';

const SOURCES = new Set(['simulator', 'live']);
const MEMORY_CLASS_VALUES = new Set(MEMORY_CLASSES);
const HANDLING_VALUES = new Set(MEMORY_HANDLING_CLASSES);
const CONTEXT_FIELDS = new Set([
  'scope', 'memory_class', 'handling', 'provenance', 'provider_contract', 'source',
]);
const SCOPE_FIELDS = new Set(['scope_type', 'department_ref']);
const PROVENANCE_FIELDS = new Set([
  'source_class', 'source_ref', 'intake_context_contract', 'intake_source',
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value, fields, label, errors) {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) errors.push(`${label} contains unsupported field ${field}`);
  }
}

function nested(value, fields, label, errors, validate) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  exactFields(value, fields, label, errors);
  validate(value);
}

function identifier(value, label, errors) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    errors.push(`${label} must be a Pixel identifier`);
  }
}

function text(value, label, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) errors.push(`${label} is required`);
}

function assertAdapter(value, methods, label) {
  if (!isRecord(value) || !SOURCES.has(value.source) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`${label} must declare simulator or live source and implement ${methods.join(', ')}`);
  }
  return value;
}

export function assertMemoryIntakeContextProvider(value) {
  return assertAdapter(value, ['resolveMemoryIntakeContext'], 'Memory intake context provider');
}

export function assertMemoryStoreAdapter(value) {
  return assertAdapter(value, ['putRecord', 'getRecord', 'listByDepartment'], 'Memory store adapter');
}

export function validateMemoryIntakeContext(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['memory intake context must be an object'] };
  exactFields(value, CONTEXT_FIELDS, 'memory intake context', errors);
  nested(value.scope, SCOPE_FIELDS, 'scope', errors, (scope) => {
    if (scope.scope_type !== 'DEPARTMENT') errors.push('scope.scope_type must equal DEPARTMENT');
    text(scope.department_ref, 'scope.department_ref', errors);
  });
  if (!MEMORY_CLASS_VALUES.has(value.memory_class)) {
    errors.push('memory_class must be OPERATIONAL or PROJECT_SAFE');
  }
  if (!HANDLING_VALUES.has(value.handling)) {
    errors.push('handling must be INTERNAL or RESTRICTED');
  }
  nested(value.provenance, PROVENANCE_FIELDS, 'provenance', errors, (provenance) => {
    identifier(provenance.source_class, 'provenance.source_class', errors);
    identifier(provenance.source_ref, 'provenance.source_ref', errors);
    if (provenance.intake_context_contract !== MEMORY_INTAKE_CONTEXT_PROVIDER_CONTRACT) {
      errors.push(`provenance.intake_context_contract must equal ${MEMORY_INTAKE_CONTEXT_PROVIDER_CONTRACT}`);
    }
    if (!SOURCES.has(provenance.intake_source)) {
      errors.push('provenance.intake_source must be simulator or live');
    }
  });
  if (value.provider_contract !== MEMORY_INTAKE_CONTEXT_PROVIDER_CONTRACT) {
    errors.push(`provider_contract must equal ${MEMORY_INTAKE_CONTEXT_PROVIDER_CONTRACT}`);
  }
  if (!SOURCES.has(value.source)) errors.push('source must be simulator or live');
  if (SOURCES.has(value.source)
    && SOURCES.has(value.provenance?.intake_source)
    && value.source !== value.provenance.intake_source) {
    errors.push('source must equal provenance.intake_source');
  }
  return { ok: errors.length === 0, errors };
}
