const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ACCESS_DECISIONS = new Set(['ALLOW', 'DENY']);
const ACCESS_ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const ACCESS_PROVIDER_SOURCES = new Set(['simulator', 'live']);
const ACCESS_VERIFICATION_STATUSES = new Set(['verified', 'not_verified', 'unknown']);
const ACCESS_ENROLLMENT_STATUSES = new Set(['enrolled', 'not_enrolled', 'unknown']);
const ACCESS_TRUST_STATUSES = new Set(['trusted', 'untrusted', 'revoked', 'unknown']);
const ACCESS_CERTIFICATE_STATUSES = new Set(['valid', 'not_valid', 'unknown']);
const ACCESS_RISK_POSTURES = new Set(['acceptable', 'not_acceptable', 'unknown']);
const ACCESS_FAILURE_KINDS = new Set(['exception', 'invalid_result']);
const ACCESS_CLAIM_CATEGORIES = new Set([
  'authorization_decision', 'certificate_status', 'device_identity', 'device_trust',
  'enrollment', 'environment', 'identity', 'permissions', 'risk_posture', 'role',
  'verification_state', 'unknown',
]);
const ACCESS_CLAIM_LOCATIONS = new Set(['body', 'header', 'query', 'unknown']);
const ACCESS_REASON_CODES = new Set([
  'ACCESS_ALLOWED', 'IDENTITY_NOT_VERIFIED', 'DEVICE_NOT_ENROLLED', 'DEVICE_REVOKED',
  'DEVICE_UNTRUSTED', 'CERTIFICATE_NOT_VALID', 'RISK_NOT_ACCEPTABLE', 'APP_NOT_PERMITTED',
  'CLIENT_AUTHORITY_CLAIM_REJECTED', 'CLIENT_INTENT_INVALID',
  'IDENTITY_CONTEXT_UNAVAILABLE', 'DEVICE_TRUST_CONTEXT_UNAVAILABLE', 'ACCESS_CONTEXT_INVALID',
]);

const DEVICE_STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'adapter.snapshot.received',
    parentName: null,
    outcome: 'success',
    attributes: Object.freeze([
      'pixel.device.role_id',
      'pixel.event.schema_version',
      'pixel.adapter.id',
      'pixel.adapter.source',
    ]),
  }),
  Object.freeze({
    name: 'contract.device_snapshot.validated',
    parentName: 'adapter.snapshot.received',
    outcome: 'success',
    attributes: Object.freeze([
      'pixel.event.name',
      'pixel.event.schema_version',
      'pixel.device.role_id',
    ]),
  }),
  Object.freeze({
    name: 'state.device.projected',
    parentName: 'contract.device_snapshot.validated',
    outcome: 'success',
    attributes: Object.freeze([
      'pixel.device.role_id',
      'pixel.device.health_state',
      'pixel.owner.state',
    ]),
  }),
  Object.freeze({
    name: 'api.response.sent',
    parentName: 'state.device.projected',
    allowMultiple: true,
    outcome: 'success',
    matchAttributes: Object.freeze({
      'http.route': '/api/v1/devices/{role_id}',
    }),
    attributes: Object.freeze([
      'http.request.method',
      'http.route',
      'http.response.status_code',
    ]),
  }),
]);

const ATTENTION_STAGE_DEFINITION = Object.freeze({
  name: 'attention.item.upserted',
  parentName: 'state.device.projected',
  outcome: 'success',
  attributes: Object.freeze([
    'pixel.device.role_id',
    'pixel.attention.deduplication_key',
    'pixel.attention.occurrence_count',
  ]),
});

const ATTENTION_API_STAGE_DEFINITION = Object.freeze({
  name: 'api.response.sent',
  parentName: 'attention.item.upserted',
  allowMultiple: true,
  required: false,
  outcome: 'success',
  matchAttributes: Object.freeze({
    'http.route': '/api/v1/attention',
  }),
  attributes: Object.freeze([
    'http.request.method',
    'http.route',
    'http.response.status_code',
  ]),
});

