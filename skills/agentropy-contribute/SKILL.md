---
name: agentropy-contribute
description: Contribute to the Agentropy repository itself. Use when changing its packages, contracts, docs, deploy files or backlog, running its full check suite, working through TODO.md roots, or preparing a commit or pull request that must pass CI and the DCO.
license: Apache-2.0
compatibility: A git checkout of https://github.com/bassemZohdy/agentropy with Node.js 24 or newer, pnpm and bash. Docker and kind are needed only for the deployment checks.
metadata:
  project: agentropy
  audience: contributors
---

# Contribute to Agentropy

Authoritative sources: `CONTRIBUTING.md`, `docs/plans/PROJECT.md`, `docs/adr/`, `docs/contracts/`. This skill is the working summary.

## Layout

pnpm TypeScript monorepo under `packages/`:

| Package | Holds |
|---|---|
| `core` | Domain types, schemas, the `Store` port, errors, telemetry interfaces |
| `runtime` | Scheduler, pool, task service, A2A, MCP, skills, workflow glue, outbox, `createLocalApp` |
| `store-sqlite`, `store-postgres` | Store adapters |
| `workflow-conductor` | Conductor workflow adapter |
| `testkit` | Fakes, fake clock, network guard, conformance suites, integration tests |
| `examples` | Quickstart, sample host (`host.ts`) used by the image |

Specs are in `docs/contracts/*-v1.md` and carry a revision number. `docs/api.md` is generated.

## Checks

```sh
pnpm install --frozen-lockfile
pnpm check            # lint, typecheck, tests, prettier check, API index check
pnpm docs:api         # regenerate docs/api.md after changing an export
bash .todo/todo-lint.sh TODO.md CHANGELOG.md
node scripts/check-readiness.mjs
node scripts/check-doc-links.mjs
node scripts/check-deploy.mjs
node scripts/check-pack.mjs
```

`.todo/check.sh` runs the backlog lint, the readiness check and `pnpm check` together, and CI runs it.

Opt-in live suites stay skipped without their environment: `AGENTROPY_PG_URL` (PostgreSQL), `AGENTROPY_CONDUCTOR_URL`, and the model API suite. Vitest aliases `@agentropy/*` to `src`, so tests need no build.

## Rules from CONTRIBUTING

- A runtime, capability or communication change needs a **specification revision** in `docs/contracts/`, clear failure semantics, tenant and authorization analysis, and conformance tests.
- Mandatory audit, task durability and isolation policies cannot be bypassed for convenience.
- Keep unrelated projects out of core dependencies.
- No secrets, credentials, user content or production data in commits.
- Security reports go through `SECURITY.md`, never a public issue.
- Every commit needs a DCO sign-off line: `git commit -s`, using your genuine name and an address you control.

## The backlog

`TODO.md` is the live task tree in the [todo-skills](https://github.com/bassemZohdy/todo-skills) format. `CHANGELOG.md` records finished roots.

- Each node has an ID, priority, effort, a `Done when:` command and a `Links:` line. A node is done when its command passes, so never tick one on faith.
- Blocked nodes use `[!]` with a `Blocked:` line that says what is needed and from whom.
- When every child of a root is `[x]`, the root moves out of `TODO.md` into `CHANGELOG.md` under `[Unreleased]`, with Ref, Validated, Docs and Notes, and an honest "Not done" for what was left out. `TODO.md` stays under 120 lines.
- Do not restructure the tree or mark unimplemented work complete as part of an unrelated change.

## Working method that fits this repo

1. Branch, change, run the checks above, commit, then fast-forward `main`. Ask the maintainer before pushing, and watch CI after.
2. Prefer a live check over a fake when behaviour matters. The first live runs against Conductor and a real model API found behaviour the in-process fakes had hidden.
3. Document what a check does not cover (for example the kind test does not exercise NetworkPolicy enforcement). Do not claim more than a test shows.
4. Keep docs and code together: contracts, `docs/compatibility.md`, `docs/deployment.md` and the threat model (`docs/security/threat-model.md`) change in the same commit as the behaviour.
5. Pin third-party GitHub Actions by commit SHA and service images by digest. `scripts/check-deploy.mjs` enforces it.

## Pitfalls seen here

- Windows shells: write multi-line files with an editor tool rather than a quoted heredoc, and avoid `\n` escapes in generated text.
- Git Bash path conversion can break `docker run` and `curl -o /dev/null`. Unset `MSYS_NO_PATHCONV` when a command misbehaves.
- A port-forward that was stopped can still hold its local port for a moment. Use a fresh port.
