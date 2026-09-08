import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertValidDeviceSnapshotV1,
  validateDeviceSnapshotV1,
} from '../../packages/contracts/src/device-snapshot-v1.js';

const VALID_EVENT = Object.freeze({
  event_id: 'evt-storage-0001',
  event_name: 'pixel.device.snapshot.v1',
  schema_version: '1.0.0',
  occurred_at: '2026-09-06T13:00:00.000Z',
  environment: 'simulation',
  source: 'simulator',
  trace_id: '0123456789abcdef0123456789abcdef',
  span_id: '0123456789abcdef',
  device: {
    device_id: 'sim-storage-01',
    role_id: 'PIXEL-STORAGE-01',
    lifecycle_state: 'active',
    health_state: 'ready',
    storage: {
      capacity_bytes: 24000000000000,
      used_bytes: 7200000000000,
      available_bytes: 16800000000000,
      protection_state: 'protected',
    },
  },
  owner: {
    state: 'Ready',
    summary: 'Your storage is ready and protected.',
    impact: 'Files and backups remain available.',
    action_required: false,
    recommended_action: null,
    verified_at: '2026-09-06T13:00:00.000Z',
  },
  attention: null,
  provenance: {
    adapter_contract: 'pixel.device.adapter.v1',
    adapter_id: 'pixel.simulator.storage.v1',
    scenario: 'healthy',
  },
});

test('accepts a complete production-shaped healthy storage event', () => {
  assert.deepEqual(validateDeviceSnapshotV1(VALID_EVENT), {
    ok: true,
    errors: [],
  });
  assert.equal(assertValidDeviceSnapshotV1(VALID_EVENT), VALID_EVENT);
});

test('accepts the dev environment boundary', () => {
  assert.deepEqual(validateDeviceSnapshotV1({ ...VALID_EVENT, environment: 'dev' }), {
    ok: true,
    errors: [],
  });
});

test('publishes dev in the v1 JSON Schema environment enum', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../../packages/contracts/schemas/pixel-device-snapshot-v1.schema.json', import.meta.url),
    'utf8',
  ));

  assert.deepEqual(schema.properties.environment.enum, [
    'dev',
    'simulation',
    'shadow',
    'canary',
    'production',
  ]);
});

test('rejects a different schema version before projection', () => {
  const event = { ...VALID_EVENT, schema_version: '2.0.0' };

  assert.deepEqual(validateDeviceSnapshotV1(event), {
    ok: false,
    errors: ['schema_version must equal 1.0.0'],
  });
});

test('rejects invalid trace identifiers', () => {
  const event = { ...VALID_EVENT, trace_id: 'not-a-trace', span_id: 'short' };

  assert.deepEqual(validateDeviceSnapshotV1(event), {
    ok: false,
    errors: [
      'trace_id must be 32 lowercase hexadecimal characters',
      'span_id must be 16 lowercase hexadecimal characters',
    ],
  });
});

test('rejects storage totals that do not reconcile', () => {
  const event = {
    ...VALID_EVENT,
    device: {
      ...VALID_EVENT.device,
      storage: {
        ...VALID_EVENT.device.storage,
        available_bytes: 1,
      },
    },
  };

  assert.deepEqual(validateDeviceSnapshotV1(event), {
    ok: false,
    errors: ['storage used_bytes plus available_bytes must equal capacity_bytes'],
  });
});

test('rejects a zero-capacity storage snapshot', () => {
  const event = {
    ...VALID_EVENT,
    device: {
      ...VALID_EVENT.device,
      storage: {
        ...VALID_EVENT.device.storage,
        capacity_bytes: 0,
        used_bytes: 0,
        available_bytes: 0,
      },
    },
  };

  assert.deepEqual(validateDeviceSnapshotV1(event), {
    ok: false,
    errors: ['storage capacity_bytes must be a positive safe integer'],
  });
});

test('rejects undeclared fields at every event nesting level', () => {
  const event = {
    ...VALID_EVENT,
    records: [{ amount: 500 }],
    device: {
      ...VALID_EVENT.device,
      account: 'must-not-project',
      storage: {
        ...VALID_EVENT.device.storage,
        raw_finance: { amount: 500 },
      },
    },
    owner: {
      ...VALID_EVENT.owner,
      secret: 'must-not-project',
    },
    provenance: {
      ...VALID_EVENT.provenance,
      secret: 'must-not-project',
    },
  };

  assert.deepEqual(validateDeviceSnapshotV1(event), {
    ok: false,
    errors: [
      'event contains unsupported field records',
      'device contains unsupported field account',
      'device.storage contains unsupported field raw_finance',
      'owner contains unsupported field secret',
      'provenance contains unsupported field secret',
    ],
  });
});

test('requires one attention descriptor for Needs Attention', () => {
  const event = {
    ...VALID_EVENT,
    device: { ...VALID_EVENT.device, health_state: 'needs_attention' },
    owner: {
      ...VALID_EVENT.owner,
      state: 'Needs Attention',
      action_required: true,
      recommended_action: 'Review storage protection.',
    },
  };

  assert.deepEqual(validateDeviceSnapshotV1(event), {
    ok: false,
    errors: ['attention is required when health_state is needs_attention'],
  });
});

test('rejects undeclared attention fields', () => {
  const event = {
    ...VALID_EVENT,
    device: { ...VALID_EVENT.device, health_state: 'needs_attention' },
    owner: {
      ...VALID_EVENT.owner,
      state: 'Needs Attention',
      action_required: true,
      recommended_action: 'Review storage protection.',
    },
    attention: {
      deduplication_key: 'PIXEL-STORAGE-01:storage-protection',
      title: 'Storage needs attention',
      summary: 'Storage protection needs review.',
      owning_department: 'Infrastructure / HomeLab',
      recommended_action: 'Review storage protection.',
      amount: 500,
    },
  };

  assert.deepEqual(validateDeviceSnapshotV1(event), {
    ok: false,
    errors: ['attention contains unsupported field amount'],
  });
});

test('rejects an attention descriptor on a ready event', () => {
  const event = {
    ...VALID_EVENT,
    attention: {
      deduplication_key: 'PIXEL-STORAGE-01:storage-protection',
      title: 'Storage needs attention',
      summary: 'Storage protection needs review.',
      owning_department: 'Infrastructure / HomeLab',
      recommended_action: 'Review storage protection.',
    },
  };

  assert.deepEqual(validateDeviceSnapshotV1(event), {
    ok: false,
    errors: ['attention must be null when health_state is ready'],
  });
});

test('throws a bounded validation error without echoing event contents', () => {
  assert.throws(
    () => assertValidDeviceSnapshotV1({ secret: 'must-not-appear' }),
    (error) => {
      assert.equal(error.name, 'PixelContractValidationError');
      assert.equal(error.message.includes('must-not-appear'), false);
      assert.equal(error.errors.length > 0, true);
      return true;
    },
  );
});
