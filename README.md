# Pixel HQ

Pixel HQ is a simulator-first, contract-driven Alpha platform for exploring secure AI-assisted operations without coupling higher layers to a hardware vendor, model provider, or workflow framework.

The current public-safe source demonstrates three completed vertical slices:

1. **PX-001 — device state:** a simulated storage device emits the same versioned contract a future live adapter would use; backend projection drives one Mission Control card, attention deduplication, Policy denial, and structured evidence.
2. **PX-002 — trust/access:** separate simulated identity and device-trust providers feed a deterministic backend Access Gate. Mission Control presents the result and cannot turn client claims into authority.
3. **PX-003 — job execution:** Relay atomically owns canonical job identity and lifecycle, Tool Gateway resolves execution-time capability authority, and one deterministic worker produces a bounded result with causal evidence.

These are architecture proofs, not production authentication, PKI, infrastructure administration, recovery, or autonomous agent systems.

## Requirements and quick start

- Node.js 22 or newer
- Git for contribution workflows; no runtime dependencies are required

```bash
npm run check:source
npm test
npm start
```

Open `http://127.0.0.1:4173` for the healthy simulation. Run `npm run start:degraded` for the deterministic degraded-storage path. Set `PIXEL_HOST` or `PIXEL_PORT` only for local development; no production exposure is configured or implied.

## Architectural guarantees demonstrated

- Pixel-owned, versioned JSON contracts validate canonical device, access, job, transition, tool-decision, execution, and result data.
- Simulator and live-shaped implementations share adapter interfaces.
- Client-supplied identity, trust, grant, lifecycle, and worker claims fail closed.
- A valid identity cannot bypass an untrusted or revoked device.
- Cross-department raw-data access is denied by a backend Policy proof.
- Relay idempotency is atomic and a canonical job can invoke at most one worker.
- Repeated API reads branch from stable canonical evidence instead of changing execution history.
- Result summaries and evidence are bounded and exclude arbitrary tool output.

## Alpha limits

State, evidence, jobs, and idempotency records are in-memory and reset when the process stops. There is no production identity/PKI, secret vault, durable queue, broker, retry/recovery protocol, scheduler, real hardware adapter, production network exposure, or continuously running LLM agent. The simulated Registry is a minimal public fixture, not an organizational authority or production roster.

## Repository guide

- `adapters/simulator/` — deterministic Alpha providers and workers
- `packages/contracts/` — versioned contracts and schemas
- `packages/adapter-sdk/` — replaceable boundary validation
- `packages/registry/` — synthetic public composition fixture
- `packages/telemetry/` — structured evidence and completeness checks
- `services/` — device projection, Policy, Access Gate, Relay, and Tool Gateway
- `apps/mission-control/` — lightweight presentation and local composition
- `tests/` — contract, integration, security, UI, and evidence coverage
- `docs/` — public architecture summaries

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [docs/README.md](docs/README.md) before contributing.

## License

The reviewed public source is licensed under the [Apache License 2.0](LICENSE). Project names and marks are not licensed beyond customary descriptive use.
