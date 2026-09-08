import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorDeviceTrustProvider } from '../../adapters/simulator/src/device-trust-simulator-provider.js';
import { SimulatorIdentityProvider } from '../../adapters/simulator/src/identity-simulator-provider.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { assessAccessTraceCompleteness } from '../../packages/telemetry/src/trace-completeness.js';
import { AccessGate } from '../../services/access-gate/src/access-gate.js';

const NOW = '2026-09-06T14:00:00.000Z';
const INTENT = Object.freeze({ app_id: 'pixel-bench', capability: 'launch' });

function createIds(seed) {
  let event = seed;
  let span = seed;
  let trace = seed;
  return {
    nextEventId: () => `access-${String(++event).padStart(6, '0')}`,
    nextSpanId: () => (++span).toString(16).padStart(16, '0'),
    nextTraceId: () => (++trace).toString(16).padStart(32, '0'),
  };
}

async function evaluate({
  seed,
  identityProvider = new SimulatorIdentityProvider(),
  deviceTrustProvider = new SimulatorDeviceTrustProvider(),
  environment = 'simulation',
  authorityClaimAttempt = null,
} = {}) {
  const ids = createIds(seed);
  const evidence = new EvidenceRecorder({ clock: () => NOW });
  const gate = new AccessGate({
    identityProvider, deviceTrustProvider, environment, evidence, ids, clock: () => NOW,
  });
  const decision = await gate.evaluate({ intent: INTENT, authorityClaimAttempt });
  evidence.append({
    traceId: decision.trace_id,
    spanId: ids.nextSpanId(),
    parentSpanId: decision.span_id,
    serviceName: 'pixel.access-gate-api',
    eventName: decision.decision === 'ALLOW' ? 'api.response.sent' : 'api.request.denied',
    outcome: decision.decision === 'ALLOW' ? 'success' : 'denied',
    severity: decision.decision === 'ALLOW' ? 'info' : 'warning',
    attributes: {
      'http.request.method': 'POST',
      'http.route': '/api/v1/access/decisions',
      'http.response.status_code': decision.decision === 'ALLOW' ? 200 : 403,
    },
  });
  return { decision, records: evidence.forTrace(decision.trace_id) };
}

test('trusted ALLOW trace is complete', async () => {
  const { records } = await evaluate({ seed: 100 });
  assert.equal(assessAccessTraceCompleteness(records).complete, true);
});

test('normal trust DENY trace is complete', async () => {
  const { records } = await evaluate({
    seed: 200,
    deviceTrustProvider: new SimulatorDeviceTrustProvider({ trustStatus: 'untrusted' }),
  });
  assert.equal(assessAccessTraceCompleteness(records).complete, true);
});

test('client-authority-forgery DENY trace is complete without provider stages', async () => {
  const { records } = await evaluate({
    seed: 300,
    authorityClaimAttempt: { categories: ['role'], locations: ['header'] },
  });
  assert.equal(assessAccessTraceCompleteness(records).complete, true);
  assert.equal(records.some((record) => record.event_name.includes('context.resolved')), false);
});

test('identity-provider failure trace is complete without downstream work', async () => {
  const { records } = await evaluate({
    seed: 400,
    environment: 'shadow',
    identityProvider: { source: 'live', async resolveIdentity() { throw new Error('private'); } },
    deviceTrustProvider: { source: 'live', async resolveDeviceTrust() { throw new Error('unreachable'); } },
  });
  assert.equal(assessAccessTraceCompleteness(records).complete, true);
});

test('device-trust-provider failure trace is complete without validation or Policy', async () => {
  const { records } = await evaluate({
    seed: 500,
    environment: 'shadow',
    identityProvider: {
      source: 'live',
      async resolveIdentity() {
        return {
          subject_id: 'PIXEL-PRINCIPAL', identity_class: 'human', role: 'Principal',
          verification_status: 'verified', provider_contract: 'pixel.identity-context-provider.v1', source: 'live',
        };
      },
    },
    deviceTrustProvider: { source: 'live', async resolveDeviceTrust() { throw new Error('private'); } },
  });
  assert.equal(assessAccessTraceCompleteness(records).complete, true);
});

test('canonical-validation failure trace is complete without Policy', async () => {
  const { records } = await evaluate({
    seed: 600,
    deviceTrustProvider: new SimulatorDeviceTrustProvider({
      enrollmentStatus: 'not_enrolled',
      trustStatus: 'trusted',
    }),
  });
  assert.equal(assessAccessTraceCompleteness(records).complete, true);
});

test('completeness rejects an impossible downstream stage after terminal failure', async () => {
  const { records } = await evaluate({
    seed: 700,
    authorityClaimAttempt: { categories: ['role'], locations: ['body'] },
  });
  const mutated = structuredClone(records);
  mutated.splice(2, 0, {
    ...mutated[1],
    span_id: 'ffffffffffffffff',
    parent_span_id: mutated[1].span_id,
    event_name: 'identity.context.resolved',
    outcome: 'success',
    attributes: {
      'pixel.identity.subject_id': 'PIXEL-PRINCIPAL',
      'pixel.identity.verification_status': 'verified',
      'pixel.identity.role': 'Principal',
      'pixel.provider.source': 'simulator',
    },
  });

  const assessment = assessAccessTraceCompleteness(mutated);
  assert.equal(assessment.complete, false);
  assert.equal(assessment.validation_errors.includes('trace contains stages impossible for CLIENT_AUTHORITY_CLAIM_REJECTED'), true);
});

