# Handoff: guided npm setup and the v0.1.0 release (2026-11-22)

> **Finished 2026-11-25.** The release v0.1.0 is out, TASK-043 and TASK-045 are closed (see CHANGELOG.md). Kept for the record.

**For:** a local Claude Code session on the owner's own computer, where a browser is available. The cloud session that wrote this had no browser and no npm login, so it could not do the owner steps.

**Goal:** walk the owner, one step at a time, through the remaining owner steps of TASK-043 and TASK-045, then finish the release. Do each step with the owner. Never do an owner step silently, and never write the "owner setup done" line before the owner has confirmed the steps.

## State of the repository

- `main` is at `539ccdb` (or later). All CI jobs pass. `pnpm check` runs 752 tests. The readiness check shows 31 of 31 criteria met.
- There are no open pull requests. All code work is finished and merged.
- Nothing is published to npm. The `@agentropy` scope was unclaimed when last checked (2026-11-22): `curl -s https://registry.npmjs.org/-/org/agentropy/package` answers `{"error":"Scope not found"}`.
- The plugin icon is on `main` (`.claude-plugin/icon.png`), and `claude plugin validate .` passes with no warnings.

## What is left (`TODO.md`)

| Task | Done-when command | Needs |
|---|---|---|
| TASK-043.3 | `grep -q 'owner setup done' docs/release.md` | The owner does steps 1 to 4 below, then records it |
| TASK-043.4 | `gh release view v0.1.0` | The owner's OK to push the `v0.1.0` tag, after 043.3 |
| TASK-043 (root) | `npm view @agentropy/core@0.1.0 version` | Passes once the release has published |
| TASK-045 | `claude plugin validate .` and `grep -q 'Tested in' docs/skills.md` | The first part passes. The owner submits the plugin and runs the five skills in a second harness |

## Steps for the owner (the checklist is in `docs/release.md`, "Owner setup runbook")

Guide the owner through these in order, one at a time, and wait for "done" after each. Verify what can be verified from the terminal.

1. **Create the npm organization `agentropy`.**
   - On https://www.npmjs.com, signed in as the account that should own the packages, with two-factor authentication on.
   - Avatar (top right), then **+ Add Organization**. Name `agentropy`. Plan **Unlimited public packages** (free). Skip inviting members.
   - Verify: `curl -s https://registry.npmjs.org/-/org/agentropy/package` should no longer answer "Scope not found".
   - If npm says the name is taken, stop and ask the owner what to do. The scope name and the `@agentropy/*` package names are in every `package.json`.

2. **Publish the six placeholder packages.** npm only lets you add a trusted publisher to a package that already exists, so each package is first created with an empty, deprecated placeholder (`0.0.0-bootstrap.0`, dist-tag `bootstrap`).
   - The owner runs this in their own terminal, because it needs `npm login` and a one-time password: `npm login`, then `node scripts/npm-bootstrap.mjs` (dry run, lists what it would do), then `node scripts/npm-bootstrap.mjs --publish`.
   - The script skips packages that already exist and deprecates an existing placeholder again, so it can be rerun after a failure.
   - Verify: `npm view @agentropy/core versions --json` shows `0.0.0-bootstrap.0`, and the same for `runtime`, `store-sqlite`, `store-postgres`, `workflow-conductor` and `testkit`.

3. **Add a trusted publisher to each of the six packages** (npmjs.com, the package, Settings, Trusted publishing, GitHub Actions). The same values for all six:

   | Field | Value |
   |---|---|
   | Organization or user | `bassemZohdy` |
   | Repository | `agentropy` |
   | Workflow filename | `release.yml` |
   | Environment name | empty |
   | Allowed actions | tick **npm publish** (new setups allow only `npm stage publish` by default) |

   **Timing:** a new trusted publisher expires unless a publish through it succeeds within **2 days**. Only start this step when the owner can do step 5 the same day or the next.

4. **Restrict token publishing** for each of the six packages (Settings, Publishing access): require two-factor authentication and disallow tokens. Only the release workflow can then publish without the owner's second factor.

5. **Record the setup, then release** (the agent does this, only after the owner confirms steps 1 to 4):
   - Add a dated line to the "Owner setup runbook" section of `docs/release.md` that says the owner setup is done. It must contain the exact words `owner setup done`, because TASK-043.3's done-check greps for them. Do not write it earlier, not even as an example.
   - Commit with `-s`, push to a branch, open a pull request, wait for CI, and merge only with the owner's OK. Pushing a tag is a separate OK.
   - Ask the owner, then push the tag: `git tag v0.1.0 && git push origin v0.1.0`. Check first that `main` contains the setup commit. The `release.yml` workflow runs as it is at the tagged commit. It verifies the repository, packs each package with `pnpm pack`, publishes the tarballs with `npm publish --provenance --tag next` through trusted publishing (no npm token), pushes and signs the image `ghcr.io/bassemzohdy/agentropy-host`, and creates a GitHub pre-release.
   - **Never retag.** If one job fails, rerun that job. The publish loop skips versions that are already on npm.

6. **Verify the release.**
   - `npm view @agentropy/core@0.1.0 version`, and the same for the other five packages. The `next` dist-tag should point at 0.1.0.
   - `gh release view v0.1.0` shows a pre-release with the SBOMs attached.
   - The package pages on npmjs.com show the provenance badge.
   - The image path is `ghcr.io/bassemzohdy/agentropy-host`. In GitHub, **Packages**, set its visibility to public and link it to the repository if GitHub did not.

## Open decisions to put to the owner

- **The npm `latest` tag.** npm gives a new package a `latest` tag on its first publish, whatever `--tag` says (not confirmed from a source). If so, a plain `npm install @agentropy/core` would install the empty placeholder after the release. The runbook suggests `npm dist-tag add @agentropy/<package>@0.1.0 latest` for each package. That goes against the accepted decision "`latest` only at 1.0", so it is the owner's call. The question has gone unanswered so far.

## TASK-045 (after the release, or in parallel)

- Submit the plugin to a marketplace. The icon (`.claude-plugin/icon.png`) may become the listing image, and that can only be set once, the first time the plugin is saved or submitted. Show the owner the icon before they submit.
- Run the five skills in `skills/` in a second AI coding tool (see [skills](../../skills.md) for installing them), then record the tool under "Tested in" in `docs/skills.md`. Do not write that text before it has been done.

## Rules for the agent

- Read `AGENTS.md` first. Commits carry a DCO sign-off (`git commit -s`). Never commit secrets or npm tokens. Ask before pushing.
- A change to a runtime, capability or communication contract needs a contract revision and tests. None is expected in this work.
- Before touching docs, run `node scripts/check-doc-links.mjs`, `node scripts/check-readiness.mjs` and `bash .todo/todo-lint.sh`.
- After merging, a finished root moves from `TODO.md` to `CHANGELOG.md`. TASK-043 can only move once `npm view @agentropy/core@0.1.0 version` passes.
- Report outcomes faithfully. If a step fails, say so with the output.

## Where to read more

- [Release packaging and the owner setup runbook](../../release.md)
- [`.github/workflows/release.yml`](../../../.github/workflows/release.yml)
- [Skills plugin](../../skills.md)
- [Review of 2026-11-20](../../review/2026-11-20-post-review-delta.md)
