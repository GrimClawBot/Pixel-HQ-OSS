<p align="center">
  <img src="docs/assets/pixel-hq-banner.svg" alt="Pixel HQ — secure infrastructure for AI organizations" width="100%">
</p>

<p align="center">
  <strong>Simulator-first • contract-driven • security-oriented • vendor-neutral</strong>
</p>

<p align="center">
  <a href="https://github.com/GrimClawBot/Pixel-HQ-OSS/actions/workflows/pixel-hq-ci.yml"><img alt="Pixel HQ CI" src="https://github.com/GrimClawBot/Pixel-HQ-OSS/actions/workflows/pixel-hq-ci.yml/badge.svg"></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/Node-22%2B-3c873a">
  <img alt="License Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue">
  <img alt="Runtime dependencies zero" src="https://img.shields.io/badge/runtime%20dependencies-0-5b5bd6">
</p>

# Pixel HQ

**Pixel HQ is a secure operating layer for AI-assisted organizations.** The public Alpha proves that identity, device trust, jobs, tool execution, policy, and evidence can stay under deterministic Pixel-owned contracts instead of being implicitly controlled by a model, client, hardware vendor, or workflow framework.

This repository is a **public-safe Alpha architecture proof**. It does not claim production authentication, PKI, durable infrastructure control, recovery, or continuously running autonomous agents.

## Why Pixel HQ is different

- **Models are runtimes, not identities.** A model or coding harness can be replaced without redefining the organizational boundary.
- **Clients are not authority.** Identity, trust, ownership, lifecycle, grants, and tool permissions are resolved server-side.
- **Tools are capability-gated.** Execution authority is checked at the Tool Gateway rather than inferred from agent intent.
- **Simulation comes first.** Hardware-facing behavior is proven against replaceable simulator/live-shaped seams before production adapters exist.
- **Evidence is part of the design.** Material state changes and security decisions are structured so they can be reviewed and reconstructed.

## What works today

| Slice | What it proves | Status |
| --- | --- | --- |
| **PX-001 — Device state** | Simulator → versioned device contract → backend projection → Mission Control, including degraded-state evidence | ✅ Public Alpha |
| **PX-002 — Trust / access** | Separate Identity + DeviceTrust inputs → deterministic Access Gate → protected-app decision; browser claims never become authority | ✅ Public Alpha |
| **PX-003 — Job execution** | Atomic Relay lifecycle → execution-time Tool Gateway decision → deterministic worker → bounded result + causal evidence | ✅ Public Alpha |

The next reviewed public export is expected to add the Memory/context slice only after it passes the same owner-gated export process. Roadmap direction is not implementation authorization.

## Try Pixel HQ in 60 seconds

Requirements: **Node.js 22+** and Git. There are **no third-party runtime dependencies**.

```bash
git clone https://github.com/GrimClawBot/Pixel-HQ-OSS.git
cd Pixel-HQ-OSS
npm run check
npm start
```

Open `http://127.0.0.1:4173`.

Want to see the system handle a deterministic failure path?

```bash
npm run start:degraded
```

See [`docs/DEMO.md`](docs/DEMO.md) for the guided healthy/degraded walkthrough.

<p align="center">
  <img src="docs/assets/mission-control-alpha.svg" alt="Illustrative map of the current Mission Control Alpha surface" width="92%">
</p>

## Architecture at a glance

```mermaid
flowchart LR
    C[Client / Mission Control] --> A[Access Gate]
    A --> R[Pixel Relay]
    R --> T[Tool Gateway]
    T --> W[Deterministic Worker]

    I[Identity Provider] --> A
    D[DeviceTrust Provider] --> A
    P[Pixel Policy] --> A
    P --> T
    G[Synthetic Registry] --> R

    A --> E[Structured Evidence]
    R --> E
    T --> E
    W --> E

    S[Simulator Adapters] -. same Pixel-owned seams .-> A
    S -.-> R
    S -.-> W
```

The important rule is simple: **authority flows through Pixel services; model/client content is data.**

For a deeper explanation, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Security by construction

The public Alpha includes explicit tests for fail-closed behavior, forged authority, cross-department data boundaries, invalid or revoked device trust, Relay idempotency, bounded tool results, and evidence completeness.

Read [`THREAT_MODEL.md`](THREAT_MODEL.md) for the public trust boundaries and threat/control matrix, and [`SECURITY.md`](SECURITY.md) before reporting a vulnerability.

## Project map

- `adapters/simulator/` — deterministic Alpha providers and workers
- `packages/contracts/` — versioned contracts and JSON Schemas
- `packages/adapter-sdk/` — replaceable runtime boundaries
- `packages/registry/` — synthetic public composition fixture
- `packages/telemetry/` — structured evidence and completeness checks
- `services/` — device projection, Policy, Access Gate, Relay, and Tool Gateway
- `apps/mission-control/` — lightweight presentation and local composition
- `tests/` — contract, integration, security, UI, and evidence coverage
- `docs/` — public architecture and demo documentation

## Project direction

See [`ROADMAP.md`](ROADMAP.md). It separates **shipped public Alpha**, **next reviewed exports**, and **later direction** so future ideas are not mistaken for current functionality.

## Contributing and support

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SUPPORT.md`](SUPPORT.md). Security-sensitive reports belong through the process in [`SECURITY.md`](SECURITY.md), not a public exploit issue.

## Release history

See [`CHANGELOG.md`](CHANGELOG.md). The current repository package version is `0.1.0-alpha`; GitHub release tags remain maintainer-gated.

## License

The reviewed public source is licensed under the [Apache License 2.0](LICENSE). Project names and marks are not licensed beyond customary descriptive use.
