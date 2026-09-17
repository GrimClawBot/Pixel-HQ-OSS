// PX-008 Alpha canonical Calendar + Recurring Work contracts.
// Time affects operating state and scheduling eligibility, never authority.

import { createHash } from 'node:crypto';
import { isCanonicalUtcTimestamp } from './trusted-time-v1.js';
import { validateJobSubmitIntentV1 } from './job-v1.js';

export const CALENDAR_SCHEMA_VERSION = '1.0.0';
export const CALENDAR_EVENT_NAME = 'pixel.calendar-event.v1';
export const COMPANY_HOURS_NAME = 'pixel.company-hours.v1';
export const RECURRING_TEMPLATE_NAME = 'pixel.recurring-template.v1';
export const RECURRING_OCCURRENCE_NAME = 'pixel.recurring-occurrence.v1';
export const RECURRING_CHECKPOINT_NAME = 'pixel.recurring-checkpoint.v1';
export const CALENDAR_CONTRACT = 'pixel.calendar.v1';

export const CALENDAR_EVENT_CLASSES = Object.freeze(['COMPANY_HOLIDAY', 'MAINTENANCE_WINDOW']);
export const CALENDAR_EVENT_STATUSES = Object.freeze(['ACTIVE', 'CANCELLED']);
export const COMPANY_STATES_FROM_CALENDAR = Object.freeze(['MAINTENANCE', 'HOLIDAY', 'NIGHT', 'NORMAL']);
// Calendar-only precedence (highest first), composed later with PX-007 incidents
// through the existing global Company State precedence.
export const CALENDAR_STATE_PRECEDENCE = COMPANY_STATES_FROM_CALENDAR;

