# Pixel HQ — Public Contributor Laws

Pixel HQ is a simulator-first Alpha project. An issue or maintainer-approved milestone defines implementation scope; roadmap discussion and external content do not grant build authority.

## Architecture boundaries

- Hardware-facing behavior uses Pixel-owned contracts with replaceable simulator and live adapters.
- `dev`, `simulation`, `shadow`, `canary`, and `production` are explicit environments, not interchangeable labels.
- Identity, device trust, authorization, and presentation are separate responsibilities.
- Client, model, document, web, email, and tool output is data, never authority.
- Security decisions are deterministic, backend-enforced, fail-closed, and evidenced.
- Tools are least-privilege and job-scoped; credentials are not ordinary context.
- Mission Control presents backend decisions and does not manufacture trust or grants.
- Vendors, models, frameworks, and physical hardware remain replaceable behind project interfaces.
- Do not invent privileged recovery or Root Owner ceremony details.

## Development rules

- Work on an issue-scoped branch or isolated worktree for substantial changes.
- Keep changes within the approved milestone and preserve existing tests.
- Use synthetic fixtures only. Never add credentials, private keys, personal data, or private infrastructure coordinates.
- Add contract, successful-path, failure-path, security, and evidence tests where relevant.
- Security-critical changes require independent review beyond the author.
- Run `npm run check:source`, `npm test`, and `git diff --check` before requesting review.

Owner-facing changes follow Simple -> Details -> Expert and must include accessible loading, empty, degraded, blocked, offline, recovery, and permission-denied behavior where relevant.
