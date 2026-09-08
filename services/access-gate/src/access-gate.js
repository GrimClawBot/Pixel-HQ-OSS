import {
  assertDeviceTrustProvider,
  assertIdentityProvider,
  validateDeviceTrustContext,
  validateIdentityContext,
} from '../../../packages/adapter-sdk/src/access-context-providers.js';
import {
  ACCESS_DECISION_EVENT_NAME,
  ACCESS_GATE_CONTRACT,
  ACCESS_REQUEST_EVENT_NAME,
  ACCESS_SCHEMA_VERSION,
  assertValidAccessDecisionV1,
  validateAccessRequestV1,
  validateProtectedAppIntentV1,
} from '../../../packages/contracts/src/access-v1.js';
import { evaluateProtectedAppAccess } from '../../policy/src/protected-app-policy.js';

const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const SIMULATOR_ENVIRONMENTS = new Set(['dev', 'simulation']);
const AUTHORITY_CLAIM_CATEGORIES = new Set([
  'authorization_decision', 'certificate_status', 'device_identity', 'device_trust',
  'enrollment', 'environment', 'identity', 'permissions', 'risk_posture', 'role',
  'verification_state',
]);
const AUTHORITY_CLAIM_LOCATIONS = new Set(['body', 'header', 'query']);
const TARGET = Object.freeze({ app_id: 'pixel-bench', capability: 'launch' });
const DENY_COPY = Object.freeze({
  CLIENT_AUTHORITY_CLAIM_REJECTED: Object.freeze({
    summary: 'Pixel blocked an invalid access request.',
    impact: 'Client-supplied authority cannot open protected apps. Nothing was changed.',
  }),
  CLIENT_INTENT_INVALID: Object.freeze({
    summary: 'Pixel could not verify this app request.',
    impact: 'The request was not accepted, and no protected app was opened.',
  }),
  IDENTITY_CONTEXT_UNAVAILABLE: Object.freeze({
    summary: 'Pixel could not verify access right now.',
    impact: 'Identity verification was unavailable, so the protected app stayed closed.',
  }),
  DEVICE_TRUST_CONTEXT_UNAVAILABLE: Object.freeze({
    summary: 'Pixel could not verify this device right now.',
    impact: 'Device trust was unavailable, so the protected app stayed closed.',
  }),
  ACCESS_CONTEXT_INVALID: Object.freeze({
    summary: 'Pixel could not establish a valid access decision.',
    impact: 'The protected app stayed closed. Nothing was changed.',
  }),
  IDENTITY_NOT_VERIFIED: Object.freeze({
    summary: 'Pixel could not verify access for this app.',
    impact: 'The protected app stayed closed. Nothing was changed.',
  }),
  DEVICE_NOT_ENROLLED: Object.freeze({
    summary: 'This Pixel app is unavailable on this device.',
    impact: 'Pixel requires an enrolled device before opening protected apps.',
  }),
  DEVICE_REVOKED: Object.freeze({
    summary: 'This Pixel app is unavailable on this device.',
    impact: 'Pixel protected the app after this device lost trusted access.',
  }),
  DEVICE_UNTRUSTED: Object.freeze({
    summary: 'This Pixel app is unavailable on this device.',
    impact: 'Pixel requires a trusted device before opening protected apps.',
  }),
  CERTIFICATE_NOT_VALID: Object.freeze({
    summary: 'Pixel could not verify this device for protected access.',
    impact: 'The protected app stayed closed. Nothing was changed.',
  }),
  RISK_NOT_ACCEPTABLE: Object.freeze({
    summary: 'Pixel protected this app from an unsafe access context.',
    impact: 'The protected app stayed closed. Nothing was changed.',
  }),
  APP_NOT_PERMITTED: Object.freeze({
    summary: 'This Pixel app is not available for the current access context.',
    impact: 'Pixel denied the launch before anything changed.',
  }),
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function freezeCopy(value) {
  return deepFreeze(structuredClone(value));
}

function requireDependencies({ evidence, ids, clock, environment }) {
  if (!evidence || typeof evidence.append !== 'function') {
    throw new TypeError('AccessGate requires an evidence recorder');
  }
  if (
    !ids
    || typeof ids.nextEventId !== 'function'
    || typeof ids.nextSpanId !== 'function'
    || typeof ids.nextTraceId !== 'function'
  ) {
    throw new TypeError('AccessGate requires event, span, and trace ID sources');
  }
  if (typeof clock !== 'function') throw new TypeError('AccessGate requires a clock');
  if (!ENVIRONMENTS.has(environment)) throw new TypeError('AccessGate requires a canonical environment');
}

function assertPlacement(environment, providers) {
  if (providers.some(({ source }) => source === 'simulator') && !SIMULATOR_ENVIRONMENTS.has(environment)) {
    throw new RangeError('Simulator access-context providers may run only in dev or simulation');
  }
}

function boundedLabels(values, allowed) {
  if (!Array.isArray(values)) return ['unknown'];
  const bounded = [...new Set(values.filter((value) => allowed.has(value)))].sort();
  return bounded.length > 0 ? bounded : ['unknown'];
}

function ownerProjection(decision, reasonCode) {
  if (decision === 'ALLOW') {
    return {
      state: 'Ready',
      summary: 'Pixel Bench is ready to open.',
      impact: 'Your current identity and device meet Pixel access requirements.',
    };
  }
  return { state: 'Protected', ...DENY_COPY[reasonCode] };
}

export class AccessGate {
  #clock;
  #deviceTrustProvider;
  #deviceTrustProviderSource;
  #environment;
  #evidence;
  #identityProvider;
  #identityProviderSource;
  #ids;

  constructor({ identityProvider, deviceTrustProvider, environment, evidence, ids, clock }) {
    requireDependencies({ evidence, ids, clock, environment });
    this.#identityProvider = assertIdentityProvider(identityProvider);
    this.#deviceTrustProvider = assertDeviceTrustProvider(deviceTrustProvider);
    this.#identityProviderSource = this.#identityProvider.source;
    this.#deviceTrustProviderSource = this.#deviceTrustProvider.source;
    assertPlacement(environment, [
      { source: this.#identityProviderSource },
      { source: this.#deviceTrustProviderSource },
    ]);
    this.#environment = environment;
    this.#evidence = evidence;
    this.#ids = ids;
    this.#clock = clock;
  }

  #append({ traceId, spanId, parentSpanId = null, eventName, outcome = 'success', severity = 'info', attributes = {} }) {
    return this.#evidence.append({
      traceId,
      spanId,
      parentSpanId,
      serviceName: 'pixel.access-gate',
      eventName,
      outcome,
      severity,
      attributes,
    });
  }

  #issueDecision({ traceId, parentSpanId, requestId = null, policyId = null, decision = 'DENY', reasonCode }) {
    const spanId = this.#ids.nextSpanId();
    const value = freezeCopy({
      decision_id: this.#ids.nextEventId(),
      event_name: ACCESS_DECISION_EVENT_NAME,
      schema_version: ACCESS_SCHEMA_VERSION,
      decided_at: this.#clock(),
      environment: this.#environment,
      trace_id: traceId,
      span_id: spanId,
      request_id: requestId,
      decision,
      reason_code: reasonCode,
      target: TARGET,
      owner: ownerProjection(decision, reasonCode),
      policy_id: policyId,
      provenance: { access_gate_contract: ACCESS_GATE_CONTRACT },
    });
    assertValidAccessDecisionV1(value);
    this.#append({
      traceId,
      spanId,
      parentSpanId,
      eventName: 'access.decision.issued',
      outcome: decision === 'ALLOW' ? 'success' : 'denied',
      severity: decision === 'ALLOW' ? 'info' : 'warning',
      attributes: {
        'pixel.access.decision': decision,
        'pixel.access.reason_code': reasonCode,
        'pixel.app.id': TARGET.app_id,
        'pixel.app.capability': TARGET.capability,
      },
    });
    return value;
  }

  async evaluate({ intent, authorityClaimAttempt = null }) {
    const traceId = this.#ids.nextTraceId();
    const rootSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId,
      spanId: rootSpanId,
      eventName: 'access.evaluation.started',
      attributes: {
        'pixel.access.gate_contract': ACCESS_GATE_CONTRACT,
        'pixel.environment': this.#environment,
      },
    });

    if (authorityClaimAttempt) {
      const claimSpanId = this.#ids.nextSpanId();
      this.#append({
        traceId,
        spanId: claimSpanId,
        parentSpanId: rootSpanId,
        eventName: 'client.authority_claim.detected',
        outcome: 'denied',
        severity: 'warning',
        attributes: {
          'pixel.security.authority_claim_categories': boundedLabels(
            authorityClaimAttempt.categories,
            AUTHORITY_CLAIM_CATEGORIES,
          ).join(','),
          'pixel.security.transport_locations': boundedLabels(
            authorityClaimAttempt.locations,
            AUTHORITY_CLAIM_LOCATIONS,
          ).join(','),
        },
      });
      return this.#issueDecision({ traceId, parentSpanId: claimSpanId, reasonCode: 'CLIENT_AUTHORITY_CLAIM_REJECTED' });
    }

    const intentValidation = validateProtectedAppIntentV1(intent);
    if (!intentValidation.ok) {
      const intentSpanId = this.#ids.nextSpanId();
      this.#append({
        traceId,
        spanId: intentSpanId,
        parentSpanId: rootSpanId,
        eventName: 'client.intent.rejected',
        outcome: 'denied',
        severity: 'warning',
        attributes: { 'pixel.validation.error_count': intentValidation.errors.length },
      });
      return this.#issueDecision({ traceId, parentSpanId: intentSpanId, reasonCode: 'CLIENT_INTENT_INVALID' });
    }

    let identity;
    let identityFailureKind = 'exception';
    try {
      identity = freezeCopy(await this.#identityProvider.resolveIdentity());
      if (!validateIdentityContext(identity).ok || identity.source !== this.#identityProviderSource) {
        identityFailureKind = 'invalid_result';
        throw new TypeError('Invalid identity provider result');
      }
    } catch {
      const failureSpanId = this.#ids.nextSpanId();
      this.#append({
        traceId,
        spanId: failureSpanId,
        parentSpanId: rootSpanId,
        eventName: 'identity.context.resolution_failed',
        outcome: 'denied',
        severity: 'warning',
        attributes: { 'pixel.provider.source': this.#identityProviderSource, 'pixel.failure.kind': identityFailureKind },
      });
      return this.#issueDecision({ traceId, parentSpanId: failureSpanId, reasonCode: 'IDENTITY_CONTEXT_UNAVAILABLE' });
    }

    const identitySpanId = this.#ids.nextSpanId();
    this.#append({
      traceId,
      spanId: identitySpanId,
      parentSpanId: rootSpanId,
      eventName: 'identity.context.resolved',
      attributes: {
        'pixel.identity.subject_id': identity.subject_id,
        'pixel.identity.verification_status': identity.verification_status,
        'pixel.identity.role': identity.role,
        'pixel.provider.source': identity.source,
      },
    });

    let device;
    let deviceFailureKind = 'exception';
    try {
      device = freezeCopy(await this.#deviceTrustProvider.resolveDeviceTrust());
      if (!validateDeviceTrustContext(device).ok || device.source !== this.#deviceTrustProviderSource) {
        deviceFailureKind = 'invalid_result';
        throw new TypeError('Invalid device-trust provider result');
      }
    } catch {
      const failureSpanId = this.#ids.nextSpanId();
      this.#append({
        traceId,
        spanId: failureSpanId,
        parentSpanId: identitySpanId,
        eventName: 'device_trust.context.resolution_failed',
        outcome: 'denied',
        severity: 'warning',
        attributes: { 'pixel.provider.source': this.#deviceTrustProviderSource, 'pixel.failure.kind': deviceFailureKind },
      });
      return this.#issueDecision({ traceId, parentSpanId: failureSpanId, reasonCode: 'DEVICE_TRUST_CONTEXT_UNAVAILABLE' });
    }

    const deviceSpanId = this.#ids.nextSpanId();
    this.#append({
      traceId,
      spanId: deviceSpanId,
      parentSpanId: identitySpanId,
      eventName: 'device_trust.context.resolved',
      attributes: {
        'pixel.device.id': device.device_id,
        'pixel.device.enrollment_status': device.enrollment_status,
        'pixel.device.trust_status': device.trust_status,
        'pixel.device.certificate_status': device.certificate_status,
        'pixel.device.risk_posture': device.risk_posture,
        'pixel.provider.source': device.source,
      },
    });

    const requestSpanId = this.#ids.nextSpanId();
    const request = freezeCopy({
      request_id: this.#ids.nextEventId(),
      event_name: ACCESS_REQUEST_EVENT_NAME,
      schema_version: ACCESS_SCHEMA_VERSION,
      occurred_at: this.#clock(),
      environment: this.#environment,
      trace_id: traceId,
      span_id: requestSpanId,
      identity: {
        subject_id: identity.subject_id,
        identity_class: identity.identity_class,
        role: identity.role,
        verification_status: identity.verification_status,
      },
      device: {
        device_id: device.device_id,
        enrollment_status: device.enrollment_status,
        trust_status: device.trust_status,
        certificate_status: device.certificate_status,
        risk_posture: device.risk_posture,
      },
      target: TARGET,
      provenance: {
        identity_provider_contract: identity.provider_contract,
        identity_source: identity.source,
        device_trust_provider_contract: device.provider_contract,
        device_trust_source: device.source,
      },
    });
    const requestValidation = validateAccessRequestV1(request);
    if (!requestValidation.ok) {
      this.#append({
        traceId,
        spanId: requestSpanId,
        parentSpanId: deviceSpanId,
        eventName: 'contract.access_request.validation_failed',
        outcome: 'denied',
        severity: 'warning',
        attributes: { 'pixel.validation.error_count': requestValidation.errors.length },
      });
      return this.#issueDecision({ traceId, parentSpanId: requestSpanId, reasonCode: 'ACCESS_CONTEXT_INVALID' });
    }

    this.#append({
      traceId,
      spanId: requestSpanId,
      parentSpanId: deviceSpanId,
      eventName: 'contract.access_request.validated',
      attributes: {
        'pixel.event.name': request.event_name,
        'pixel.event.schema_version': request.schema_version,
        'pixel.environment': request.environment,
        'pixel.app.id': request.target.app_id,
        'pixel.app.capability': request.target.capability,
      },
    });

    const policy = evaluateProtectedAppAccess(request);
    const policySpanId = this.#ids.nextSpanId();
    this.#append({
      traceId,
      spanId: policySpanId,
      parentSpanId: requestSpanId,
      eventName: 'policy.protected_app.evaluated',
      outcome: policy.decision === 'ALLOW' ? 'success' : 'denied',
      severity: policy.decision === 'ALLOW' ? 'info' : 'warning',
      attributes: {
        'pixel.policy.id': policy.policy_id,
        'pixel.policy.decision': policy.decision,
        'pixel.access.reason_code': policy.reason_code,
        'pixel.app.id': request.target.app_id,
        'pixel.app.capability': request.target.capability,
      },
    });
    return this.#issueDecision({
      traceId,
      parentSpanId: policySpanId,
      requestId: request.request_id,
      policyId: policy.policy_id,
      decision: policy.decision,
      reasonCode: policy.reason_code,
    });
  }
}
