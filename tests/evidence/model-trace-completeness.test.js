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
