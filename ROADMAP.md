# Pixel HQ Public Roadmap

This roadmap is **directional**. It communicates project intent to contributors and evaluators, but it does not authorize implementation by itself. Security, architecture, and release gates still apply.

## Shipped public Alpha

### PX-001 — Device state ✅

- simulator-backed storage/device state;
- versioned Pixel-owned contract;
- backend projection;
- Mission Control card;
- degraded-state attention/evidence;
- one data-boundary denial proof.

### PX-002 — Trust / Access Gate ✅

- separate Identity and DeviceTrust providers;
- deterministic protected-app Policy;
- server-owned access decision;
- fail-closed malformed/stale/untrusted paths;
- Mission Control presentation without client-created authority.

### PX-003 — Relay / Tool Gateway ✅

- atomic canonical job identity/lifecycle;
- idempotent acceptance;
- execution-time capability resolution;
- deterministic simulated worker;
- bounded job result;
- causal evidence and completeness checks.

## Next reviewed public export

### Memory / context packaging

The next public export is expected to add a bounded Memory/context slice after it is merged privately and separately passes the public-export security/review process.

Goals include:

- Memory as data, never authority;
- server-owned scope/context;
- deterministic filtering and relevance;
- bounded context packages;
- Relay-linked evidence;
- simulator-first storage seams.

Nothing in this section should be read as proof that the current public tag already contains those capabilities.

## Later Alpha direction

- model/runtime gateway with replaceable provider adapters;
- richer Mission Control owner visibility;
- persistent Pixel agent identities independent of model sessions;
- more explicit review/oversight flows;
- stronger release and recovery evidence;
- additional simulator-backed infrastructure domains.

## Beta direction

Beta is intended to prove the same contracts against real infrastructure and real runtime adapters rather than simply replacing the simulator with ad-hoc production code.

Candidate areas include:

- live device/network/storage adapters;
- local/cloud model routing;
- durable storage/queues where justified;
- device enrollment/trust;
- operational power/thermal state;
- Pixel Office as a replaceable visualization of canonical Pixel state.

Hardware, model, vendor, and deployment choices remain late-bound and must be re-evaluated near deployment.

## What is deliberately not promised

This roadmap does not promise dates, specific vendors, specific models, production security certification, multi-tenant hosting, or autonomous high-risk actions. Those require separate design and validation.

## How to propose roadmap work

Use the feature-request template and explain:

1. the problem being solved;
2. which current invariant must remain true;
3. why the change belongs in Alpha, Beta, or later;
4. how it can be simulated/tested before production;
5. security/privacy implications;
6. what would prove the change is complete.
