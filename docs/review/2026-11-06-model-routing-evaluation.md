# 2026-11-06 — Task-aware model routing evaluation (N-03, R-35)

**Status:** evaluation for FEAT-028.10. Option B was implemented in FEAT-035.3 as `routedReasoning` (`packages/runtime/src/model-routing.ts`), with the floors below verified offline in `packages/runtime/test/model-routing.test.ts`; options C and D are not built. The fixture cost benchmark ran in FEAT-043 (`packages/testkit/test/model-routing-cost.test.ts`, results below) on declared prices and latencies; real endpoints' prices and latencies were not measured. Question: should Agentropy route a task's model calls to different models by cost, latency, quality, residency and policy, and if so where? Constraint: vendor-neutral, with a fallback that never weakens a security floor.

## Options

| | Option | Where routing happens |
|---|---|---|
| A | **Pinned model per definition** (today) | The definition's `reasoning` binding names one OpenAI-compatible endpoint and model |
| B | **Rule-based routing provider** | A `ReasoningProvider` wrapper picks among configured endpoints by declared task attributes (data class, residency zone, budget left, latency class) with ordered fallbacks |
| C | **Learned router** | A classifier (small model) scores each request and picks a model |
| D | **Gateway routing** | An external LLM gateway behind the OpenAI-compatible endpoint (e.g. LiteLLM, agentgateway, a cloud router) routes and fails over |

## Security floors (any option must keep them)

1. **Residency and data class are hard constraints, never weights.** A request tagged with a zone or data class may go only to endpoints declared for that zone and class. If none is available the call fails (`ProviderUnavailable`); it is never sent elsewhere.
2. **Fallback only within the same floor set.** A fallback endpoint must satisfy every constraint of the primary. No silent downgrade from a private deployment to a public API.
3. **Budget counts across attempts.** Tokens of a failed attempt still count against `budget.maxCostUnits`; a fallback that would exceed it is refused (`BudgetExceeded`).
4. **Same tool bounds.** Only tools pinned in the task snapshot are offered, whichever model answers (TM-19).
5. **Auditable choice.** The chosen endpoint, model and reason (rule ID or score) go into the reasoning span and, for policy-relevant choices, the audit trail. Prompts and keys never do (TM-21).
6. **Credentials per endpoint**, resolved just in time through `CredentialProvider`; a router never shares one key across endpoints.

## Offline benchmark matrix (to run before any implementation)

A recorded-fixture benchmark, in the style of the existing OpenAI fixtures, so it runs in CI without network. Each cell is measured per option.

| Scenario (fixture set) | Measures | Pass condition |
|---|---|---|
| Mixed workload: 70 % short classification, 30 % long reasoning | cost units per task, p95 latency, quality score from fixture labels | B or D beats A on cost at equal quality |
| Primary endpoint returns 429/5xx for 20 % of calls | success rate, extra cost, added latency | ≥ 99 % success, no floor violated |
| Residency-tagged requests with the in-zone endpoint down | calls sent out of zone | exactly 0 (calls fail instead) |
| Budget nearly spent, fallback more expensive | budget overruns | 0 |
| Prompt-injection text asking for "the best model" | routing decisions influenced by content | 0 for A/B/D; measured for C |
| Router decision determinism (same request twice) | identical choice | always for A/B; reported for C and D |

## Fixture benchmark results (FEAT-043)

`pnpm exec vitest run packages/testkit/test/model-routing-cost.test.ts` runs the six scenarios offline: 1,000 tasks (700 short, 300 long) against fixture endpoints with **declared** prices and latencies, so the numbers show the shape of the trade-off, not what a provider charges. Option A is the dear `strong` model (10 cost units per 1,000 tokens, 400 ms) pinned for everything; option B is `routedReasoning` with `small` (1 unit, 80 ms, right on short tasks only), `strong` and a dearer second `strong-b` (12 units, 450 ms); an out-of-zone `us-public` is the cheapest of all. Option C is not built and option D (a gateway) is outside Agentropy, so neither is measured.

