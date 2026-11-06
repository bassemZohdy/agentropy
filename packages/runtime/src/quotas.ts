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

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

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
  const tasks = await tx.find<{ status: string; createdAt: string }>('tasks', {
    where: { tenantId },
  });
  if (
    quota.maxActiveTasks !== undefined &&
    tasks.filter((t) => !TERMINAL.has(t.value.status)).length >=
      quota.maxActiveTasks
  )
    throw exceeded('maxActiveTasks', quota.maxActiveTasks);
  if (quota.maxAcceptsPerMinute !== undefined) {
    const since = new Date(Date.parse(now) - 60_000).toISOString();
    if (
      tasks.filter((t) => t.value.createdAt > since).length >=
      quota.maxAcceptsPerMinute
    )
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
