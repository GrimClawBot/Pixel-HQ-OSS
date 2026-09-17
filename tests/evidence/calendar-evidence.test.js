import assert from 'node:assert/strict';
import test from 'node:test';

import { calendarRuntime, defaultCompanyHours, baseEvent, baseTemplate } from '../helpers/px008-runtime.js';
import { createClock, NOW } from '../helpers/px006-runtime.js';

function bounded(attributes) {
  return attributes !== null && typeof attributes === 'object' && !Array.isArray(attributes)
    && Object.values(attributes).every((value) => (
      ['string', 'number', 'boolean'].includes(typeof value)
      && (typeof value !== 'string' || value.length <= 160)
    ));
}

test('calendar evidence is bounded with canonical pixel keys only', async () => {
  const runtime = calendarRuntime();
  runtime.calendar.setCompanyHours(defaultCompanyHours());
  runtime.calendar.createEvent(baseEvent());
  runtime.calendar.createTemplate(baseTemplate());
  await runtime.calendar.evaluateDueOccurrences();
  const records = runtime.evidence.all();
  const calendarRecords = records.filter((record) => record.service_name === 'pixel.calendar');
  assert.ok(calendarRecords.length > 0);
  for (const record of calendarRecords) {
    assert.ok(Object.keys(record.attributes).every((key) => key.startsWith('pixel.calendar.')));
    assert.equal(bounded(record.attributes), true, record.event_name);
    assert.equal(record.parent_span_id, null);
  }
});

test('calendar refused evidence carries bounded reason codes', () => {
  const runtime = calendarRuntime();
  const denied = runtime.calendar.setCompanyHours(defaultCompanyHours({ company_timezone: 'Not/AZone' }));
  assert.equal(denied.disposition, 'REJECTED');
  const refused = runtime.evidence.all().find((record) => record.event_name === 'calendar.refused');
  assert.ok(refused);
  assert.equal(refused.outcome, 'denied');
  assert.ok(refused.attributes['pixel.calendar.reason_code']);
});
