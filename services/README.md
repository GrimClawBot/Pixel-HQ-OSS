# Services

Pixel platform services live here.

Examples from the signed architecture include Identity, Policy, Relay, Memory, Scheduler, Vault, Tool Gateway, Config, Observatory, Incident, System Verification, Update Manager, and related platform components.

Do not create duplicate services for capabilities already owned by a named Pixel component.

## Current implementation

- `device-state-api/` validates and projects device events, deduplicates active attention, and exposes the Milestone 1 versioned API.
- `access-gate/` resolves separate server-owned Identity and DeviceTrust context, constructs the internal access request, obtains a deterministic Policy decision, and exposes the Milestone 2 access endpoint.
- `relay/` owns canonical job lifecycle plus mutually exclusive PX-003 worker and PX-005 model invocation/terminal paths.
- `memory/` owns canonical records, deterministic approved context construction, and exact approved-package lookup.
- `tool-gateway/` owns PX-003 execution-time capability decisions and bounded worker execution.
- `model-gateway/` validates Relay-created invocations, applies exact operation eligibility and deterministic simulator routing/budgets, and returns bounded outcomes without lifecycle authority.
- `policy/` contains narrow deterministic Alpha policies, including protected access, Memory scope/handling, model operation eligibility, and model placement. It is not a general Pixel Policy implementation.