test('completeness rejects broken parentage, duplicate IDs, and missing attributes', async () => {
  const { records } = await evaluate({ seed: 800 });
  const mutated = structuredClone(records);
  mutated[1].parent_span_id = 'eeeeeeeeeeeeeeee';
  mutated[2].span_id = mutated[1].span_id;
  delete mutated[4].attributes['pixel.policy.id'];

  const assessment = assessAccessTraceCompleteness(mutated);
  assert.equal(assessment.complete, false);
  assert.equal(assessment.broken_parent_span_ids.includes('eeeeeeeeeeeeeeee'), true);
  assert.equal(assessment.validation_errors.includes('span_id values must be unique'), true);
  assert.equal(
    assessment.validation_errors.includes('policy.protected_app.evaluated requires attribute pixel.policy.id'),
    true,
  );
});

test('completeness rejects semantically inconsistent access evidence', async (t) => {
  const { records } = await evaluate({ seed: 850 });
  const cases = [
    ['decision and reason', (mutated) => {
      const decision = mutated.find((record) => record.event_name === 'access.decision.issued');
      decision.attributes['pixel.access.reason_code'] = 'DEVICE_UNTRUSTED';
    }],
    ['Policy and issued decision', (mutated) => {
      const policy = mutated.find((record) => record.event_name === 'policy.protected_app.evaluated');
      policy.attributes['pixel.policy.decision'] = 'DENY';
    }],
    ['environment across root and contract', (mutated) => {
      const contract = mutated.find((record) => record.event_name === 'contract.access_request.validated');
      contract.attributes['pixel.environment'] = 'production';
    }],
    ['API status and decision', (mutated) => {
      const api = mutated.find((record) => record.event_name === 'api.response.sent');
      api.attributes['http.response.status_code'] = 403;
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const mutated = structuredClone(records);
      mutate(mutated);
      assert.equal(assessAccessTraceCompleteness(mutated).complete, false);
    });
  }
});

test('completeness rejects unbounded or extra access evidence attributes', async (t) => {
  const { records } = await evaluate({ seed: 875 });
  const cases = [
    ['extra sensitive attribute', (mutated) => {
      const identity = mutated.find((record) => record.event_name === 'identity.context.resolved');
      identity.attributes.credential = 'must-not-enter-evidence';
    }],
    ['unrecognized provider source', (mutated) => {
      const device = mutated.find((record) => record.event_name === 'device_trust.context.resolved');
      device.attributes['pixel.provider.source'] = 'vendor-specific-source';
    }],
    ['wrong access contract', (mutated) => {
      const root = mutated.find((record) => record.event_name === 'access.evaluation.started');
      root.attributes['pixel.access.gate_contract'] = 'unrecognized-contract';
    }],
    ['unrecognized identity state', (mutated) => {
      const identity = mutated.find((record) => record.event_name === 'identity.context.resolved');
      identity.attributes['pixel.identity.verification_status'] = 'attacker-verified';
    }],
    ['inconsistent target', (mutated) => {
      const contract = mutated.find((record) => record.event_name === 'contract.access_request.validated');
      contract.attributes['pixel.app.id'] = 'not-pixel-bench';
    }],
    ['unrecognized emitting service', (mutated) => {
      const policy = mutated.find((record) => record.event_name === 'policy.protected_app.evaluated');
      policy.service_name = 'vendor-policy-service';
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const mutated = structuredClone(records);
      mutate(mutated);
      assert.equal(assessAccessTraceCompleteness(mutated).complete, false);
    });
  }
});

test('completeness rejects unbounded provider-failure classifications', async () => {
  const { records } = await evaluate({
    seed: 890,
    environment: 'shadow',
    identityProvider: { source: 'live', async resolveIdentity() { throw new Error('private'); } },
    deviceTrustProvider: { source: 'live', async resolveDeviceTrust() { throw new Error('unreachable'); } },
  });
  const mutated = structuredClone(records);
  const failure = mutated.find((record) => record.event_name === 'identity.context.resolution_failed');
  failure.attributes['pixel.failure.kind'] = 'attacker-controlled-failure';

  assert.equal(assessAccessTraceCompleteness(mutated).complete, false);
});

test('repeated evaluations remain complete as independent traces', async () => {
  const first = await evaluate({ seed: 900 });
  const second = await evaluate({ seed: 1000 });

  assert.notEqual(first.decision.trace_id, second.decision.trace_id);
  assert.equal(assessAccessTraceCompleteness(first.records).complete, true);
  assert.equal(assessAccessTraceCompleteness(second.records).complete, true);
});
