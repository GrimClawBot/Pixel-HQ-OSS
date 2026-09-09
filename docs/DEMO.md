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

## 4. Follow the synthetic PX-004 Memory flow

Run the focused simulator-first integration test:

```bash
node --test tests/integration/memory-vertical-slice.test.js
```

The test follows one synthetic record through the shipped PX-004 path:

1. **Memory intake** accepts the bounded text `Router 7 status is stable.` and tags; it does not accept caller-supplied authority fields.
2. **Canonical record** creation assigns the ID, timestamps, `simulation` environment, department scope, handling, lifecycle, provenance, and trace fields on the server side. The simulator store receives that complete validated record.
3. **Relay acceptance** creates a separate canonical job whose server-owned lifecycle is `ACCEPTED`.
4. **Context retrieval** uses that accepted job ID and the query `router 7 status`; the caller does not supply retrieval scope, authority, or budgets.
5. **Deterministic selection** revalidates store output and applies `environment -> scope/handling -> lifecycle -> relevance -> budget` filtering. Alpha relevance and ordering are deterministic and model-free.
6. **Bounded package** returns whole matching records only, with selection counts. The Alpha limits are four items and 2,048 Unicode code points of record text, and the package continues the accepted Relay job's trace.

All values in this walkthrough are synthetic and in-memory. It demonstrates existing contracts and tests, not production storage, identity, or deployment behavior.

## 5. What the test suite is proving

The public suite includes contract, integration, security, UI, and evidence coverage for the completed Alpha slices. In particular, the source demonstrates that:

- unknown/forged authority fields do not become canonical server state;
- a valid identity cannot bypass an untrusted or revoked device;
- backend Policy owns protected-app access decisions;
- cross-department raw-data access is denied by a deterministic Policy proof;
- Relay acceptance is idempotent and canonical job state is server-owned;
- Tool Gateway resolves execution-time capability authority;
- worker results and evidence are bounded;
- repeated reads do not rewrite canonical execution history.

## 6. Safe experimentation

Good Alpha experiments include:

- changing a simulator fixture and confirming contract validation catches invalid shapes;
- adding a denied-path regression test;
- adding a new presentation state that consumes existing canonical backend data;
- proving a live-shaped adapter can satisfy the same interface without weakening service-side validation.

Do not expose the simulator to an untrusted network or treat its synthetic trust/identity data as production credentials.

## 7. Where to read next

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — system map and invariants
- [`THREAT_MODEL.md`](../THREAT_MODEL.md) — public trust boundaries and threat/control matrix
- [`docs/architecture/alpha-milestones.md`](architecture/alpha-milestones.md) — milestone details
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — contribution workflow
