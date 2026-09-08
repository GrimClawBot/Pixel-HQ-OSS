import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ACCESS_DECISION_EVENT_NAME,
  ACCESS_REQUEST_EVENT_NAME,
  ACCESS_SCHEMA_VERSION,
  validateAccessDecisionV1,
  validateAccessRequestV1,
  validateProtectedAppIntentV1,
} from '../../packages/contracts/src/access-v1.js';

const VALID_REQUEST = Object.freeze({
  request_id: 'access-request-0001',
  event_name: 'pixel.access.request.v1',
  schema_version: '1.0.0',
  occurred_at: '2026-09-06T14:00:00.000Z',
  environment: 'simulation',
  trace_id: '11111111111111111111111111111111',
  span_id: '1111111111111111',
  identity: {
    subject_id: 'PIXEL-PRINCIPAL',
    identity_class: 'human',
    role: 'Principal',
    verification_status: 'verified',
  },
  device: {
    device_id: 'sim-owner-device-01',
    enrollment_status: 'enrolled',
    trust_status: 'trusted',
    certificate_status: 'valid',
    risk_posture: 'acceptable',
  },
  target: {
    app_id: 'pixel-bench',
    capability: 'launch',
  },
  provenance: {
    identity_provider_contract: 'pixel.identity-context-provider.v1',
    identity_source: 'simulator',
    device_trust_provider_contract: 'pixel.device-trust-provider.v1',
    device_trust_source: 'simulator',
  },
});
const VALID_ALLOW_DECISION = Object.freeze({
  decision_id: 'access-decision-0001',
  event_name: 'pixel.access.decision.v1',
  schema_version: '1.0.0',
  decided_at: '2026-09-06T14:00:00.000Z',
  environment: 'simulation',
  trace_id: '11111111111111111111111111111111',
  span_id: '2222222222222222',
  request_id: 'access-request-0001',
  decision: 'ALLOW',
  reason_code: 'ACCESS_ALLOWED',
  target: {
    app_id: 'pixel-bench',
    capability: 'launch',
  },
  owner: {
    state: 'Ready',
    summary: 'Pixel Bench is ready to open.',
    impact: 'Your current identity and device meet Pixel access requirements.',
  },
  policy_id: 'pixel.protected-app-access.v1',
  provenance: {
    access_gate_contract: 'pixel.access-gate.v1',
  },
});

test('accepts the minimal non-authoritative Pixel Bench launch intent', () => {
  assert.deepEqual(validateProtectedAppIntentV1({
    app_id: 'pixel-bench',
    capability: 'launch',
  }), { ok: true, errors: [] });
});

test('rejects undeclared and nested launch-intent fields', () => {
  assert.deepEqual(validateProtectedAppIntentV1({
    app_id: 'pixel-bench',
    capability: 'launch',
    context: { role: 'Principal' },
  }), {
    ok: false,
    errors: ['intent contains unsupported field context'],
  });
});

test('accepts a complete server-internal access evaluation request', () => {
  assert.equal(ACCESS_REQUEST_EVENT_NAME, 'pixel.access.request.v1');
  assert.equal(ACCESS_SCHEMA_VERSION, '1.0.0');
  assert.deepEqual(validateAccessRequestV1(VALID_REQUEST), { ok: true, errors: [] });
});

test('accepts all canonical environment vocabulary values', () => {
  for (const environment of ['dev', 'simulation', 'shadow', 'canary', 'production']) {
    assert.deepEqual(validateAccessRequestV1({ ...VALID_REQUEST, environment }), {
      ok: true,
      errors: [],
    });
  }
});

test('rejects undeclared authority fields at every canonical nesting level', () => {
  const request = {
    ...VALID_REQUEST,
    grants: ['pixel-bench:launch'],
    identity: { ...VALID_REQUEST.identity, credential: 'not-allowed' },
    device: { ...VALID_REQUEST.device, certificate: { serial: 'not-allowed' } },
    target: { ...VALID_REQUEST.target, authorized: true },
    provenance: { ...VALID_REQUEST.provenance, provider_class: 'not-allowed' },
  };

  assert.deepEqual(validateAccessRequestV1(request), {
    ok: false,
    errors: [
      'access request contains unsupported field grants',
      'identity contains unsupported field credential',
      'device contains unsupported field certificate',
      'target contains unsupported field authorized',
      'provenance contains unsupported field provider_class',
    ],
  });
});

test('rejects an internally inconsistent trusted device', () => {
  const request = {
    ...VALID_REQUEST,
    device: {
      ...VALID_REQUEST.device,
      enrollment_status: 'not_enrolled',
    },
  };

  assert.deepEqual(validateAccessRequestV1(request), {
    ok: false,
    errors: ['device.trust_status trusted requires enrollment_status enrolled'],
  });
});