const POLICY_DENIAL_STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'policy.data_boundary.evaluated',
    parentName: null,
    outcome: 'denied',
    attributes: Object.freeze([
      'pixel.identity.subject_id',
      'pixel.identity.department',
      'pixel.policy.id',
      'pixel.policy.decision',
      'pixel.policy.action',
      'pixel.data.domain',
      'pixel.data.classification',
    ]),
  }),
  Object.freeze({
    name: 'api.request.denied',
    parentName: 'policy.data_boundary.evaluated',
    outcome: 'denied',
    attributes: Object.freeze([
      'http.request.method',
      'http.route',
      'http.response.status_code',
    ]),
  }),
]);

const ACCESS_STAGES = Object.freeze({
  root: Object.freeze({
    name: 'access.evaluation.started',
    parentName: null,
    outcome: 'success',
    attributes: Object.freeze(['pixel.access.gate_contract', 'pixel.environment']),
  }),
  identity: Object.freeze({
    name: 'identity.context.resolved',
    parentName: 'access.evaluation.started',
    outcome: 'success',
    attributes: Object.freeze([
      'pixel.identity.subject_id', 'pixel.identity.verification_status',
      'pixel.identity.role', 'pixel.provider.source',
    ]),
  }),
  device: Object.freeze({
    name: 'device_trust.context.resolved',
    parentName: 'identity.context.resolved',
    outcome: 'success',
    attributes: Object.freeze([
      'pixel.device.id', 'pixel.device.enrollment_status', 'pixel.device.trust_status',
      'pixel.device.certificate_status', 'pixel.device.risk_posture', 'pixel.provider.source',
    ]),
  }),
  contract: Object.freeze({
    name: 'contract.access_request.validated',
    parentName: 'device_trust.context.resolved',
    outcome: 'success',
    attributes: Object.freeze([
      'pixel.event.name', 'pixel.event.schema_version', 'pixel.environment',
      'pixel.app.id', 'pixel.app.capability',
    ]),
  }),
  policy: Object.freeze({
    name: 'policy.protected_app.evaluated',
    parentName: 'contract.access_request.validated',
    attributes: Object.freeze([
      'pixel.policy.id', 'pixel.policy.decision', 'pixel.access.reason_code',
      'pixel.app.id', 'pixel.app.capability',
    ]),
  }),
  decision: Object.freeze({
    name: 'access.decision.issued',
    attributes: Object.freeze([
      'pixel.access.decision', 'pixel.access.reason_code', 'pixel.app.id', 'pixel.app.capability',
    ]),
  }),
  apiSuccess: Object.freeze({
    name: 'api.response.sent',
    parentName: 'access.decision.issued',
    outcome: 'success',
    attributes: Object.freeze(['http.request.method', 'http.route', 'http.response.status_code']),
  }),
  apiDenied: Object.freeze({
    name: 'api.request.denied',
    parentName: 'access.decision.issued',
    outcome: 'denied',
    attributes: Object.freeze(['http.request.method', 'http.route', 'http.response.status_code']),
  }),
  claim: Object.freeze({
    name: 'client.authority_claim.detected',
    parentName: 'access.evaluation.started',
    outcome: 'denied',
    attributes: Object.freeze([
      'pixel.security.authority_claim_categories', 'pixel.security.transport_locations',
    ]),
  }),
  intent: Object.freeze({
    name: 'client.intent.rejected',
    parentName: 'access.evaluation.started',
    outcome: 'denied',
    attributes: Object.freeze(['pixel.validation.error_count']),
  }),
  identityFailure: Object.freeze({
    name: 'identity.context.resolution_failed',
    parentName: 'access.evaluation.started',
    outcome: 'denied',
    attributes: Object.freeze(['pixel.provider.source', 'pixel.failure.kind']),
  }),
  deviceFailure: Object.freeze({
    name: 'device_trust.context.resolution_failed',
    parentName: 'identity.context.resolved',
    outcome: 'denied',
    attributes: Object.freeze(['pixel.provider.source', 'pixel.failure.kind']),
  }),
  contractFailure: Object.freeze({
    name: 'contract.access_request.validation_failed',
    parentName: 'device_trust.context.resolved',
    outcome: 'denied',
    attributes: Object.freeze(['pixel.validation.error_count']),
  }),
});

