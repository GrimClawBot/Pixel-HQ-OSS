import { createHash } from 'node:crypto';
import { snapshotSafePlainData } from '../../../packages/adapter-sdk/src/model-runtime-adapters.js';
import { createTrustedClock } from '../../../packages/contracts/src/trusted-time-v1.js';
import { JOB_STATES, validateJobEnvelopeV1 } from '../../../packages/contracts/src/job-v1.js';
import {
  CALENDAR_CONTRACT, CALENDAR_SCHEMA_VERSION, CALENDAR_EVENT_NAME, COMPANY_HOURS_NAME,
  RECURRING_TEMPLATE_NAME, RECURRING_OCCURRENCE_NAME, RECURRING_CHECKPOINT_NAME,
  REVIEW_REQUIRED_AFTER_MISSED_WINDOWS, MAX_ACTIVE_EVENT_REFS,
  validateCalendarEventV1, validateCompanyHoursV1, validateRecurringTemplateV1,
  validateCalendarOperatingFactsV1, derivedCalendarStateAt, calendarCheckpointId,
} from '../../../packages/contracts/src/calendar-v1.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const provenance = () => ({ calendar_contract: CALENDAR_CONTRACT });
const MAX_SUBMISSION_ATTEMPTS = 3;
const MUTATIONS = new Map([
  ['calendar.event.create', ['calendar_event_id', 'event_class', 'status', 'starts_at', 'ends_at', 'timezone', 'scope_ref', 'summary_code', 'authorization_ref']],
  ['calendar.event.change', ['calendar_event_id', 'expected_revision', 'status', 'starts_at', 'ends_at', 'timezone', 'scope_ref', 'summary_code', 'authorization_ref']],
  ['company.hours.change', ['company_hours_id', 'company_timezone', 'weekly_windows', 'expected_revision', 'authorization_ref']],
  ['recurring.template.create', ['template_id', 'job_type', 'requested_capability', 'schedule', 'missed_run_policy', 'overlap_policy', 'authorization_ref']],
  ['recurring.template.change', ['template_id', 'expected_revision', 'status', 'schedule', 'missed_run_policy', 'overlap_policy', 'authorization_ref']],
]);
const validId = value => typeof value === 'string' && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);

export class CalendarService {
  #clock;
  #environment;
  #store;
  #evidence;
  #ids;
  #authorizer;
  #relay;

  constructor({ environment, store, evidence, ids, clock, authorizer = null, relay }) {
    if (!['dev', 'simulation', 'shadow', 'canary', 'production'].includes(environment)) throw new TypeError('Calendar environment invalid');
    if (!store || ['put', 'get', 'list', 'observeTime', 'currentCheckpoint', 'templateRevision',
      'acquireTemplate', 'releaseTemplate', 'claimOccurrence', 'updateOccurrence'].some(method => typeof store[method] !== 'function')) throw new TypeError('Calendar store required');
    if (!evidence || typeof evidence.append !== 'function' || !ids
      || ['nextTraceId', 'nextSpanId'].some(method => typeof ids[method] !== 'function')) throw new TypeError('Calendar evidence and IDs required');
    if (!relay || typeof relay.accept !== 'function' || typeof relay.getJob !== 'function') throw new TypeError('Calendar requires Relay accept/getJob seams');
    if ([store, relay, authorizer].some(x => x?.source === 'simulator')
      && !['dev', 'simulation'].includes(environment)) throw new RangeError('Simulator Calendar adapters require dev or simulation');
    this.#environment = environment;
    this.#store = store;
    this.#evidence = evidence;
    this.#ids = ids;
    this.#authorizer = authorizer;
    this.#relay = relay;
    const trusted = createTrustedClock({ source: clock });
    // Store high-water time survives service replacement against the same
    // simulator store; configuration and occurrence clocks cannot diverge.
    this.#clock = () => store.observeTime(trusted.now());
  }

