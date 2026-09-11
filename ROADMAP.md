# Pixel HQ Public Roadmap

This roadmap is **directional**. It communicates project intent to contributors and evaluators, but it does not authorize implementation by itself. Security, architecture, and release gates still apply.

## Shipped public Alpha

### PX-001 — Device state ✅

- simulator-backed storage/device state;
- versioned Pixel-owned contract;
- backend projection and Mission Control card;
- deterministic degraded-state handling;
- structured evidence and a data-boundary denial proof.

### PX-002 — Trust / Access Gate ✅

- separate Identity and DeviceTrust providers;
- deterministic protected-app Policy;
- server-owned allow/deny decision;
- fail-closed malformed/stale/untrusted paths;
- Mission Control presentation without client-created authority.

### PX-003 — Relay / Tool Gateway ✅

- atomic canonical job identity/lifecycle;
- idempotent acceptance;
- execution-time capability resolution;
- deterministic simulated worker;
- bounded result and causal evidence.

### PX-004 — Memory / context ✅

- strict Memory intake/record/context/package contracts;
- server-owned department scope, environment, handling, lifecycle, provenance, and budget;
- bounded iterative forged-authority scanning;
- post-adapter copy/revalidation;
- deterministic `environment → scope/handling → lifecycle → relevance → budget` filtering;
- whole-record 4-item / 2,048-code-point context packaging;
- Relay-linked evidence and trace completeness.

### PX-005 — Pixel Model Gateway ✅

- Relay-owned immutable `SYSTEM_STATUS_SUMMARY` invocation bound to an approved Memory package;
- exact read-only operation eligibility kept separate from placement;
- deterministic `simulation → Fake Model A` and `dev → Fake Model B` routing;
- fixed Pixel instruction with pre/post Pixel Alpha token-unit caps;
- unsafe/malformed adapter output rejection and no fallback;
- truthful model provenance, Relay-owned terminal results, and causal evidence.

## Next Alpha direction

The next implementation milestone should remain separately authorized and simulator-first. Candidate areas include:

- additional separately reviewed simulator-first operational slices;
- richer Mission Control owner visibility for jobs, Memory, reviews, and incidents;
- persistent Pixel employee identities independent of model/harness sessions;
- stronger release/recovery evidence and additional simulator-backed infrastructure domains.

## Pixel Office direction

Pixel Office is planned as a **replaceable visualization of canonical Pixel state**, not an authorization system. The current design direction includes a lightweight campus, persistent Pixel employees, real badges/clearances, Access Gate-backed visible gates, and separate Infrastructure, Academy, and Quarantine layers.

The renderer must never become the source of identity, permissions, job state, Memory, or infrastructure authority.

## Beta direction

Beta is intended to prove the same contracts against real infrastructure and real runtime adapters rather than replacing the simulator with ad-hoc production code.

Candidate areas include:

- live device/network/storage adapters;
- local/cloud model routing;
- durable storage/queues where justified;
- device enrollment/trust and revocation;
- operational power/thermal state;
- HomeLab digital-twin inputs for Mission Control/Pixel Office.

Hardware, model, vendor, and deployment choices remain late-bound and should be re-evaluated near deployment.

## What is deliberately not promised

This roadmap does not promise dates, specific vendors/models, production security certification, multi-tenant hosting, or autonomous high-risk actions. Those require separate design and validation.

## How to propose roadmap work

Use the feature-request template and explain:

1. the problem being solved;
2. which current invariant must remain true;
3. why the change belongs in Alpha, Beta, or later;
4. how it can be simulated/tested before production;
5. security/privacy implications;
6. what would prove the change is complete.
