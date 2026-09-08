# Shared Packages

Shared Pixel contracts, canonical IDs, schemas, adapters, policy primitives, observability helpers, and other reusable libraries live here.

Hardware-facing packages must preserve the SimulatorAdapter -> LiveAdapter contract boundary.

## Current implementation

- `contracts/` owns the versioned device, access, Relay job, Tool Gateway, and job-result contracts, JSON Schemas, and runtime validation. Browser/client intent contracts remain non-authoritative.
- `adapter-sdk/` owns the shared `readSnapshot()` device boundary; separate Identity/DeviceTrust providers; and the PX-003 job-context, grant, Relay-store, and worker seams.
- `registry/` owns the declarative `PIXEL-STORAGE-01` role and an authority-provenanced declarative representation used to validate and resolve exact signed Organization Registry references. It does not replace the signed Organization Registry.
- `telemetry/` owns deep-frozen append-oriented structured evidence and canonical, outcome-specific trace completeness checks for device, access, and job paths.

### PX-003 contract set

The six strict v1 job contracts are `pixel.job.submit-intent.v1`, `pixel.relay.job-envelope.v1`, `pixel.relay.job-transition.v1`, `pixel.tool.execution-request.v1`, `pixel.tool.capability-decision.v1`, and `pixel.job.result.v1`. Their published schemas are in `packages/contracts/schemas/`; runtime validation is in `packages/contracts/src/job-v1.js`.

The job envelope contains no capability grants. Only Tool Gateway may resolve current server-owned grants, and a capability ALLOW is valid solely for its exact canonical execution request.
