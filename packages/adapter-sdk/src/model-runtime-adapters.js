import {
  MODEL_RUNTIME_ADAPTER_CONTRACT,
  validateModelProviderResultV1,
} from '../../contracts/src/model-v1.js';

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SAFE_DATA_MAX_DEPTH = 16;
const SAFE_DATA_MAX_NODES = 128;
const SAFE_DATA_MAX_KEYS = 256;
const SAFE_DATA_MAX_KEYS_PER_OBJECT = 64;
const SAFE_DATA_MAX_ARRAY_LENGTH = 64;
const SAFE_DATA_MAX_PROPERTY_NAME_CODE_UNITS = 160;
const SAFE_DATA_MAX_STRING_CODE_UNITS = 4096;

function visitPlainData(value, ancestors, state, depth) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > SAFE_DATA_MAX_STRING_CODE_UNITS) throw new TypeError('Adapter data must be safe plain data');
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new TypeError('Adapter data must be safe plain data');
  state.nodes += 1;
  if (depth > SAFE_DATA_MAX_DEPTH || state.nodes > SAFE_DATA_MAX_NODES) {
    throw new TypeError('Adapter data must be safe plain data');
  }

  const expectedPrototype = Array.isArray(value) ? Array.prototype : Object.prototype;
  if (Object.getPrototypeOf(value) !== expectedPrototype || ancestors.has(value)) {
    throw new TypeError('Adapter data must be safe plain data');
  }
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  state.keys += keys.length;
  if (keys.length > SAFE_DATA_MAX_KEYS_PER_OBJECT || state.keys > SAFE_DATA_MAX_KEYS) {
    throw new TypeError('Adapter data must be safe plain data');
  }
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    const elementKeys = keys.filter((key) => key !== 'length');
    if (!Number.isSafeInteger(length) || length > SAFE_DATA_MAX_ARRAY_LENGTH
      || elementKeys.length !== length
      || elementKeys.some((key, index) => key !== String(index))) {
      throw new TypeError('Adapter data must be safe plain data');
    }
  }
  for (const key of keys) {
    if (typeof key === 'symbol') throw new TypeError('Adapter data must be safe plain data');
    if (key.length > SAFE_DATA_MAX_PROPERTY_NAME_CODE_UNITS) throw new TypeError('Adapter data must be safe plain data');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) throw new TypeError('Adapter data must be safe plain data');
    if ('get' in descriptor || 'set' in descriptor) throw new TypeError('Adapter data must be safe plain data');
    if (key !== 'length') visitPlainData(descriptor.value, ancestors, state, depth + 1);
  }
  ancestors.delete(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function assertSafePlainData(value) {
  visitPlainData(value, new WeakSet(), { nodes: 0, keys: 0 }, 0);
  return value;
}

export function snapshotSafePlainData(value) {
  assertSafePlainData(value);
  return deepFreeze(structuredClone(value));
}

export function assertModelRuntimeAdapter(value) {
  if (!plainRecord(value)
    || value.source !== 'simulator'
    || value.providerContract !== MODEL_RUNTIME_ADAPTER_CONTRACT
    || typeof value.runtimeId !== 'string'
    || typeof value.modelId !== 'string'
    || typeof value.invoke !== 'function') {
    throw new TypeError('Model runtime adapter must declare exact simulator identity and implement invoke()');
  }
  return value;
}

export function snapshotModelProviderResult(value) {
  const snapshot = snapshotSafePlainData(value);
  const validation = validateModelProviderResultV1(snapshot);
  if (!validation.ok) throw new TypeError('Model provider result failed validation');
  return snapshot;
}
