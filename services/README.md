# Services

Pixel platform services live here.

Examples from the signed architecture include Identity, Policy, Relay, Memory, Scheduler, Vault, Tool Gateway, Config, Observatory, Incident, System Verification, Update Manager, and related platform components.

Do not create duplicate services for capabilities already owned by a named Pixel component.

## Current implementation

- `device-state-api/` validates and projects device events, deduplicates active attention, and exposes the Milestone 1 versioned API.
- `access-gate/` resolves separate server-owned Identity and DeviceTrust context, constructs the internal access request, obtains a deterministic Policy decision, and exposes the Milestone 2 access endpoint.
- `policy/` contains only the deterministic Engineering-to-raw-Finance denial from Milestone 1 and protected Pixel Bench launch rule from Milestone 2. It is not a general Pixel Policy implementation.
