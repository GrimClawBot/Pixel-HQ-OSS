const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isCanonicalUtcTimestamp(value) {
  if (typeof value !== 'string' || !CANONICAL_UTC.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function canonicalUtcTimestamp(value, label = 'timestamp') {
  if (!isCanonicalUtcTimestamp(value)) {
    throw new TypeError(`${label} must be a canonical UTC ISO-8601 millisecond timestamp`);
  }
  return value;
}

export function addMilliseconds(timestamp, milliseconds) {
  canonicalUtcTimestamp(timestamp, 'timestamp');
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new TypeError('duration must be a positive safe integer of milliseconds');
  }
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

export function isExpiredAt(expiresAt, now) {
  if (expiresAt === null || expiresAt === undefined) return false;
  canonicalUtcTimestamp(expiresAt, 'expires_at');
  canonicalUtcTimestamp(now, 'now');
  return Date.parse(now) >= Date.parse(expiresAt);
}

// Trusted Time contract: security-sensitive duration evaluation must not let a
// backward wall-clock jump revive expired authority. The trusted clock observes
// the injected source and never reports a time earlier than the latest observed
// time, so an expired approval, hold, or lease remains expired after a rollback.
export function createTrustedClock({ source, onRollback } = {}) {
  if (typeof source !== 'function') throw new TypeError('Trusted clock requires a time source');
  let last = null;
  let rollbackCount = 0;

  function now() {
    const raw = source();
    canonicalUtcTimestamp(raw, 'clock value');
    if (last !== null && Date.parse(raw) < Date.parse(last)) {
      rollbackCount += 1;
      if (typeof onRollback === 'function') onRollback({ observed: raw, clamp: last, count: rollbackCount });
      return last;
    }
    last = raw;
    return raw;
  }

  return Object.freeze({
    now,
    rollbackCount: () => rollbackCount,
  });
}
