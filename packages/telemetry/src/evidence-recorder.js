const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function freezeRecord(record) {
  return deepFreeze(structuredClone(record));
}

export class EvidenceRecorder {
  #clock;
  #records = [];

  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.#clock = clock;
  }

  append({
    traceId,
    spanId,
    parentSpanId = null,
    serviceName,
    eventName,
    severity = 'info',
    outcome = 'success',
    attributes = {},
  }) {
    if (!TRACE_ID.test(traceId) || /^0+$/.test(traceId)) {
      throw new TypeError('Evidence traceId must be 32 non-zero lowercase hexadecimal characters');
    }
    if (!SPAN_ID.test(spanId) || /^0+$/.test(spanId)) {
      throw new TypeError('Evidence spanId must be 16 non-zero lowercase hexadecimal characters');
    }
    if (parentSpanId !== null && (!SPAN_ID.test(parentSpanId) || /^0+$/.test(parentSpanId))) {
      throw new TypeError('Evidence parentSpanId must be null or 16 non-zero lowercase hexadecimal characters');
    }
    if (typeof serviceName !== 'string' || serviceName.length === 0) {
      throw new TypeError('Evidence serviceName is required');
    }
    if (typeof eventName !== 'string' || eventName.length === 0) {
      throw new TypeError('Evidence eventName is required');
    }

    const record = freezeRecord({
      timestamp: this.#clock(),
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: parentSpanId,
      service_name: serviceName,
      event_name: eventName,
      severity,
      outcome,
      attributes,
    });
    this.#records.push(record);
    return record;
  }

  forTrace(traceId) {
    return this.#records.filter((record) => record.trace_id === traceId);
  }

  all() {
    return [...this.#records];
  }
}