  #append(eventName, attributes, outcome = 'success') {
    const traceId = this.#ids.nextTraceId();
    this.#evidence.append({ traceId, spanId: this.#ids.nextSpanId(), parentSpanId: null,
      serviceName: 'pixel.calendar', eventName, outcome, severity: outcome === 'success' ? 'info' : 'warning', attributes });
    return traceId;
  }

  #refused(reason_code) {
    const trace_id = this.#append('calendar.refused', { 'pixel.calendar.reason_code': reason_code }, 'denied');
    return Object.freeze({ disposition: 'REJECTED', reason_code, record: null, trace_id });
  }

  #input(action, input) {
    try {
      const args = snapshotSafePlainData(input);
      if (!args || Array.isArray(args) || typeof args !== 'object'
        || Object.keys(args).some(key => !MUTATIONS.get(action).includes(key))) return null;
      if ('authorization_ref' in args && !validId(args.authorization_ref)) return null;
      return args;
    } catch { return null; }
  }

  #commit(action, kind, idField, args, record, expectedRevision, validate) {
    if (!validate(record).ok) return this.#refused('CALENDAR_INVALID');
    let authorization;
    try {
      // Resource and proposal are server-bound, frozen facts. Caller refs are
      // provenance only; the injected server authorizer owns authentication.
      authorization = snapshotSafePlainData(this.#authorizer?.authorize({
        action, resource_ref: record[idField], expected_revision: expectedRevision,
        mutation: snapshotSafePlainData(record), authorization_ref: args.authorization_ref ?? null,
      }));
      if (authorization?.allowed !== true || !validId(authorization.authorization_ref)
        || Object.keys(authorization).some(key => !['allowed', 'authorization_ref'].includes(key))) throw new Error('denied');
    } catch { return this.#refused('MUTATION_AUTHORIZATION_DENIED'); }
    if (kind === 'recurring-template') record.authorization_ref = authorization.authorization_ref;
    // Evidence must be available before the persistent configuration change.
    this.#append('calendar.mutation.authorized', {
      'pixel.calendar.resource_ref': record[idField], 'pixel.calendar.action': action,
      'pixel.calendar.authorization_ref': authorization.authorization_ref,
    });
    const stored = this.#store.put(kind, record, { expectedRevision });
    if (!['CREATED', 'UPDATED'].includes(stored.disposition)) return this.#refused(stored.reason_code ?? 'CALENDAR_UNAVAILABLE');
    const trace_id = this.#append('calendar.mutation.recorded', {
      'pixel.calendar.resource_ref': record[idField], 'pixel.calendar.action': action,
      'pixel.calendar.revision': stored.record.revision,
    });
    return Object.freeze({ disposition: 'RECORDED', record: stored.record, trace_id });
  }

  createEvent(input = {}) {
    const action = 'calendar.event.create';
    const a = this.#input(action, input);
    if (!a) return this.#refused('CALENDAR_INVALID');
    const now = this.#clock();
    const { authorization_ref, ...fields } = a;
    const record = { ...fields, status: a.status ?? 'ACTIVE', scope_ref: a.scope_ref ?? null,
      event_name: CALENDAR_EVENT_NAME, schema_version: CALENDAR_SCHEMA_VERSION,
      revision: 1, created_at: now, updated_at: now, provenance: provenance() };
    return this.#commit(action, 'calendar-event', 'calendar_event_id', a, record, null, validateCalendarEventV1);
  }

  changeEvent(input = {}) {
    const action = 'calendar.event.change';
    const a = this.#input(action, input);
    if (!a) return this.#refused('CALENDAR_INVALID');
    const current = this.#store.get('calendar-event', a.calendar_event_id);
    if (!current) return this.#refused('NOT_FOUND');
    if (!Number.isSafeInteger(a.expected_revision)) return this.#refused('STALE_REVISION');
    const { expected_revision, authorization_ref, ...fields } = a;
    const record = { ...current, ...fields, updated_at: this.#clock(), revision: current.revision + 1 };
    return this.#commit(action, 'calendar-event', 'calendar_event_id', a, record, expected_revision, validateCalendarEventV1);
  }

  setCompanyHours(input = {}) {
    const action = 'company.hours.change';
    const a = this.#input(action, input);
    if (!a) return this.#refused('CALENDAR_INVALID');
    const current = this.#store.get('company-hours', a.company_hours_id);
    if (current && !Number.isSafeInteger(a.expected_revision)) return this.#refused('STALE_REVISION');
    const { authorization_ref, expected_revision, ...fields } = a;
    const record = { ...fields, event_name: COMPANY_HOURS_NAME, schema_version: CALENDAR_SCHEMA_VERSION,
      revision: (current?.revision ?? 0) + 1, updated_at: this.#clock(), provenance: provenance() };
    return this.#commit(action, 'company-hours', 'company_hours_id', a, record, expected_revision ?? null, validateCompanyHoursV1);
  }

  createTemplate(input = {}) {
    const action = 'recurring.template.create';
    const a = this.#input(action, input);
    if (!a) return this.#refused('CALENDAR_INVALID');
    const now = this.#clock();
    // Placeholder is a bounded validation value, replaced with the authorizer's
    // provenance before storage; it grants no mutation/execution permission.
    const record = { ...a, authorization_ref: 'authorization.pending', status: 'ACTIVE',
      event_name: RECURRING_TEMPLATE_NAME, schema_version: CALENDAR_SCHEMA_VERSION,
      revision: 1, created_at: now, updated_at: now, provenance: provenance() };
    return this.#commit(action, 'recurring-template', 'template_id', a, record, null, validateRecurringTemplateV1);
  }

  changeTemplate(input = {}) {
    const action = 'recurring.template.change';
    const a = this.#input(action, input);
    if (!a) return this.#refused('CALENDAR_INVALID');
    const current = this.#store.get('recurring-template', a.template_id);
    if (!current) return this.#refused('NOT_FOUND');
    if (!Number.isSafeInteger(a.expected_revision)) return this.#refused('STALE_REVISION');
    const { expected_revision, authorization_ref, ...fields } = a;
    const record = { ...current, ...fields, revision: current.revision + 1, updated_at: this.#clock() };
    return this.#commit(action, 'recurring-template', 'template_id', a, record, expected_revision, validateRecurringTemplateV1);
  }

  #occurrences(templateId) {
    // ponytail: linear history scan in the in-process Alpha store; index by
    // template before moving to a larger persistent deployment.
    return this.#store.list('recurring-occurrence').filter(x => x.template_id === templateId);
  }

  #claim(template, scheduled_at, status, now, token) {
    const identity = hash([template.template_id, scheduled_at]);
    const result = this.#store.claimOccurrence({
      occurrence_id: `occurrence:${identity}`, event_name: RECURRING_OCCURRENCE_NAME,
      schema_version: CALENDAR_SCHEMA_VERSION, revision: 1,
      template_id: template.template_id, template_revision: template.revision,
      template_fingerprint: hash(template), scheduled_at, status, relay_job_id: null,
      relay_idempotency_key: `calendar:${identity}`, attempt_count: 0, last_attempt_at: null,
      created_at: now, updated_at: now, provenance: provenance(),
    }, token);
    if (!['CREATED', 'EXISTING'].includes(result.disposition)) throw new Error('Occurrence claim failed');
    if (result.disposition === 'CREATED') this.#occurrenceEvidence(result.record);
    return result.record;
  }

  #occurrenceEvidence(record) {
    this.#append('calendar.occurrence.recorded', {
      'pixel.calendar.template_id': record.template_id, 'pixel.calendar.template_revision': record.template_revision,
      'pixel.calendar.occurrence_id': record.occurrence_id, 'pixel.calendar.scheduled_at': record.scheduled_at,
      'pixel.calendar.status': record.status, 'pixel.calendar.revision': record.revision,
      ...(record.relay_job_id ? { 'pixel.calendar.relay_job_id': record.relay_job_id } : {}),
    });
  }

  #update(occurrence, changes, token) {
    const result = this.#store.updateOccurrence(occurrence.occurrence_id,
      { ...changes, updated_at: this.#clock() }, { expectedRevision: occurrence.revision, token });
    if (result.disposition !== 'UPDATED') throw new Error('Occurrence update failed');
    this.#occurrenceEvidence(result.record);
    return result.record;
  }

  #boundJob(value, occurrence, template) {
    try {
      // Relay getJob/accept return a canonical job including the full envelope.
      // Snapshot just the consumed fields: job history may grow independently.
      const job = snapshotSafePlainData({ envelope: value?.envelope, current_state: value?.current_state, job_revision: value?.job_revision });
      const e = job.envelope;
      return validateJobEnvelopeV1(e).ok && JOB_STATES.includes(job.current_state)
        && Number.isSafeInteger(job.job_revision) && job.job_revision > 0
        && e.environment === this.#environment && e.idempotency.key === occurrence.relay_idempotency_key
        && e.job_type === template.job_type && e.requested_capability === template.requested_capability
        && (!occurrence.relay_job_id || occurrence.relay_job_id === e.job_id) ? job : null;
    } catch { return null; }
  }

  async #process(occurrence, token) {
    const template = this.#store.templateRevision(occurrence.template_id, occurrence.template_revision);
    if (!template || hash(template) !== occurrence.template_fingerprint) {
      return this.#update(occurrence, { status: 'REVIEW_REQUIRED' }, token);
    }
    // Every submitted predecessor matters, including across schedule edits or
    // intervening SKIPPED occurrences. Unknown submission outcome blocks overlap.
    for (const prior of this.#occurrences(template.template_id)) {
      if (prior.occurrence_id === occurrence.occurrence_id || prior.status === 'SKIPPED') continue;
      if (prior.status !== 'SUBMITTED') return this.#update(occurrence, { status: 'REVIEW_REQUIRED' }, token);
      let job;
      try { job = this.#boundJob(await this.#relay.getJob(prior.relay_job_id), prior,
        this.#store.templateRevision(prior.template_id, prior.template_revision)); } catch { job = null; }
      if (!job) return this.#update(occurrence, { status: 'REVIEW_REQUIRED' }, token);
      if (!['COMPLETED', 'FAILED'].includes(job.current_state)) return this.#update(occurrence, { status: 'SKIPPED' }, token);
    }
    if (occurrence.attempt_count >= MAX_SUBMISSION_ATTEMPTS) return this.#update(occurrence, { status: 'REVIEW_REQUIRED' }, token);
    occurrence = this.#update(occurrence, { status: 'SUBMISSION_PENDING',
      attempt_count: occurrence.attempt_count + 1, last_attempt_at: this.#clock() }, token);
    let submission;
    try {
      submission = await this.#relay.accept(Object.freeze({ event_name: 'pixel.job.submit-intent.v1',
        schema_version: '1.0.0', idempotency_key: occurrence.relay_idempotency_key,
        job_type: template.job_type, requested_capability: template.requested_capability }));
      const job = this.#boundJob(submission?.job, occurrence, template);
      if (['CREATED', 'EXISTING'].includes(submission?.disposition) && job) {
        return this.#update(occurrence, { status: 'SUBMITTED', relay_job_id: job.envelope.job_id }, token);
      }
      if (['CONFLICT', 'REJECTED'].includes(submission?.disposition)) return this.#update(occurrence, { status: 'REVIEW_REQUIRED' }, token);
    } catch { /* Unknown outcome: preserve this occurrence and its exact key. */ }
    return occurrence.attempt_count >= MAX_SUBMISSION_ATTEMPTS
      ? this.#update(occurrence, { status: 'REVIEW_REQUIRED' }, token) : occurrence;
  }

  async evaluateDueOccurrences(...callerArguments) {
    if (callerArguments.length) return this.#refused('CALENDAR_INVALID');
    const now = this.#clock();
    const results = [];
    for (const listed of this.#store.list('recurring-template')) {
      if (listed.status !== 'ACTIVE') continue;
      const token = this.#store.acquireTemplate(listed.template_id);
      if (!token) continue;
      try {
        const template = this.#store.get('recurring-template', listed.template_id);
        if (!validateRecurringTemplateV1(template).ok || template.status !== 'ACTIVE') continue;
        let history = this.#occurrences(template.template_id);
        if (history.some(x => x.status === 'REVIEW_REQUIRED')) continue;
        // Retry pending claims independently of the forward-only scan cursor.
        const pending = history.filter(x => ['DUE', 'SUBMISSION_PENDING'].includes(x.status));
        for (const record of pending) {
          const occurrence = await this.#process(record, token);
          results.push({ disposition: occurrence.status, occurrence });
        }
        history = this.#occurrences(template.template_id);
        if (history.some(x => ['DUE', 'SUBMISSION_PENDING', 'REVIEW_REQUIRED'].includes(x.status))) continue;
        const checkpoint = this.#store.currentCheckpoint(template.template_id);
        const anchor = Date.parse(template.schedule.anchor_at);
        const interval = template.schedule.interval_seconds * 1000;
        const latestIndex = Math.floor((Date.parse(now) - anchor) / interval);
        const firstIndex = checkpoint ? Math.max(0, Math.floor((Date.parse(checkpoint.last_evaluated_at) - anchor) / interval) + 1) : 0;
        const count = Math.max(0, latestIndex - firstIndex + 1);
        if (count > 0) {
          const scheduledAt = new Date(anchor + latestIndex * interval).toISOString();
          if (count > REVIEW_REQUIRED_AFTER_MISSED_WINDOWS) {
            const occurrence = this.#claim(template, scheduledAt, 'REVIEW_REQUIRED', now, token);
            results.push({ disposition: occurrence.status, occurrence });
          } else if (count === 1 || template.missed_run_policy === 'RUN_ONCE_FOR_MISSED_WINDOW') {
            let occurrence = this.#claim(template, scheduledAt, 'DUE', now, token);
            if (['DUE', 'SUBMISSION_PENDING'].includes(occurrence.status)) occurrence = await this.#process(occurrence, token);
            results.push({ disposition: occurrence.status, occurrence });
          } else {
            this.#append('calendar.missed-runs.skipped', { 'pixel.calendar.template_id': template.template_id,
              'pixel.calendar.missed_occurrences': count });
          }
        }
        if (!checkpoint || now > checkpoint.last_evaluated_at) {
          const result = this.#store.put('recurring-checkpoint', {
            checkpoint_id: calendarCheckpointId(template.template_id), event_name: RECURRING_CHECKPOINT_NAME,
            schema_version: CALENDAR_SCHEMA_VERSION, template_id: template.template_id,
            last_evaluated_at: now, revision: (checkpoint?.revision ?? 0) + 1, updated_at: now, provenance: provenance(),
          }, { expectedRevision: checkpoint?.revision ?? null });
          if (!['CREATED', 'UPDATED'].includes(result.disposition)) throw new Error('Checkpoint update failed');
        }
      } finally { this.#store.releaseTemplate(listed.template_id, token); }
    }
    return Object.freeze({ disposition: 'EVALUATED', evaluated_at: now, results: Object.freeze(results.map(Object.freeze)) });
  }

  operatingFactsAt(...callerArguments) {
    const now = this.#clock();
    const unavailable = () => Object.freeze({ available: false, observed_at: now, company_hours_id: null,
      company_timezone: null, active_event_refs: Object.freeze([]), calendar_state: null, revision_token: null });
    if (callerArguments.length) return unavailable();
    try {
      const hours = this.#store.list('company-hours');
      if (!Array.isArray(hours) || hours.length !== 1 || !validateCompanyHoursV1(hours[0]).ok) return unavailable();
      const companyHours = snapshotSafePlainData(hours[0]);
      const events = this.#store.list('calendar-event');
      if (!Array.isArray(events)) return unavailable();
      const active = [];
      for (const candidate of events) {
        const event = snapshotSafePlainData(candidate);
        if (!validateCalendarEventV1(event).ok) return unavailable();
        if (event.status === 'ACTIVE' && event.starts_at <= now && now < event.ends_at) active.push(event);
        if (active.length > MAX_ACTIVE_EVENT_REFS) return unavailable();
      }
      const facts = { available: true, observed_at: now, company_hours_id: companyHours.company_hours_id,
        company_timezone: companyHours.company_timezone,
        active_event_refs: active.map(x => x.calendar_event_id).sort(),
        calendar_state: derivedCalendarStateAt({ activeEvents: active, companyHours, instant: now }),
        revision_token: hash([companyHours, active.map(x => [x.calendar_event_id, x.revision]).sort()]),
      };
      return validateCalendarOperatingFactsV1(facts).ok ? snapshotSafePlainData(facts) : unavailable();
    } catch { return unavailable(); }
  }

  activeCalendarFacts() { return this.operatingFactsAt(); }
  listEvents() { return this.#store.list('calendar-event'); }
  listTemplates() { return this.#store.list('recurring-template'); }
  listOccurrences() { return this.#store.list('recurring-occurrence'); }
  getOccurrence(id) { return this.#store.get('recurring-occurrence', id); }
}
