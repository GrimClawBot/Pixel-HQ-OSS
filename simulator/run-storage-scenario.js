import { resolve } from 'node:path';
import { openFreshnessState } from '../apps/mission-control/src/freshness-state.js';
import { OrganizationalStateService } from '../services/organizational-state/src/org-state-service.js';
import { SimulatorOrgStateStoreAdapter } from '../adapters/simulator/src/org-state-store-simulator-adapter.js';
import { EvidenceRecorder } from '../packages/telemetry/src/evidence-recorder.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { SimulatorStorageAdapter } from '../adapters/simulator/src/storage-simulator-adapter.js';
import { createMilestoneRuntime } from '../apps/mission-control/src/server.js';

const scenarioArgument = process.argv.find((argument) => argument.startsWith('--scenario='));
const scenario = scenarioArgument?.slice('--scenario='.length) ?? 'healthy';
const allowedScenarios = new Set(['healthy', 'degraded-storage']);

if (!allowedScenarios.has(scenario)) {
  throw new RangeError(`Unsupported milestone scenario: ${scenario}`);
}

const clock = () => new Date().toISOString();
const orgState = new OrganizationalStateService({ environment: 'simulation', store: new SimulatorOrgStateStoreAdapter(),
  evidence: new EvidenceRecorder({ clock }), clock,
  ids: { nextEventId: () => `evt-${randomUUID()}`, nextSpanId: () => randomBytes(8).toString('hex'), nextTraceId: () => randomBytes(16).toString('hex') },
});
let overviewFreshness = null;
try { overviewFreshness = openFreshnessState(resolve(process.env.PIXEL_OVERVIEW_STATE_DIR ?? '.pixel/runtime/mission-control-freshness')); }
catch { process.stderr.write('Mission Control freshness unavailable; overview will fail closed.\n'); }
const runtime = await createMilestoneRuntime({
  overviewFreshness, orgState, overviewSourceMode: 'SIMULATED',
  adapterFactory: (dependencies) => new SimulatorStorageAdapter(dependencies),
  scenario,
});
const port = Number.parseInt(process.env.PIXEL_PORT ?? '4173', 10);
const host = process.env.PIXEL_HOST ?? '127.0.0.1';

runtime.server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({
    event_name: 'pixel.milestone.runtime.started',
    environment: 'simulation',
    host,
    port,
    scenario,
    trace_id: runtime.event.trace_id,
  })}\n`);
});
