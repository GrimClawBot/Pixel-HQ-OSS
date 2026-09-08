import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDeviceAdapter,
  readDeviceSnapshot,
} from '../../packages/adapter-sdk/src/device-adapter.js';

const REPLACEMENT_EVENT = Object.freeze({
  event_id: 'evt-live-test-0001',
  event_name: 'pixel.device.snapshot.v1',
  schema_version: '1.0.0',
  occurred_at: '2026-09-06T13:00:00.000Z',
  environment: 'shadow',
  source: 'live',
  trace_id: 'cccccccccccccccccccccccccccccccc',
  span_id: '1111111111111111',
  device: {
    device_id: 'enrolled-device-test-01',
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
    adapter_id: 'test.live.storage.v1',
    scenario: 'shadow-readiness',
  },
});

test('accepts a replacement adapter without simulator inheritance', async () => {
  const replacementAdapter = {
    async readSnapshot() {
      return REPLACEMENT_EVENT;
    },
  };

  assert.equal(assertDeviceAdapter(replacementAdapter), replacementAdapter);
  assert.equal(await readDeviceSnapshot(replacementAdapter, {}), REPLACEMENT_EVENT);
});

test('rejects adapters missing the shared read contract', () => {
  assert.throws(
    () => assertDeviceAdapter({ readDevice: () => REPLACEMENT_EVENT }),
    /readSnapshot/,
  );
});

test('rejects adapter output that violates the canonical contract', async () => {
  const invalidAdapter = {
    async readSnapshot() {
      return { ...REPLACEMENT_EVENT, schema_version: '9.0.0' };
    },
  };

  await assert.rejects(readDeviceSnapshot(invalidAdapter, {}), {
    name: 'PixelContractValidationError',
  });
});
