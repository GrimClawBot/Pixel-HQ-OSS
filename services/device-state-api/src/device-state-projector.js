import { assertValidDeviceSnapshotV1 } from '../../../packages/contracts/src/device-snapshot-v1.js';
import { getDeviceRole } from '../../../packages/registry/src/device-roles.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function immutableCopy(value) {
  return deepFreeze(structuredClone(value));
}

export class DeviceStateProjector {
  #activeAttention = new Map();
  #clock;
  #devices = new Map();
  #evidence;
  #ids;

  constructor({ evidence, ids, clock = () => new Date().toISOString() }) {
    if (!evidence || typeof evidence.append !== 'function') {
      throw new TypeError('DeviceStateProjector requires an evidence recorder');
    }
    if (!ids || typeof ids.nextSpanId !== 'function') {
      throw new TypeError('DeviceStateProjector requires a span ID source');
    }
    this.#evidence = evidence;
    this.#ids = ids;
    this.#clock = clock;
  }

  accept(event) {
    assertValidDeviceSnapshotV1(event);

    const validationSpanId = this.#ids.nextSpanId();
    this.#evidence.append({
      traceId: event.trace_id,
      spanId: validationSpanId,
      parentSpanId: event.span_id,
      serviceName: 'pixel.contracts',
      eventName: 'contract.device_snapshot.validated',
      attributes: {
        'pixel.event.name': event.event_name,
        'pixel.event.schema_version': event.schema_version,
        'pixel.device.role_id': event.device.role_id,
      },
    });

    const role = getDeviceRole(event.device.role_id);
    const view = immutableCopy({
      api_version: 'v1',
      schema_version: event.schema_version,
      event_name: event.event_name,
      event_id: event.event_id,
      device_id: event.device.device_id,
      role_id: event.device.role_id,
      display_name: role.display_name,
      lifecycle_state: event.device.lifecycle_state,
      health_state: event.device.health_state,
      state: event.owner.state,
      summary: event.owner.summary,
      impact: event.owner.impact,
      action_required: event.owner.action_required,
      recommended_action: event.owner.recommended_action,
      verified_at: event.owner.verified_at,
      storage: {
        capacity_bytes: event.device.storage.capacity_bytes,
        used_bytes: event.device.storage.used_bytes,
        available_bytes: event.device.storage.available_bytes,
        protection_state: event.device.storage.protection_state,
      },
      trace_id: event.trace_id,
      source: event.source,
      provenance: {
        adapter_contract: event.provenance.adapter_contract,
        adapter_id: event.provenance.adapter_id,
        scenario: event.provenance.scenario,
      },
    });
    this.#devices.set(event.device.role_id, view);

    const projectionSpanId = this.#ids.nextSpanId();
    this.#evidence.append({
      traceId: event.trace_id,
      spanId: projectionSpanId,
      parentSpanId: validationSpanId,
      serviceName: 'pixel.device-state-api',
      eventName: 'state.device.projected',
      attributes: {
        'pixel.device.role_id': event.device.role_id,
        'pixel.device.health_state': event.device.health_state,
        'pixel.owner.state': event.owner.state,
      },
    });

    if (event.attention) {
      const current = this.#activeAttention.get(event.attention.deduplication_key);
      const item = immutableCopy({
        deduplication_key: event.attention.deduplication_key,
        title: event.attention.title,
        summary: event.attention.summary,
        owning_department: event.attention.owning_department,
        recommended_action: event.attention.recommended_action,
        role_id: event.device.role_id,
        state: 'Needs Attention',
        first_seen_at: current?.first_seen_at ?? event.occurred_at,
        last_seen_at: event.occurred_at,
        occurrence_count: (current?.occurrence_count ?? 0) + 1,
        trace_id: event.trace_id,
      });
      this.#activeAttention.set(item.deduplication_key, item);
      this.#evidence.append({
        traceId: event.trace_id,
        spanId: this.#ids.nextSpanId(),
        parentSpanId: projectionSpanId,
        serviceName: 'pixel.device-state-api',
        eventName: 'attention.item.upserted',
        attributes: {
          'pixel.device.role_id': event.device.role_id,
          'pixel.attention.deduplication_key': item.deduplication_key,
          'pixel.attention.occurrence_count': item.occurrence_count,
        },
      });
    } else if (event.device.health_state === 'ready') {
      for (const [key, item] of this.#activeAttention.entries()) {
        if (item.role_id === event.device.role_id) {
          this.#activeAttention.delete(key);
          this.#evidence.append({
            traceId: event.trace_id,
            spanId: this.#ids.nextSpanId(),
            parentSpanId: projectionSpanId,
            serviceName: 'pixel.device-state-api',
            eventName: 'attention.item.resolved',
            attributes: {
              'pixel.device.role_id': event.device.role_id,
              'pixel.attention.deduplication_key': key,
              'pixel.attention.resolved_at': this.#clock(),
            },
          });
        }
      }
    }

    return view;
  }

  getDevice(roleId) {
    return this.#devices.get(roleId) ?? null;
  }

  getActiveAttention() {
    return [...this.#activeAttention.values()];
  }
}
