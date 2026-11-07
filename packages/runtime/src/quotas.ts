/**
 * Per-tenant quotas (M2-11, R-16): limits evaluated inside the accepting transaction, so concurrent requests cannot
 * overshoot. A quota refusal is `QuotaExceeded` (retryable, `limit` category) and only affects the tenant that hit
 * it. Idempotent replays of already accepted requests are answered before quotas are checked.
 */
import { AgentropyError, type StoreTx } from '@agentropy/core';

export interface TenantQuota {
  /** Non-terminal tasks at once. */
  maxActiveTasks?: number;
  /** New tasks accepted in any rolling 60-second window. */
  maxAcceptsPerMinute?: number;
  /** Agent instances that are not retired. */
  maxInstances?: number;
  /** Executions running at once across every worker sharing the store (M3-02); excess work waits queued. */
  maxConcurrentExecutions?: number;
}

export type QuotaResolver = (tenantId: string) => TenantQuota | undefined;

/** Statuses of a task that has not ended. */
const LIVE = ['created', 'assigned', 'running', 'waiting'] as const;

const exceeded = (quota: keyof TenantQuota, limit: number) =>
  new AgentropyError(
    'QuotaExceeded',
    `Tenant quota ${quota} (${limit}) reached`,
    {
      details: { quota, limit },
    },
  );

export async function checkTaskQuota(
  tx: StoreTx,
  tenantId: string,
  quota: TenantQuota | undefined,
  now: string,
): Promise<void> {
  if (
    quota?.maxActiveTasks === undefined &&
    quota?.maxAcceptsPerMinute === undefined
  )
    return;
  // Counted through the `status` and `createdAt` indexes, each read stopping at the limit: a tenant's history of
  // finished tasks costs nothing here (FEAT-039.3).
  if (quota.maxActiveTasks !== undefined) {
    let active = 0;
    for (const status of LIVE) {
      active += (
        await tx.find('tasks', {
          where: { tenantId, status },
          limit: quota.maxActiveTasks - active,
        })
      ).length;
      if (active >= quota.maxActiveTasks)
        throw exceeded('maxActiveTasks', quota.maxActiveTasks);
    }
  }
  if (quota.maxAcceptsPerMinute !== undefined) {
    const since = new Date(Date.parse(now) - 60_000).toISOString();
    // `createdAt > since`: the range is inclusive, so the boundary row is excluded after the read.
    const recent = (
      await tx.find<{ createdAt: string }>('tasks', {
        where: { tenantId },
        range: { field: 'createdAt', gte: since },
        limit: quota.maxAcceptsPerMinute + 1,
      })
    ).filter((t) => t.value.createdAt > since);
    if (recent.length >= quota.maxAcceptsPerMinute)
      throw exceeded('maxAcceptsPerMinute', quota.maxAcceptsPerMinute);
  }
}

export async function checkInstanceQuota(
  tx: StoreTx,
  tenantId: string,
  quota: TenantQuota | undefined,
): Promise<void> {
  if (quota?.maxInstances === undefined) return;
  const live = (
    await tx.find<{ state: string }>('instances', { where: { tenantId } })
  ).filter((i) => i.value.state !== 'retired').length;
  if (live >= quota.maxInstances)
    throw exceeded('maxInstances', quota.maxInstances);
}
