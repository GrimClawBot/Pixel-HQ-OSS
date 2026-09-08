const POLICY_ID = 'pixel.protected-app-access.v1';

function result(decision, reasonCode) {
  return Object.freeze({ decision, policy_id: POLICY_ID, reason_code: reasonCode });
}

export function evaluateProtectedAppAccess(request) {
  if (request?.identity?.verification_status !== 'verified') {
    return result('DENY', 'IDENTITY_NOT_VERIFIED');
  }
  if (request?.device?.enrollment_status !== 'enrolled') {
    return result('DENY', 'DEVICE_NOT_ENROLLED');
  }
  if (request?.device?.trust_status === 'revoked') {
    return result('DENY', 'DEVICE_REVOKED');
  }
  if (request?.device?.trust_status !== 'trusted') {
    return result('DENY', 'DEVICE_UNTRUSTED');
  }
  if (request?.device?.certificate_status !== 'valid') {
    return result('DENY', 'CERTIFICATE_NOT_VALID');
  }
  if (request?.device?.risk_posture !== 'acceptable') {
    return result('DENY', 'RISK_NOT_ACCEPTABLE');
  }
  if (
    request?.identity?.role !== 'Principal'
    || request?.target?.app_id !== 'pixel-bench'
    || request?.target?.capability !== 'launch'
  ) {
    return result('DENY', 'APP_NOT_PERMITTED');
  }
  return result('ALLOW', 'ACCESS_ALLOWED');
}
