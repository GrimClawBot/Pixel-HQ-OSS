import { randomBytes, randomUUID } from 'node:crypto';

import {
  DEVICE_ADAPTER_CONTRACT,
  DEVICE_SNAPSHOT_EVENT_NAME,
  DEVICE_SNAPSHOT_SCHEMA_VERSION,
  assertValidDeviceSnapshotV1,
} from '../../../packages/contracts/src/device-snapshot-v1.js';
import { getDeviceRole } from '../../../packages/registry/src/device-roles.js';

const ROLE_ID = 'PIXEL-STORAGE-01';
const DEVICE_ID = 'sim-storage-01';
const ADAPTER_ID = 'pixel.simulator.storage.v1';
const CAPACITY_BYTES = 24_000_000_000_000;

function defaultIds() {
  return {
    nextEventId: () => `evt-${randomUUID()}`,
    nextSpanId: () => randomBytes(8).toString('hex'),
  };
}

function scenarioState(scenario) {
  if (scenario === 'healthy') {
    return {
      healthState: 'ready',
      protectionState: 'protected',
      usedBytes: 7_200_000_000_000,
      owner: {
        state: 'Ready',
        summary: 'Your storage is ready and protected.',
        impact: 'Files and backups remain available.',
        action_required: false,
        recommended_action: null,
      },
      attention: null,
    };
  }

  if (scenario === 'degraded-storage') {
    return {
      healthState: 'needs_attention',
      protectionState: 'at_risk',
      usedBytes: 7_800_000_000_000,
      owner: {
        state: 'Needs Attention',
        summary: 'Storage needs attention. Protection is at risk.',
        impact: 'Storage remains available while protection is reduced.',
        action_required: true,
        recommended_action: 'Review storage protection when convenient.',
      },
      attention: {
        deduplication_key: 'PIXEL-STORAGE-01:storage-protection',
        title: 'Storage needs attention',
        summary: 'Storage remains available, but its protection needs review.',
        owning_department: getDeviceRole(ROLE_ID).owning_department,
        recommended_action: 'Review storage protection when convenient.',
      },
    };
  }

  throw new RangeError(`Unsupported storage simulator scenario: ${scenario}`);
}

export class SimulatorStorageAdapter {
  #clock;
  #ids;

  constructor({ clock = () => new Date().toISOString(), ids = defaultIds() } = {}) {
    this.#clock = clock;
    this.#ids = ids;
  }

  async readSnapshot({ scenario = 'healthy', traceContext }) {
    const state = scenarioState(scenario);
    const occurredAt = this.#clock();
    const spanId = this.#ids.nextSpanId();
    const event = {
      event_id: this.#ids.nextEventId(),
      event_name: DEVICE_SNAPSHOT_EVENT_NAME,
      schema_version: DEVICE_SNAPSHOT_SCHEMA_VERSION,
      occurred_at: occurredAt,
      environment: 'simulation',
      source: 'simulator',
      trace_id: traceContext.traceId,
      span_id: spanId,
      device: {
        device_id: DEVICE_ID,
        role_id: ROLE_ID,
        lifecycle_state: 'active',
        health_state: state.healthState,
        storage: {
          capacity_bytes: CAPACITY_BYTES,
          used_bytes: state.usedBytes,
          available_bytes: CAPACITY_BYTES - state.usedBytes,
          protection_state: state.protectionState,
        },
      },
      owner: {
        ...state.owner,
        verified_at: occurredAt,
      },
      attention: state.attention,
      provenance: {
        adapter_contract: DEVICE_ADAPTER_CONTRACT,
        adapter_id: ADAPTER_ID,
        scenario,
      },
    };

    assertValidDeviceSnapshotV1(event);
    return event;
  }
}
