export const DEVICE_SNAPSHOT_EVENT_NAME = 'pixel.device.snapshot.v1';
export const DEVICE_SNAPSHOT_SCHEMA_VERSION = '1.0.0';
export const DEVICE_ADAPTER_CONTRACT = 'pixel.device.adapter.v1';

export const DEVICE_LIFECYCLE_STATES = Object.freeze(['active']);
export const DEVICE_HEALTH_STATES = Object.freeze(['ready', 'needs_attention']);
export const OWNER_STATES = Object.freeze(['Ready', 'Needs Attention']);

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const SOURCES = new Set(['simulator', 'live']);
const PROTECTION_STATES = new Set(['protected', 'at_risk', 'unknown']);
const EVENT_FIELDS = new Set([
  'event_id', 'event_name', 'schema_version', 'occurred_at', 'environment', 'source',
  'trace_id', 'span_id', 'device', 'owner', 'attention', 'provenance',
]);
const DEVICE_FIELDS = new Set(['device_id', 'role_id', 'lifecycle_state', 'health_state', 'storage']);
const STORAGE_FIELDS = new Set(['capacity_bytes', 'used_bytes', 'available_bytes', 'protection_state']);
const OWNER_FIELDS = new Set([
  'state', 'summary', 'impact', 'action_required', 'recommended_action', 'verified_at',
]);
const ATTENTION_FIELDS = new Set([
  'deduplication_key', 'title', 'summary', 'owning_department', 'recommended_action',
]);
const PROVENANCE_FIELDS = new Set(['adapter_contract', 'adapter_id', 'scenario']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  return hasText(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateRequiredText(record, field, errors, prefix = '') {
  if (!hasText(record?.[field])) {
    errors.push(`${prefix}${field} must be a non-empty string`);
  }
}

function validateExactFields(record, allowedFields, errors, label) {
  for (const field of Object.keys(record)) {
    if (!allowedFields.has(field)) {
      errors.push(`${label} contains unsupported field ${field}`);
    }
  }
}

function validateAttention(attention, errors) {
  if (!isRecord(attention)) {
    errors.push('attention must be an object when present');
    return;
  }

  validateExactFields(attention, ATTENTION_FIELDS, errors, 'attention');

  for (const field of [
    'deduplication_key',
    'title',
    'summary',
    'owning_department',
    'recommended_action',
  ]) {
    validateRequiredText(attention, field, errors, 'attention.');
  }
}

export class PixelContractValidationError extends Error {
  constructor(errors) {
    super(`Device snapshot failed contract validation (${errors.length} error${errors.length === 1 ? '' : 's'})`);
    this.name = 'PixelContractValidationError';
    this.errors = Object.freeze([...errors]);
  }
}

export function validateDeviceSnapshotV1(value) {
  const errors = [];

  if (!isRecord(value)) {
    return { ok: false, errors: ['event must be an object'] };
  }

  validateExactFields(value, EVENT_FIELDS, errors, 'event');

  validateRequiredText(value, 'event_id', errors);
  if (hasText(value.event_id) && !IDENTIFIER.test(value.event_id)) {
    errors.push('event_id contains unsupported characters');
  }

  if (value.event_name !== DEVICE_SNAPSHOT_EVENT_NAME) {
    errors.push(`event_name must equal ${DEVICE_SNAPSHOT_EVENT_NAME}`);
  }
  if (value.schema_version !== DEVICE_SNAPSHOT_SCHEMA_VERSION) {
    errors.push(`schema_version must equal ${DEVICE_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!isIsoTimestamp(value.occurred_at)) {
    errors.push('occurred_at must be an ISO 8601 UTC timestamp');
  }
  if (!ENVIRONMENTS.has(value.environment)) {
    errors.push('environment must be dev, simulation, shadow, canary, or production');
  }
  if (!SOURCES.has(value.source)) {
    errors.push('source must be simulator or live');
  }
  if (!HEX_32.test(value.trace_id) || /^0+$/.test(value.trace_id ?? '')) {
    errors.push('trace_id must be 32 lowercase hexadecimal characters');
  }
  if (!HEX_16.test(value.span_id) || /^0+$/.test(value.span_id ?? '')) {
    errors.push('span_id must be 16 lowercase hexadecimal characters');
  }

  if (!isRecord(value.device)) {
    errors.push('device must be an object');
  } else {
    validateExactFields(value.device, DEVICE_FIELDS, errors, 'device');
    validateRequiredText(value.device, 'device_id', errors, 'device.');
    validateRequiredText(value.device, 'role_id', errors, 'device.');
    if (!DEVICE_LIFECYCLE_STATES.includes(value.device.lifecycle_state)) {
      errors.push('device.lifecycle_state must be active');
    }
    if (!DEVICE_HEALTH_STATES.includes(value.device.health_state)) {
      errors.push('device.health_state must be ready or needs_attention');
    }

    if (!isRecord(value.device.storage)) {
      errors.push('device.storage must be an object');
    } else {
      const storage = value.device.storage;
      validateExactFields(storage, STORAGE_FIELDS, errors, 'device.storage');
      if (!Number.isSafeInteger(storage.capacity_bytes) || storage.capacity_bytes <= 0) {
        errors.push('storage capacity_bytes must be a positive safe integer');
      }
      for (const field of ['used_bytes', 'available_bytes']) {
        if (!Number.isSafeInteger(storage[field]) || storage[field] < 0) {
          errors.push(`storage ${field} must be a non-negative safe integer`);
        }
      }
      if (
        Number.isSafeInteger(storage.capacity_bytes)
        && Number.isSafeInteger(storage.used_bytes)
        && Number.isSafeInteger(storage.available_bytes)
        && storage.used_bytes + storage.available_bytes !== storage.capacity_bytes
      ) {
        errors.push('storage used_bytes plus available_bytes must equal capacity_bytes');
      }
      if (!PROTECTION_STATES.has(storage.protection_state)) {
        errors.push('storage protection_state must be protected, at_risk, or unknown');
      }
    }
  }

  if (!isRecord(value.owner)) {
    errors.push('owner must be an object');
  } else {
    validateExactFields(value.owner, OWNER_FIELDS, errors, 'owner');
    if (!OWNER_STATES.includes(value.owner.state)) {
      errors.push('owner.state must be Ready or Needs Attention');
    }
    validateRequiredText(value.owner, 'summary', errors, 'owner.');
    validateRequiredText(value.owner, 'impact', errors, 'owner.');
    if (typeof value.owner.action_required !== 'boolean') {
      errors.push('owner.action_required must be a boolean');
    }
    if (value.owner.recommended_action !== null && !hasText(value.owner.recommended_action)) {
      errors.push('owner.recommended_action must be null or a non-empty string');
    }
    if (!isIsoTimestamp(value.owner.verified_at)) {
      errors.push('owner.verified_at must be an ISO 8601 UTC timestamp');
    }
  }

  if (value.device?.health_state === 'needs_attention') {
    if (value.attention === null || value.attention === undefined) {
      errors.push('attention is required when health_state is needs_attention');
    } else {
      validateAttention(value.attention, errors);
    }
    if (value.owner?.state !== 'Needs Attention') {
      errors.push('owner.state must be Needs Attention when health_state is needs_attention');
    }
    if (value.owner?.action_required !== true) {
      errors.push('owner.action_required must be true when health_state is needs_attention');
    }
  }

  if (value.device?.health_state === 'ready') {
    if (value.attention !== null) {
      errors.push('attention must be null when health_state is ready');
    }
    if (value.owner?.state !== 'Ready') {
      errors.push('owner.state must be Ready when health_state is ready');
    }
    if (value.owner?.action_required !== false) {
      errors.push('owner.action_required must be false when health_state is ready');
    }
  }

  if (!isRecord(value.provenance)) {
    errors.push('provenance must be an object');
  } else {
    validateExactFields(value.provenance, PROVENANCE_FIELDS, errors, 'provenance');
    validateRequiredText(value.provenance, 'adapter_contract', errors, 'provenance.');
    validateRequiredText(value.provenance, 'adapter_id', errors, 'provenance.');
    validateRequiredText(value.provenance, 'scenario', errors, 'provenance.');
    if (
      hasText(value.provenance.adapter_contract)
      && value.provenance.adapter_contract !== DEVICE_ADAPTER_CONTRACT
    ) {
      errors.push(`provenance.adapter_contract must equal ${DEVICE_ADAPTER_CONTRACT}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidDeviceSnapshotV1(value) {
  const result = validateDeviceSnapshotV1(value);
  if (!result.ok) {
    throw new PixelContractValidationError(result.errors);
  }
  return value;
}
