# Public Alpha Architecture

## PX-001 — storage state vertical slice

`SimulatorStorageAdapter -> pixel.device.snapshot.v1 -> backend projection -> Mission Control storage card -> structured evidence`

Healthy and deterministically degraded storage use the same contract and API. The degraded case reports `at_risk`, creates one deduplicated attention item, and stays consistent from owner summary through technical details. A backend data-boundary test denies an Engineering-scoped requester raw Finance data regardless of client parameters.

## PX-002 — Access Gate trust slice

`protected-app intent -> Identity provider + DeviceTrust provider -> backend Policy -> access decision -> Mission Control presentation`

The client supplies only bounded intent. Identity, device trust, and Policy authority are server-owned and separate. Invalid or unavailable context fails closed, a revoked/untrusted device cannot be bypassed by valid identity, and decision evidence excludes provider errors or attacker-controlled body values.

## PX-003 — Relay and Tool Gateway slice

`job intent -> Relay atomic job -> ACCEPTED -> RUNNING -> Tool Gateway decision -> bounded worker result -> terminal job + evidence`

Relay owns canonical job identity and lifecycle. Idempotency uses an atomic claim-or-return-existing operation. Tool Gateway resolves the complete server-owned capability context at execution time, records a decision before an invocation claim, and allows at most one worker invocation per canonical job. Results and evidence contain enumerated, server-generated summaries rather than arbitrary worker output.

## PX-004 — Memory intake and context packaging slice

`memory intake intent -> server-owned scope/context -> canonical Memory record -> scoped simulator store -> ACCEPTED Relay job -> context request -> deterministic filtering/relevance -> bounded context package -> Relay-linked evidence`

Memory intake accepts only bounded text/tags. Caller/model attempts to provide scope, owner, handling, environment, lifecycle, IDs, timestamps, grants, permissions, Policy, trace, or other authority-shaped fields fail closed before provider/store work. The forged-authority traversal is iterative and capped at exactly 1,024 examined entries.

The Memory service treats store output as untrusted: it copies and validates complete candidate records before tokenization/scoring. Filtering follows `environment -> scope/handling -> lifecycle -> relevance -> budget`, so cross-scope restricted content cannot influence ranking, package contents, or detailed evidence. Relevance is deterministic/model-free and packages include whole records within a 4-item / 2,048-code-point text budget.

Memory never mutates Relay, alters Policy, or mints Tool Gateway capability. Context evidence continues the canonical Relay trace and remains bounded to allowlisted fields/counts.

## PX-005 — Pixel Model Gateway slice

`ACCEPTED Relay job -> approved Memory package -> RUNNING -> Relay-owned invocation -> exact operation eligibility -> deterministic Fake Model A/B route -> bounded Gateway outcome -> Relay terminal result/evidence`

The only operation is `SYSTEM_STATUS_SUMMARY`; callers provide no prompt or model preference. Eligibility requires the exact read-only system-status tuple and is separate from placement. Routing uses only the canonical job environment: simulation selects Fake Model A, dev selects Fake Model B, and every other route stops without fallback.

Relay creates and atomically claims the immutable invocation after Memory package construction and the RUNNING transition. Canonical SHA-256 bindings cover the complete Memory package and fixed instruction template. Gateway independently resolves and validates those bindings, applies Pixel Alpha token-unit caps, sends only fixed instruction plus approved item text to one adapter, and rejects unsafe/malformed results. Relay alone validates the bounded outcome and commits the terminal Pixel result; runtime/model identity never replaces the Pixel agent binding.

## PX-006 — Organizational State + Scheduler slice

`ACCEPTED Relay job -> canonical Organizational State facts -> Scheduler eligibility -> lease-bounded reservation -> live stage-two recheck -> RUNNING`

Organizational State owns approvals, delegations, holds, duty, capacity, and derived Company State. Mutable facts use positive revisions, optimistic stale-write protection, and Trusted Time expiry evaluation. Scheduler consumes these facts but cannot grant authority: `ELIGIBLE`, `WAIT`, `HOLD`, and `DENY` are decision classes rather than Relay lifecycle states.

