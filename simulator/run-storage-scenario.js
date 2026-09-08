import { SimulatorStorageAdapter } from '../adapters/simulator/src/storage-simulator-adapter.js';
import { createMilestoneRuntime } from '../apps/mission-control/src/server.js';

const scenarioArgument = process.argv.find((argument) => argument.startsWith('--scenario='));
const scenario = scenarioArgument?.slice('--scenario='.length) ?? 'healthy';
const allowedScenarios = new Set(['healthy', 'degraded-storage']);

if (!allowedScenarios.has(scenario)) {
  throw new RangeError(`Unsupported milestone scenario: ${scenario}`);
}

const runtime = await createMilestoneRuntime({
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
