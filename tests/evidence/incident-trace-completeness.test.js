import assert from 'node:assert/strict';
import test from 'node:test';

import { assessIncidentTraceCompleteness } from '../../packages/telemetry/src/incident-trace-completeness.js';

const TRACE = 'a'.repeat(31) + 'b';
const SPAN = '1'.repeat(16);

function record(overrides = {}) {
  return {
    trace_id: TRACE,
    span_id: SPAN,
    parent_span_id: null,
    service_name: 'pixel.incident',
    event_name: 'incident.created',
    outcome: 'success',
    severity: 'info',
    attributes: {
      'pixel.incident.incident_id': 'incident-001',
      'pixel.incident.status': 'OPEN',
      'pixel.incident.revision': 1,
    },
    ...overrides,
  };
}

test('canonical incident evidence records assess complete', () => {
  assert.equal(assessIncidentTraceCompleteness([record()]).complete, true);
});

test('empty and malformed traces fail closed', () => {
  assert.equal(assessIncidentTraceCompleteness([]).complete, false);
  assert.equal(assessIncidentTraceCompleteness(null).complete, false);
  assert.equal(assessIncidentTraceCompleteness([null]).complete, false);
});

test('unknown events and tampered attributes are rejected', () => {
  assert.equal(assessIncidentTraceCompleteness([record({ event_name: 'incident.evil' })]).complete, false);
  const tampered = record();
  tampered.attributes = { ...tampered.attributes, 'pixel.incident.secret': 'leak' };
  assert.equal(assessIncidentTraceCompleteness([tampered]).complete, false);
});

test('refused incident evidence must carry a bounded reason and denied outcome', () => {
  const refused = record({
    event_name: 'incident.refused',
    outcome: 'denied',
    severity: 'warning',
    attributes: { 'pixel.incident.incident_id': 'incident-001', 'pixel.incident.reason_code': 'INCIDENT_INVALID' },
  });
  assert.equal(assessIncidentTraceCompleteness([refused]).complete, true);
  const wrongOutcome = { ...refused, outcome: 'success' };
  assert.equal(assessIncidentTraceCompleteness([wrongOutcome]).complete, false);
  const missingReason = { ...refused, attributes: {} };
  assert.equal(assessIncidentTraceCompleteness([missingReason]).complete, false);
});
