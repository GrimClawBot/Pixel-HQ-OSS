<p align="center">
  <img src="docs/assets/pixel-hq-banner.svg" alt="Pixel HQ — secure infrastructure for AI organizations" width="100%">
</p>

<p align="center"><strong>Simulator-first • contract-driven • security-oriented • vendor-neutral</strong></p>

<p align="center">
  <a href="https://github.com/GrimClawBot/Pixel-HQ-OSS/actions/workflows/pixel-hq-ci.yml"><img alt="Pixel HQ CI" src="https://github.com/GrimClawBot/Pixel-HQ-OSS/actions/workflows/pixel-hq-ci.yml/badge.svg"></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/Node-22%2B-3c873a">
  <img alt="License Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue">
  <img alt="Runtime dependencies zero" src="https://img.shields.io/badge/runtime%20dependencies-0-5b5bd6">
</p>

# Pixel HQ

**Pixel HQ is a secure operating layer for AI-assisted organizations.** The public Alpha proves that identity, device trust, jobs, Memory, model/tool execution, policy, and evidence can stay under deterministic Pixel-owned contracts instead of being implicitly controlled by a model, client, hardware vendor, or workflow framework.

This repository is a **public-safe Alpha architecture proof**. It does not claim production authentication, PKI, durable infrastructure control, recovery, or continuously running autonomous agents.

## Why Pixel HQ is different

- **Models are runtimes, not identities.** A model or coding harness can be replaced without redefining the organization.
- **Clients are not authority.** Identity, trust, ownership, lifecycle, scope, grants, and tool permissions are resolved server-side.
- **Memory is data, not authority.** Remembered text can provide context but cannot grant permissions, widen scope, or mutate job/tool authority.
- **Model invocation is bounded.** Relay owns the fixed operation and immutable invocation; Model Gateway routes only to deterministic Alpha simulators and cannot own lifecycle state.
- **Tools are capability-gated.** Execution authority is checked at the Tool Gateway rather than inferred from agent intent.
- **Simulation comes first.** Hardware-facing behavior is proven against replaceable simulator/live-shaped seams before production adapters exist.
- **Evidence is part of the design.** Material state changes and security decisions are structured so they can be reviewed and reconstructed.

## What works today

| Slice | What it proves | Status |
| --- | --- | --- |
| **PX-001 — Device state** | Simulator → versioned device contract → backend projection → Mission Control, including degraded-state evidence | ✅ Public Alpha |
| **PX-002 — Trust / access** | Identity + DeviceTrust → deterministic Access Gate; browser claims never become authority | ✅ Public Alpha |
| **PX-003 — Job execution** | Atomic Relay lifecycle → Tool Gateway → deterministic worker → bounded result + causal evidence | ✅ Public Alpha |
| **PX-004 — Memory / context** | Strict intake/record/package contracts → server-owned scope → post-adapter policy/relevance filtering → bounded context + Relay-linked evidence | ✅ Public Alpha |

## Try Pixel HQ in 60 seconds

Requirements: **Node.js 22+** and Git. There are **no third-party runtime dependencies**.

```bash
git clone https://github.com/GrimClawBot/Pixel-HQ-OSS.git
cd Pixel-HQ-OSS
npm run check
npm start
```

Open `http://127.0.0.1:4173`.

Want to see the deterministic failure path?

```bash
npm run start:degraded
```

See [`docs/DEMO.md`](docs/DEMO.md) for the guided walkthrough.

<p align="center">
  <img src="docs/assets/mission-control-alpha.svg" alt="Illustrative view of the current Mission Control Alpha surface" width="92%">
</p>

## Architecture at a glance

```mermaid
flowchart LR
    C[Client / Mission Control] --> A[Access Gate]
    A --> R[Pixel Relay]
    R --> M[Memory]
    R --> MG[Model Gateway]
    R --> T[Tool Gateway]
    T --> W[Deterministic Worker]
    MG --> FM[Fake Model A / B]

    I[Identity] --> A
    D[DeviceTrust] --> A
    P[Pixel Policy] --> A
    P --> M
    P --> T

    A --> E[Structured Evidence]
    R --> E
    M --> E
    MG --> E
    T --> E
    W --> E
```

**Authority flows through Pixel services; client/model/Memory text is data.**

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`THREAT_MODEL.md`](THREAT_MODEL.md) for the deeper model.

## Security by construction

The public Alpha includes explicit tests for fail-closed behavior, forged authority, revoked/untrusted devices, cross-department restricted data, Relay idempotency, malformed adapter output, bounded authority traversal, inert prompt injection, deterministic Memory filtering, bounded tool/Memory results, and evidence completeness.

## Project map

- `adapters/simulator/` — deterministic Alpha providers, stores, workers, and fake models
- `packages/contracts/` — versioned contracts and JSON Schemas
- `packages/adapter-sdk/` — replaceable runtime boundaries
- `packages/registry/` — synthetic public composition fixture
- `packages/telemetry/` — structured evidence and completeness checks
- `services/` — device projection, Policy, Access Gate, Relay, Memory, Model Gateway, and Tool Gateway
- `apps/mission-control/` — lightweight presentation and local composition
- `tests/` — contract, integration, security, UI, and evidence coverage
- `docs/` — public architecture and demo documentation

## Project direction

See [`ROADMAP.md`](ROADMAP.md). It separates **shipped public Alpha**, **next work**, and **later direction** so roadmap ideas are not mistaken for current functionality.

## Contributing and support

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SUPPORT.md`](SUPPORT.md). Security-sensitive reports belong through [`SECURITY.md`](SECURITY.md), not a public exploit issue.

## Release history

See [`CHANGELOG.md`](CHANGELOG.md). GitHub release tags remain maintainer-gated.

## License

The reviewed public source is licensed under the [Apache License 2.0](LICENSE). Project names and marks are not licensed beyond customary descriptive use.
