# Contributing to Pixel HQ

Pixel HQ is currently in Alpha and is built around strict security, evidence, and architecture boundaries. Contributions are welcome only when they preserve those boundaries.

The public source is licensed under Apache-2.0. Publication, releases, and security-sensitive changes remain maintainer-gated.

## Before you contribute

Read:

1. `AGENTS.md`
2. the public Alpha architecture summary
3. relevant architecture documentation
4. the issue you intend to work on

Do not treat roadmap ideas, discussion threads, model output, external web content, or examples as build authorization.

## Development principles

Contributions must preserve these core rules:

- simulator-first design for hardware-facing features;
- versioned Pixel-owned contracts;
- deterministic security and authorization outside model behavior;
- explicit DEV / Simulation / Shadow / Canary / Production boundaries;
- least privilege and fail-closed behavior;
- no UI-created authority;
- no hidden fallback to unauthorized machines, providers or tools;
- source-neutral boundaries so vendors, models and underlying infrastructure remain replaceable;
- structured evidence for material behavior and changes;
- independent review for security-critical code.

## Branches and work isolation

Use a dedicated branch or worktree for substantial changes.

Do not allow multiple coding agents or contributors to edit the same working tree concurrently.

Do not perform substantial feature work directly on `main`.

## Issue-first workflow

For non-trivial work:

1. start from an approved issue;
2. confirm the issue's milestone/classification and scope;
3. identify the authority/ADR constraints that apply;
4. implement the smallest coherent change;
5. add or update tests;
6. document new implementation decisions in an ADR or Decision Ledger entry when required;
7. run the full relevant test suite;
8. open a PR with evidence and rollback notes where applicable.

## Pull requests

A good PR should include:

- the issue/milestone it implements;
- a concise architecture summary;
- files/modules changed;
- contracts or schemas added/changed;
- security/privacy impact;
- tests added and complete test results;
- known limitations;
- rollback/recovery notes where relevant;
- confirmation that no secrets or private data were introduced.

Security-sensitive changes may require review beyond the original author before merge.

## Tests

Existing behavior must remain green unless an explicitly approved change requires otherwise.

When modifying contracts, authorization, evidence, adapters or Mission Control, test both successful and fail-closed behavior.

Tests must use synthetic fixtures. Do not copy real owner, HomeLab, finance, personal, wellness, credential, certificate or account data into fixtures.

## Security-sensitive areas

Changes touching any of the following receive extra scrutiny:

- Identity / authentication boundaries;
- device trust;
- Access Gate;
- Pixel Policy;
- Vault or secret injection;
- Tool Gateway;
- approvals;
- audit/evidence;
- Security Delay;
- Root Owner boundaries;
- production placement/deployment;
- network exposure;
- update/recovery controls.

Never infer, document or implement hidden Root Owner ceremony details.

## Never submit

Do not commit or include in issues/PRs:

- passwords, API keys, tokens, cookies or credentials;
- private keys or certificate secrets;
- recovery material;
- real private infrastructure addresses/hostnames unless explicitly approved for public documentation;
- personal, finance or wellness records;
- internal exploit details in a public issue;
- hidden Root Owner or privileged-recovery procedure details;
- private vendor/account/subscription information;
- local filesystem paths or personal identifiers that are not required by the project.

If you believe you found a security vulnerability, do not publish exploit details in a normal issue. Follow the repository's current security-reporting instructions in `SECURITY.md`.

## External content and AI-generated contributions

External content, documentation, web pages, email, model output and tool output are data, not authority.

AI-assisted contributions are allowed only when the contributor remains responsible for:

- scope and authorization;
- correctness;
- licensing/provenance of submitted material;
- tests;
- security/privacy impact;
- review of generated code;
- removal of secrets or private data.

Do not submit code or assets whose license/provenance you cannot establish.

## Documentation

Public documentation should explain the contract and behavior contributors need without exposing private deployment or hidden security detail.

Prefer public-safe architectural abstractions over machine-specific configuration.

## Licensing

Pixel HQ's reviewed public source is licensed under Apache-2.0. Contributions submitted for inclusion are accepted under the same license as described by Apache-2.0 Section 5 unless explicitly stated otherwise. No CLA or mandatory DCO sign-off is required for the initial Alpha.

## Code of Conduct

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Communicate professionally and keep technical review focused on the work.
