import { validateReservationV1 } from '../../../packages/contracts/src/scheduler-v1.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function frozenCopy(value) {
  return deepFreeze(structuredClone(value));
}

export class SimulatorSchedulerStoreAdapter {
  #reservations = new Map();

  get source() {
    return 'simulator';
  }

  #project(entry) {
    return entry ? frozenCopy(entry.value) : null;
  }

  #activeFor(resourceRef, now) {
    for (const entry of this.#reservations.values()) {
      if (entry.value.resource_ref !== resourceRef) continue;
      if (!['ACTIVE'].includes(entry.value.state)) continue;
      if (Date.parse(entry.value.expires_at) <= Date.parse(now)) continue;
      return entry;
    }
    return null;
  }

  // Reservation means capacity ownership only, never authority. An exclusive
  // resource is claimed atomically: if a live (unexpired) reservation already
  // owns the resource, this attempt fails closed rather than double-allocating.
  reserve(value, { now } = {}) {
    const validation = validateReservationV1(value);
    if (!validation.ok) {
      return { disposition: 'REJECTED', reason_code: 'RESERVATION_INVALID', reservation: null, errors: validation.errors };
    }
    if (value.state !== 'ACTIVE') {
      return { disposition: 'REJECTED', reason_code: 'RESERVATION_INVALID', reservation: null };
    }
    const owner = this.#activeFor(value.resource_ref, now);
    if (owner) {
      return { disposition: 'RESOURCE_BUSY', reason_code: 'WAIT_CAPACITY', reservation: this.#project(owner) };
    }
    // A reservation id is strictly single-use: any reuse of an id (live,
    // released, expired, or cancelled) is rejected rather than silently
    // re-pointed or revived as a fresh record.
    if (this.#reservations.has(value.reservation_id)) {
      return { disposition: 'REJECTED', reason_code: 'RESERVATION_ID_CONFLICT', reservation: null };
    }
    const entry = { value: frozenCopy(value) };
    this.#reservations.set(value.reservation_id, entry);
    return { disposition: 'RESERVED', reservation: this.#project(entry) };
  }

  get(reservationId) {
    if (typeof reservationId !== 'string') return null;
    return this.#project(this.#reservations.get(reservationId));
  }

  // Releases expire stale leases lazily before returning the current record so
  // a crashed worker cannot hold capacity forever through wall-clock passage.
  #expireIfNeeded(entry, now) {
    if (!entry) return entry;
    if (entry.value.state !== 'ACTIVE') return entry;
    if (Date.parse(entry.value.expires_at) > Date.parse(now)) return entry;
    entry.value = frozenCopy({
      ...entry.value,
      state: 'EXPIRED',
      revision: entry.value.revision + 1,
      updated_at: now,
      expires_at: null,
    });
    return entry;
  }

  current(reservationId, { now } = {}) {
    if (typeof reservationId !== 'string') return null;
    const entry = this.#reservations.get(reservationId);
    if (!entry) return null;
    return this.#project(this.#expireIfNeeded(entry, now));
  }

  // Every reservation mutation is revision-guarded. Expired/released/cancelled
  // reservations can never return to ACTIVE.
  transition(reservationId, { toState, now, expectedRevision } = {}) {
    const entry = this.#reservations.get(reservationId);
    if (!entry) return { disposition: 'REJECTED', reason_code: 'NOT_FOUND', reservation: null };
    this.#expireIfNeeded(entry, now);
    const current = entry.value;
    if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision) {
      return { disposition: 'STALE_REVISION', reason_code: 'STALE_REVISION', reservation: this.#project(entry) };
    }
    const allowedFrom = {
      RELEASED: ['ACTIVE'],
      CANCELLED: ['ACTIVE', 'PENDING'],
    };
    if (!allowedFrom[toState]?.includes(current.state)) {
      return { disposition: 'REJECTED', reason_code: 'INVALID_TRANSITION', reservation: this.#project(entry) };
    }
    entry.value = frozenCopy({
      ...current,
      state: toState,
      revision: current.revision + 1,
      updated_at: now,
      expires_at: null,
    });
    return { disposition: 'UPDATED', reservation: this.#project(entry) };
  }

  activeReservations() {
    return [...this.#reservations.values()]
      .map((entry) => this.#project(entry))
      .filter((reservation) => reservation.state === 'ACTIVE');
  }
}
