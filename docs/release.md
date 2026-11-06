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
2. packs it with `pnpm pack` and inspects the tarball: required files present; no `src/`, `test/`, test files or build info; no `workspace:` ranges left;
3. installs all tarballs into a fresh npm project (no workspace, no links) and runs a durable task through `@agentropy/runtime` on `@agentropy/store-sqlite`, importing every other package.

`--no-install` runs steps 1–2 only, without the npm registry.

## Owner decisions

These are deliberately left open; each needs the owner, not an implementation change:

- **Version and stability.** First version number and what it promises: the [contracts](contracts/) are versioned documents; the TypeScript API is not yet frozen.
- **Publishing identity.** Ownership of the `@agentropy` npm scope, the publishing account or trusted-publisher setup, and npm provenance.
- **Release flow.** Flip `private` to `false`, tag, publish from CI (for example `pnpm -r publish --access public --provenance`), and draft release notes from the `CHANGELOG.md` `[Unreleased]` section.
- **Image.** Whether the container image is published, to which registry, and with which tags and signatures.
