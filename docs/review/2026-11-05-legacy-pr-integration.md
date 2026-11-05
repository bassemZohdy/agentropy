# 2026-11-05 — Legacy PR integration review

**Repository:** Agentropy. **Target branch:** main. **Scope:** review prior PRs against newer, independently implemented M1 baseline. This is an integration assessment, not a claim that blocked PRs were merged.

## Verified baseline

- main advanced beyond the initial M0 scaffold: FEAT-011…018 and FEAT-021 appear in [CHANGELOG](../../CHANGELOG.md); see their verified test commands and caveats.
- Latest main scaffold CI was successful at the time of this review.
- The active backlog is already in the todo-skills format. It includes FEAT-019 (inbox/outbox), FEAT-020 (human actions), FEAT-022 (offline acceptance/testkit), TASK-023 (journeys), and blocked TASK-025 (DCO signed/unsigned PR verification).
- An accepted ADR and an existing helper are not evidence of full AC/SEC acceptance; M1 is still incomplete.

## Prior PRs and merge decision

| PR | Description | Current integration outcome | Required action |
|---|---|---|---|
| [#3](https://github.com/bassemZohdy/agentropy/pull/3) | Error Contract v1 | **Closed as superseded, not merged.** FEAT-011 already provides a more complete `ERROR_CATALOG`, `AgentropyError`, redaction and serialization. The old alternative `ERROR_DEFINITIONS` would duplicate API surfaces. | No change to main from PR #3. Preserve historical review only |
| [#4](https://github.com/bassemZohdy/agentropy/pull/4) | Scheduling FakeClock | **Open; not safe to merge unchanged.** main already exports `FakeClock` from `packages/testkit/src/fakes.ts` with an ISO-time API. PR #4 adds a different `FakeClock` class and export, risking ambiguity/semantic divergence. | Resolve API/naming overlap, rebase/refresh against main, test, and satisfy DCO |
| [#5](https://github.com/bassemZohdy/agentropy/pull/5) | FaultInjector | **Open; technical CI succeeded** on the reviewed head, but module must align with current `@agentropy/testkit` export/conformance conventions and satisfy DCO. | Integrate into FEAT-022 without duplicate modules, test and sign commits |
| [#6](https://github.com/bassemZohdy/agentropy/pull/6) | Scripted FakeModel | **Open; technical CI succeeded** on the reviewed head, but main's testkit conventions and J2 contract must be reconciled and DCO satisfied. | Integrate under FEAT-022, validate J2, sign commits |

## DCO governance gate

Technical CI success is not sufficient for merging: the DCO workflow rejects the unsigned API-authored commits on these legacy PRs. **Do not fabricate a contributor sign-off or bypass the configured policy.** The contributor with provenance/rights to the commits must add their own `Signed-off-by` line using a verified identity, then publish the corrected branch and confirm DCO green. A single new signed commit does not make earlier unsigned commits pass when every commit is checked.

## Next parallel lanes

1. **Collaboration**: FEAT-019 and FEAT-020 are independent of these legacy PRs and are next high-priority implementation goals, each requiring its specified AC/SEC tests.
2. **Testkit**: FEAT-022 can incorporate reconciled FakeClock/FaultInjector/FakeModel as coherent public testkit contracts, with no duplicate exports; do not count it completed until its acceptance matrix passes.
3. **Governance/ops**: TASK-025 remains blocked pending a genuine signed PR validation. No lowering of the DCO gate.

No blocked PR was merged by this review. Protect the newer main baseline from regressions.
