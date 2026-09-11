import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateModelOperationEligibility } from '../../services/policy/src/model-operation-policy.js';
import { selectAlphaModelRoute } from '../../services/policy/src/model-routing-policy.js';

const TUPLE = Object.freeze({
  job_type: 'system-status', capability: 'pixel.system-status.read',
  tool_class: 'pixel.system-status', target: 'pixel.platform',
});

test('operation eligibility allows only the exact canonical SYSTEM_STATUS_SUMMARY tuple', () => {
  assert.deepEqual(evaluateModelOperationEligibility({ operation: 'SYSTEM_STATUS_SUMMARY', execution: TUPLE }), {
    decision: 'ALLOW', reason_code: 'OPERATION_ELIGIBLE', policy_id: 'pixel.model-operation.alpha.v1',
  });
  for (const execution of [
    { ...TUPLE, capability: 'pixel.system-status.raw.read' },
    { ...TUPLE, tool_class: 'pixel.other' },
    { ...TUPLE, target: 'pixel.other' },
    { ...TUPLE, job_type: 'other' },
  ]) {
    assert.deepEqual(evaluateModelOperationEligibility({ operation: 'SYSTEM_STATUS_SUMMARY', execution }), {
      decision: 'DENY', reason_code: 'OPERATION_INELIGIBLE', policy_id: 'pixel.model-operation.alpha.v1',
    });
  }
  assert.equal(evaluateModelOperationEligibility({ operation: 'CALLER_PROMPT', execution: TUPLE }).decision, 'DENY');
});

test('routing uses only environment and has no fallback', () => {
  assert.deepEqual(selectAlphaModelRoute('simulation'), {
    decision: 'ROUTE', reason_code: 'ROUTE_SELECTED', policy_id: 'pixel.model-routing.alpha.v1',
    placement: { runtime_id: 'pixel.simulator.model-runtime-a', model_id: 'pixel.fake-model-a.v1', source: 'simulator' },
    budget: { max_input_token_units: 256, max_output_token_units: 64, max_output_chars: 512 },
  });
  assert.deepEqual(selectAlphaModelRoute('dev'), {
    decision: 'ROUTE', reason_code: 'ROUTE_SELECTED', policy_id: 'pixel.model-routing.alpha.v1',
    placement: { runtime_id: 'pixel.simulator.model-runtime-b', model_id: 'pixel.fake-model-b.v1', source: 'simulator' },
    budget: { max_input_token_units: 512, max_output_token_units: 96, max_output_chars: 512 },
  });
  for (const environment of ['shadow', 'canary', 'production', 'unknown']) {
    assert.deepEqual(selectAlphaModelRoute(environment), {
      decision: 'DENY', reason_code: 'ROUTE_UNSUPPORTED', policy_id: 'pixel.model-routing.alpha.v1',
      placement: null, budget: null,
    });
  }
});
