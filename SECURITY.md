# Security Policy

Pixel HQ is an Alpha-stage simulator. Its security boundaries are tested seriously, but the project does not claim production-grade authentication, PKI, isolation, recovery, secret management, or infrastructure security.

Read [`THREAT_MODEL.md`](THREAT_MODEL.md) for the public trust boundaries and current threat/control matrix.

## Reporting a vulnerability

Do **not** open a normal public issue containing exploit details, credentials, private infrastructure information, sensitive evidence, or a working authorization-bypass payload.

If GitHub private vulnerability reporting is enabled for this repository, use the repository's **Security** tab to submit the finding privately.

If private vulnerability reporting is not available, open only a minimal non-sensitive issue asking the maintainer to provide a private reporting channel. Do not include the vulnerability details in that issue.

Include only the minimum synthetic information needed to reproduce a report. Never send real credentials, private keys, recovery material, personal data, or unrelated infrastructure details.

## Security model

- Client, model, external content, and tool output are data, never authority.
- Identity and device trust are separate requirements.
- Missing, invalid, stale, revoked, malformed, or conflicting authority context fails closed.
- Mission Control presents decisions made by backend boundaries.
- Tool access is capability-bound and job-scoped.
- Simulated credentials or trust states are not production credentials.
- Adapter output is validated at Pixel-owned service boundaries.
- Critical security changes require independent review beyond their author.

## Sensitive contribution boundaries

Do not publish credentials, tokens, keys, private certificates, recovery secrets, private network coordinates, personal/finance/wellness data, private audit evidence, unpublished exploit chains, or hidden privileged-security ceremony details. Use synthetic fixtures.

## Supported versions

The current public source is an **Alpha**. No security response-time SLA is promised. Supported-version and backport policy will be formalized when maintainer-approved GitHub releases begin.

## Production warning

The local simulator is not a production deployment guide. Do not expose it to an untrusted network or substitute its synthetic Identity/DeviceTrust fixtures for real authentication, PKI, device attestation, or secrets infrastructure.
