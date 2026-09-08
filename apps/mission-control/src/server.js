import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { SimulatorDeviceTrustProvider } from '../../../adapters/simulator/src/device-trust-simulator-provider.js';
import { SimulatorIdentityProvider } from '../../../adapters/simulator/src/identity-simulator-provider.js';
import { SimulatorCapabilityGrantProvider } from '../../../adapters/simulator/src/capability-grant-simulator-provider.js';
import { SimulatorJobContextProvider } from '../../../adapters/simulator/src/job-context-simulator-provider.js';
import { SimulatorRelayStoreAdapter } from '../../../adapters/simulator/src/relay-store-simulator-adapter.js';
import {
  assertDeviceAdapter,
  readDeviceSnapshot,
} from '../../../packages/adapter-sdk/src/device-adapter.js';
import { SimulatorSystemStatusWorker } from '../../../adapters/simulator/src/system-status-worker-simulator-adapter.js';
import { EvidenceRecorder } from '../../../packages/telemetry/src/evidence-recorder.js';
import { AccessGate } from '../../../services/access-gate/src/access-gate.js';
import { createAccessHttpHandler } from '../../../services/access-gate/src/http-handler.js';
import { DeviceStateProjector } from '../../../services/device-state-api/src/device-state-projector.js';
import { createPixelHttpServer } from '../../../services/device-state-api/src/http-api.js';
import { ENGINEERING_SIMULATED_REQUESTER } from '../../../services/policy/src/trusted-requester-context.js';
import { createRelayHttpHandler } from '../../../services/relay/src/http-handler.js';
import { RelayService } from '../../../services/relay/src/relay-service.js';
import { ToolGateway } from '../../../services/tool-gateway/src/tool-gateway.js';

const STATIC_FILES = new Map([
  ['/', { url: new URL('../public/index.html', import.meta.url), type: 'text/html; charset=utf-8' }],
  ['/styles.css', { url: new URL('../public/styles.css', import.meta.url), type: 'text/css; charset=utf-8' }],
  ['/storage-card.js', { url: new URL('../public/storage-card.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/access-card.js', { url: new URL('../public/access-card.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/storage-card-view.js', { url: new URL('./storage-card-view.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/access-card-view.js', { url: new URL('./access-card-view.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/access-card-controller.js', { url: new URL('./access-card-controller.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
]);

function defaultIds() {
  return {
    nextEventId: () => `evt-${randomUUID()}`,
    nextExecutionId: () => `execution-${randomUUID()}`,
    nextJobId: () => `job-${randomUUID()}`,
    nextSpanId: () => randomBytes(8).toString('hex'),
    nextTraceId: () => randomBytes(16).toString('hex'),
  };
}

function sendStaticFile(response, body, type) {
  const headers = {
    'cache-control': 'no-store',
    'content-length': body.byteLength,
    'content-type': type,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
  if (type.startsWith('text/html')) {
    headers['content-security-policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";
  }
  response.writeHead(200, headers);
  response.end(body);
}

function createStaticHandler() {
  return (request, response, url) => {
    const file = request.method === 'GET' ? STATIC_FILES.get(url.pathname) : null;
    if (!file) {
      return false;
    }

    void readFile(file.url)
      .then((body) => sendStaticFile(response, body, file.type))
      .catch(() => {
        const body = 'Mission Control could not load this resource.';
        response.writeHead(500, {
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
          'content-type': 'text/plain; charset=utf-8',
          'x-content-type-options': 'nosniff',
        });
        response.end(body);
      });
    return true;
  };
}

export async function createMilestoneRuntime({
  adapterFactory,
  scenario = 'healthy',
  accessEnvironment = 'simulation',
  accessIdentityProvider = null,
  accessDeviceTrustProvider = null,
  jobContextProvider = null,
  jobEnvironment = 'simulation',
  jobGrantProvider = null,
  jobStore = null,
  jobWorker = null,
  clock = () => new Date().toISOString(),
  ids = defaultIds(),
}) {
  if (typeof adapterFactory !== 'function') {
    throw new TypeError('Mission Control runtime requires an adapter factory');
  }

  const evidence = new EvidenceRecorder({ clock });
  const jobIds = Object.freeze({
    ...ids,
    nextExecutionId: ids.nextExecutionId ?? (() => `execution-${ids.nextEventId()}`),
    nextJobId: ids.nextJobId ?? (() => `job-${ids.nextEventId()}`),
  });
  const identityProvider = accessIdentityProvider ?? new SimulatorIdentityProvider();
  const deviceTrustProvider = accessDeviceTrustProvider ?? new SimulatorDeviceTrustProvider();
  const accessGate = new AccessGate({
    identityProvider,
    deviceTrustProvider,
    environment: accessEnvironment,
    evidence,
    ids,
    clock,
  });
  const accessHandler = createAccessHttpHandler({ accessGate, evidence, ids });
  const contextProvider = jobContextProvider ?? new SimulatorJobContextProvider();
  const grantProvider = jobGrantProvider ?? new SimulatorCapabilityGrantProvider();
  const relayStore = jobStore ?? new SimulatorRelayStoreAdapter();
  const worker = jobWorker ?? new SimulatorSystemStatusWorker();
  const toolGateway = new ToolGateway({
    environment: jobEnvironment,
    grantProvider,
    store: relayStore,
    worker,
    evidence,
    ids: jobIds,
    clock,
  });
  const relay = new RelayService({
    environment: jobEnvironment,
    contextProvider,
    store: relayStore,
    toolGateway,
    evidence,
    ids: jobIds,
    clock,
  });
  const relayHandler = createRelayHttpHandler({ relay, evidence, ids: jobIds });
  const adapter = assertDeviceAdapter(adapterFactory({ clock, evidence, ids }));
  const projector = new DeviceStateProjector({ evidence, ids, clock });
  const traceId = ids.nextTraceId();
  const event = await readDeviceSnapshot(adapter, {
    scenario,
    traceContext: { traceId },
  });
  evidence.append({
    traceId: event.trace_id,
    spanId: event.span_id,
    serviceName: 'pixel.adapter-sdk',
    eventName: 'adapter.snapshot.received',
    attributes: {
      'pixel.device.role_id': event.device.role_id,
      'pixel.event.schema_version': event.schema_version,
      'pixel.adapter.id': event.provenance.adapter_id,
      'pixel.adapter.source': event.source,
    },
  });
  projector.accept(event);

  const staticHandler = createStaticHandler();
  const server = createPixelHttpServer({
    projector,
    evidence,
    requesterContext: ENGINEERING_SIMULATED_REQUESTER,
    ids,
    fallbackHandler: (request, response, url) => (
      relayHandler(request, response, url)
      || accessHandler(request, response, url)
      || staticHandler(request, response, url)
    ),
  });

  return Object.freeze({
    accessDeviceTrustProvider: deviceTrustProvider,
    accessGate,
    accessIdentityProvider: identityProvider,
    adapter,
    evidence,
    event,
    projector,
    jobContextProvider: contextProvider,
    jobGrantProvider: grantProvider,
    jobIds,
    jobStore: relayStore,
    jobWorker: worker,
    relay,
    server,
    toolGateway,
  });
}
