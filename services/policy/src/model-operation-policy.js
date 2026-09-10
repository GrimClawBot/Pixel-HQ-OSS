import { MODEL_OPERATION_POLICY_ID } from '../../../packages/contracts/src/model-v1.js';

const ELIGIBLE = Object.freeze({
  job_type: 'system-status',
  capability: 'pixel.system-status.read',
  tool_class: 'pixel.system-status',
  target: 'pixel.platform',
});

export function evaluateModelOperationEligibility({ operation, execution } = {}) {
  const allowed = operation === 'SYSTEM_STATUS_SUMMARY'
    && execution !== null
    && typeof execution === 'object'
    && !Array.isArray(execution)
    && Object.keys(ELIGIBLE).every((key) => execution[key] === ELIGIBLE[key])
    && Object.keys(execution).length === Object.keys(ELIGIBLE).length;
  return Object.freeze({
    decision: allowed ? 'ALLOW' : 'DENY',
    reason_code: allowed ? 'OPERATION_ELIGIBLE' : 'OPERATION_INELIGIBLE',
    policy_id: MODEL_OPERATION_POLICY_ID,
  });
}
