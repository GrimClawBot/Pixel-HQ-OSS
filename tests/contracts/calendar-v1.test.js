import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CALENDAR_CONTRACT,
  CALENDAR_EVENT_NAME,
  CALENDAR_SCHEMA_VERSION,
  COMPANY_HOURS_NAME,
  RECURRING_CHECKPOINT_NAME,
  RECURRING_OCCURRENCE_NAME,
  RECURRING_TEMPLATE_NAME,
  assertValidCalendarEventV1,
  assertValidCompanyHoursV1,
  assertValidRecurringCheckpointV1,
  assertValidRecurringOccurrenceV1,
  assertValidRecurringTemplateV1,
  derivedCalendarStateAt,
  isValidIanaTimezone,
  validateCalendarEventV1,
  validateCompanyHoursV1,
  validateRecurringOccurrenceV1,
  validateRecurringTemplateV1,
} from '../../packages/contracts/src/calendar-v1.js';

const NOW = '2026-09-12T12:00:00.000Z';
const LATER = '2026-09-12T18:00:00.000Z';
const PROVENANCE = Object.freeze({ calendar_contract: CALENDAR_CONTRACT });

function event(overrides = {}) {
  return {
    calendar_event_id: 'event-001', event_name: CALENDAR_EVENT_NAME, schema_version: CALENDAR_SCHEMA_VERSION,
    event_class: 'COMPANY_HOLIDAY', status: 'ACTIVE', starts_at: NOW, ends_at: LATER,
    timezone: 'America/New_York', scope_ref: null, summary_code: 'HOLIDAY',
    revision: 1, created_at: NOW, updated_at: NOW, provenance: PROVENANCE,
    ...overrides,
  };
}

function companyHours(overrides = {}) {
  return {
    company_hours_id: 'hours-001', event_name: COMPANY_HOURS_NAME, schema_version: CALENDAR_SCHEMA_VERSION,
    company_timezone: 'America/New_York',
    weekly_windows: [{ day: 'MON', starts_at: '09:00', ends_at: '17:00' }],
    revision: 1, updated_at: NOW, provenance: PROVENANCE,
    ...overrides,
  };
}

function template(overrides = {}) {
  return {
    template_id: 'template-001', event_name: RECURRING_TEMPLATE_NAME, schema_version: CALENDAR_SCHEMA_VERSION,
    status: 'ACTIVE', job_type: 'system-status', requested_capability: 'pixel.system-status.read',
    schedule: { kind: 'FIXED_INTERVAL', anchor_at: NOW, interval_seconds: 3600 },
    missed_run_policy: 'SKIP', overlap_policy: 'SKIP', authorization_ref: 'authz-123',
    revision: 1, created_at: NOW, updated_at: NOW, provenance: PROVENANCE,
    ...overrides,
  };
}

function occurrence(overrides = {}) {
  return {
    occurrence_id: 'occurrence-001', revision: 1, event_name: RECURRING_OCCURRENCE_NAME, schema_version: CALENDAR_SCHEMA_VERSION,
    template_id: 'template-001', template_revision: 1,
    template_fingerprint: 'ab'.repeat(32), scheduled_at: NOW, status: 'DUE',
    relay_job_id: null, relay_idempotency_key: 'calendar:template-001:2026-09-12T12:00:00.000Z',
    attempt_count: 0, last_attempt_at: null, created_at: NOW, updated_at: NOW, provenance: PROVENANCE,
    ...overrides,
  };
}

function checkpoint(overrides = {}) {
  return {
    checkpoint_id: 'checkpoint:template-001', event_name: RECURRING_CHECKPOINT_NAME,
    schema_version: CALENDAR_SCHEMA_VERSION, template_id: 'template-001',
    last_evaluated_at: NOW, revision: 1, updated_at: NOW, provenance: PROVENANCE,
    ...overrides,
  };
}

test('calendar contracts accept canonical values', () => {
  assert.deepEqual(validateCalendarEventV1(event()), { ok: true, errors: [] });
  assert.deepEqual(validateCompanyHoursV1(companyHours()), { ok: true, errors: [] });
  assert.deepEqual(validateRecurringTemplateV1(template()), { ok: true, errors: [] });
  assert.deepEqual(validateRecurringOccurrenceV1(occurrence()), { ok: true, errors: [] });
  assert.deepEqual(assertValidCalendarEventV1(event()).calendar_event_id, 'event-001');
  assert.deepEqual(assertValidCompanyHoursV1(companyHours()).company_hours_id, 'hours-001');
  assert.deepEqual(assertValidRecurringTemplateV1(template()).template_id, 'template-001');
  assert.deepEqual(assertValidRecurringOccurrenceV1(occurrence()).occurrence_id, 'occurrence-001');
  assertValidRecurringCheckpointV1(checkpoint());
});

