import { snapshotSafePlainData } from '../../../packages/adapter-sdk/src/model-runtime-adapters.js';
import { canonicalUtcTimestamp } from '../../../packages/contracts/src/trusted-time-v1.js';
import {
  calendarCheckpointId, validateCalendarEventV1, validateCompanyHoursV1, validateRecurringCheckpointV1,
  validateRecurringOccurrenceV1, validateRecurringTemplateV1,
} from '../../../packages/contracts/src/calendar-v1.js';

const KINDS = new Map([
  ['calendar-event', ['calendar_event_id', validateCalendarEventV1]],
  ['company-hours', ['company_hours_id', validateCompanyHoursV1]],
  ['recurring-template', ['template_id', validateRecurringTemplateV1]],
  ['recurring-checkpoint', ['checkpoint_id', validateRecurringCheckpointV1]],
  ['recurring-occurrence', ['occurrence_id', validateRecurringOccurrenceV1]],
]);
const denied = (reason_code) => ({ disposition: 'REJECTED', reason_code, record: null });

export class SimulatorCalendarStoreAdapter {
  #records = new Map([...KINDS.keys()].map(kind => [kind, new Map()]));
  #claims = new Map();
  #templates = new Map();
  #locks = new Map();
  #highWater = null;

  get source() { return 'simulator'; }

  observeTime(instant) {
    canonicalUtcTimestamp(instant);
    if (this.#highWater === null || instant > this.#highWater) this.#highWater = instant;
    return this.#highWater;
  }

  get(kind, id) { return this.#records.get(kind)?.get(id) ?? null; }
  list(kind) { return [...(this.#records.get(kind)?.values() ?? [])]; }
  currentCheckpoint(id) { return this.get('recurring-checkpoint', calendarCheckpointId(id)); }
  templateRevision(id, revision) { return this.#templates.get(JSON.stringify([id, revision])) ?? null; }

  // ponytail: process-local, per-template locks cover async Relay calls. A live
  // multi-process store would need transactional claims and fenced leases.
  acquireTemplate(id) {
    if (this.#locks.has(id)) return null;
    const token = Symbol('calendar-evaluator');
    this.#locks.set(id, token);
    return token;
  }

  releaseTemplate(id, token) {
    if (token !== null && this.#locks.get(id) === token) this.#locks.delete(id);
  }

  put(kind, value, { expectedRevision = null } = {}) {
    if (!KINDS.has(kind) || kind === 'recurring-occurrence') return denied('UNKNOWN_KIND');
    let record;
    try {
      record = snapshotSafePlainData(value);
      if (!KINDS.get(kind)[1](record).ok) return denied('RECORD_INVALID');
    } catch { return denied('RECORD_INVALID'); }
    const id = record[KINDS.get(kind)[0]];
    const bucket = this.#records.get(kind);
    const current = bucket.get(id);
    if (kind === 'recurring-template' && this.#locks.has(id)) return denied('EVALUATION_IN_PROGRESS');
    if (current ? (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision || record.revision !== expectedRevision + 1)
      : (expectedRevision !== null || record.revision !== 1)) return denied('STALE_REVISION');
    if (current && (record.updated_at < current.updated_at || ('created_at' in current && record.created_at !== current.created_at))) return denied('RECORD_INVALID');
    if (kind === 'company-hours' && !current && bucket.size) return denied('COMPANY_HOURS_ALREADY_CONFIGURED');
    if (kind === 'calendar-event' && current?.status === 'CANCELLED') return denied('EVENT_CANCELLED');
    if (kind === 'recurring-template' && current?.status === 'RETIRED') return denied('TEMPLATE_RETIRED');
    if (kind === 'recurring-checkpoint' && (id !== calendarCheckpointId(record.template_id)
      || (current && record.last_evaluated_at < current.last_evaluated_at))) return denied('CHECKPOINT_ROLLBACK');
    bucket.set(id, record);
    if (kind === 'recurring-template') this.#templates.set(JSON.stringify([id, record.revision]), record);
    return { disposition: current ? 'UPDATED' : 'CREATED', record };
  }

  claimOccurrence(value, token) {
    let record;
    try {
      record = snapshotSafePlainData(value);
      if (!validateRecurringOccurrenceV1(record).ok || record.revision !== 1) return denied('RECORD_INVALID');
    } catch { return denied('RECORD_INVALID'); }
    if (!token || this.#locks.get(record.template_id) !== token) return denied('CLAIM_NOT_OWNED');
    const key = JSON.stringify([record.template_id, record.scheduled_at]);
    const existingId = this.#claims.get(key);
    if (existingId) return { disposition: 'EXISTING', record: this.get('recurring-occurrence', existingId) };
    if (this.get('recurring-occurrence', record.occurrence_id)) return denied('OCCURRENCE_ID_CONFLICT');
    const definition = this.templateRevision(record.template_id, record.template_revision);
    if (!definition || definition.status !== 'ACTIVE') return denied('TEMPLATE_INVALID');
    this.#records.get('recurring-occurrence').set(record.occurrence_id, record);
    this.#claims.set(key, record.occurrence_id);
    return { disposition: 'CREATED', record };
  }

  updateOccurrence(id, changes, { expectedRevision, token } = {}) {
    const current = this.get('recurring-occurrence', id);
    if (!current || !token || this.#locks.get(current.template_id) !== token) return denied('CLAIM_NOT_OWNED');
    if (current.revision !== expectedRevision) return denied('STALE_REVISION');
    if (['SUBMITTED', 'SKIPPED', 'REVIEW_REQUIRED'].includes(current.status)) return denied('OCCURRENCE_TERMINAL');
    let record;
    try {
      const patch = snapshotSafePlainData(changes);
      if (Object.keys(patch).some(key => !['status', 'relay_job_id', 'attempt_count', 'last_attempt_at', 'updated_at'].includes(key))) return denied('RECORD_INVALID');
      record = snapshotSafePlainData({ ...current, ...patch, revision: current.revision + 1 });
      if (!validateRecurringOccurrenceV1(record).ok || record.updated_at < current.updated_at
        || record.attempt_count < current.attempt_count) return denied('RECORD_INVALID');
    } catch { return denied('RECORD_INVALID'); }
    this.#records.get('recurring-occurrence').set(id, record);
    return { disposition: 'UPDATED', record };
  }
}
