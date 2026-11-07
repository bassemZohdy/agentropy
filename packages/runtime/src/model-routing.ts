/**
 * Rule-based model routing (FEAT-035.3, N-03 option B): a `ReasoningProvider` that picks among configured endpoints,
 * outside the core runtime and without a new contract surface beyond the endpoint descriptors.
 *
 * Security floors (see the model routing evaluation):
 * 1. **Residency and data class are hard constraints.** The endpoints considered are those declared for the required
 *    zone and data class; with none available the call fails `ProviderUnavailable` — it is never sent elsewhere.
 *    Constraints come from the deployment's `floors` (trusted: tenant, task) and the caller's `route` hints; a floor
 *    always wins over a hint, and routing never reads prompts or any model-generated text.
 * 2. **Fallback only within the same floor set.** Rules order candidates; candidates are filtered by the floors first,
 *    so a fallback can never be an endpoint the primary was not allowed to be.
 * 3. **Budget.** The reasoning capability reserves the call's tokens before this provider runs and settles after, so
 *    attempts (including failed ones) cannot exceed `budget.maxCostUnits`; every attempt is asked for no more
 *    than the request's `maxTokens`.
 * 4. **Auditable choice.** `onChoice` receives the rule, endpoint and outcome of every attempt (identifiers only, never
 *    prompts or keys) for spans and the audit trail.
 * 5. **Credentials per endpoint.** Each endpoint is its own provider with its own credential reference; the router
 *    shares nothing between them.
 * 6. **Deterministic.** The same request and floors always give the same candidate order.
 */
import {
  AgentropyError,
  isAgentropyError,
  type ReasoningProvider,
  type ReasoningRequest,
  type ReasoningResult,
} from '@agentropy/core';

/** Where a request may go and how it prefers to be served. All fields are identifiers, never free text from a model. */
export interface ModelRoute {
  /** Residency zone the data must stay in. */
  zone?: string;
  /** Data class the endpoint must be cleared for. */
  dataClass?: string;
  /** Capability tier the caller wants (matched by rules). */
  tier?: string;
  latency?: 'low' | 'normal';
}

export interface ModelEndpoint {
  id: string;
  provider: ReasoningProvider;
  /** The zone this endpoint runs in. */
  zone: string;
  /** Data classes it is cleared for. */
  dataClasses: readonly string[];
}

export interface RoutingRule {
  id: string;
  /** The rule applies when every given attribute equals the request's `route` hint. */
  when?: Pick<ModelRoute, 'tier' | 'latency'>;
  /** Candidate endpoint IDs in order of preference. */
  endpoints: readonly string[];
}

export interface RoutingChoice {
  ruleId: string;
  endpointId: string;
  attempt: number;
  outcome: 'ok' | 'failed';
  /** Errors v1 code of a failed attempt. */
  code?: string;
}

const FAILOVER = new Set(['ProviderUnavailable', 'Timeout', 'QuotaExceeded']);

export function routedReasoning(o: {
  id?: string;
  endpoints: readonly ModelEndpoint[];
  /** Ordered; the first rule that matches decides. A rule without `when` is the default. */
  rules: readonly RoutingRule[];
  /** Trusted constraints for a call (from the tenant or task); they override the caller's hints. */
  floors?: (ctx: {
    tenantId: string;
    taskId: string;
  }) =>
    | Pick<ModelRoute, 'zone' | 'dataClass'>
    | Promise<Pick<ModelRoute, 'zone' | 'dataClass'>>;
  onChoice?: (choice: RoutingChoice) => void;
}): ReasoningProvider {
  const byId = new Map(o.endpoints.map((e) => [e.id, e]));
  if (byId.size !== o.endpoints.length)
    throw new AgentropyError('InvalidConfiguration', 'Duplicate endpoint IDs');
  for (const r of o.rules)
    for (const id of r.endpoints)
      if (!byId.has(id))
        throw new AgentropyError(
          'InvalidConfiguration',
          `Rule ${r.id} names unknown endpoint ${id}`,
        );
  const noRoute = () =>
    new AgentropyError(
      'ProviderUnavailable',
      'No model endpoint satisfies the required residency and data class',
      { details: { kind: 'reasoning', reason: 'routing' } },
    );
  return {
    id: o.id ?? 'routed',
    async complete(request: ReasoningRequest, ctx): Promise<ReasoningResult> {
      const hint = request.route ?? {};
      const floors = (await o.floors?.(ctx)) ?? {};
      const zone = floors.zone ?? hint.zone;
      const dataClass = floors.dataClass ?? hint.dataClass;
      const rule = o.rules.find(
        (r) =>
          (r.when?.tier === undefined || r.when.tier === hint.tier) &&
          (r.when?.latency === undefined || r.when.latency === hint.latency),
      );
      if (!rule) throw noRoute();
      // The floors filter first: nothing outside them is ever a candidate, primary or fallback.
      const candidates = rule.endpoints
        .map((id) => byId.get(id)!)
        .filter(
          (e) =>
            (zone === undefined || e.zone === zone) &&
            (dataClass === undefined || e.dataClasses.includes(dataClass)),
        );
      if (!candidates.length) throw noRoute();
      let last: unknown;
      for (const [i, e] of candidates.entries()) {
        try {
          const result = await e.provider.complete(request, ctx);
          o.onChoice?.({
            ruleId: rule.id,
            endpointId: e.id,
            attempt: i + 1,
            outcome: 'ok',
          });
          return result;
        } catch (err) {
          const code = isAgentropyError(err) ? err.code : 'Internal';
          o.onChoice?.({
            ruleId: rule.id,
            endpointId: e.id,
            attempt: i + 1,
            outcome: 'failed',
            code,
          });
          // Only an outage, a timeout or a rate limit moves on to the next endpoint; anything else is the answer.
          if (!FAILOVER.has(code)) throw err;
          last = err;
        }
      }
      throw last;
    },
  };
}