test('invalid timezone rejects and unsupported timezones fail closed', () => {
  assert.equal(isValidIanaTimezone('America/New_York'), true);
  assert.equal(isValidIanaTimezone('UTC'), true);
  assert.equal(isValidIanaTimezone('Not/AZone'), false);
  assert.equal(isValidIanaTimezone(''), false);
  assert.equal(validateCalendarEventV1(event({ timezone: 'Not/AZone' })).ok, false);
  assert.equal(validateCompanyHoursV1(companyHours({ company_timezone: 'Not/AZone' })).ok, false);
});

test('half-open event intervals and non-overlapping company-hours windows enforce bounds', () => {
  assert.equal(validateCalendarEventV1(event({ ends_at: NOW })).ok, false);
  assert.equal(validateCalendarEventV1({ ...event(), starts_at: LATER, ends_at: NOW }).ok, false);
  const overlapping = companyHours({ weekly_windows: [
    { day: 'MON', starts_at: '09:00', ends_at: '17:00' },
    { day: 'MON', starts_at: '16:00', ends_at: '18:00' },
  ] });
  assert.equal(validateCompanyHoursV1(overlapping).ok, false);
  const duplicate = companyHours({ weekly_windows: [
    { day: 'MON', starts_at: '09:00', ends_at: '17:00' },
    { day: 'MON', starts_at: '09:00', ends_at: '17:00' },
  ] });
  assert.equal(validateCompanyHoursV1(duplicate).ok, false);
});

test('recurring template binds to existing Relay submit-intent vocabulary only', () => {
  assert.equal(validateRecurringTemplateV1(template({ job_type: 'finance' })).ok, false);
  assert.equal(validateRecurringTemplateV1(template({ requested_capability: 'finance.execute' })).ok, false);
  assert.equal(validateRecurringTemplateV1(template({ job_type: 'system-status', requested_capability: 'pixel.system-status.raw.read' })).ok, true);
  assert.equal(validateRecurringTemplateV1(template({ overlap_policy: 'ALLOW_PARALLEL' })).ok, false);
  assert.equal(validateRecurringTemplateV1(template({ missed_run_policy: 'UNBOUNDED' })).ok, false);
});

test('occurrence and checkpoint contracts bind exact template revision/fingerprint', () => {
  assert.equal(validateRecurringOccurrenceV1(occurrence({ template_fingerprint: 'zz' })).ok, false);
  assert.equal(validateRecurringOccurrenceV1(occurrence({ template_revision: 0 })).ok, false);
  assert.equal(validateRecurringOccurrenceV1(occurrence({ status: 'SUBMITTED', relay_job_id: null })).ok, false);
  assert.equal(validateRecurringOccurrenceV1(occurrence({ status: 'DUE', relay_job_id: 'job-1' })).ok, false);
  assert.equal(validateRecurringOccurrenceV1(occurrence({ attempt_count: -1 })).ok, false);
  assertValidRecurringCheckpointV1(checkpoint({ last_evaluated_at: LATER, updated_at: LATER }));
});

test('derived calendar state follows MAINTENANCE > HOLIDAY > NIGHT > NORMAL', () => {
  const hours = companyHours();
  const holiday = [event({ event_class: 'COMPANY_HOLIDAY', starts_at: NOW, ends_at: LATER })];
  const maintenance = [event({ event_class: 'MAINTENANCE_WINDOW', starts_at: NOW, ends_at: LATER })];
  // Monday 11:00 EDT is within MON 09:00-17:00 business hours.
  assert.equal(derivedCalendarStateAt({ activeEvents: [], companyHours: hours, instant: '2026-09-14T15:00:00.000Z' }), 'NORMAL');
  assert.equal(derivedCalendarStateAt({ activeEvents: holiday, companyHours: hours, instant: NOW }), 'HOLIDAY');
  assert.equal(derivedCalendarStateAt({ activeEvents: maintenance, companyHours: hours, instant: NOW }), 'MAINTENANCE');
  assert.equal(
    derivedCalendarStateAt({ activeEvents: [...maintenance, ...holiday], companyHours: hours, instant: NOW }),
    'MAINTENANCE',
  );
  // Saturday outside configured business hours -> NIGHT.
  assert.equal(
    derivedCalendarStateAt({
      activeEvents: [], companyHours: { ...hours, weekly_windows: [{ day: 'SAT', starts_at: '09:00', ends_at: '17:00' }] },
      instant: '2026-09-12T12:00:00.000Z',
    }),
    'NIGHT',
  );
  // Unavailable/malformed company hours must never imply NORMAL.
  assert.equal(derivedCalendarStateAt({ activeEvents: [], companyHours: null, instant: NOW }), null);
  assert.equal(
    derivedCalendarStateAt({ activeEvents: [], companyHours: { ...hours, weekly_windows: [] }, instant: NOW }),
    null,
  );
});

test('sparse weekly windows reject instead of becoming a valid hours configuration', () => {
  assert.equal(validateCompanyHoursV1(companyHours({ weekly_windows: new Array(1) })).ok, false);
});
