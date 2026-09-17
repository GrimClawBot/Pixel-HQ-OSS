const SOURCES = new Set(['simulator', 'live']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertProvider(value, method, label) {
  if (!isRecord(value) || !SOURCES.has(value.source) || typeof value[method] !== 'function') {
    throw new TypeError(`${label} must declare simulator or live source and implement ${method}()`);
  }
  return value;
}

export function assertSchedulerJobLookupAdapter(value) {
  return assertProvider(value, 'getJob', 'Scheduler job lookup adapter');
}

export function assertOrgStateStoreAdapter(value) {
  const methods = ['put', 'get', 'list', 'listHoldsForJob', 'currentCompanyState', 'dutyFor', 'capacityFor'];
  if (!isRecord(value) || !SOURCES.has(value.source) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`Organizational State store adapter must declare simulator or live source and implement ${methods.join(', ')}`);
  }
  return value;
}

export function assertSchedulerStoreAdapter(value) {
  const methods = ['reserve', 'current', 'transition'];
  if (!isRecord(value) || !SOURCES.has(value.source) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`Scheduler store adapter must declare simulator or live source and implement ${methods.join(', ')}`);
  }
  return value;
}

export function assertExecutionRequirementProvider(value) {
  return assertProvider(value, 'resolveExecutionRequirement', 'Execution requirement provider');
}

export function assertOrgStateService(value) {
  if (!isRecord(value)
    || typeof value.evaluateExecutionInputs !== 'function'
    || typeof value.getApproval !== 'function'
    || typeof value.getDelegation !== 'function'
    || typeof value.holdsForJob !== 'function'
    || typeof value.companyState !== 'function') {
    throw new TypeError('Organizational State service must implement evaluateExecutionInputs, getApproval, getDelegation, holdsForJob, and companyState');
  }
  return value;
}
