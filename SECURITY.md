# Security policy

Agentropy is pre-1.0: no release is published and no API is stable ([compatibility matrix](docs/compatibility.md)). Security reports are still welcome for the code in this repository, the container image and the deployment files.

## Reporting a vulnerability

Please report privately and do not open a public issue or pull request that describes the problem:

- use GitHub's private vulnerability reporting for this repository (the repository's **Security** tab, then **Report a vulnerability**).

Include what you found, the commit or version, how to reproduce it (a failing test is ideal) and the impact you see. Do not include real credentials or customer data. We will acknowledge a report, confirm or dispute it, and agree a disclosure date with you before anything is published; fixes land with a regression test and a [threat-model](docs/security/threat-model.md) row when the issue is a new class.

## In scope

The runtime and stores (`packages/*`), the A2A server and client, the example host and its image (`deploy/`), CI and supply-chain configuration. Weaknesses that need control of the store, the host or its credentials are listed as accepted residual risks in the threat model; reports that extend them are still useful.

## Out of scope

Sample policy and authentication code in `packages/examples` (static bearer tokens, the allow-list policy) is documented as a sample to be replaced; vulnerabilities in third-party dependencies belong with their maintainers, but tell us if our usage is exposed (dependencies are audited in CI with `pnpm audit --prod`).
