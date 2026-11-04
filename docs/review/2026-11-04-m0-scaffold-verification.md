# M0-08 scaffold verification — 2026-11-04

- Scope: Agentropy scaffold only; **not** M1 feature or resilience acceptance
- Initial verified CI: [scaffold-ci run 41861578838](https://github.com/bassemZohdy/agentropy/actions/runs/41861578838) on commit `783d7b0c30ba7cd692daebb0bb1f334d38314a14` — **success**
- Follow-up CI after contribution guidance: [run 41861661041](https://github.com/bassemZohdy/agentropy/actions/runs/41861661041) — **success**
- Package-manager version pinned later to pnpm 10.34.9 with matching workflow setup; check the latest run independently before treating it as confirmed.

## Created

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, ESLint/Prettier/Vitest configurations, `.gitignore`.
- Four thin package shells: `@agentropy/core`, `@agentropy/runtime`, `@agentropy/store-sqlite`, `@agentropy/testkit`; they intentionally **do not implement agent logic**.
- A core smoke test exercising one exported scaffold marker.
- `.github/workflows/ci.yml` runs dependency installation, TS build, ESLint, Vitest, and formatting.
- `scripts/check-dco.mjs` and `.github/workflows/dco.yml` enforce sign-off for future PR commits (workflow **not tested on a real PR yet**).

## Verified via GitHub Actions

The successful scaffold run confirmed that Node.js 24 with pnpm 10 supports the project scaffolding and that TypeScript build, lint, one Vitest smoke test, and Prettier check pass. It **does not** prove runtime recovery, A2A support, persisted tasks, audit security, or the AC-01…AC-20 / SEC-01/02/03/04/07 suites.

## Deferred hardening / next gates

1. **Commit a generated `pnpm-lock.yaml`** from a trusted build environment; then switch CI from `pnpm install --no-frozen-lockfile` to `pnpm install --frozen-lockfile` and re-enable the pnpm cache. Current installs are not fully reproducible.
2. Validate the DCO workflow on a signed and an unsigned sample PR; a GitHub Actions workflow file alone does not prove the policy check works.
3. Import and use the todo-skills pack through a real git checkout; keep the current TODO intact until the staged lossless migration is approved and syntax lint passes.
4. Implement the actual contract tests in M1 and keep the accepted security tests mandatory. Never treat the smoke test as acceptance proof.

M0-08's **minimal scaffold** is in place and has verified build/lint/test/format checks; package lock and contribution-gate live validation remain tracked follow-ups. M1 work still needs an explicit decision to activate the plan and backlog.
