# Changelog

All notable **public-safe** changes to Pixel HQ are recorded here. Architecture authority remains in the relevant reviewed design/security process.

## Unreleased

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
- no production PKI, secret vault, durable queue/database, scheduler, real hardware adapter, recovery system, production-grade Memory store, or continuously running LLM workforce;
- no production network exposure is implied by the local simulator.
