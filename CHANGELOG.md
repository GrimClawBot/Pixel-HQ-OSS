# Changelog

All notable public-safe changes to Pixel HQ are recorded here. This file is descriptive release history; architecture authority remains in the relevant reviewed design and security process.

## Unreleased

### Repository presentation and community readiness

- redesigned the public README around a concise project identity, current capabilities, quick demo, architecture map, and security model;
- added a public threat model, architecture overview, directional roadmap, support guide, and guided demo;
- added local visual assets for the README without introducing runtime dependencies;
- clarified public vulnerability-reporting behavior for an already-public repository;
- added issue-template configuration to keep reports structured.

## 0.1.0-alpha — 2026-09-08

Initial public-safe Alpha source export.

### Included

- **PX-001:** simulator-backed device/storage state, backend projection, Mission Control, deterministic degraded-state handling, and evidence;
- **PX-002:** separate Identity and DeviceTrust context, deterministic Access Gate decisions, and protected-app presentation;
- **PX-003:** atomic Relay lifecycle, execution-time Tool Gateway authorization, deterministic simulated worker, bounded result, and causal evidence;
- Apache-2.0 licensing and public contribution/security documentation;
- public-safe synthetic Registry composition;
- CI, source validation, contract/integration/security/UI/evidence tests.

### Known Alpha limits

- in-memory state resets on process restart;
- no production PKI, secret vault, durable queue, scheduler, real hardware adapter, recovery system, or continuously running agent runtime;
- no production network exposure is implied by the local simulator.
