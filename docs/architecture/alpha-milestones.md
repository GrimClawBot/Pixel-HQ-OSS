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

## Replacement boundaries

All public code consumes Pixel-owned interfaces. The included Registry is a minimal synthetic fixture with the same `getSystemsJobBinding()` interface used by the private composition boundary. It is not a copy or subset of a private roster. Future reviewed Registry, durable Relay/Memory stores, providers, workers, model gateways, or live device adapters can replace simulation counterparts only while preserving service-side validation and authority rules.

## Explicit limits

The Alpha source does not provide production PKI, secrets management, real infrastructure adapters, durable execution/storage, retry/recovery, a broker, a scheduler, autonomous agents, a production-grade Memory database, or model-driven authorization. Recognizing an environment name never authorizes deployment there.
