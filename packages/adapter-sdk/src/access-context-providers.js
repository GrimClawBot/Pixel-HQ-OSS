export const IDENTITY_PROVIDER_CONTRACT = 'pixel.identity-context-provider.v1';
export const DEVICE_TRUST_PROVIDER_CONTRACT = 'pixel.device-trust-provider.v1';

const SOURCES = new Set(['simulator', 'live']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const IDENTITY_FIELDS = new Set([
  'subject_id', 'identity_class', 'role', 'verification_status', 'provider_contract', 'source',
]);
const DEVICE_FIELDS = new Set([
  'device_id', 'enrollment_status', 'trust_status', 'certificate_status', 'risk_posture',
  'provider_contract', 'source',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateIdentifier(value, label, errors) {
  if (!hasText(value)) {
    errors.push(`${label} is required`);
  } else if (!IDENTIFIER.test(value)) {
    errors.push(`${label} must be a Pixel identifier`);
  }
}

function exactFields(value, fields, label, errors) {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) {
      errors.push(`${label} contains unsupported field ${field}`);
    }
  }
}

function validateProvider(provider, method, label) {
  if (!isRecord(provider) || !SOURCES.has(provider.source) || typeof provider[method] !== 'function') {
    throw new TypeError(`${label} must declare simulator or live source and implement ${method}()`);
  }
  return provider;
}

export function assertIdentityProvider(provider) {
  return validateProvider(provider, 'resolveIdentity', 'Identity provider');
}

export function assertDeviceTrustProvider(provider) {
  return validateProvider(provider, 'resolveDeviceTrust', 'Device trust provider');
}

export function validateIdentityContext(value) {
  const errors = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['identity context must be an object'] };
  }
  exactFields(value, IDENTITY_FIELDS, 'identity context', errors);
  validateIdentifier(value.subject_id, 'identity context subject_id', errors);
  if (value.identity_class !== 'human') errors.push('identity context identity_class must equal human');
  validateIdentifier(value.role, 'identity context role', errors);
  if (!['verified', 'not_verified', 'unknown'].includes(value.verification_status)) {
    errors.push('identity context verification_status must be verified, not_verified, or unknown');
  }
  if (value.provider_contract !== IDENTITY_PROVIDER_CONTRACT) {
    errors.push(`identity context provider_contract must equal ${IDENTITY_PROVIDER_CONTRACT}`);
  }
  if (!SOURCES.has(value.source)) errors.push('identity context source must be simulator or live');
  return { ok: errors.length === 0, errors };
}

export function validateDeviceTrustContext(value) {
  const errors = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['device trust context must be an object'] };
  }
  exactFields(value, DEVICE_FIELDS, 'device trust context', errors);
  validateIdentifier(value.device_id, 'device trust context device_id', errors);
  if (!['enrolled', 'not_enrolled', 'unknown'].includes(value.enrollment_status)) {
    errors.push('device trust context enrollment_status must be enrolled, not_enrolled, or unknown');
  }
  if (!['trusted', 'untrusted', 'revoked', 'unknown'].includes(value.trust_status)) {
    errors.push('device trust context trust_status must be trusted, untrusted, revoked, or unknown');
  }
  if (!['valid', 'not_valid', 'unknown'].includes(value.certificate_status)) {
    errors.push('device trust context certificate_status must be valid, not_valid, or unknown');
  }
  if (!['acceptable', 'not_acceptable', 'unknown'].includes(value.risk_posture)) {
    errors.push('device trust context risk_posture must be acceptable, not_acceptable, or unknown');
  }
  if (value.provider_contract !== DEVICE_TRUST_PROVIDER_CONTRACT) {
    errors.push(`device trust context provider_contract must equal ${DEVICE_TRUST_PROVIDER_CONTRACT}`);
  }
  if (!SOURCES.has(value.source)) errors.push('device trust context source must be simulator or live');
  return { ok: errors.length === 0, errors };
}
