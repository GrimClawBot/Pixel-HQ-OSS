import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarRuntime, defaultCompanyHours, baseEvent, baseTemplate } from '../helpers/px008-runtime.js';

for (const response of [null, { allowed: false }, { allowed: true }, { allowed: 'true', authorization_ref: 'authz' }, { allowed: true, authorization_ref: 'bad ref' }]) {
  test(`malformed or denied mutation authority cannot persist configuration: ${JSON.stringify(response)}`, () => {
    const r = calendarRuntime({ authorizer: { authorize: () => response } });
    for (const result of [r.calendar.setCompanyHours(defaultCompanyHours()), r.calendar.createEvent(baseEvent()), r.calendar.createTemplate(baseTemplate())]) {
      assert.equal(result.disposition, 'REJECTED');
    }
    assert.equal(r.calendar.listEvents().length, 0);
    assert.equal(r.calendar.listTemplates().length, 0);
    assert.equal(r.calendar.operatingFactsAt().available, false);
  });
}

test('authorizer sees the exact resource, expected revision and proposed bounded mutation', () => {
  const calls = [];
  const r = calendarRuntime({ authorizer: { authorize: request => {
    calls.push(request);
    return { allowed: true, authorization_ref: 'server-authz' };
  } } });
  r.calendar.setCompanyHours(defaultCompanyHours());
  r.calendar.createEvent(baseEvent());
  r.calendar.createTemplate(baseTemplate());
  r.calendar.changeEvent({ calendar_event_id: 'event-001', expected_revision: 1, status: 'CANCELLED' });
  r.calendar.changeTemplate({ template_id: 'template-001', expected_revision: 1, status: 'PAUSED' });
  assert.deepEqual(calls.map(x => x.resource_ref), ['company-hours-001', 'event-001', 'template-001', 'event-001', 'template-001']);
  assert.equal(calls[3].mutation.status, 'CANCELLED');
  assert.equal(calls[3].expected_revision, 1);
  assert.equal(r.calendar.listTemplates()[0].authorization_ref, 'server-authz');
});

test('all mutation paths deny when the server authorizer becomes unavailable', () => {
  let allowed = true;
  const r = calendarRuntime({ authorizer: { authorize: () => {
    if (!allowed) throw new Error('offline');
    return { allowed: true, authorization_ref: 'server-authz' };
  } } });
  r.calendar.setCompanyHours(defaultCompanyHours());
  r.calendar.createEvent(baseEvent());
  r.calendar.createTemplate(baseTemplate());
  allowed = false;
  assert.equal(r.calendar.setCompanyHours(defaultCompanyHours({ expected_revision: 1 })).disposition, 'REJECTED');
  assert.equal(r.calendar.changeEvent({ calendar_event_id: 'event-001', expected_revision: 1, status: 'CANCELLED' }).disposition, 'REJECTED');
  assert.equal(r.calendar.changeTemplate({ template_id: 'template-001', expected_revision: 1, status: 'RETIRED' }).disposition, 'REJECTED');
  assert.equal(r.calendar.listTemplates()[0].revision, 1);
  assert.equal(r.calendar.listEvents()[0].revision, 1);
});

test('company hours are a singleton and all updates require explicit current revision', () => {
  const r = calendarRuntime();
  r.calendar.setCompanyHours(defaultCompanyHours());
  assert.equal(r.calendar.setCompanyHours(defaultCompanyHours()).reason_code, 'STALE_REVISION');
  assert.equal(r.calendar.setCompanyHours(defaultCompanyHours({ expected_revision: 7 })).reason_code, 'STALE_REVISION');
  assert.equal(r.calendar.setCompanyHours(defaultCompanyHours({ company_hours_id: 'other-hours' })).disposition, 'REJECTED');
  assert.equal(r.calendar.setCompanyHours(defaultCompanyHours({ expected_revision: 1 })).disposition, 'RECORDED');
});

test('cancelled events and retired templates cannot be revived', () => {
  const r = calendarRuntime();
  r.calendar.createEvent(baseEvent());
  r.calendar.createTemplate(baseTemplate());
  assert.equal(r.calendar.changeEvent({ calendar_event_id: 'event-001', expected_revision: 1, status: 'CANCELLED' }).disposition, 'RECORDED');
  assert.equal(r.calendar.changeEvent({ calendar_event_id: 'event-001', expected_revision: 2, status: 'ACTIVE' }).disposition, 'REJECTED');
  assert.equal(r.calendar.changeTemplate({ template_id: 'template-001', expected_revision: 1, status: 'RETIRED' }).disposition, 'RECORDED');
  assert.equal(r.calendar.changeTemplate({ template_id: 'template-001', expected_revision: 2, status: 'ACTIVE' }).disposition, 'REJECTED');
});

test('unsafe caller data and caller-owned progress or authority fields reject without mutation', () => {
  const r = calendarRuntime();
  const cyclic = {}; cyclic.self = cyclic;
  const getter = Object.defineProperty({}, 'template_id', { enumerable: true, get() { throw new Error('getter'); } });
  for (const debris of [null, cyclic, getter, { ...baseTemplate(), last_evaluated_at: '2099-01-01T00:00:00.000Z' }, { ...baseTemplate(), owner: 'root' }, { ...baseTemplate(), schedule: { ...baseTemplate().schedule, injected: () => true } }]) {
    assert.doesNotThrow(() => assert.equal(r.calendar.createTemplate(debris).disposition, 'REJECTED'));
  }
  assert.equal(r.calendar.listTemplates().length, 0);
});

test('missing mutation authorizer and missing evidence cannot persist Calendar configuration', () => {
  const missing = calendarRuntime({ authorizer: null });
  assert.equal(missing.calendar.createTemplate(baseTemplate()).reason_code, 'MUTATION_AUTHORIZATION_DENIED');
  const r = calendarRuntime();
  r.evidence.append = () => { throw new Error('evidence unavailable'); };
  assert.throws(() => r.calendar.createTemplate(baseTemplate()), /evidence unavailable/);
  assert.equal(r.calendar.listTemplates().length, 0);
});

test('caller authorization provenance must be a bounded identifier', () => {
  const r = calendarRuntime();
  assert.equal(r.calendar.createTemplate(baseTemplate({ authorization_ref: 'a'.repeat(161) })).disposition, 'REJECTED');
  assert.equal(r.calendar.listTemplates().length, 0);
});
