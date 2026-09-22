import assert from 'node:assert/strict';
import test from 'node:test';

import { assessModelTraceCompleteness } from '../../packages/telemetry/src/model-trace-completeness.js';

test('empty model evidence is incomplete with bounded diagnostics', () => {
  assert.deepEqual(assessModelTraceCompleteness([]), {
    complete: false,
    missing: ['job.submission.received'],
    errors: ['trace has no evidence'],
  });
});

test('model completeness rejects malformed records without throwing or echoing content', () => {
  const assessment = assessModelTraceCompleteness([{
    trace_id: { secret: 'do not echo' }, span_id: null, parent_span_id: null,
    service_name: 'attacker', event_name: 'model.invocation.created',
    outcome: 'success', severity: 'info', attributes: { output: 'private model text' },
  }]);
  assert.equal(assessment.complete, false);
  assert.equal(JSON.stringify(assessment).includes('private model text'), false);
  assert.ok(assessment.errors.length <= 32);
});

test('null or non-object evidence records produce incomplete assessments without throwing', () => {
  for (const records of [[null], [null, { event_name: 'model.invocation.created' }], ['record']]) {
    const assessment = assessModelTraceCompleteness(records);
    assert.equal(assessment.complete, false);
    assert.equal(JSON.stringify(assessment).includes('Cannot'), false);
  }
});

test('a rejected transition may never parent another rejected transition', () => {
  const root = {
    trace_id: 'a'.repeat(31) + 'b', span_id: '1'.repeat(16), parent_span_id: null,
    service_name: 'pixel.relay', event_name: 'job.submission.received',
    outcome: 'success', severity: 'info',
    attributes: { 'pixel.environment': 'simulation', 'pixel.relay.contract': 'pixel.relay.v1' },
  };
  const rejected = {
    ...root, span_id: '2'.repeat(16), parent_span_id: '1'.repeat(16),
    event_name: 'relay.transition.rejected', outcome: 'denied', severity: 'warning',
    attributes: { 'pixel.job.id': 'job-001', 'pixel.job.current_state': 'ACCEPTED', 'pixel.job.attempted_state': 'RUNNING', 'pixel.job.reason_code': 'EXECUTION_STARTED' },
  };
  // Canonical parentage: the refusal references the canonical submission span.
  const wellParented = assessModelTraceCompleteness([root, rejected]);
  assert.equal(wellParented.errors.includes('relay.transition.rejected is not parented to a preceding canonical model span'), false, JSON.stringify(wellParented.errors));

  // Rejection-to-rejection parentage is never complete evidence: the second
  // refusal must reference a canonical (non-rejection) span instead.
  const chained = {
    ...rejected, span_id: '3'.repeat(16), parent_span_id: '2'.repeat(16),
  };
  const assessment = assessModelTraceCompleteness([root, rejected, chained]);
  assert.equal(assessment.complete, false);
  assert.equal(assessment.errors.includes('relay.transition.rejected is not parented to a preceding canonical model span'), true, JSON.stringify(assessment.errors));
});
