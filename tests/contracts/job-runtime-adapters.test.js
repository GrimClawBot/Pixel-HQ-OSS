import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorJobContextProvider } from '../../adapters/simulator/src/job-context-simulator-provider.js';
import {
  assertCapabilityGrantProvider,
  assertJobContextProvider,
  assertModelJobLookupAdapter,
  assertModelRelayStoreAdapter,
  assertRelayStoreAdapter,
  assertSystemStatusWorker,
  validateCapabilityAuthorizationContext,
  validateCapabilityGrantContext,
  validateJobContext,
  validateWorkerOutcome,
} from '../../packages/adapter-sdk/src/job-runtime-adapters.js';
import { getSystemsJobBinding } from '../../packages/registry/src/organization-bindings.js';

const PUBLIC_REGISTRY = Object.freeze({
  registry_id: 'pixel.organization-registry',
  schema_version: '0.1.0',
  provenance: {
    classification: 'synthetic-public',
    source: 'pixel.public-registry.fixture.v1',
  },
  departments: [{
    department_ref: 'Infrastructure / HomeLab',
    roles: ['Systems'],
  }],
});

test('Registry composition exposes the exact synthetic public Registry Systems binding', () => {
  const binding = getSystemsJobBinding();
  assert.deepEqual(binding, {
    department_ref: 'Infrastructure / HomeLab',
    role_ref: 'Systems',
  });
  assert.equal(Object.isFrozen(binding), true);
});

test('synthetic public Registry lookup fails closed when provenance, department, or role is absent', () => {
  assert.deepEqual(getSystemsJobBinding(PUBLIC_REGISTRY), {
    department_ref: 'Infrastructure / HomeLab',
    role_ref: 'Systems',
  });
  assert.throws(() => getSystemsJobBinding({
    ...PUBLIC_REGISTRY,
    provenance: { ...PUBLIC_REGISTRY.provenance, source: 'untrusted.fixture' },
  }), /Organization Registry/);
  assert.throws(() => getSystemsJobBinding({ ...PUBLIC_REGISTRY, departments: [] }), /Organization Registry/);
  assert.throws(() => getSystemsJobBinding({ ...PUBLIC_REGISTRY, departments: [null] }), RangeError);
  assert.throws(() => getSystemsJobBinding({
    ...PUBLIC_REGISTRY,
    departments: [...PUBLIC_REGISTRY.departments, null],
  }), RangeError);
  assert.throws(() => getSystemsJobBinding({
    ...PUBLIC_REGISTRY,
    departments: [...PUBLIC_REGISTRY.departments, []],
  }), RangeError);
  assert.throws(() => getSystemsJobBinding({
    ...PUBLIC_REGISTRY,
    departments: [{ department_ref: 'Infrastructure / HomeLab', roles: ['Storage'] }],
  }), /Organization Registry/);
});

test('capability authorization context requires the full strict canonical execution scope', () => {
  const context = {
    job_id: 'job-001',
    execution_id: 'execution-001',
    requester: { subject_id: 'PIXEL-PRINCIPAL' },
    owner: { department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems' },
    worker_binding: {
      worker_id: 'PIXEL-SYSTEMS-WORKER-01',
      department_ref: 'Infrastructure / HomeLab',
      role_ref: 'Systems',
    },
    current_state: 'RUNNING',
    environment: 'simulation',
    job_type: 'system-status',
    capability: 'pixel.system-status.read',
    tool_class: 'pixel.system-status',
    target: 'pixel.platform',
    parameter_hash: 'a'.repeat(64),
  };

  assert.deepEqual(validateCapabilityAuthorizationContext(context), { ok: true, errors: [] });
  assert.equal(validateCapabilityAuthorizationContext({ ...context, grants: ['forged'] }).ok, false);
  assert.equal(validateCapabilityAuthorizationContext({ ...context, current_state: 'ACCEPTED' }).ok, false);
  assert.equal(validateCapabilityAuthorizationContext({
    ...context,
    worker_binding: { ...context.worker_binding, role_ref: 'Network' },
  }).ok, false);
});

test('simulated job context resolves requester and worker through the Registry binding', async () => {
  const provider = assertJobContextProvider(new SimulatorJobContextProvider());
  const context = await provider.resolveJobContext();

  assert.deepEqual(context, {
    requester: { subject_id: 'PIXEL-PRINCIPAL' },
    owner: {
      department_ref: 'Infrastructure / HomeLab',
      role_ref: 'Systems',
    },
    worker_binding: {
      worker_id: 'PIXEL-SYSTEMS-WORKER-01',
      department_ref: 'Infrastructure / HomeLab',
      role_ref: 'Systems',
    },
    provider_contract: 'pixel.job-context-provider.v1',
    source: 'simulator',
  });
  assert.equal(validateJobContext(context).ok, true);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.worker_binding), true);
});

test('provider contexts reject malformed or extra authority data', () => {
  const context = {
    requester: { subject_id: 'PIXEL-PRINCIPAL' },
    owner: { department_ref: 'Infrastructure / HomeLab', role_ref: 'Systems' },
    worker_binding: {
      worker_id: 'PIXEL-SYSTEMS-WORKER-01',
      department_ref: 'Infrastructure / HomeLab',
      role_ref: 'Systems',
    },
    provider_contract: 'pixel.job-context-provider.v1',
    source: 'live',
  };
  assert.equal(validateJobContext({ ...context, grants: ['forged'] }).ok, false);
  assert.equal(validateJobContext({
    ...context,
    requester: { subject_id: 'bad subject' },
  }).ok, false);
  assert.equal(validateCapabilityGrantContext({
    capabilities: ['pixel.system-status.read'],
    policy_id: 'pixel.alpha.system-status.v1',
    provider_contract: 'pixel.capability-grant-provider.v1',
    source: 'live',
    policy_result: 'ALLOW',
  }).ok, false);
  assert.equal(validateWorkerOutcome({
    outcome_code: 'SYSTEM_STATUS_AVAILABLE',
    summary: 'arbitrary worker prose',
  }).ok, false);
});

test('adapter SDK accepts independent live-shaped implementations', () => {
  assert.equal(assertJobContextProvider({ source: 'live', resolveJobContext() {} }).source, 'live');
  assert.equal(assertCapabilityGrantProvider({ source: 'live', resolveCapabilities() {} }).source, 'live');
  assert.equal(assertRelayStoreAdapter({
    source: 'live',
    claimOrReturnExisting() {},
    getJob() {},
    applyTransition() {},
    recordGatewayDecision() {},
    claimWorkerInvocation() {},
    commitTerminalResult() {},
  }).source, 'live');
  assert.equal(assertSystemStatusWorker({ source: 'live', execute() {} }).source, 'live');
  assert.equal(assertModelJobLookupAdapter({ source: 'live', getJob() {} }).source, 'live');
  assert.throws(() => assertModelJobLookupAdapter({ source: 'live', applyTransition() {} }), /getJob/);
  assert.equal(assertModelRelayStoreAdapter({
    source: 'live',
    claimOrReturnExisting() {},
    getJob() {},
    applyTransition() {},
    recordGatewayDecision() {},
    claimWorkerInvocation() {},
    claimModelInvocation() {},
    commitTerminalResult() {},
  }).source, 'live');
  assert.throws(() => assertModelRelayStoreAdapter({
    source: 'live',
    claimOrReturnExisting() {},
    getJob() {},
    applyTransition() {},
    recordGatewayDecision() {},
    claimWorkerInvocation() {},
    commitTerminalResult() {},
  }), /claimModelInvocation/);
});
