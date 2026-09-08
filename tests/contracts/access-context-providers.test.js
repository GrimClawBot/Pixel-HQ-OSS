import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorDeviceTrustProvider } from '../../adapters/simulator/src/device-trust-simulator-provider.js';
import { SimulatorIdentityProvider } from '../../adapters/simulator/src/identity-simulator-provider.js';
import {
  assertDeviceTrustProvider,
  assertIdentityProvider,
  validateDeviceTrustContext,
  validateIdentityContext,
} from '../../packages/adapter-sdk/src/access-context-providers.js';

test('simulated identity resolves a frozen verified Principal independently', async () => {
  const provider = assertIdentityProvider(new SimulatorIdentityProvider());
  const identity = await provider.resolveIdentity();

  assert.deepEqual(identity, {
    subject_id: 'PIXEL-PRINCIPAL',
    identity_class: 'human',
    role: 'Principal',
    verification_status: 'verified',
    provider_contract: 'pixel.identity-context-provider.v1',
    source: 'simulator',
  });
  assert.equal(Object.isFrozen(identity), true);
  assert.deepEqual(validateIdentityContext(identity), { ok: true, errors: [] });
  assert.equal('device_id' in identity, false);
});

test('simulated device trust resolves independently from user identity', async () => {
  const provider = assertDeviceTrustProvider(new SimulatorDeviceTrustProvider());
  const device = await provider.resolveDeviceTrust();

  assert.deepEqual(device, {
    device_id: 'sim-owner-device-01',
    enrollment_status: 'enrolled',
    trust_status: 'trusted',
    certificate_status: 'valid',
    risk_posture: 'acceptable',
    provider_contract: 'pixel.device-trust-provider.v1',
    source: 'simulator',
  });
  assert.equal(Object.isFrozen(device), true);
  assert.deepEqual(validateDeviceTrustContext(device), { ok: true, errors: [] });
  assert.equal('subject_id' in device, false);
});

test('server-side revocation changes the same simulated device on its next resolution', async () => {
  const provider = new SimulatorDeviceTrustProvider();
  const before = await provider.resolveDeviceTrust();

  provider.revoke();
  const after = await provider.resolveDeviceTrust();

  assert.equal(after.device_id, before.device_id);
  assert.equal(before.trust_status, 'trusted');
  assert.equal(after.trust_status, 'revoked');
  assert.equal(Object.isFrozen(after), true);
});

test('simulator provider provenance cannot be changed after construction', () => {
  const identityProvider = new SimulatorIdentityProvider();
  const deviceTrustProvider = new SimulatorDeviceTrustProvider();

  assert.throws(() => { identityProvider.source = 'live'; }, TypeError);
  assert.throws(() => { deviceTrustProvider.source = 'live'; }, TypeError);
  assert.equal(identityProvider.source, 'simulator');
  assert.equal(deviceTrustProvider.source, 'simulator');
});

test('provider boundaries accept structurally independent live-shaped implementations', () => {
  const identityProvider = {
    source: 'live',
    async resolveIdentity() {},
  };
  const deviceTrustProvider = {
    source: 'live',
    async resolveDeviceTrust() {},
  };

  assert.equal(assertIdentityProvider(identityProvider), identityProvider);
  assert.equal(assertDeviceTrustProvider(deviceTrustProvider), deviceTrustProvider);
});

test('provider result validation rejects undeclared and non-normalized data', () => {
  assert.deepEqual(validateIdentityContext({
    subject_id: 'PIXEL-PRINCIPAL',
    identity_class: 'human',
    role: 'Principal',
    verification_status: 'verified',
    provider_contract: 'pixel.identity-context-provider.v1',
    source: 'simulator',
    token: 'must-not-enter-context',
  }), {
    ok: false,
    errors: ['identity context contains unsupported field token'],
  });

  assert.deepEqual(validateDeviceTrustContext({
    device_id: 'sim-owner-device-01',
    enrollment_status: 'enrolled',
    trust_status: 'trusted',
    certificate_status: { serial: 'must-not-enter-context' },
    risk_posture: 'acceptable',
    provider_contract: 'pixel.device-trust-provider.v1',
    source: 'simulator',
  }), {
    ok: false,
    errors: ['device trust context certificate_status must be valid, not_valid, or unknown'],
  });
});

test('provider identifier fields enforce the canonical Pixel identifier shape', () => {
  const identity = {
    subject_id: 'PIXEL-PRINCIPAL',
    identity_class: 'human',
    role: 'Principal',
    verification_status: 'verified',
    provider_contract: 'pixel.identity-context-provider.v1',
    source: 'live',
  };
  const device = {
    device_id: 'qualified-device-test-01',
    enrollment_status: 'enrolled',
    trust_status: 'trusted',
    certificate_status: 'valid',
    risk_posture: 'acceptable',
    provider_contract: 'pixel.device-trust-provider.v1',
    source: 'live',
  };

  assert.deepEqual(validateIdentityContext({ ...identity, subject_id: 'PIXEL PRINCIPAL' }), {
    ok: false,
    errors: ['identity context subject_id must be a Pixel identifier'],
  });
  assert.deepEqual(validateIdentityContext({ ...identity, role: 'Principal/Root' }), {
    ok: false,
    errors: ['identity context role must be a Pixel identifier'],
  });
  assert.deepEqual(validateDeviceTrustContext({ ...device, device_id: 'device path' }), {
    ok: false,
    errors: ['device trust context device_id must be a Pixel identifier'],
  });
});