Capacity reservations are atomic per resource, revision-bound, and lease-bounded. Immediately before execution, Scheduler rechecks current job revision, lease, holds, Company State, duty/capacity, approval, delegation, and environment. Relay remains the lifecycle owner. Approved Memory packages remain protected while in flight and are released only from Relay terminal truth.

## PX-007 — Incident + degraded-state slice

`declared incident -> canonical Incident truth -> Organizational State composition -> Scheduler reaction -> stage-two safety recheck`

Incident owns class, severity, exactly one commander, lifecycle, response phase, impact, affected references, recovery state, and bounded evidence. Deterministic environmental normalization maps incident facts into the existing Company State precedence seam. Incident-linked holds reuse the existing Organizational State hold classes.

Scheduler rechecks incident safety immediately before `RUNNING`. Resolving one incident cannot clear another incident or hold, and an unavailable or malformed configured incident seam fails closed.

## PX-008 — Company calendar + recurring-work slice

`company hours and events -> canonical Calendar facts -> Organizational State/Scheduler composition -> deterministic recurring Relay submission -> bounded checkpoints`

Calendar owns half-open operating windows, local holidays and maintenance, immutable recurring-template revisions, deterministic occurrence identity, and forward-only checkpoints. Trusted Time provides the authoritative clock. Organizational State composes incident-precedence and operating facts; Scheduler reacts to those facts but does not grant authority. Recurring work enters Relay through canonical idempotent submission, and unknown overlap remains blocked.

## PX-009 — Workforce + AgentOps slice

`server-resolved persistent Pixel identity -> canonical Workforce record -> qualification/attribution/evidence -> AgentOps projection -> Scheduler stage-two recheck`

Workforce owns persistent synthetic employee identity, lifecycle, role/department history, per-capability qualification, causal attribution, and bounded evidence. Model, provider, harness, and session identities remain replaceable and cannot become Pixel authority. AgentOps derives bounded `NORMAL`, `WATCH`, and `REVIEW` projections from canonical evidence. Qualification is eligibility only; it does not mint authorization.

## PX-010 — Mission Control Home slice

`canonical device/Relay/Org State/Incident/Workforce seams -> bounded overview projection -> exact freshness token -> GET endpoint -> browser Home rendering`

Mission Control Home is presentation-only. The server normalizes a strict `pixel.mission-control-overview.v1` projection, bounds every section and the whole envelope, and owns an exact decimal `{ epoch, sequence }` freshness order. The browser compares tokens with BigInt, rejects equal or older responses, and renders explicit source modes and availability states. Failed, unavailable, stale, denied, and unknown sources remain explicit; one failed section cannot silently make another healthy or clear an incident.

Recent Work is a bounded read-only Relay projection. Workforce Home data is aggregate-only. Mission Control creates no identity, policy, lifecycle, scheduler, incident, calendar, workforce, memory, model, tool, or evidence authority.

## Beyond the current candidate

PX-010 is the newest slice in this candidate. Public `main` currently contains PX-001 through PX-005. PX-011 and later private milestones are withheld until separate owner-gated public-sync revisions export and review them; nothing in this document authorizes or previews unpublished behavior.

## Replacement boundaries

All public code consumes Pixel-owned interfaces. The included Registry is a minimal synthetic fixture with the same `getSystemsJobBinding()` interface used by the private composition boundary. It is not a copy or subset of a private roster. Future reviewed Registry, durable Relay/Memory stores, providers, workers, model runtimes, or live device adapters can replace simulation counterparts only while preserving service-side validation and authority rules.

## Explicit limits

The Alpha source does not provide production PKI, secrets management, production authentication, real infrastructure/model providers, durable execution/storage, retry/recovery/fallback, streaming, a broker, durable scheduling, autonomous agents, a production-grade Memory database, production Workforce/AgentOps management, production calendar integrations, vendor token accounting, or model-driven authorization. Mission Control is an unauthenticated Alpha service: it defaults to `127.0.0.1`, configuration can override the bind address, and non-loopback or production exposure requires a separately authorized security milestone. Recognizing an environment name never authorizes deployment there.
