import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorDeviceTrustProvider } from '../../adapters/simulator/src/device-trust-simulator-provider.js';
import { SimulatorIdentityProvider } from '../../adapters/simulator/src/identity-simulator-provider.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { AccessGate } from '../../services/access-gate/src/access-gate.js';
import { evaluateProtectedAppAccess } from '../../services/policy/src/protected-app-policy.js';

const NOW = '2026-09-06T14:00:00.000Z';
const INTENT = Object.freeze({ app_id: 'pixel-bench', capability: 'launch' });

function createIds(seed = 100) {
  let event = seed;
  let span = seed;
  let trace = seed;
  return {
    nextEventId: () => `access-${String(++event).padStart(6, '0')}`,
    nextSpanId: () => (++span).toString(16).padStart(16, '0'),
    nextTraceId: () => (++trace).toString(16).padStart(32, '0'),
  };
}

function createGate({
  identityProvider = new SimulatorIdentityProvider(),
  deviceTrustProvider = new SimulatorDeviceTrustProvider(),
  environment = 'simulation',
  seed = 100,
} = {}) {
  const ids = createIds(seed);
  const evidence = new EvidenceRecorder({ clock: () => NOW });
  const gate = new AccessGate({
    identityProvider,
    deviceTrustProvider,
    environment,
    evidence,
    ids,
    clock: () => NOW,
  });
  return { deviceTrustProvider, evidence, gate };
}

test('trusted Principal and trusted enrolled device receive ALLOW', async () => {
  const { gate } = createGate();

  const decision = await gate.evaluate({ intent: INTENT });

  assert.equal(decision.decision, 'ALLOW');
  assert.equal(decision.reason_code, 'ACCESS_ALLOWED');
  assert.equal(decision.owner.state, 'Ready');
  assert.equal(decision.environment, 'simulation');
  assert.equal(decision.policy_id, 'pixel.protected-app-access.v1');
  assert.equal(Object.isFrozen(decision), true);
});
test('verified identity cannot bypass untrusted or unknown device trust', async (t) => {
  for (const trustStatus of ['untrusted', 'unknown']) {
    await t.test(trustStatus, async () => {
      const { gate } = createGate({
        deviceTrustProvider: new SimulatorDeviceTrustProvider({ trustStatus }),
      });

      const decision = await gate.evaluate({ intent: INTENT });

      assert.equal(decision.decision, 'DENY');
      assert.equal(decision.reason_code, 'DEVICE_UNTRUSTED');
      assert.equal(decision.owner.state, 'Protected');
    });
  }
});

test('server-side revocation removes eligibility on the next evaluation', async () => {
  const runtime = createGate();
  const before = await runtime.gate.evaluate({ intent: INTENT });

  runtime.deviceTrustProvider.revoke();
  const after = await runtime.gate.evaluate({ intent: INTENT });

  assert.equal(before.decision, 'ALLOW');
  assert.equal(after.decision, 'DENY');
  assert.equal(after.reason_code, 'DEVICE_REVOKED');
  assert.notEqual(after.trace_id, before.trace_id);
  assert.notEqual(after.decision_id, before.decision_id);
});

test('Policy applies deterministic fail-closed reason precedence', () => {
  const base = {
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
    target: INTENT,
  };
  const cases = [
    [{ ...base, identity: { ...base.identity, verification_status: 'unknown' } }, 'IDENTITY_NOT_VERIFIED'],
    [{ ...base, device: { ...base.device, enrollment_status: 'not_enrolled', trust_status: 'untrusted' } }, 'DEVICE_NOT_ENROLLED'],
    [{ ...base, device: { ...base.device, trust_status: 'revoked' } }, 'DEVICE_REVOKED'],
    [{ ...base, device: { ...base.device, trust_status: 'untrusted' } }, 'DEVICE_UNTRUSTED'],
    [{ ...base, device: { ...base.device, certificate_status: 'unknown' } }, 'CERTIFICATE_NOT_VALID'],
    [{ ...base, device: { ...base.device, risk_posture: 'unknown' } }, 'RISK_NOT_ACCEPTABLE'],
    [{ ...base, identity: { ...base.identity, role: 'Engineering' } }, 'APP_NOT_PERMITTED'],
  ];

  for (const [request, reasonCode] of cases) {
    assert.deepEqual(evaluateProtectedAppAccess(request), {
      decision: 'DENY',
      policy_id: 'pixel.protected-app-access.v1',
      reason_code: reasonCode,
    });
  }
});

test('client authority claims are denied before provider resolution', async () => {
  const { evidence, gate } = createGate();

  const decision = await gate.evaluate({
    intent: INTENT,
    authorityClaimAttempt: {
      categories: ['role', 'device_trust'],
      locations: ['header', 'body'],
    },
  });

  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason_code, 'CLIENT_AUTHORITY_CLAIM_REJECTED');
  assert.equal(decision.request_id, null);
  assert.equal(decision.policy_id, null);
  assert.deepEqual(
    evidence.forTrace(decision.trace_id).map((record) => record.event_name),
    ['access.evaluation.started', 'client.authority_claim.detected', 'access.decision.issued'],
  );
});

