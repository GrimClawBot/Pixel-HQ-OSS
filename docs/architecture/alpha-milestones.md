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

## Replacement boundaries

All public code consumes Pixel-owned interfaces. The included Registry is a minimal synthetic fixture with the same `getSystemsJobBinding()` interface used by the private composition boundary. It is not a copy or subset of a private roster. A future reviewed Registry, durable Relay store, grant provider, worker, or live device adapter can replace its simulation counterpart without changing callers.

## Explicit limits

The Alpha source does not provide production PKI, secrets management, real infrastructure adapters, durable execution, retry/recovery, a broker, a scheduler, or autonomous agents. Recognizing an environment name never authorizes deployment there.
