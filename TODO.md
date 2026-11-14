# Active Backlog

## 🌳 Task Tree

- [ ] **TASK-043** · P1 · high · First release 0.1.0 (owner defaults accepted 2026-11-08)
  - Done when: `npm view @agentropy/core@0.1.0 version`
  - Links: Ref: docs/release.md
  - State: branch todo/TASK-043-first-release-0-1 from main; next: build children
  - [x] **TASK-043.1** · mid · Write release.yml: tag trigger, pnpm check and check-pack first, npm provenance under tag next, GHCR image by digest, cosign, GitHub release
    - Done when: `test -f .github/workflows/release.yml` `node scripts/check-deploy.mjs`
    - Links: Ref: docs/release.md
  - [x] **TASK-043.2** · low · Set publishable packages to 0.1.0 and drop `private` in one reviewed commit
    - Done when: `grep -q '"version": "0.1.0"' packages/core/package.json` `node scripts/check-pack.mjs`
  - [!] **TASK-043.3** · low · Owner: create the `@agentropy` npm org, trusted publishers per package, repository owner name for the image path
    - Done when: `grep -q 'owner setup done' docs/release.md`
    - Blocked: nothing is published and no npm org exists → `npm view @agentropy/core` finds no package → owner creates the org and trusted publishers, then records it in docs/release.md
  - [ ] **TASK-043.4** · mid · Cut v0.1.0 (tag, workflow publishes packages and image), verify provenance and signature
    - Done when: `gh release view v0.1.0`
    - Links: Depends: TASK-043.1, TASK-043.2, TASK-043.3, TASK-040, TASK-044
- [!] **TASK-045** · P2 · low · Skills: list the plugin in a public marketplace; run the five skills in a second harness (TASK-039 leftover)
  - Done when: `claude plugin validate .` `grep -q 'Tested in' docs/skills.md`
  - Links: Ref: docs/skills.md
  - Blocked: a public listing needs the owner's submission and a second harness needs to be run by hand → n/a (manual) → owner submits the plugin, runs the five skills in another harness and records it under "Tested in" in docs/skills.md
