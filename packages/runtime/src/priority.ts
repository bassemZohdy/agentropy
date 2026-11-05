/**
 * Briefing priority and delivery policy (docs/human-actions.md "Shared effective priority", M2-04, R-26).
 *
 * effectiveSeverity = max(entry severity, policy floor). The floor is set by policy (e.g. a pending approval is at
 * least `high`); personal preferences may only decide how much *below the floor-free range* is mentioned and can
 * never hide an entry that has a floor. Delivery: `critical` interrupts (push + top of briefing); entries at or
 * above the user's briefing threshold, or with a floor, are mentioned; the rest wait for on-demand reading.
 */
import type { InboxEntry, Severity } from '@agentropy/core';

export const SEVERITY_ORDER: readonly Severity[] = [
  'critical',
  'high',
  'normal',
  'low',
];
const rank = (s: Severity) => SEVERITY_ORDER.indexOf(s);

export type Delivery = 'interrupt' | 'mention' | 'on-demand';

export interface InboxPreferences {
  /** Lowest severity mentioned in a briefing (default `normal`): lower entries are on-demand unless floored. */
  briefFrom?: Severity;
}

export interface PriorityPolicy {
  /** Minimum severity for an entry, or undefined when policy sets none. Never lowered by preferences. */
  floor(entry: InboxEntry): Severity | undefined;
}

/** Default floors: approvals someone must act on and failed delegated work are at least `high`. */
export const DEFAULT_PRIORITY_POLICY: PriorityPolicy = {
  floor: (e) =>
    e.actionRequestId && !e.markers.resolvedAt
      ? 'high'
      : e.source.type === 'taskFailed'
        ? 'high'
        : undefined,
};

export interface DeliveryDecision {
  severity: Severity;
  delivery: Delivery;
  floored: boolean;
}

export function resolveDelivery(
  entry: InboxEntry,
  preferences: InboxPreferences = {},
  policy: PriorityPolicy = DEFAULT_PRIORITY_POLICY,
): DeliveryDecision {
  const floor = policy.floor(entry);
  const severity =
    floor !== undefined && rank(floor) < rank(entry.severity)
      ? floor
      : entry.severity;
  const threshold = preferences.briefFrom ?? 'normal';
  const delivery: Delivery =
    severity === 'critical'
      ? 'interrupt'
      : floor !== undefined || rank(severity) <= rank(threshold)
        ? 'mention'
        : 'on-demand';
  return { severity, delivery, floored: floor !== undefined };
}
