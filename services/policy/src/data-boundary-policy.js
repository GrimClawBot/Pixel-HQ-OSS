const POLICY_ID = 'pixel.department-data-boundary.v1';

function decision(decisionValue, reason) {
  return {
    decision: decisionValue,
    policy_id: POLICY_ID,
    reason,
  };
}

export function evaluateDataAccess({ requester, action, resource }) {
  if (
    !requester
    || typeof requester.subject_id !== 'string'
    || typeof requester.department !== 'string'
  ) {
    return decision('DENY', 'Requester identity and department are required.');
  }

  if (
    resource?.domain === 'Finance & Opportunity'
    && resource?.data_classification === 'RESTRICTED'
    && requester.department !== 'Finance & Opportunity'
  ) {
    return decision('DENY', `Raw Finance data is not available to ${requester.department}.`);
  }

  if (!Array.isArray(requester.grants) || !requester.grants.includes(action)) {
    return decision('DENY', 'The requested capability is not granted to this requester.');
  }

  return decision('ALLOW', 'The trusted requester context permits this action.');
}
