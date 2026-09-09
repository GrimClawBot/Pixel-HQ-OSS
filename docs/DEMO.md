# Pixel HQ Alpha Demo

This walkthrough demonstrates the current public Alpha without any production infrastructure or third-party runtime dependency.

## Requirements

- Node.js 22 or newer
- Git

## 1. Clone and validate

```bash
git clone https://github.com/GrimClawBot/Pixel-HQ-OSS.git
cd Pixel-HQ-OSS
npm run check
```

`npm run check` runs source validation followed by the complete Node test suite.

## 2. Run the healthy simulator

```bash
npm start
```

Open:

`http://127.0.0.1:4173`

Mission Control currently exposes the lightweight **Company Pulse** surface with:

- **Infrastructure** — current simulated storage readiness, verified by Pixel;
- **Protected apps** — current launch access, verified by Pixel.

The UI is a presentation layer over backend state and decisions; it does not create trust or authorization itself.

## 3. Run the degraded-storage path

Stop the healthy process, then run:

```bash
npm run start:degraded
```

Open the same local address again. The degraded scenario exercises the same contract and presentation path while changing the simulator input so failure/attention behavior can be observed deterministically.

## 4. What the test suite is proving

The public suite includes contract, integration, security, UI, and evidence coverage for the completed Alpha slices. In particular, the source demonstrates that:

- unknown/forged authority fields do not become canonical server state;
- a valid identity cannot bypass an untrusted or revoked device;
- backend Policy owns protected-app access decisions;
- cross-department raw-data access is denied by a deterministic Policy proof;
- Relay acceptance is idempotent and canonical job state is server-owned;
- Tool Gateway resolves execution-time capability authority;
- worker results and evidence are bounded;
- repeated reads do not rewrite canonical execution history.

## 5. Safe experimentation

Good Alpha experiments include:

- changing a simulator fixture and confirming contract validation catches invalid shapes;
- adding a denied-path regression test;
- adding a new presentation state that consumes existing canonical backend data;
- proving a live-shaped adapter can satisfy the same interface without weakening service-side validation.

Do not expose the simulator to an untrusted network or treat its synthetic trust/identity data as production credentials.

## 6. Where to read next

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — system map and invariants
- [`THREAT_MODEL.md`](../THREAT_MODEL.md) — public trust boundaries and threat/control matrix
- [`docs/architecture/alpha-milestones.md`](architecture/alpha-milestones.md) — milestone details
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — contribution workflow
