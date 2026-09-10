import {
  MODEL_RUNTIME_ADAPTER_CONTRACT,
  validateModelProviderResultV1,
} from '../../contracts/src/model-v1.js';

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function visitPlainData(value, ancestors) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new TypeError('Adapter data must be safe plain data');

  const expectedPrototype = Array.isArray(value) ? Array.prototype : Object.prototype;
  if (Object.getPrototypeOf(value) !== expectedPrototype || ancestors.has(value)) {
    throw new TypeError('Adapter data must be safe plain data');
  }
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') throw new TypeError('Adapter data must be safe plain data');
    const descriptor = descriptors[key];
    if ('get' in descriptor || 'set' in descriptor) throw new TypeError('Adapter data must be safe plain data');
    if (key !== 'length') visitPlainData(descriptor.value, ancestors);
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
  visitPlainData(value, new WeakSet());
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
