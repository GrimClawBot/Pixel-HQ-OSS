import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { SimulatorDeviceTrustProvider } from '../../adapters/simulator/src/device-trust-simulator-provider.js';
import { SimulatorIdentityProvider } from '../../adapters/simulator/src/identity-simulator-provider.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';
import { AccessGate } from '../../services/access-gate/src/access-gate.js';
import { createAccessHttpHandler } from '../../services/access-gate/src/http-handler.js';

const NOW = '2026-09-06T14:00:00.000Z';
const INTENT = Object.freeze({ app_id: 'pixel-bench', capability: 'launch' });

function createIds(seed = 2000) {
  let event = seed;
  let span = seed;
  let trace = seed;
  return {
    nextEventId: () => `access-http-${String(++event).padStart(6, '0')}`,
    nextSpanId: () => (++span).toString(16).padStart(16, '0'),
    nextTraceId: () => (++trace).toString(16).padStart(32, '0'),
  };
}

async function startAccessServer({
  identityProvider = new SimulatorIdentityProvider(),
  deviceTrustProvider = new SimulatorDeviceTrustProvider(),
  accessGate = null,
  evidenceRecorder = null,
} = {}) {
  const ids = createIds();
  const evidence = evidenceRecorder ?? new EvidenceRecorder({ clock: () => NOW });
  const gate = accessGate ?? new AccessGate({
    identityProvider,
    deviceTrustProvider,
    environment: 'simulation',
    evidence,
    ids,
    clock: () => NOW,
  });
  const accessHandler = createAccessHttpHandler({ accessGate: gate, evidence, ids });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://pixel.local');
    if (!accessHandler(request, response, url)) {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    deviceTrustProvider,
    evidence,
  };
}

async function requestDecision(baseUrl, {
  body = INTENT,
  contentType = 'application/json',
  headers = {},
  query = '',
  signal,
} = {}) {
  const requestHeaders = { ...headers };
  if (contentType !== null) requestHeaders['content-type'] = contentType;
  const serializedBody = typeof body === 'string' ? body : JSON.stringify(body);
  const response = await fetch(`${baseUrl}/api/v1/access/decisions${query}`, {
    method: 'POST',
    headers: requestHeaders,
    body: contentType === null ? Buffer.from(serializedBody) : serializedBody,
    signal,
  });
  return { response, body: await response.json() };
}

test('detached HTTP failures are contained without disclosing sensitive details', async (t) => {
  const cases = [
    {
      name: 'access evaluation rejection',
      createRuntime: (secret) => {
        const evidenceRecorder = new EvidenceRecorder({ clock: () => NOW });
        return {
          options: {
            evidenceRecorder,
            accessGate: {
              async evaluate() {
                throw new Error(secret);
              },
            },
          },
          records: () => evidenceRecorder.all(),
        };
      },
    },
    {
      name: 'evidence append rejection',
      createRuntime: (secret) => ({
        options: {
          evidenceRecorder: {
            append() {
              throw new Error(secret);
            },
          },
          accessGate: {
            async evaluate() {
              return {
                decision: 'ALLOW',
                trace_id: '00000000000000000000000000000001',
                span_id: '0000000000000001',
              };
            },
          },
        },
        records: () => [],
      }),
    },
    {
      name: 'response serialization rejection',
      createRuntime: (secret) => {
        const records = [];
        return {
          options: {
            evidenceRecorder: { append: (record) => records.push(record) },
            accessGate: {
              async evaluate() {
                return {
                  decision: 'ALLOW',
                  trace_id: '00000000000000000000000000000001',
                  span_id: '0000000000000001',
                  toJSON() {
                    throw new Error(secret);
                  },
                };
              },
            },
          },
          records: () => records,
        };
      },
    },
  ];

  for (const failureCase of cases) {
    await t.test(failureCase.name, async (t) => {
      const secret = `sensitive-${failureCase.name.replaceAll(' ', '-')}`;
      const fixture = failureCase.createRuntime(secret);
      const runtime = await startAccessServer(fixture.options);
      t.after(runtime.close);

      const { response, body } = await requestDecision(runtime.baseUrl, {
        signal: AbortSignal.timeout(500),
      });

      assert.equal(response.status, 500);
      assert.deepEqual(body, { error: 'internal_error' });
      assert.equal(JSON.stringify(body).includes(secret), false);
      assert.equal(JSON.stringify(fixture.records()).includes(secret), false);
    });
  }
});

