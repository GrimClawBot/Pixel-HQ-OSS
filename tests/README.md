# Tests

Tests must cover success, degraded/failure, policy-denial, and evidence/trace behavior for each meaningful vertical slice.

Critical security behavior requires independent review beyond the builder that wrote it.

## Current suite

Node's built-in test runner exercises strict contracts, adapters/providers, projections, HTTP servers, Policy decisions, client-forgery denial, revocation, outcome-specific evidence, replacement-provider parity, and Mission Control fail-closed rendering. Run the complete suite with `npm test`.

Loopback HTTP integration tests may require local permission to bind ephemeral ports in a restricted development environment.
