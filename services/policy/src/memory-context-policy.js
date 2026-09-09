const REASON_CODES = Object.freeze({
  SCOPE_MISMATCH: 'SCOPE_MISMATCH',
  RESTRICTED_SCOPE_DENIED: 'RESTRICTED_SCOPE_DENIED',
});

export function evaluateMemoryContextAccess({ record, departmentRef }) {
  if (record?.scope?.scope_type !== 'DEPARTMENT'
    || record.scope.department_ref !== departmentRef) {
    return Object.freeze({
      decision: 'DENY',
      reason_code: record?.handling === 'RESTRICTED'
        ? REASON_CODES.RESTRICTED_SCOPE_DENIED
        : REASON_CODES.SCOPE_MISMATCH,
    });
  }
  return Object.freeze({ decision: 'ALLOW' });
}