test('a detached write failure after headers commit safely destroys the response', async () => {
  const secret = 'sensitive-response-write-failure';
  const records = [];
  const handler = createAccessHttpHandler({
    accessGate: {
      async evaluate() {
        return {
          decision: 'ALLOW',
          trace_id: '00000000000000000000000000000001',
          span_id: '0000000000000001',
        };
      },
    },
    evidence: { append: (record) => records.push(record) },
    ids: createIds(),
  });
  const request = {
    method: 'POST',
    headers: {},
    resume() {},
  };
  const response = {
    headersSent: true,
    writableEnded: false,
    destroyed: false,
    writeHead() { throw new Error(secret); },
    end() {},
    destroy() { this.destroyed = true; },
  };

  assert.equal(handler(request, response, new URL('http://pixel.local/api/v1/access/decisions')), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(response.destroyed, true);
  assert.equal(JSON.stringify(records).includes(secret), false);
});

test('strict client intent receives a current backend ALLOW decision', async (t) => {
  const runtime = await startAccessServer();
  t.after(runtime.close);

  const { response, body } = await requestDecision(runtime.baseUrl);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(body.data.decision, 'ALLOW');
  assert.equal(body.data.environment, 'simulation');
});

test('JSON content type accepts case-insensitive UTF-8 charset formatting', async (t) => {
  const runtime = await startAccessServer();
  t.after(runtime.close);

  const { response, body } = await requestDecision(runtime.baseUrl, {
    contentType: 'Application/JSON ; Charset = UTF-8',
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.decision, 'ALLOW');
});

test('unsupported or missing content type rejects before resolving access providers', async (t) => {
  let identityResolutions = 0;
  let deviceTrustResolutions = 0;
  const identityProvider = {
    source: 'simulator',
    async resolveIdentity() {
      identityResolutions += 1;
      throw new Error('must not be reached');
    },
  };
  const deviceTrustProvider = {
    source: 'simulator',
    async resolveDeviceTrust() {
      deviceTrustResolutions += 1;
      throw new Error('must not be reached');
    },
  };
  const runtime = await startAccessServer({ identityProvider, deviceTrustProvider });
  t.after(runtime.close);
  const attackerValue = 'attacker-controlled-body-value';
  const cases = [
    { contentType: 'text/plain', body: INTENT },
    { contentType: null, body: INTENT },
    { contentType: 'application/x-www-form-urlencoded', body: INTENT },
    {
      contentType: 'text/plain',
      body: { ...INTENT, note: attackerValue },
    },
  ];

  for (const request of cases) {
    const { response, body } = await requestDecision(runtime.baseUrl, request);
    assert.equal(response.status, 403);
    assert.equal(body.data.decision, 'DENY');
    assert.equal(body.data.reason_code, 'CLIENT_INTENT_INVALID');
    assert.equal(JSON.stringify(body).includes(attackerValue), false);
  }

  assert.equal(identityResolutions, 0);
  assert.equal(deviceTrustResolutions, 0);
  assert.equal(JSON.stringify(runtime.evidence.all()).includes(attackerValue), false);
});

test('unknown body and query fields fail closed', async (t) => {
  const runtime = await startAccessServer();
  t.after(runtime.close);

  const bodyResult = await requestDecision(runtime.baseUrl, {
    body: { ...INTENT, decorative: 'not-allowed' },
  });
  const queryResult = await requestDecision(runtime.baseUrl, {
    query: '?extra=not-allowed',
  });

  assert.equal(bodyResult.response.status, 403);
  assert.equal(bodyResult.body.data.reason_code, 'CLIENT_INTENT_INVALID');
  assert.equal(queryResult.response.status, 403);
  assert.equal(queryResult.body.data.reason_code, 'CLIENT_INTENT_INVALID');
});

test('nested authority injection is rejected before provider resolution', async (t) => {
  const runtime = await startAccessServer();
  t.after(runtime.close);
  const attackerValue = 'attacker-supplied-principal-secret';

  const { response, body } = await requestDecision(runtime.baseUrl, {
    body: {
      ...INTENT,
      metadata: { nested: { identity: { subject_id: attackerValue } } },
    },
  });

  assert.equal(response.status, 403);
  assert.equal(body.data.reason_code, 'CLIENT_AUTHORITY_CLAIM_REJECTED');
  const records = runtime.evidence.forTrace(body.data.trace_id);
  assert.deepEqual(records.map((record) => record.event_name), [
    'access.evaluation.started',
    'client.authority_claim.detected',
    'access.decision.issued',
    'api.request.denied',
  ]);
  assert.equal(JSON.stringify(body).includes(attackerValue), false);
  assert.equal(JSON.stringify(records).includes(attackerValue), false);
});

test('authority-bearing query fields return the bounded forgery reason', async (t) => {
  const runtime = await startAccessServer({
    deviceTrustProvider: new SimulatorDeviceTrustProvider({ trustStatus: 'untrusted' }),
  });
  t.after(runtime.close);

  const { response, body } = await requestDecision(runtime.baseUrl, {
    query: '?environment=production&grants=pixel-bench%3Alaunch',
  });

  assert.equal(response.status, 403);
  assert.equal(body.data.reason_code, 'CLIENT_AUTHORITY_CLAIM_REJECTED');
  assert.equal(body.data.environment, 'simulation');
});

test('authority-bearing header names are detected case-insensitively', async (t) => {
  const runtime = await startAccessServer();
  t.after(runtime.close);
  const attackerValue = 'trusted-by-attacker';

  const { response, body } = await requestDecision(runtime.baseUrl, {
    headers: { 'X-PiXeL-DeViCe-TrUsT': attackerValue },
  });

  assert.equal(response.status, 403);
  assert.equal(body.data.reason_code, 'CLIENT_AUTHORITY_CLAIM_REJECTED');
  const evidence = runtime.evidence.forTrace(body.data.trace_id);
  assert.equal(JSON.stringify(body).includes(attackerValue), false);
  assert.equal(JSON.stringify(evidence).includes(attackerValue), false);
});

test('subject and Principal authority headers cannot bypass backend evaluation', async (t) => {
  const runtime = await startAccessServer();
  t.after(runtime.close);

  for (const name of ['X-Subject-ID', 'X-Pixel-Principal']) {
    const { response, body } = await requestDecision(runtime.baseUrl, {
      headers: { [name]: 'PIXEL-PRINCIPAL' },
    });

    assert.equal(response.status, 403);
    assert.equal(body.data.reason_code, 'CLIENT_AUTHORITY_CLAIM_REJECTED');
    assert.equal(body.data.policy_id, null);
  }
});

test('canonical authority-name variants are rejected across body, query, and headers', async (t) => {
  const runtime = await startAccessServer();
  t.after(runtime.close);
  const cases = [
    { body: { ...INTENT, grants: ['pixel-bench:launch'] } },
    { query: '?permissions=pixel-bench%3Alaunch' },
    { headers: { 'X-Pixel-Enrolled': 'true' } },
    { headers: { 'X-Pixel-Trusted': 'true' } },
    { headers: { 'X-Pixel-Revoked': 'false' } },
  ];

  for (const request of cases) {
    const { response, body } = await requestDecision(runtime.baseUrl, request);
    assert.equal(response.status, 403);
    assert.equal(body.data.reason_code, 'CLIENT_AUTHORITY_CLAIM_REJECTED');
  }
});

test('malformed and oversized JSON fail closed without echoing input', async (t) => {
  const runtime = await startAccessServer();
  t.after(runtime.close);

  const malformed = await requestDecision(runtime.baseUrl, { body: '{"app_id":' });
  const oversizedValue = 'x'.repeat(9000);
  const oversized = await requestDecision(runtime.baseUrl, {
    body: { ...INTENT, note: oversizedValue },
  });

  assert.equal(malformed.response.status, 403);
  assert.equal(malformed.body.data.reason_code, 'CLIENT_INTENT_INVALID');
  assert.equal(oversized.response.status, 403);
  assert.equal(oversized.body.data.reason_code, 'CLIENT_INTENT_INVALID');
  assert.equal(JSON.stringify(oversized.body).includes(oversizedValue), false);
  assert.equal(JSON.stringify(runtime.evidence.all()).includes(oversizedValue), false);
});

test('client cannot reuse an earlier ALLOW after server-side revocation', async (t) => {
  const runtime = await startAccessServer();
  t.after(runtime.close);

  const before = await requestDecision(runtime.baseUrl);
  runtime.deviceTrustProvider.revoke();
  const after = await requestDecision(runtime.baseUrl);

  assert.equal(before.body.data.decision, 'ALLOW');
  assert.equal(after.response.status, 403);
  assert.equal(after.body.data.reason_code, 'DEVICE_REVOKED');
  assert.notEqual(after.body.data.trace_id, before.body.data.trace_id);
});