export const TEMPLATE_STATUSES = Object.freeze(['ACTIVE', 'PAUSED', 'RETIRED']);
export const SCHEDULE_KINDS = Object.freeze(['FIXED_INTERVAL']);
export const MISSED_RUN_POLICIES = Object.freeze(['SKIP', 'RUN_ONCE_FOR_MISSED_WINDOW']);
export const OVERLAP_POLICIES = Object.freeze(['SKIP']);
export const OCCURRENCE_STATUSES = Object.freeze(['DUE', 'SUBMISSION_PENDING', 'SUBMITTED', 'SKIPPED', 'REVIEW_REQUIRED']);
export const DAYS = Object.freeze(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
export const MAX_WEEKLY_WINDOWS = 28;
export const REVIEW_REQUIRED_AFTER_MISSED_WINDOWS = 64;
export const MAX_ACTIVE_EVENT_REFS = 64;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const IDENTIFIER_MAX = 160;
const HASH = /^[0-9a-f]{64}$/;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const TIMEZONE_MAX = 64;

const EVENT_FIELDS = new Set([
  'calendar_event_id', 'event_name', 'schema_version', 'event_class', 'status',
  'starts_at', 'ends_at', 'timezone', 'scope_ref', 'summary_code', 'revision',
  'created_at', 'updated_at', 'provenance',
]);
const COMPANY_HOURS_FIELDS = new Set([
  'company_hours_id', 'event_name', 'schema_version', 'company_timezone',
  'weekly_windows', 'revision', 'updated_at', 'provenance',
]);
const TEMPLATE_FIELDS = new Set([
  'template_id', 'event_name', 'schema_version', 'status', 'job_type',
  'requested_capability', 'schedule', 'missed_run_policy', 'overlap_policy',
  'authorization_ref', 'revision', 'created_at', 'updated_at', 'provenance',
]);
const OCCURRENCE_FIELDS = new Set([
  'occurrence_id', 'event_name', 'schema_version', 'template_id', 'template_revision',
  'template_fingerprint', 'scheduled_at', 'status', 'relay_job_id',
  'relay_idempotency_key', 'attempt_count', 'last_attempt_at',
  'created_at', 'updated_at', 'revision', 'provenance',
]);
const CHECKPOINT_FIELDS = new Set([
  'checkpoint_id', 'event_name', 'schema_version', 'template_id', 'last_evaluated_at',
  'revision', 'updated_at', 'provenance',
]);
const PROVENANCE_FIELDS = new Set(['calendar_contract']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, allowed, label, errors) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${label} contains unsupported field ${field}`);
  }
}

function identifier(value, label, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length === 0 || value.length > IDENTIFIER_MAX || !IDENTIFIER.test(value)) {
    errors.push(`${label} must be a Pixel identifier`);
  }
}

function hash(value, label, errors) {
  if (typeof value !== 'string' || value.length !== 64 || !HASH.test(value)) {
    errors.push(`${label} must be a 64-character lowercase hex fingerprint`);
  }
}

function boundedText(value, label, errors, { nullable = false, maximum = IDENTIFIER_MAX } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    errors.push(`${label} must be between 1 and ${maximum} characters`);
  }
}

function timestamp(value, label, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!isCanonicalUtcTimestamp(value)) {
    errors.push(`${label} must be a canonical UTC ISO-8601 millisecond timestamp`);
  }
}

function revision(value, label, errors) {
  if (!Number.isSafeInteger(value) || value < 1) errors.push(`${label} must be a positive safe integer`);
}

function result(errors) {
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors.slice(0, 32)) });
}

// Explicit IANA timezone validation using the runtime's Intl timezone support.
// An unknown/unsupported timezone string rejects rather than being normalized.
export function isValidIanaTimezone(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > TIMEZONE_MAX
    || !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function timezone(value, label, errors) {
  if (!isValidIanaTimezone(value)) errors.push(`${label} must be an explicit valid IANA timezone`);
}

function calendarCommon(value, fields, label, eventName, timestampField, errors) {
  exact(value, fields, label, errors);
  if (value.event_name !== eventName) errors.push(`event_name must equal ${eventName}`);
  if (value.schema_version !== CALENDAR_SCHEMA_VERSION) errors.push(`schema_version must equal ${CALENDAR_SCHEMA_VERSION}`);
  if (!isRecord(value.provenance)) {
    errors.push('provenance must be an object');
    return;
  }
  exact(value.provenance, PROVENANCE_FIELDS, 'provenance', errors);
  if (value.provenance.calendar_contract !== CALENDAR_CONTRACT) {
    errors.push(`provenance.calendar_contract must equal ${CALENDAR_CONTRACT}`);
  }
  timestamp(value[timestampField], timestampField, errors);
}

export function validateCalendarEventV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['calendar event must be an object']);
  calendarCommon(value, EVENT_FIELDS, 'calendar event', CALENDAR_EVENT_NAME, 'created_at', errors);
  identifier(value.calendar_event_id, 'calendar_event_id', errors);
  if (!CALENDAR_EVENT_CLASSES.includes(value.event_class)) errors.push('event_class must be canonical');
  if (!CALENDAR_EVENT_STATUSES.includes(value.status)) errors.push('status must be canonical');
  timestamp(value.starts_at, 'starts_at', errors);
  timestamp(value.ends_at, 'ends_at', errors);
  timezone(value.timezone, 'timezone', errors);
  identifier(value.scope_ref, 'scope_ref', errors, { nullable: true });
  boundedText(value.summary_code, 'summary_code', errors, { maximum: 80 });
  revision(value.revision, 'revision', errors);
  timestamp(value.updated_at, 'updated_at', errors);
  if (isCanonicalUtcTimestamp(value.starts_at) && isCanonicalUtcTimestamp(value.ends_at)
    && Date.parse(value.ends_at) <= Date.parse(value.starts_at)) {
    errors.push('ends_at must be strictly later than starts_at');
  }
  return result(errors);
}

export function validateWeeklyWindow(value, index, errors) {
  if (!isRecord(value)) {
    errors.push(`weekly_windows[${index}] must be an object`);
    return;
  }
  exact(value, new Set(['day', 'starts_at', 'ends_at']), `weekly_windows[${index}]`, errors);
  if (!DAYS.includes(value.day)) errors.push(`weekly_windows[${index}].day must be a canonical day`);
  if (typeof value.starts_at !== 'string' || !TIME_PATTERN.test(value.starts_at)) {
    errors.push(`weekly_windows[${index}].starts_at must be HH:MM in 24-hour local time`);
  }
  if (typeof value.ends_at !== 'string' || !TIME_PATTERN.test(value.ends_at)) {
    errors.push(`weekly_windows[${index}].ends_at must be HH:MM in 24-hour local time`);
  }
  if (typeof value.starts_at === 'string' && TIME_PATTERN.test(value.starts_at)
    && typeof value.ends_at === 'string' && TIME_PATTERN.test(value.ends_at)
    && value.ends_at <= value.starts_at) {
    errors.push(`weekly_windows[${index}].ends_at must be later than starts_at`);
  }
}

export function validateCompanyHoursV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['company hours must be an object']);
  calendarCommon(value, COMPANY_HOURS_FIELDS, 'company hours', COMPANY_HOURS_NAME, 'updated_at', errors);
  identifier(value.company_hours_id, 'company_hours_id', errors);
  timezone(value.company_timezone, 'company_timezone', errors);
  revision(value.revision, 'revision', errors);
  timestamp(value.updated_at, 'updated_at', errors);
  if (!Array.isArray(value.weekly_windows) || value.weekly_windows.length === 0
    || value.weekly_windows.length > MAX_WEEKLY_WINDOWS) {
    errors.push(`weekly_windows must contain between 1 and ${MAX_WEEKLY_WINDOWS} windows`);
  } else {
    for (let index = 0; index < value.weekly_windows.length; index++) {
      validateWeeklyWindow(value.weekly_windows[index], index, errors);
    }
    const seen = new Set();
    for (const window of value.weekly_windows) {
      const key = `${window?.day}:${window?.starts_at}:${window?.ends_at}`;
      if (seen.has(key)) {
        errors.push('weekly_windows must not contain duplicate windows');
        break;
      }
      seen.add(key);
    }
    // Same-day windows must not overlap (half-open local-time comparison).
    const byDay = new Map();
    for (const window of value.weekly_windows) {
      if (!DAYS.includes(window?.day) || typeof window?.starts_at !== 'string' || typeof window?.ends_at !== 'string') continue;
      if (!byDay.has(window.day)) byDay.set(window.day, []);
      byDay.get(window.day).push(window);
    }
    for (const [day, windows] of byDay) {
      const ordered = [...windows].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index].starts_at < ordered[index - 1].ends_at) {
          errors.push(`weekly_windows for ${day} must not overlap`);
          break;
        }
      }
    }
  }
  return result(errors);
}

export function validateFixedIntervalSchedule(value, errors) {
  if (!isRecord(value)) {
    errors.push('schedule must be an object');
    return;
  }
  exact(value, new Set(['kind', 'anchor_at', 'interval_seconds']), 'schedule', errors);
  if (!SCHEDULE_KINDS.includes(value.kind)) errors.push('schedule.kind must be FIXED_INTERVAL');
  timestamp(value.anchor_at, 'schedule.anchor_at', errors);
  if (!Number.isSafeInteger(value.interval_seconds) || value.interval_seconds < 60
    || value.interval_seconds > 365 * 24 * 60 * 60) {
    errors.push('schedule.interval_seconds must be a bounded positive interval of at least 60 seconds');
  }
}

export function validateRecurringTemplateV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['recurring template must be an object']);
  calendarCommon(value, TEMPLATE_FIELDS, 'recurring template', RECURRING_TEMPLATE_NAME, 'created_at', errors);
  identifier(value.template_id, 'template_id', errors);
  if (!TEMPLATE_STATUSES.includes(value.status)) errors.push('status must be canonical');
  // Recurring templates must use the EXISTING Relay submit-intent vocabulary.
  const intentValidation = validateJobSubmitIntentV1({
    event_name: 'pixel.job.submit-intent.v1',
    schema_version: '1.0.0',
    idempotency_key: 'calendar.template.vocabulary-check',
    job_type: value.job_type,
    requested_capability: value.requested_capability,
  });
  if (!intentValidation.ok) {
    for (const message of intentValidation.errors) errors.push(`job intent: ${message}`);
  }
  validateFixedIntervalSchedule(value.schedule, errors);
  if (!MISSED_RUN_POLICIES.includes(value.missed_run_policy)) errors.push('missed_run_policy must be canonical');
  if (!OVERLAP_POLICIES.includes(value.overlap_policy)) errors.push('overlap_policy must be canonical');
  // authorization_ref is bounded provenance only, never authority.
  identifier(value.authorization_ref, 'authorization_ref', errors);
  revision(value.revision, 'revision', errors);
  timestamp(value.updated_at, 'updated_at', errors);
  return result(errors);
}

export function validateRecurringOccurrenceV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['recurring occurrence must be an object']);
  calendarCommon(value, OCCURRENCE_FIELDS, 'recurring occurrence', RECURRING_OCCURRENCE_NAME, 'created_at', errors);
  identifier(value.occurrence_id, 'occurrence_id', errors);
  revision(value.revision, 'revision', errors);
  identifier(value.template_id, 'template_id', errors);
  revision(value.template_revision, 'template_revision', errors);
  hash(value.template_fingerprint, 'template_fingerprint', errors);
  timestamp(value.scheduled_at, 'scheduled_at', errors);
  if (!OCCURRENCE_STATUSES.includes(value.status)) errors.push('status must be canonical');
  identifier(value.relay_job_id, 'relay_job_id', errors, { nullable: true });
  identifier(value.relay_idempotency_key, 'relay_idempotency_key', errors);
  if (value.status === 'SUBMITTED' && value.relay_job_id === null) {
    errors.push('relay_job_id is required when status is SUBMITTED');
  }
  if (value.status !== 'SUBMITTED' && value.relay_job_id !== null) {
    errors.push('relay_job_id must be null unless status is SUBMITTED');
  }
  if (!Number.isSafeInteger(value.attempt_count) || value.attempt_count < 0 || value.attempt_count > 100) {
    errors.push('attempt_count must be a bounded non-negative integer');
  }
  timestamp(value.last_attempt_at, 'last_attempt_at', errors, { nullable: true });
  timestamp(value.updated_at, 'updated_at', errors);
  return result(errors);
}

export function validateRecurringCheckpointV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['recurring checkpoint must be an object']);
  calendarCommon(value, CHECKPOINT_FIELDS, 'recurring checkpoint', RECURRING_CHECKPOINT_NAME, 'updated_at', errors);
  identifier(value.checkpoint_id, 'checkpoint_id', errors);
  identifier(value.template_id, 'template_id', errors);
  timestamp(value.last_evaluated_at, 'last_evaluated_at', errors);
  revision(value.revision, 'revision', errors);
  timestamp(value.updated_at, 'updated_at', errors);
  return result(errors);
}

export function assertValidCalendarEventV1(value) {
  const validation = validateCalendarEventV1(value);
  if (!validation.ok) throw new TypeError('Calendar event failed contract validation');
  return value;
}

export function assertValidCompanyHoursV1(value) {
  const validation = validateCompanyHoursV1(value);
  if (!validation.ok) throw new TypeError('Company hours failed contract validation');
  return value;
}

export function assertValidRecurringTemplateV1(value) {
  const validation = validateRecurringTemplateV1(value);
  if (!validation.ok) throw new TypeError('Recurring template failed contract validation');
  return value;
}

export function assertValidRecurringOccurrenceV1(value) {
  const validation = validateRecurringOccurrenceV1(value);
  if (!validation.ok) throw new TypeError('Recurring occurrence failed contract validation');
  return value;
}

export function assertValidRecurringCheckpointV1(value) {
  const validation = validateRecurringCheckpointV1(value);
  if (!validation.ok) throw new TypeError('Recurring checkpoint failed contract validation');
  return value;
}

// Deterministic calendar-only operating state at a UTC instant, given active
// events and company hours. Returns null when the operating state cannot be
// established (must never infer NORMAL from unavailable state).
export function derivedCalendarStateAt({ activeEvents = [], companyHours = null, instant } = {}) {
  if (!isCanonicalUtcTimestamp(instant)) return null;
  if (!validateCompanyHoursV1(companyHours).ok || !Array.isArray(activeEvents)
    || Array.from(activeEvents).some(event => !validateCalendarEventV1(event).ok)) return null;
  const now = Date.parse(instant);
  for (const event of activeEvents) {
    if (event?.event_class === 'MAINTENANCE_WINDOW' && event?.status === 'ACTIVE'
      && Date.parse(event.starts_at) <= now && now < Date.parse(event.ends_at)) {
      return 'MAINTENANCE';
    }
  }
  for (const event of activeEvents) {
    if (event?.event_class === 'COMPANY_HOLIDAY' && event?.status === 'ACTIVE'
      && Date.parse(event.starts_at) <= now && now < Date.parse(event.ends_at)) {
      return 'HOLIDAY';
    }
  }
  if (!isValidIanaTimezone(companyHours?.company_timezone)) return null;
  if (!Array.isArray(companyHours?.weekly_windows) || companyHours.weekly_windows.length === 0) return null;
  const parts = localTimeParts(instant, companyHours.company_timezone);
  if (parts === null) return null;
  const localMinutes = parts.hour * 60 + parts.minute;
  for (const window of companyHours.weekly_windows) {
    if (window.day !== parts.day) continue;
    const starts = parseLocalTime(window.starts_at);
    const ends = parseLocalTime(window.ends_at);
    if (starts !== null && ends !== null && localMinutes >= starts && localMinutes < ends) {
      return 'NORMAL';
    }
  }
  return 'NIGHT';
}

export function localTimeParts(instant, timeZone) {
  if (!isCanonicalUtcTimestamp(instant) || !isValidIanaTimezone(timeZone)) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(instant));
    const values = {};
    for (const part of parts) values[part.type] = part.value;
    const dayMap = { Sun: 'SUN', Mon: 'MON', Tue: 'TUE', Wed: 'WED', Thu: 'THU', Fri: 'FRI', Sat: 'SAT' };
    const hour = Number(values.hour === '24' ? '0' : values.hour);
    const minute = Number(values.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { day: dayMap[values.weekday] ?? null, hour, minute };
  } catch {
    return null;
  }
}

export function parseLocalTime(text) {
  if (typeof text !== 'string' || !TIME_PATTERN.test(text)) return null;
  const match = text.match(TIME_PATTERN);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour * 60 + minute;
}

// Validate the Calendar read projection, not a calendar-event record. Consumers
// snapshot the seam first so accessors, sparse arrays and mutable data reject.
export function validateCalendarOperatingFactsV1(value) {
  const errors = [];
  if (!isRecord(value)) return result(['calendar facts must be an object']);
  exact(value, new Set(['available', 'observed_at', 'company_hours_id', 'company_timezone',
    'active_event_refs', 'calendar_state', 'revision_token']), 'calendar facts', errors);
  if (value.available !== true) errors.push('calendar facts unavailable');
  timestamp(value.observed_at, 'observed_at', errors);
  identifier(value.company_hours_id, 'company_hours_id', errors);
  timezone(value.company_timezone, 'company_timezone', errors);
  hash(value.revision_token, 'revision_token', errors);
  if (!COMPANY_STATES_FROM_CALENDAR.includes(value.calendar_state)) errors.push('calendar_state must be canonical');
  if (!Array.isArray(value.active_event_refs) || value.active_event_refs.length > MAX_ACTIVE_EVENT_REFS) {
    errors.push('active_event_refs must be bounded');
  } else {
    for (let index = 0; index < value.active_event_refs.length; index++) {
      identifier(value.active_event_refs[index], 'active_event_ref', errors);
    }
    if (new Set(value.active_event_refs).size !== value.active_event_refs.length) errors.push('active_event_refs must be unique');
    const plannedEvent = ['MAINTENANCE', 'HOLIDAY'].includes(value.calendar_state);
    if (plannedEvent !== (value.active_event_refs.length > 0)) errors.push('calendar state must agree with event refs');
  }
  return result(errors);
}

export const calendarCheckpointId = id => `checkpoint:${createHash('sha256').update(id).digest('hex')}`;