test('authority-claim evidence remains bounded when the shared gate is called directly', async () => {
  const { evidence, gate } = createGate();
  const attackerValue = 'attacker-controlled-evidence-value';

  const decision = await gate.evaluate({
    intent: INTENT,
    authorityClaimAttempt: {
      categories: ['role', attackerValue],
      locations: ['body', attackerValue],
    },
  });

  assert.equal(decision.reason_code, 'CLIENT_AUTHORITY_CLAIM_REJECTED');
  const serialized = JSON.stringify(evidence.forTrace(decision.trace_id));
  assert.equal(serialized.includes(attackerValue), false);
  assert.match(serialized, /role/);
  assert.match(serialized, /body/);
});

test('identity provider failure and invalid output fail closed without device resolution', async (t) => {
  for (const identityProvider of [
    { source: 'live', async resolveIdentity() { throw new Error('sensitive provider failure'); } },
    { source: 'live', async resolveIdentity() { return { subject_id: 'incomplete' }; } },
  ]) {
    await t.test('provider outcome', async () => {
      const { evidence, gate } = createGate({
        identityProvider,
        deviceTrustProvider: {
          source: 'live',
          async resolveDeviceTrust() { throw new Error('must not be reached'); },
        },
        environment: 'shadow',
      });

      const decision = await gate.evaluate({ intent: INTENT });

      assert.equal(decision.decision, 'DENY');
      assert.equal(decision.reason_code, 'IDENTITY_CONTEXT_UNAVAILABLE');
      assert.deepEqual(
        evidence.forTrace(decision.trace_id).map((record) => record.event_name),
        ['access.evaluation.started', 'identity.context.resolution_failed', 'access.decision.issued'],
      );
      assert.equal(JSON.stringify(evidence.all()).includes('sensitive provider failure'), false);
    });
  }
});

test('provider-owned identity mutation cannot change the validated access snapshot', async () => {
  const identity = {
    subject_id: 'PIXEL-PRINCIPAL', identity_class: 'human', role: 'Principal',
    verification_status: 'not_verified', provider_contract: 'pixel.identity-context-provider.v1', source: 'live',
  };
  const identityProvider = {
    source: 'live',
    async resolveIdentity() { return identity; },
  };
  const deviceTrustProvider = {
    source: 'live',
    async resolveDeviceTrust() {
      identity.verification_status = 'verified';
      return {
        device_id: 'qualified-device-test-01', enrollment_status: 'enrolled', trust_status: 'trusted',
        certificate_status: 'valid', risk_posture: 'acceptable',
        provider_contract: 'pixel.device-trust-provider.v1', source: 'live',
      };
    },
  };
  const { evidence, gate } = createGate({ identityProvider, deviceTrustProvider, environment: 'shadow' });

  const decision = await gate.evaluate({ intent: INTENT });

  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason_code, 'IDENTITY_NOT_VERIFIED');
  const identityEvidence = evidence.forTrace(decision.trace_id)
    .find((record) => record.event_name === 'identity.context.resolved');
  assert.equal(identityEvidence.attributes['pixel.identity.verification_status'], 'not_verified');
});

test('device-trust provider failure and invalid output fail closed before canonical validation', async (t) => {
  for (const deviceTrustProvider of [
    { source: 'live', async resolveDeviceTrust() { throw new Error('sensitive device failure'); } },
    { source: 'live', async resolveDeviceTrust() { return { device_id: 'incomplete' }; } },
  ]) {
    await t.test('provider outcome', async () => {
      const { evidence, gate } = createGate({
        identityProvider: {
          source: 'live',
          async resolveIdentity() {
            return {
              subject_id: 'PIXEL-PRINCIPAL', identity_class: 'human', role: 'Principal',
              verification_status: 'verified', provider_contract: 'pixel.identity-context-provider.v1', source: 'live',
            };
          },
        },
        deviceTrustProvider,
        environment: 'shadow',
      });

      const decision = await gate.evaluate({ intent: INTENT });

      assert.equal(decision.reason_code, 'DEVICE_TRUST_CONTEXT_UNAVAILABLE');
      assert.deepEqual(
        evidence.forTrace(decision.trace_id).map((record) => record.event_name),
        [
          'access.evaluation.started',
          'identity.context.resolved',
          'device_trust.context.resolution_failed',
          'access.decision.issued',
        ],
      );
      assert.equal(JSON.stringify(evidence.all()).includes('sensitive device failure'), false);
    });
  }
});

