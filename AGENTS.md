# Agentropy: notes for coding agents

Agentropy is a pnpm TypeScript monorepo (Node 24 or newer) for durable, capability-driven multi-agent work. Packages are under `packages/`. Specifications are `docs/contracts/*-v1.md`.

## Skills

Task-specific instructions are in `plugins/agentropy/skills/`, one folder per skill (Agent Skills format):

- `agentropy-build-agent`: write and test agents and apps.
- `agentropy-deploy`: image, environment, Kubernetes, the kind live-cluster test.
- `agentropy-a2a`: serve and call agents over A2A.
- `agentropy-operate`: readiness, stuck tasks, quarantine, compaction, telemetry.
- `agentropy-contribute`: working on this repository.

See `docs/skills.md` for installing them into a harness.

## Before you change code

```sh
pnpm install --frozen-lockfile
pnpm check        # lint, typecheck, tests, format check, API index check
```

Also run `node scripts/check-deploy.mjs`, `node scripts/check-doc-links.mjs` and `node scripts/check-readiness.mjs` when you touch deploy files, docs or contracts. `pnpm docs:api` regenerates `docs/api.md` after an export changes.

## Ground rules

- A runtime, capability or communication change needs a revision of the matching contract in `docs/contracts/` and conformance tests.
- Do not bypass audit, durability or isolation policy, and do not add an allow-all policy default.
- `TODO.md` is the live backlog (checked by `.todo/todo-lint.sh`), and a task is done when its `Done when:` command passes. Finished roots move to `CHANGELOG.md`.
- Commits carry a DCO sign-off (`git commit -s`). Never commit secrets.
- Ask before pushing.
