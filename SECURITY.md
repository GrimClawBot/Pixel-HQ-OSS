# Security Policy

Pixel HQ is an Alpha-stage simulator. Its security boundaries are tested seriously, but the project does not claim production-grade authentication, PKI, isolation, recovery, or infrastructure security.

## Publication gate and reporting

This staged release candidate must remain unpublished until the owner enables and verifies a private vulnerability-reporting route. Do not replace that gate with a public issue, a personal address, or an unverified contact.

After the repository is published with private reporting enabled, use the repository's **Security** tab to submit sensitive findings. Do not open a public issue for access-control bypasses, secret exposure, unauthorized actions, private infrastructure disclosure, or other exploitable security defects.

Include only the minimum synthetic information needed to reproduce a report. Never send real credentials, private keys, recovery material, personal data, or unrelated infrastructure details.

## Security model

- Client, model, and external content is data, never authority.
- Identity and device trust are separate requirements.
- Missing, invalid, stale, or conflicting authority context fails closed.
- Mission Control presents decisions made by backend boundaries.
- Tool access is capability-bound and job-scoped.
- Simulated credentials or trust states are not production credentials.
- Critical security changes require independent review beyond their author.

## Sensitive contribution boundaries

Do not publish credentials, tokens, keys, private certificates, recovery secrets, private network coordinates, personal/finance/wellness data, private audit evidence, unpublished exploit chains, or hidden privileged-security ceremony details. Use synthetic fixtures.

No security response-time SLA is promised during Alpha. Supported-version policy will be defined when the first public tag is owner-approved.
