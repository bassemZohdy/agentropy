# Release packaging

**Status:** FEAT-030 (2026-11-06). The library packages are publish-ready artifacts; **nothing is published**. Every package stays `"private": true` at version `0.0.0` until the owner decides the items under [Owner decisions](#owner-decisions).

## What is packaged

| Package | Contents |
|---|---|
| `@agentropy/core` | Contracts: types, JSON Schemas, error catalog, lifecycle tables, pure resolvers |
| `@agentropy/runtime` | Registries, task service, scheduler, communication providers (direct, A2A), local app facade |
| `@agentropy/store-sqlite` | Store adapter on `node:sqlite` |
| `@agentropy/store-postgres` | Store adapter for PostgreSQL (driver-neutral client port) |
| `@agentropy/workflow-conductor` | WorkflowEngine adapter for Conductor |
| `@agentropy/testkit` | Offline fakes and conformance suites |

`@agentropy/examples` is not a library; it is shipped only inside the container image ([deployment](deployment.md)).

Each library is ESM-only (`"type": "module"`), needs Node.js 24 or newer (`engines`), exposes one entry point (`exports["."]` → `dist/index.js` with `dist/index.d.ts`), and ships only `dist/`, `package.json` and `LICENSE` (Apache-2.0, copied from the repository root by `prepack`). `pnpm pack`/`pnpm publish` rewrite `workspace:*` dependencies to the released version, so the packages must be published together at one version.

## Verification

`node scripts/check-pack.mjs` (CI, after `pnpm build`):

1. checks each library's metadata (scope, description, license, repository directory, engines, module type, exports, files);
2. packs it with `pnpm pack` and inspects the tarball: required files present; no `src/`, `test/`, test files or build info; no `workspace:` ranges left; its SBOM lists every direct dependency, and every component has a purl and a license from the allow-list in `scripts/sbom.mjs` (Apache-2.0, MIT, ISC, BSD-2/3-Clause, 0BSD, BlueOak-1.0.0);
3. installs all tarballs into a fresh npm project (no workspace, no links) and runs a durable task through `@agentropy/runtime` on `@agentropy/store-sqlite`, importing every other package.

`--no-install` runs steps 1–2 only, without the npm registry.

## Software bill of materials (TASK-030.2)

- **Packages.** `node scripts/sbom.mjs` writes one CycloneDX 1.5 JSON document per library to `sbom/` (gitignored), plus `host-app.cdx.json` for the application layer of the host image. Each one lists every production dependency the package installs (transitively, as resolved by the lockfile) with version, purl, license and the dependency graph. The output has no timestamp or random serial number, so the same lockfile gives the same files. CI uploads them as the `sbom-packages` artifact.
- **Image.** The CI `image` job scans the built host image with syft (pinned by digest) into `host-image.cdx.json`, covering the Debian packages of the digest-pinned base image as well as the application, and uploads it as the `sbom-image` artifact.

## Signing and provenance plan

Nothing is published yet ([owner decisions](#owner-decisions)), so nothing is signed yet. When publishing starts, the release workflow is to:

1. **npm provenance.** Publish from GitHub Actions with `id-token: write` and `pnpm -r publish --provenance` (or npm trusted publishing), so each package version carries a Sigstore-signed SLSA provenance statement linking it to the commit and workflow run. Attach the package SBOMs to the GitHub release.
2. **Image signature and attestations.** Push the image by digest. Sign the digest with cosign keyless (`cosign sign --yes <registry>/agentropy-host@sha256:…`, identity = the release workflow), and attach the SBOM and build provenance as attestations (`cosign attest --type cyclonedx`, or `actions/attest-build-provenance` and `actions/attest-sbom`). Deployments verify with `cosign verify --certificate-identity-regexp '^https://github.com/<owner>/agentropy/' --certificate-oidc-issuer https://token.actions.githubusercontent.com`.
3. **Air-gapped mirrors** copy the signature and attestations with the image (`cosign copy`), so they can still be verified offline against the bundled transparency-log entries.

## Owner decisions

These are deliberately left open; each needs the owner, not an implementation change:

- **Version and stability.** First version number and what it promises: the [contracts](contracts/) are versioned documents; the TypeScript API is not yet frozen.
- **Publishing identity.** Ownership of the `@agentropy` npm scope, the publishing account or trusted-publisher setup, and npm provenance.
- **Release flow.** Flip `private` to `false`, tag, publish from CI (for example `pnpm -r publish --access public --provenance`), and draft release notes from the `CHANGELOG.md` `[Unreleased]` section.
- **Image.** Whether the container image is published, to which registry, and with which tags and signatures.

### Recommendation (not a decision)

Drafted so the decisions above can be confirmed or changed quickly; none of it is in effect until the owner records it here and TASK-032 is unblocked.

| Decision | Recommended default | Why |
|---|---|---|
| Version and stability | `0.1.0`, published under the npm dist-tag `next` | `0.x` allows breaking changes between minors while the TypeScript API is unfrozen; the contracts keep their own revision numbers, which is the compatibility promise that exists today. `latest` only at 1.0 |
| Publishing identity | An `@agentropy` npm organization owned by the maintainer account, publishing through npm trusted publishing (GitHub OIDC) | No long-lived token to leak; provenance comes with it (see the signing plan above) |
| Release flow | Tag `v0.1.0` → a `release.yml` workflow that runs `pnpm check` and `node scripts/check-pack.mjs`, publishes with `pnpm -r publish --provenance --tag next`, and creates a GitHub release from `CHANGELOG.md` with the package SBOMs attached; `"private": true` is removed in one reviewed commit | Everything the workflow needs already runs in CI; publishing is the only new step |
| Image | GitHub Container Registry, `ghcr.io/<owner>/agentropy-host`, tags `0.1.0` and the digest (never `latest`), signed with cosign keyless and carrying the SBOM and provenance attestations | No second account or secret (the workflow's `GITHUB_TOKEN` suffices); deployments pin by digest, as the manifests already require |

What the owner must do regardless: create the npm organization, configure the trusted publisher for each package (or choose a token), and decide the repository owner name that appears in the image path.