test('keeps normalized certificate and risk values minimal', () => {
  const request = {
    ...VALID_REQUEST,
    device: {
      ...VALID_REQUEST.device,
      certificate_status: 'certificate-chain-valid',
      risk_posture: 42,
    },
  };

  assert.deepEqual(validateAccessRequestV1(request), {
    ok: false,
    errors: [
      'device.certificate_status must be valid, not_valid, or unknown',
      'device.risk_posture must be acceptable, not_acceptable, or unknown',
    ],
  });
});

test('accepts a consistent canonical allow decision', () => {
  assert.equal(ACCESS_DECISION_EVENT_NAME, 'pixel.access.decision.v1');
  assert.deepEqual(validateAccessDecisionV1(VALID_ALLOW_DECISION), { ok: true, errors: [] });
});

test('requires Protected owner state and no Policy id for an early denial', () => {
  const decision = {
    ...VALID_ALLOW_DECISION,
    request_id: null,
    decision: 'DENY',
    reason_code: 'CLIENT_AUTHORITY_CLAIM_REJECTED',
    owner: {
      state: 'Ready',
      summary: 'Access was denied.',
      impact: 'Nothing was opened.',
    },
    policy_id: 'pixel.protected-app-access.v1',
  };

  assert.deepEqual(validateAccessDecisionV1(decision), {
    ok: false,
    errors: [
      'owner.state must be Protected when decision is DENY',
      'policy_id must be null when Policy was not evaluated',
    ],
  });
});

test('requires request and Policy linkage for every Policy-evaluated decision', () => {
  for (const decision of [
    { ...VALID_ALLOW_DECISION, request_id: null },
    {
      ...VALID_ALLOW_DECISION,
      request_id: null,
      decision: 'DENY',
      reason_code: 'DEVICE_UNTRUSTED',
      owner: {
        state: 'Protected',
        summary: 'This Pixel app is unavailable on this device.',
        impact: 'Pixel requires a trusted device before opening protected apps.',
      },
    },
  ]) {
    assert.deepEqual(validateAccessDecisionV1(decision), {
      ok: false,
      errors: ['request_id is required when Policy was evaluated'],
    });
  }
});

test('published schemas keep client intent separate from the internal request', () => {
  const intentSchema = JSON.parse(readFileSync(
    new URL('../../packages/contracts/schemas/pixel-protected-app-intent-v1.schema.json', import.meta.url),
    'utf8',
  ));
  const requestSchema = JSON.parse(readFileSync(
    new URL('../../packages/contracts/schemas/pixel-access-request-v1.schema.json', import.meta.url),
    'utf8',
  ));

  assert.deepEqual(intentSchema.required, ['app_id', 'capability']);
  assert.equal(intentSchema.additionalProperties, false);
  assert.match(requestSchema.description, /server-internal/i);
  assert.deepEqual(requestSchema.properties.environment.enum, [
    'dev',
    'simulation',
    'shadow',
    'canary',
    'production',
  ]);
});

test('published access schemas encode the runtime cross-field invariants', () => {
  const requestSchema = JSON.parse(readFileSync(
    new URL('../../packages/contracts/schemas/pixel-access-request-v1.schema.json', import.meta.url),
    'utf8',
  ));
  const decisionSchema = JSON.parse(readFileSync(
    new URL('../../packages/contracts/schemas/pixel-access-decision-v1.schema.json', import.meta.url),
    'utf8',
  ));
  const requestJson = JSON.stringify(requestSchema);
  const decisionJson = JSON.stringify(decisionSchema);
  const identifierPattern = '^[A-Za-z0-9][A-Za-z0-9._:-]*$';
  const timestampPattern = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';

  assert.equal(requestSchema.properties.request_id.pattern, identifierPattern);
  assert.equal(requestSchema.properties.occurred_at.pattern, timestampPattern);
  assert.equal(requestSchema.properties.identity.properties.subject_id.pattern, identifierPattern);
  assert.equal(requestSchema.properties.identity.properties.role.pattern, identifierPattern);
  assert.equal(requestSchema.properties.device.properties.device_id.pattern, identifierPattern);
  assert.match(requestSchema.properties.trace_id.pattern, /\?!0/);
  assert.match(requestSchema.properties.span_id.pattern, /\?!0/);
  assert.match(requestJson, /trust_status.*trusted.*enrollment_status.*enrolled/);
  assert.equal(decisionSchema.properties.decision_id.pattern, identifierPattern);
  assert.equal(decisionSchema.properties.decided_at.pattern, timestampPattern);
  assert.equal(decisionSchema.properties.request_id.pattern, identifierPattern);
  assert.match(decisionSchema.properties.trace_id.pattern, /\?!0/);
  assert.match(decisionSchema.properties.span_id.pattern, /\?!0/);
  assert.match(decisionJson, /ACCESS_ALLOWED.*Ready/);
  assert.match(decisionJson, /CLIENT_AUTHORITY_CLAIM_REJECTED.*request_id.*null.*policy_id.*null/);
});
