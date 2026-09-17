import assert from 'node:assert/strict';
import test from 'node:test';

import { calendarRuntime, defaultCompanyHours, baseEvent } from '../helpers/px008-runtime.js';
import { createClock, NOW, baseRequirement, canonicalJob } from '../helpers/px006-runtime.js';

test('business-hours instant derives NORMAL absent higher state', () => {
  const { clock, calendar } = calendarRuntime();
  calendar.setCompanyHours(defaultCompanyHours());
  clock.set('2026-09-14T15:00:00.000Z'); // Monday 11:00 EDT
  const facts = calendar.operatingFactsAt();
  assert.equal(facts.available, true);
  assert.equal(facts.calendar_state, 'NORMAL');
});

test('outside-hours instant derives NIGHT', () => {
  const { clock, calendar } = calendarRuntime();
  calendar.setCompanyHours(defaultCompanyHours());
  clock.set('2026-09-14T03:00:00.000Z'); // Monday 23:00 EDT
  const facts = calendar.operatingFactsAt();
  assert.equal(facts.available, true);
  assert.equal(facts.calendar_state, 'NIGHT');
});

test('active holiday derives HOLIDAY', () => {
  const { clock, calendar } = calendarRuntime();
  calendar.setCompanyHours(defaultCompanyHours());
  calendar.createEvent(baseEvent({
    event_class: 'COMPANY_HOLIDAY',
    starts_at: '2026-09-14T00:00:00.000Z',
    ends_at: '2026-09-15T00:00:00.000Z',
  }));
  clock.set('2026-09-14T15:00:00.000Z');
  assert.equal(calendar.operatingFactsAt().calendar_state, 'HOLIDAY');
});

test('active maintenance window derives MAINTENANCE and outranks holiday', () => {
  const { clock, calendar } = calendarRuntime();
  calendar.setCompanyHours(defaultCompanyHours());
  calendar.createEvent(baseEvent({ event_class: 'MAINTENANCE_WINDOW', starts_at: '2026-09-14T12:00:00.000Z', ends_at: '2026-09-14T18:00:00.000Z' }));
  calendar.createEvent(baseEvent({ calendar_event_id: 'event-h', event_class: 'COMPANY_HOLIDAY', starts_at: '2026-09-14T00:00:00.000Z', ends_at: '2026-09-15T00:00:00.000Z' }));
  clock.set('2026-09-14T15:00:00.000Z');
  assert.equal(calendar.operatingFactsAt().calendar_state, 'MAINTENANCE');
});

test('DST fixture: deterministic timezone evaluation across a DST boundary', () => {
  // Set the injected clock forward before configuring company hours so the
  // Trusted Time clamp (rollback protection) does not mask the DST check.
  const { clock, calendar } = calendarRuntime({ clock: createClock('2026-03-09T00:00:00.000Z') });
  calendar.setCompanyHours(defaultCompanyHours({ company_timezone: 'America/New_York' }));
  // 2026-03-08 is US spring-forward (EST -> EDT). 15:00Z Monday? March 8 is Sunday;
  // use a Monday: 2026-03-09.
  clock.set('2026-03-09T15:00:00.000Z'); // 11:00 EDT Monday
  assert.equal(calendar.operatingFactsAt().calendar_state, 'NORMAL');
  clock.set('2026-03-09T22:00:00.000Z'); // 18:00 EDT Monday
  assert.equal(calendar.operatingFactsAt().calendar_state, 'NIGHT');
  // Fall-back week: 2026-11-02 Monday, 15:00Z = 10:00 EST -> NORMAL.
  clock.set('2026-11-02T15:00:00.000Z');
  assert.equal(calendar.operatingFactsAt().calendar_state, 'NORMAL');
});

test('invalid timezone rejects company-hours mutation', () => {
  const { calendar } = calendarRuntime();
  const result = calendar.setCompanyHours(defaultCompanyHours({ company_timezone: 'Not/AZone' }));
  assert.equal(result.disposition, 'REJECTED');
});

test('authorized event creation records canonical provenance', () => {
  const { calendar } = calendarRuntime();
  const result = calendar.createEvent(baseEvent({
    calendar_event_id: 'event-deny',
    starts_at: '2026-09-14T00:00:00.000Z',
    ends_at: '2026-09-15T00:00:00.000Z',
  }));
  assert.equal(result.disposition, 'RECORDED');
  assert.equal(result.record.provenance.calendar_contract, 'pixel.calendar.v1');
  assert.equal(calendar.listEvents().length, 1);
});

test('calendar events are half-open: boundary instant is not active', () => {
  const { clock, calendar } = calendarRuntime({ clock: createClock('2026-09-14T09:00:00.000Z') });
  calendar.setCompanyHours(defaultCompanyHours());
  calendar.createEvent(baseEvent({ starts_at: '2026-09-14T10:00:00.000Z', ends_at: '2026-09-14T12:00:00.000Z' }));
  clock.set('2026-09-14T10:00:00.000Z');
  assert.equal(calendar.operatingFactsAt().active_event_refs.length, 1);
  clock.set('2026-09-14T12:00:00.000Z');
  assert.equal(calendar.operatingFactsAt().active_event_refs.length, 0);
  clock.set('2026-09-14T11:59:00.000Z');
  assert.equal(calendar.operatingFactsAt().active_event_refs.length, 0);
});

test('DST spring jump and repeated fall hour use deterministic half-open local windows', () => {
  const spring = calendarRuntime({ clock: createClock('2026-03-08T06:59:00.000Z') });
  spring.calendar.setCompanyHours(defaultCompanyHours({ weekly_windows: [{ day: 'SUN', starts_at: '01:00', ends_at: '02:00' }] }));
  assert.equal(spring.calendar.operatingFactsAt().calendar_state, 'NORMAL');
  spring.clock.set('2026-03-08T07:00:00.000Z');
  assert.equal(spring.calendar.operatingFactsAt().calendar_state, 'NIGHT');
  const fall = calendarRuntime({ clock: createClock('2026-11-01T05:30:00.000Z') });
  fall.calendar.setCompanyHours(defaultCompanyHours({ weekly_windows: [{ day: 'SUN', starts_at: '01:00', ends_at: '02:00' }] }));
  assert.equal(fall.calendar.operatingFactsAt().calendar_state, 'NORMAL');
  fall.clock.set('2026-11-01T06:30:00.000Z');
  assert.equal(fall.calendar.operatingFactsAt().calendar_state, 'NORMAL');
  fall.clock.set('2026-11-01T07:00:00.000Z');
  assert.equal(fall.calendar.operatingFactsAt().calendar_state, 'NIGHT');
});

test('operating facts require valid company hours even while maintenance is active', () => {
  const r = calendarRuntime();
  r.calendar.createEvent(baseEvent({ event_class: 'MAINTENANCE_WINDOW' }));
  const facts = r.calendar.operatingFactsAt();
  assert.equal(facts.available, false);
  assert.equal(facts.calendar_state, null);
  assert.deepEqual(facts.active_event_refs, []);
});

test('event revisions change the operating-facts revision token', () => {
  const r = calendarRuntime();
  r.calendar.setCompanyHours(defaultCompanyHours());
  r.calendar.createEvent(baseEvent());
  const first = r.calendar.operatingFactsAt().revision_token;
  r.calendar.changeEvent({ calendar_event_id: 'event-001', expected_revision: 1, summary_code: 'UPDATED' });
  assert.notEqual(r.calendar.operatingFactsAt().revision_token, first);
});
