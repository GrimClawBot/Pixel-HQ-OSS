import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { SimulatorStorageAdapter } from '../../adapters/simulator/src/storage-simulator-adapter.js';
import { createMilestoneRuntime } from '../../apps/mission-control/src/server.js';
import {
  assessDeviceTraceCompleteness,
  assessPolicyDenialTraceCompleteness,
} from '../../packages/telemetry/src/trace-completeness.js';
import { EvidenceRecorder } from '../../packages/telemetry/src/evidence-recorder.js';

function createIds() {
  let event = 0;
  let span = 200;
  let trace = 200;
  return {
    nextEventId: () => `evt-evidence-${String(++event).padStart(4, '0')}`,
    nextSpanId: () => (++span).toString(16).padStart(16, '0'),
    nextTraceId: () => (++trace).toString(16).padStart(32, '0'),
  };
}

test('evidence records deep-copy and freeze nested caller attributes', () => {
  const evidence = new EvidenceRecorder({ clock: () => '2026-09-06T13:00:00.000Z' });
  const attributes = {
    nested: { classification: 'RESTRICTED' },
    stages: ['validated'],
  };

  const record = evidence.append({
    traceId: '12121212121212121212121212121212',
    spanId: '1212121212121212',
    serviceName: 'pixel.test',
    eventName: 'test.evidence.recorded',
    attributes,
  });
  attributes.nested.classification = 'PUBLIC';
  attributes.stages.push('mutated');

  assert.equal(record.attributes.nested.classification, 'RESTRICTED');
  assert.deepEqual(record.attributes.stages, ['validated']);
  assert.equal(Object.isFrozen(record.attributes.nested), true);
  assert.equal(Object.isFrozen(record.attributes.stages), true);
  assert.throws(() => record.attributes.stages.push('blocked'), TypeError);
});

async function createRuntime(scenario) {
  const clock = () => '2026-09-06T13:00:00.000Z';
  const ids = createIds();
  const runtime = await createMilestoneRuntime({
    adapterFactory: (dependencies) => new SimulatorStorageAdapter(dependencies),
    scenario,
    clock,
    ids,
  });
  const { evidence, event, server } = runtime;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    evidence,
    traceId: event.trace_id,
  };
}

test('healthy and degraded device traces prove every required stage', async (t) => {
  const healthy = await createRuntime('healthy');
  const degraded = await createRuntime('degraded-storage');
  t.after(healthy.close);
  t.after(degraded.close);

  await fetch(`${healthy.baseUrl}/api/v1/devices/PIXEL-STORAGE-01`);
  await fetch(`${degraded.baseUrl}/api/v1/devices/PIXEL-STORAGE-01`);
  await fetch(`${degraded.baseUrl}/api/v1/attention`);

  assert.deepEqual(
    assessDeviceTraceCompleteness(healthy.evidence.forTrace(healthy.traceId)),
    { complete: true, missing_stages: [], broken_parent_span_ids: [], validation_errors: [] },
  );
  assert.deepEqual(
    assessDeviceTraceCompleteness(degraded.evidence.forTrace(degraded.traceId)),
    { complete: true, missing_stages: [], broken_parent_span_ids: [], validation_errors: [] },
  );
});

const REQUEST_SEQUENCES = [
  ['device GET twice', ['device', 'device']],
  ['device GET ten times', Array.from({ length: 10 }, () => 'device')],
  ['attention GET followed by device GET', ['attention', 'device']],
  ['device GET, attention GET, then device GET', ['device', 'attention', 'device']],
];

for (const [label, sequence] of REQUEST_SEQUENCES) {
  test(`degraded trace stays complete after ${label}`, async (t) => {
    const runtime = await createRuntime('degraded-storage');
    t.after(runtime.close);

    for (const requestType of sequence) {
      const path = requestType === 'device'
        ? '/api/v1/devices/PIXEL-STORAGE-01'
        : '/api/v1/attention';
      const response = await fetch(`${runtime.baseUrl}${path}`);
      assert.equal(response.status, 200);
    }

    const records = runtime.evidence.forTrace(runtime.traceId);
    const projectionSpanId = records.find(
      (record) => record.event_name === 'state.device.projected',
    ).span_id;
    const attentionSpanId = records.find(
      (record) => record.event_name === 'attention.item.upserted',
    ).span_id;
    const apiRecords = records.filter((record) => record.event_name === 'api.response.sent');

    assert.equal(apiRecords.length, sequence.length);
    for (const record of apiRecords) {
      const expectedParent = record.attributes['http.route'] === '/api/v1/attention'
        ? attentionSpanId
        : projectionSpanId;
      assert.equal(record.parent_span_id, expectedParent);
    }
    assert.deepEqual(assessDeviceTraceCompleteness(records), {
      complete: true,
      missing_stages: [],
      broken_parent_span_ids: [],
      validation_errors: [],
    });
  });
}

