# 2026-11-06 — Task-aware model routing evaluation (N-03, R-35)

**Status:** evaluation for FEAT-028.10; no implementation is claimed. Question: should Agentropy route a task's model calls to different models by cost, latency, quality, residency and policy, and if so where? Constraint: vendor-neutral, with a fallback that never weakens a security floor.

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

Next step if adopted: build the fixture benchmark above, then the B wrapper with a conformance test for the six floors.