| Scenario | A pinned | B rules | Pass condition |
|---|---|---|---|
| 1 Mixed workload | cost 4,020 units; quality 100 %; mean latency 400 ms, p95 400 ms | cost 3,642 units (−9.4 %); quality 100 %; mean 176 ms, p95 400 ms | B cheaper at equal quality: **met** |
| 2 Primary fails on 20 % of calls (429 and 5xx alternate) | 80 % succeed (200 of 1,000 lost) | 100 % succeed; cost 3,878.4 units (+236.4 for the dearer fallback); mean latency 266 ms (+90 ms); 0 calls to `us-public` | ≥ 99 % success, no floor violated: **met** |
| 3 In-zone endpoints down, requests tagged `eu` and `pii` | 1,000 of 1,000 fail | 1,000 of 1,000 fail; calls out of zone: 0 | exactly 0 out-of-zone calls: **met** |
| 4 Budget of 100 units nearly spent, dearer fallback | n/a (one endpoint) | every attempt, failed or not, was asked for at most what remained (60, then 30); the third call was refused (`BudgetExceeded`) before any endpoint was contacted; spent 110 of 100 | no overrun beyond the grant: **met for output, see below** |
| 5 Prompts asking for "the best model" | n/a | decisions changed in 1,000 tasks: 0 | 0: **met** |
| 6 Same request twice | n/a | identical choice sequence from two routers (1,140 choices, 140 of them failovers) | always: **met** |

Two readings to keep in mind:

- **The saving in scenario 1 is small because the long tasks dominate the bill**: 300 tasks at 1,200 tokens cost 3,600 of B's 3,642 units, and the router cannot make them cheaper without a weaker model. It scales with the share of short tasks and with the price ratio; it says nothing about quality beyond the fixture labels.
- **Scenario 4 shows a property of the budget, not of the router**: `budget.maxCostUnits` counts input and output tokens, but only the output is capped (`maxTokens` is reduced to what remains). A verbose fallback therefore ends up over the budget by the input tokens of the last call (10 here: 110 against 100). The router adds no overrun of its own, and a call after the budget is spent never reaches a model.

## Weighted assessment

Weights reflect Agentropy's priorities (vendor neutrality, safety, minimal core). Scores 1 (poor) – 5 (good).

| Criterion | Weight | A pinned | B rules | C learned | D gateway |
|---|---|---|---|---|---|
| Security floors enforceable and testable | 0.25 | 5 | 5 | 3 | 3 |
| Vendor neutrality | 0.15 | 5 | 5 | 4 | 4 |
| Determinism and auditability | 0.15 | 5 | 5 | 2 | 3 |
| Cost and latency gains | 0.15 | 1 | 4 | 5 | 4 |
| Quality per task | 0.10 | 3 | 4 | 4 | 3 |
| Core complexity added | 0.10 | 5 | 4 | 1 | 5 |
| Operational effort | 0.10 | 5 | 4 | 2 | 3 |
| **Weighted total** | 1.00 | **4.40** | **4.65** | **3.05** | **3.55** |

## Recommendation

- Keep **A** as the default.
- If routing is needed, add **B** as an optional `ReasoningProvider` wrapper outside the core runtime: explicit rules, ordered same-floor fallbacks, budget across attempts, choice recorded in spans. It needs no new contract surface beyond endpoint descriptors (zone, data classes, cost per token).
- **D** remains compatible today without any Agentropy change, because the reasoning adapter speaks the OpenAI-compatible API; the deployment must then enforce the floors in the gateway, and Agentropy cannot test them.
- **C** is not recommended for the core: non-deterministic, hard to audit, and open to content-based manipulation. It can sit behind B as a scoring hint inside a rule's allowed set.

Both next steps are done: the B wrapper with a test for the six floors (FEAT-035.3) and the fixture benchmark above (FEAT-043).
