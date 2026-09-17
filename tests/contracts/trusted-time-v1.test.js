import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addMilliseconds,
  canonicalUtcTimestamp,
  createTrustedClock,
  isCanonicalUtcTimestamp,
  isExpiredAt,
} from '../../packages/contracts/src/trusted-time-v1.js';

test('canonical timestamps accept only exact UTC millisecond ISO-8601', () => {
  assert.equal(isCanonicalUtcTimestamp('2026-09-12T12:00:00.000Z'), true);
  assert.equal(isCanonicalUtcTimestamp('2026-09-12T12:00:00Z'), false);
  assert.equal(isCanonicalUtcTimestamp('2026-09-12T08:00:00.000-04:00'), false);
  assert.equal(isCanonicalUtcTimestamp('2026-09-12T12:00:00.000+00:00'), false);
  assert.equal(isCanonicalUtcTimestamp('2026-02-30T12:00:00.000Z'), false);
  assert.equal(isCanonicalUtcTimestamp('2026-13-01T12:00:00.000Z'), false);
  assert.equal(isCanonicalUtcTimestamp(1770000000000), false);
  assert.equal(isCanonicalUtcTimestamp(null), false);
  assert.throws(() => canonicalUtcTimestamp('nope'), /canonical UTC/);
});

test('addMilliseconds requires positive bounded durations and canonical input', () => {
  assert.equal(addMilliseconds('2026-09-12T12:00:00.000Z', 60_000), '2026-09-12T12:01:00.000Z');
  assert.throws(() => addMilliseconds('2026-09-12T12:00:00.000Z', 0), /positive/);
  assert.throws(() => addMilliseconds('2026-09-12T12:00:00.000Z', -5), /positive/);
  assert.throws(() => addMilliseconds('2026-09-12T12:00:00Z', 5), /canonical UTC/);
});

test('expiry uses inclusive-at-boundary comparison and null means no expiry', () => {
  assert.equal(isExpiredAt(null, '2026-09-12T12:00:00.000Z'), false);
  assert.equal(isExpiredAt('2026-09-12T12:01:00.000Z', '2026-09-12T12:00:00.000Z'), false);
  assert.equal(isExpiredAt('2026-09-12T12:00:00.000Z', '2026-09-12T12:00:00.000Z'), true);
  assert.equal(isExpiredAt('2026-09-12T11:59:59.999Z', '2026-09-12T12:00:00.000Z'), true);
});

test('trusted clock clamps backward wall-clock jumps so expired authority cannot revive', () => {
  let source = '2026-09-12T12:00:00.000Z';
  const rollbacks = [];
  const clock = createTrustedClock({ source: () => source, onRollback: (event) => rollbacks.push(event) });

  assert.equal(clock.now(), '2026-09-12T12:00:00.000Z');
  source = '2026-09-12T12:05:00.000Z';
  assert.equal(clock.now(), '2026-09-12T12:05:00.000Z');

  // Wall clock rolls back 10 minutes; the trusted clock must not report it.
  source = '2026-09-12T11:55:00.000Z';
  assert.equal(clock.now(), '2026-09-12T12:05:00.000Z');
  assert.equal(clock.rollbackCount(), 1);
  assert.deepEqual(rollbacks, [{ observed: '2026-09-12T11:55:00.000Z', clamp: '2026-09-12T12:05:00.000Z', count: 1 }]);

  // Forward movement resumes normally after the rollback.
  source = '2026-09-12T12:10:00.000Z';
  assert.equal(clock.now(), '2026-09-12T12:10:00.000Z');
  source = '2026-09-12T12:09:00.000Z';
  assert.equal(clock.now(), '2026-09-12T12:10:00.000Z');
  assert.equal(clock.rollbackCount(), 2);
});

test('expired authority stays expired across a wall-clock rollback', () => {
  let source = '2026-09-12T12:00:00.000Z';
  const clock = createTrustedClock({ source: () => source });
  const expiresAt = '2026-09-12T12:01:00.000Z';

  assert.equal(isExpiredAt(expiresAt, clock.now()), false);
  source = '2026-09-12T12:02:00.000Z';
  assert.equal(isExpiredAt(expiresAt, clock.now()), true);
  // An attacker rolls the wall clock back before the expiry instant.
  source = '2026-09-12T11:59:00.000Z';
  assert.equal(isExpiredAt(expiresAt, clock.now()), true);
});

test('trusted clock requires a valid time source and rejects malformed output', () => {
  assert.throws(() => createTrustedClock({}), /time source/);
  const clock = createTrustedClock({ source: () => 'not-a-timestamp' });
  assert.throws(() => clock.now(), /canonical UTC/);
});