function isNonzeroMatch(value, pattern) {
  return typeof value === 'string' && pattern.test(value) && !/^0+$/.test(value);
}

function isIsoTimestamp(value) {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function matchesStage(record, definition) {
  if (record.event_name !== definition.name) {
    return false;
  }
  return Object.entries(definition.matchAttributes ?? {}).every(
    ([attribute, expected]) => record.attributes?.[attribute] === expected,
  );
}

function assess(records, stageDefinitions) {
  const stageRecords = stageDefinitions.map((definition) => (
    records.filter((record) => matchesStage(record, definition))
  ));
  const missingStages = stageDefinitions
    .filter((definition, index) => definition.required !== false && stageRecords[index].length === 0)
    .map(({ name }) => name);
  const validationErrors = [];
  const traceIds = new Set(records.map((record) => record.trace_id));
  const spanIds = records.map((record) => record.span_id);
  const knownSpanIds = new Set(spanIds);
  const brokenParentSpanIds = [...new Set(
    records
      .map((record) => record.parent_span_id)
      .filter((parentSpanId) => parentSpanId !== null && !knownSpanIds.has(parentSpanId)),
  )];

  if (records.some((record) => !isNonzeroMatch(record.trace_id, TRACE_ID))) {
    validationErrors.push('trace_id values must be valid non-zero W3C trace identifiers');
  }
  if (traceIds.size > 1) {
    validationErrors.push('records must share one trace_id');
  }
  if (records.some((record) => !isNonzeroMatch(record.span_id, SPAN_ID))) {
    validationErrors.push('span_id values must be valid non-zero W3C span identifiers');
  }
  if (knownSpanIds.size !== spanIds.length) {
    validationErrors.push('span_id values must be unique');
  }
  if (records.some((record) => !isIsoTimestamp(record.timestamp))) {
    validationErrors.push('records must have ISO 8601 UTC timestamps');
  }
  if (records.some((record) => typeof record.service_name !== 'string' || record.service_name.length === 0)) {
    validationErrors.push('records must name an emitting service');
  }

  for (let index = 0; index < stageDefinitions.length; index += 1) {
    const definition = stageDefinitions[index];
    const matches = stageRecords[index];
    if (matches.length > 1 && definition.allowMultiple !== true) {
      validationErrors.push(`${definition.name} must occur exactly once`);
    }
    if (matches.length === 0) {
      continue;
    }
    for (const record of matches) {
      if (record.outcome !== definition.outcome) {
        validationErrors.push(`${definition.name} outcome must be ${definition.outcome}`);
      }
      for (const attribute of definition.attributes) {
        if (
          record.attributes === null
          || typeof record.attributes !== 'object'
          || !Object.hasOwn(record.attributes, attribute)
        ) {
          validationErrors.push(`${definition.name} requires attribute ${attribute}`);
        }
      }
    }
  }

  if (missingStages.length === 0) {
    let stagesOutOfOrder = false;
    for (let index = 0; index < stageDefinitions.length; index += 1) {
      const definition = stageDefinitions[index];
      const matches = stageRecords[index];
      if (definition.parentName === null) {
        if (matches.some((record) => record.parent_span_id !== null)) {
          validationErrors.push(`${definition.name} must be the trace root`);
        }
        continue;
      }

      const parentIndex = stageDefinitions.findIndex(
        (candidate) => candidate.name === definition.parentName,
      );
      const parentRecord = stageRecords[parentIndex]?.[0];
      if (!parentRecord) {
        continue;
      }
      for (const record of matches) {
        if (records.indexOf(record) <= records.indexOf(parentRecord)) {
          stagesOutOfOrder = true;
        }
        if (record.parent_span_id !== parentRecord.span_id) {
          validationErrors.push(`${definition.name} must link to ${definition.parentName}`);
        }
      }
    }
    if (stagesOutOfOrder) {
      validationErrors.push('required stages must be in canonical order');
    }
  }

  return {
    complete: missingStages.length === 0
      && brokenParentSpanIds.length === 0
      && validationErrors.length === 0,
    missing_stages: missingStages,
    broken_parent_span_ids: brokenParentSpanIds,
    validation_errors: validationErrors,
  };
}

export function assessDeviceTraceCompleteness(records) {
  const projected = records.find((record) => record.event_name === 'state.device.projected');
  const stageDefinitions = projected?.attributes?.['pixel.device.health_state'] === 'needs_attention'
    ? [
        ...DEVICE_STAGE_DEFINITIONS.slice(0, 3),
        ATTENTION_STAGE_DEFINITION,
        DEVICE_STAGE_DEFINITIONS[3],
        ATTENTION_API_STAGE_DEFINITION,
      ]
    : DEVICE_STAGE_DEFINITIONS;
  return assess(records, stageDefinitions);
}

export function assessPolicyDenialTraceCompleteness(records) {
  return assess(records, POLICY_DENIAL_STAGE_DEFINITIONS);
}

function accessShape(reasonCode, decision) {
  if (reasonCode === 'CLIENT_AUTHORITY_CLAIM_REJECTED') {
    return [
      ACCESS_STAGES.root,
      ACCESS_STAGES.claim,
      { ...ACCESS_STAGES.decision, parentName: ACCESS_STAGES.claim.name, outcome: 'denied' },
      ACCESS_STAGES.apiDenied,
    ];
  }
  if (reasonCode === 'CLIENT_INTENT_INVALID') {
    return [
      ACCESS_STAGES.root,
      ACCESS_STAGES.intent,
      { ...ACCESS_STAGES.decision, parentName: ACCESS_STAGES.intent.name, outcome: 'denied' },
      ACCESS_STAGES.apiDenied,
    ];
  }
  if (reasonCode === 'IDENTITY_CONTEXT_UNAVAILABLE') {
    return [
      ACCESS_STAGES.root,
      ACCESS_STAGES.identityFailure,
      { ...ACCESS_STAGES.decision, parentName: ACCESS_STAGES.identityFailure.name, outcome: 'denied' },
      ACCESS_STAGES.apiDenied,
    ];
  }
  if (reasonCode === 'DEVICE_TRUST_CONTEXT_UNAVAILABLE') {
    return [
      ACCESS_STAGES.root,
      ACCESS_STAGES.identity,
      ACCESS_STAGES.deviceFailure,
      { ...ACCESS_STAGES.decision, parentName: ACCESS_STAGES.deviceFailure.name, outcome: 'denied' },
      ACCESS_STAGES.apiDenied,
    ];
  }
  if (reasonCode === 'ACCESS_CONTEXT_INVALID') {
    return [
      ACCESS_STAGES.root,
      ACCESS_STAGES.identity,
      ACCESS_STAGES.device,
      ACCESS_STAGES.contractFailure,
      { ...ACCESS_STAGES.decision, parentName: ACCESS_STAGES.contractFailure.name, outcome: 'denied' },
      ACCESS_STAGES.apiDenied,
    ];
  }
  const outcome = decision === 'ALLOW' ? 'success' : 'denied';
  return [
    ACCESS_STAGES.root,
    ACCESS_STAGES.identity,
    ACCESS_STAGES.device,
    ACCESS_STAGES.contract,
    { ...ACCESS_STAGES.policy, outcome },
    { ...ACCESS_STAGES.decision, parentName: ACCESS_STAGES.policy.name, outcome },
    decision === 'ALLOW' ? ACCESS_STAGES.apiSuccess : ACCESS_STAGES.apiDenied,
  ];
}

function commaSeparatedValuesAreBounded(value, allowed) {
  return typeof value === 'string'
    && value.length > 0
    && value.split(',').every((item) => allowed.has(item));
}

function accessSemanticErrors(records, definitions, decision, reasonCode) {
  const errors = [];
  const root = records.find((record) => record.event_name === ACCESS_STAGES.root.name);
  const contract = records.find((record) => record.event_name === ACCESS_STAGES.contract.name);
  const policy = records.find((record) => record.event_name === ACCESS_STAGES.policy.name);
  const api = records.find((record) => (
    record.event_name === ACCESS_STAGES.apiSuccess.name
    || record.event_name === ACCESS_STAGES.apiDenied.name
  ));

  for (const record of records) {
    const definition = definitions.find(({ name }) => name === record.event_name);
    if (!definition || record.attributes === null || typeof record.attributes !== 'object') continue;
    const allowedAttributes = new Set(definition.attributes);
    if (Object.keys(record.attributes).some((attribute) => !allowedAttributes.has(attribute))) {
      errors.push(`${record.event_name} contains unsupported evidence attributes`);
    }
    const expectedService = record.event_name === ACCESS_STAGES.apiSuccess.name
      || record.event_name === ACCESS_STAGES.apiDenied.name
      ? 'pixel.access-gate-api'
      : 'pixel.access-gate';
    if (record.service_name !== expectedService) {
      errors.push(`${record.event_name} must name its canonical emitting service`);
    }
  }

  if (!ACCESS_DECISIONS.has(decision)) errors.push('access decision attribute must be ALLOW or DENY');
  if (!ACCESS_REASON_CODES.has(reasonCode)) errors.push('access reason attribute must be canonical');
  if ((decision === 'ALLOW') !== (reasonCode === 'ACCESS_ALLOWED')) {
    errors.push('access decision and reason attributes must agree');
  }
  if (
    root?.attributes?.['pixel.access.gate_contract'] !== 'pixel.access-gate.v1'
    || !ACCESS_ENVIRONMENTS.has(root?.attributes?.['pixel.environment'])
  ) {
    errors.push('access root attributes must use bounded contract and environment values');
  }
  for (const providerRecord of records.filter((record) => (
    record.event_name === ACCESS_STAGES.identity.name
    || record.event_name === ACCESS_STAGES.device.name
    || record.event_name === ACCESS_STAGES.identityFailure.name
    || record.event_name === ACCESS_STAGES.deviceFailure.name
  ))) {
    if (!ACCESS_PROVIDER_SOURCES.has(providerRecord.attributes?.['pixel.provider.source'])) {
      errors.push('access provider source must be simulator or live');
    }
  }
  const identity = records.find((record) => record.event_name === ACCESS_STAGES.identity.name);
  if (identity && !ACCESS_VERIFICATION_STATUSES.has(
    identity.attributes?.['pixel.identity.verification_status'],
  )) {
    errors.push('identity evidence must use a bounded verification status');
  }
  const device = records.find((record) => record.event_name === ACCESS_STAGES.device.name);
  if (device && (
    !ACCESS_ENROLLMENT_STATUSES.has(device.attributes?.['pixel.device.enrollment_status'])
    || !ACCESS_TRUST_STATUSES.has(device.attributes?.['pixel.device.trust_status'])
    || !ACCESS_CERTIFICATE_STATUSES.has(device.attributes?.['pixel.device.certificate_status'])
    || !ACCESS_RISK_POSTURES.has(device.attributes?.['pixel.device.risk_posture'])
  )) {
    errors.push('device-trust evidence must use bounded normalized states');
  }
  for (const failure of records.filter((record) => (
    record.event_name === ACCESS_STAGES.identityFailure.name
    || record.event_name === ACCESS_STAGES.deviceFailure.name
  ))) {
    if (!ACCESS_FAILURE_KINDS.has(failure.attributes?.['pixel.failure.kind'])) {
      errors.push('provider-failure evidence must use a bounded failure kind');
    }
  }
  const claim = records.find((record) => record.event_name === ACCESS_STAGES.claim.name);
  if (claim && (
    !commaSeparatedValuesAreBounded(
      claim.attributes?.['pixel.security.authority_claim_categories'],
      ACCESS_CLAIM_CATEGORIES,
    )
    || !commaSeparatedValuesAreBounded(
      claim.attributes?.['pixel.security.transport_locations'],
      ACCESS_CLAIM_LOCATIONS,
    )
  )) {
    errors.push('client authority-claim evidence must use bounded labels');
  }
  if (contract && root?.attributes?.['pixel.environment'] !== contract.attributes?.['pixel.environment']) {
    errors.push('access root and canonical request environment must agree');
  }
  if (contract && (
    contract.attributes?.['pixel.event.name'] !== 'pixel.access.request.v1'
    || contract.attributes?.['pixel.event.schema_version'] !== '1.0.0'
  )) {
    errors.push('canonical request evidence must identify the v1 access contract');
  }
  for (const targetRecord of records.filter((record) => (
    Object.hasOwn(record.attributes ?? {}, 'pixel.app.id')
    || Object.hasOwn(record.attributes ?? {}, 'pixel.app.capability')
  ))) {
    if (
      targetRecord.attributes?.['pixel.app.id'] !== 'pixel-bench'
      || targetRecord.attributes?.['pixel.app.capability'] !== 'launch'
    ) {
      errors.push('access target evidence must identify the protected Pixel Bench launch capability');
    }
  }
  if (policy && (
    policy.attributes?.['pixel.policy.id'] !== 'pixel.protected-app-access.v1'
    || policy.attributes?.['pixel.policy.decision'] !== decision
    || policy.attributes?.['pixel.access.reason_code'] !== reasonCode
  )) {
    errors.push('Policy evidence must agree with the issued decision');
  }
  if (api && (
    api.attributes?.['http.request.method'] !== 'POST'
    || api.attributes?.['http.route'] !== '/api/v1/access/decisions'
    || api.attributes?.['http.response.status_code'] !== (decision === 'ALLOW' ? 200 : 403)
  )) {
    errors.push('API evidence must agree with the issued decision');
  }
  return errors;
}

export function assessAccessTraceCompleteness(records) {
  const decisionRecords = records.filter((record) => record.event_name === 'access.decision.issued');
  if (decisionRecords.length !== 1) {
    const base = assess(records, [ACCESS_STAGES.root, ACCESS_STAGES.decision]);
    return {
      ...base,
      complete: false,
      validation_errors: [...base.validation_errors, 'access trace must contain exactly one decision'],
    };
  }

  const decisionRecord = decisionRecords[0];
  const reasonCode = decisionRecord.attributes?.['pixel.access.reason_code'];
  const decision = decisionRecord.attributes?.['pixel.access.decision'];
  const definitions = accessShape(reasonCode, decision);
  const assessment = assess(records, definitions);
  const expectedNames = new Set(definitions.map(({ name }) => name));
  const unexpected = records.some((record) => !expectedNames.has(record.event_name));
  const semanticErrors = accessSemanticErrors(records, definitions, decision, reasonCode);
  if (!unexpected && semanticErrors.length === 0) return assessment;
  return {
    ...assessment,
    complete: false,
    validation_errors: [
      ...assessment.validation_errors,
      ...semanticErrors,
      ...(unexpected ? [`trace contains stages impossible for ${reasonCode}`] : []),
    ],
  };
}