test('device trace assessment names missing proof stages', async (t) => {
  const runtime = await createRuntime('healthy');
  t.after(runtime.close);
  await fetch(`${runtime.baseUrl}/api/v1/devices/PIXEL-STORAGE-01`);
  const incomplete = runtime.evidence
    .forTrace(runtime.traceId)
    .filter((record) => record.event_name !== 'api.response.sent');

  assert.deepEqual(assessDeviceTraceCompleteness(incomplete), {
    complete: false,
    missing_stages: ['api.response.sent'],
    broken_parent_span_ids: [],
    validation_errors: [],
  });
});

test('policy denial trace proves evaluation and denied response without payload data', async (t) => {
  const runtime = await createRuntime('healthy');
  t.after(runtime.close);
  const response = await fetch(`${runtime.baseUrl}/api/v1/finance/raw`, { method: 'POST' });
  const body = await response.json();
  const records = runtime.evidence.forTrace(body.trace_id);

  assert.deepEqual(assessPolicyDenialTraceCompleteness(records), {
    complete: true,
    missing_stages: [],
    broken_parent_span_ids: [],
    validation_errors: [],
  });
  assert.equal(JSON.stringify(records).includes('records'), false);
  assert.equal(JSON.stringify(records).includes('amount'), false);
});

function deviceTraceRecords() {
  const traceId = '34343434343434343434343434343434';
  const definitions = [
    ['adapter.snapshot.received', null, {
      'pixel.device.role_id': 'PIXEL-STORAGE-01',
      'pixel.event.schema_version': '1.0.0',
      'pixel.adapter.id': 'test.adapter.v1',
      'pixel.adapter.source': 'live',
    }],
    ['contract.device_snapshot.validated', 1, {
      'pixel.event.name': 'pixel.device.snapshot.v1',
      'pixel.event.schema_version': '1.0.0',
      'pixel.device.role_id': 'PIXEL-STORAGE-01',
    }],
    ['state.device.projected', 2, {
      'pixel.device.role_id': 'PIXEL-STORAGE-01',
      'pixel.device.health_state': 'ready',
      'pixel.owner.state': 'Ready',
    }],
    ['api.response.sent', 3, {
      'http.request.method': 'GET',
      'http.route': '/api/v1/devices/{role_id}',
      'http.response.status_code': 200,
    }],
  ];

  return definitions.map(([eventName, parentIndex, attributes], index) => ({
    timestamp: '2026-09-06T13:00:00.000Z',
    trace_id: traceId,
    span_id: String(index + 1).padStart(16, '0'),
    parent_span_id: parentIndex === null ? null : String(parentIndex).padStart(16, '0'),
    service_name: 'pixel.test',
    event_name: eventName,
    severity: 'info',
    outcome: 'success',
    attributes,
  }));
}

test('device trace rejects mixed trace IDs and unlinked stage roots', () => {
  const records = deviceTraceRecords();
  records[1].trace_id = '56565656565656565656565656565656';
  records[1].parent_span_id = null;

  const result = assessDeviceTraceCompleteness(records);

  assert.equal(result.complete, false);
  assert.equal(result.validation_errors.includes('records must share one trace_id'), true);
  assert.equal(
    result.validation_errors.includes('contract.device_snapshot.validated must link to adapter.snapshot.received'),
    true,
  );
});

test('device trace rejects duplicate spans and out-of-order stages', () => {
  const records = deviceTraceRecords();
  records[2].span_id = records[1].span_id;
  [records[1], records[2]] = [records[2], records[1]];

  const result = assessDeviceTraceCompleteness(records);

  assert.equal(result.complete, false);
  assert.equal(result.validation_errors.includes('span_id values must be unique'), true);
  assert.equal(result.validation_errors.includes('required stages must be in canonical order'), true);
});

test('device trace rejects wrong outcomes and incomplete stage attributes', () => {
  const records = deviceTraceRecords();
  records[2].outcome = 'denied';
  delete records[2].attributes['pixel.owner.state'];

  const result = assessDeviceTraceCompleteness(records);

  assert.equal(result.complete, false);
  assert.equal(result.validation_errors.includes('state.device.projected outcome must be success'), true);
  assert.equal(
    result.validation_errors.includes('state.device.projected requires attribute pixel.owner.state'),
    true,
  );
});
