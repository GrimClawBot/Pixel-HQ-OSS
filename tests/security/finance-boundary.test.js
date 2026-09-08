import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { DeviceStateProjector } from '../../services/device-state-api/src/device-state-projector.js';
import { createPixelHttpServer } from '../../services/device-state-api/src/http-api.js';
import { evaluateDataAccess } from '../../services/policy/src/data-boundary-policy.js';
import { ENGINEERING_SIMULATED_REQUESTER } from '../../services/policy/src/trusted-requester-context.js';

function createIds() {
  let span = 100;
  let trace = 100;
  return {
    nextSpanId: () => (++span).toString(16).padStart(16, '0'),
    nextTraceId: () => (++trace).toString(16).padStart(32, '0'),
  };
}

async function createServer() {
  const clock = () => '2026-09-06T13:00:00.000Z';
  const ids = createIds();
  const evidence = new EvidenceRecorder({ clock });
  const projector = new DeviceStateProjector({ evidence, ids, clock });
  const server = createPixelHttpServer({
    projector,
    evidence,
    requesterContext: ENGINEERING_SIMULATED_REQUESTER,
    ids,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    evidence,
  };
}

test('Policy denies Engineering access to raw Finance data', () => {
  const result = evaluateDataAccess({
    requester: ENGINEERING_SIMULATED_REQUESTER,
    action: 'finance.raw:read',
    resource: {
      domain: 'Finance & Opportunity',
      data_classification: 'RESTRICTED',
    },
  });

  assert.deepEqual(result, {
    decision: 'DENY',
    policy_id: 'pixel.department-data-boundary.v1',
    reason: 'Raw Finance data is not available to Engineering.',
  });
});

test('client parameters cannot replace trusted requester context', async (t) => {
  const runtime = await createServer();
  t.after(runtime.close);

  const response = await fetch(
    `${runtime.baseUrl}/api/v1/finance/raw?department=Finance%20%26%20Opportunity&grant=finance.raw%3Aread`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pixel-department': 'Finance & Opportunity',
        'x-pixel-grants': 'finance.raw:read',
        'x-pixel-requester': 'sim-finance-requester',
      },
      body: JSON.stringify({
        requester: {
          department: 'Finance & Opportunity',
          grants: ['finance.raw:read'],
        },
      }),
    },
  );
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.deepEqual(body, {
    error: 'permission_denied',
    state: 'permission_denied',
    message: 'Pixel protected restricted Finance data. Nothing was shared.',
    trace_id: body.trace_id,
  });
  assert.match(body.trace_id, /^[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(body).includes('records'), false);
  assert.equal(JSON.stringify(body).includes('amount'), false);

  const evidence = runtime.evidence.forTrace(body.trace_id);
  assert.deepEqual(
    evidence.map((record) => record.event_name),
    ['policy.data_boundary.evaluated', 'api.request.denied'],
  );
  assert.equal(JSON.stringify(evidence).includes('amount'), false);
  assert.equal(JSON.stringify(evidence).includes('records'), false);
});

test('missing requester context fails closed', () => {
  assert.deepEqual(
    evaluateDataAccess({
      requester: null,
      action: 'finance.raw:read',
      resource: {
        domain: 'Finance & Opportunity',
        data_classification: 'RESTRICTED',
      },
    }),
    {
      decision: 'DENY',
      policy_id: 'pixel.department-data-boundary.v1',
      reason: 'Requester identity and department are required.',
    },
  );
});