test('malformed provider identifiers fail through provider-context resolution', async (t) => {
  const validIdentity = {
    subject_id: 'PIXEL-PRINCIPAL', identity_class: 'human', role: 'Principal',
    verification_status: 'verified', provider_contract: 'pixel.identity-context-provider.v1', source: 'live',
  };
  const validDevice = {
    device_id: 'qualified-device-test-01', enrollment_status: 'enrolled', trust_status: 'trusted',
    certificate_status: 'valid', risk_posture: 'acceptable',
    provider_contract: 'pixel.device-trust-provider.v1', source: 'live',
  };
  const identityCases = [
    ['malformed subject_id', { ...validIdentity, subject_id: 'PIXEL PRINCIPAL' }],
    ['malformed role', { ...validIdentity, role: 'Principal/Root' }],
  ];

  for (const [label, identity] of identityCases) {
    await t.test(label, async () => {
      let deviceResolutions = 0;
      const { evidence, gate } = createGate({
        identityProvider: { source: 'live', async resolveIdentity() { return identity; } },
        deviceTrustProvider: {
          source: 'live',
          async resolveDeviceTrust() {
            deviceResolutions += 1;
            return validDevice;
          },
        },
        environment: 'shadow',
      });

      const decision = await gate.evaluate({ intent: INTENT });

      assert.equal(decision.reason_code, 'IDENTITY_CONTEXT_UNAVAILABLE');
      assert.equal(deviceResolutions, 0);
      assert.deepEqual(
        evidence.forTrace(decision.trace_id).map((record) => record.event_name),
        ['access.evaluation.started', 'identity.context.resolution_failed', 'access.decision.issued'],
      );
      assert.equal(JSON.stringify(evidence.all()).includes(identity.subject_id), false);
      assert.equal(JSON.stringify(evidence.all()).includes(identity.role), false);
    });
  }

  await t.test('malformed device_id', async () => {
    const device = { ...validDevice, device_id: 'device path' };
    const { evidence, gate } = createGate({
      identityProvider: { source: 'live', async resolveIdentity() { return validIdentity; } },
      deviceTrustProvider: { source: 'live', async resolveDeviceTrust() { return device; } },
      environment: 'shadow',
    });

    const decision = await gate.evaluate({ intent: INTENT });

    assert.equal(decision.reason_code, 'DEVICE_TRUST_CONTEXT_UNAVAILABLE');
    assert.deepEqual(
      evidence.forTrace(decision.trace_id).map((record) => record.event_name),
      [
        'access.evaluation.started',
        'identity.context.resolved',
        'device_trust.context.resolution_failed',
        'access.decision.issued',
      ],
    );
    assert.equal(JSON.stringify(evidence.all()).includes(device.device_id), false);
  });
});

test('canonical request validation failure denies without evaluating Policy', async () => {
  const { evidence, gate } = createGate({
    deviceTrustProvider: new SimulatorDeviceTrustProvider({
      enrollmentStatus: 'not_enrolled',
      trustStatus: 'trusted',
    }),
  });

  const decision = await gate.evaluate({ intent: INTENT });

  assert.equal(decision.reason_code, 'ACCESS_CONTEXT_INVALID');
  assert.deepEqual(
    evidence.forTrace(decision.trace_id).map((record) => record.event_name),
    [
      'access.evaluation.started',
      'identity.context.resolved',
      'device_trust.context.resolved',
      'contract.access_request.validation_failed',
      'access.decision.issued',
    ],
  );
});

test('simulator providers cannot run outside dev or simulation', () => {
  assert.throws(
    () => createGate({ environment: 'production' }),
    /Simulator access-context providers may run only in dev or simulation/,
  );
  assert.throws(
    () => createGate({ environment: 'shadow' }),
    /Simulator access-context providers may run only in dev or simulation/,
  );
});

test('provider results cannot change their declared provenance source', async () => {
  const identityProvider = {
    source: 'live',
    async resolveIdentity() {
      return {
        subject_id: 'PIXEL-PRINCIPAL', identity_class: 'human', role: 'Principal',
        verification_status: 'verified', provider_contract: 'pixel.identity-context-provider.v1', source: 'simulator',
      };
    },
  };
  const deviceTrustProvider = {
    source: 'live',
    async resolveDeviceTrust() {
      return {
        device_id: 'qualified-device-test-01', enrollment_status: 'enrolled', trust_status: 'trusted',
        certificate_status: 'valid', risk_posture: 'acceptable',
        provider_contract: 'pixel.device-trust-provider.v1', source: 'live',
      };
    },
  };
  const { gate } = createGate({ identityProvider, deviceTrustProvider, environment: 'shadow' });

  const decision = await gate.evaluate({ intent: INTENT });

  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason_code, 'IDENTITY_CONTEXT_UNAVAILABLE');
});

test('independent live-shaped providers prove replacement in shadow without Production claims', async () => {
  const identityProvider = {
    source: 'live',
    async resolveIdentity() {
      return {
        subject_id: 'PIXEL-PRINCIPAL', identity_class: 'human', role: 'Principal',
        verification_status: 'verified', provider_contract: 'pixel.identity-context-provider.v1', source: 'live',
      };
    },
  };
  const deviceTrustProvider = {
    source: 'live',
    async resolveDeviceTrust() {
      return {
        device_id: 'qualified-device-test-01', enrollment_status: 'enrolled', trust_status: 'trusted',
        certificate_status: 'valid', risk_posture: 'acceptable',
        provider_contract: 'pixel.device-trust-provider.v1', source: 'live',
      };
    },
  };
  const { gate } = createGate({ identityProvider, deviceTrustProvider, environment: 'shadow' });

  const decision = await gate.evaluate({ intent: INTENT });

  assert.equal(decision.decision, 'ALLOW');
  assert.equal(decision.environment, 'shadow');
});
