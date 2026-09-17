# Changelog

All notable **public-safe** changes to Pixel HQ are recorded here. Architecture authority remains in the relevant reviewed design/security process.

## Unreleased

This OSS-006 candidate contains PX-001 through PX-010. Public `main` currently contains PX-001 through PX-005. The latest tagged release, `v0.2.0-alpha`, predates PX-005 and does **not** include it.

### PX-010 — Mission Control Home integration

- added a read-only Mission Control Home overview over canonical device, Relay, Organizational State, Incident, and Workforce seams;
- added a strict `pixel.mission-control-overview.v1` contract with bounded sections, counters, lists, metadata, and a 64 KiB envelope limit;
- added exact decimal freshness tokens, durable epoch state, and BigInt-based browser comparison so older responses cannot overwrite newer state;
- added explicit source modes, stale/unavailable/denied/failed/unknown states, isolated section failures, and incident uncertainty handling;
- added responsive, keyboard-navigable, and mobile-accessible presentation without UI-created authority;
- added focused contract, integration, and UI tests for projection bounds, freshness, HTTP behavior, rendering, source modes, and security boundaries.

### PX-009 — Workforce + AgentOps foundation

- added persistent synthetic employee records with lifecycle, role/department history, optimistic revisions, and server-resolved identity;
- added per-capability qualification, causal attribution, bounded evidence, and deterministic AgentOps projections;
- composed Workforce facts with Organizational State and added fail-closed Scheduler stage-two checks;
- kept qualification separate from authorization and model/provider/harness identity;
- added focused contract, evidence, integration, and seam-failure tests.

### PX-008 — Company calendar + recurring work foundation

- added half-open calendar events, company hours, recurring templates, occurrences, and forward-only checkpoint contracts;
- composed Calendar operating facts with Trusted Time, Organizational State, Incident, and Scheduler boundaries;
- submitted recurring work through deterministic Relay idempotency without adding a second lifecycle engine;
- added bounded missed-run, replay, overlap, and checkpoint behavior;
- added focused contract, evidence, integration, mutation, and seam-failure tests.

### PX-007 — Incident + degraded-state foundation

- added canonical incident lifecycle, commander, phase, impact, recovery, closure, and bounded evidence contracts;
- composed deterministic incident/environmental facts through Organizational State without adding a second authority source;
- added incident-linked holds and fail-closed stage-two Scheduler safety rechecks;
- added focused contract, evidence, integration, store, and seam-failure tests.

### PX-006 — Organizational State + Scheduler foundation

- added canonical coordination facts with Trusted Time expiry and optimistic revision protection;
- added fail-closed Scheduler eligibility, atomic lease-bounded reservations, and stage-two start confirmation;
- kept authorization in Access/Policy and canonical job lifecycle in Relay;
- coupled approved Memory package cleanup to Relay terminal truth with in-flight protection;
- added focused contract, evidence, integration, race, reservation, retention, and security tests.

### PX-005 — reviewed hardening

- included the complete reviewed post-publication hardening for model/runtime adapter boundaries, schemas, Policy, Model Gateway, Relay, telemetry, and focused tests;
- retained deterministic simulator routing, bounded outcomes, and Relay-owned terminal state without fallback.

### PX-005 — Pixel Model Gateway

- added five strict Pixel-owned model invocation/routing/provider/outcome contracts and schemas;
- bound Relay-created immutable invocations to approved Memory packages and fixed instructions using canonical SHA-256 bindings;
- separated exact operation eligibility from deterministic simulator placement (`simulation → Fake Model A`, `dev → Fake Model B`);
- enforced route input/output caps in Pixel Alpha token units with no provider fallback;
- rejected accessor-backed, exotic-prototype, cyclic, malformed, or identity-substituted provider data;
- preserved PX-003 worker execution while adding a mutually exclusive model claim/provenance path for truthful Relay terminal commits;
- added model/job evidence completeness without recording Memory or model output text.

### Repository presentation and community readiness

- redesigned the README around project identity, shipped capabilities, a 60-second demo, architecture map, security model, and contributor navigation;
- added public architecture, threat model, roadmap, support, changelog, and demo documentation;
- added local README visual assets without adding runtime dependencies;
- added public-safe CODEOWNERS and structured issue configuration;
- clarified vulnerability-reporting behavior for an already-public repository.

## 0.1.0-alpha — current Alpha line

### PX-004 — Memory / context

- added strict `pixel.memory.*.v1` runtime contracts and structural/lexical JSON Schemas;
- added simulator intake-context and in-memory store adapters behind Pixel-owned seams;
- kept caller/model Memory content non-authoritative while deriving canonical scope/context server-side;
- added iterative 1,024-entry authority scanning and fail-closed malformed-input handling;
- revalidated adapter-returned records before deterministic scope/lifecycle/relevance filtering;
- added bounded whole-record context packaging and Relay-linked trace completeness;
- added security regressions for cross-scope restricted data, prompt injection, deep/wide malformed input, schema/runtime semantic gaps, evidence leakage, and snapshot-before-validation store integrity.

### PX-001 through PX-003

- **PX-001:** simulator-backed device/storage state, backend projection, Mission Control, deterministic degraded-state handling, and evidence;
- **PX-002:** separate Identity and DeviceTrust context, deterministic Access Gate decisions, and protected-app presentation;
- **PX-003:** atomic Relay lifecycle, execution-time Tool Gateway authorization, deterministic simulated worker, bounded result, and causal evidence;
- Apache-2.0 licensing, CI, source validation, and public contribution/security documentation.

### Known Alpha limits

- process-local state resets on restart;
- no production PKI, secret vault, durable queue/database, real hardware adapter, recovery system, production-grade Memory store, or continuously running LLM workforce;
- no production network exposure is implied by the local simulator.
