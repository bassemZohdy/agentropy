/**
 * A2A push notifications (FEAT-029.2): the four TaskPushNotificationConfig methods and best-effort delivery of
 * every `StreamResponse` update to allow-listed webhook URLs. Configs live in memory, scoped to tenant + creating
 * principal + task.
 */
import {
  AgentropyError,
  type TaskSnapshot,
  type TrustedPrincipal,
} from '@agentropy/core';
import { randomUUID } from 'node:crypto';
import type { DirectTarget } from './communication.js';
import { A2A_PROTOCOL_VERSION, TERMINAL_A2A, TO_A2A } from './a2a-protocol.js';
import type { A2AStreamFrame } from './a2a-server.js';

/** Push delivery transport; `redirect: 'manual'` keeps a webhook from bouncing deliveries elsewhere. */
export type A2APushFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    redirect: 'manual';
  },
) => Promise<{ status: number }>;

export interface A2APushOptions {
  /**
   * Required SSRF guard: a webhook URL is accepted only when this admits it (match exact origins; never admit
   * internal addresses a client could name). URLs with embedded credentials are always refused.
   */
  allowUrl: (url: URL) => boolean;
  /** Admit `http:` URLs (default false: `https:` only). */
  allowHttp?: boolean;
  fetch?: A2APushFetch;
  /** Attempts per notification (default 3); 5xx, 429 and transport errors are retried with doubling backoff. */
  maxAttempts?: number;
  /** First retry delay in ms (default 200). */
  retryMs?: number;
  /** Configs one principal may hold per task (default 10). */
  maxConfigsPerTask?: number;
  /** Called when a notification is given up on; delivery is best-effort and never fails the task. */
  onDeliveryError?: (e: {
    taskId: string;
    configId: string;
    status?: number;
  }) => void;
}

/** A2A `TaskPushNotificationConfig` (credentials are write-only: reads return the scheme alone). */
export interface A2APushConfig {
  id: string;
  taskId: string;
  url: string;
  token?: string;
  authentication?: { scheme: string; credentials?: string };
}

/** Push config methods and watchers for one server. */
export function createPushNotifications(
  target: DirectTarget,
  options: A2APushOptions | undefined,
  follow: (
    id: unknown,
    first: TaskSnapshot,
    principal: TrustedPrincipal,
  ) => AsyncIterable<A2AStreamFrame>,
) {
  const pushConfigs = new Map<string, A2APushConfig>();
  const watchers = new Set<Promise<void>>();
  const pushKey = (c: TrustedPrincipal, taskId: string, id: string) =>
    JSON.stringify([c.tenantId, c.id, taskId, id]);
  const taskConfigs = (c: TrustedPrincipal, taskId: string) => {
    const prefix = JSON.stringify([c.tenantId, c.id, taskId]).slice(0, -1);
    return [...pushConfigs.entries()].filter(([k]) =>
      k.startsWith(prefix + ','),
    );
  };
  const requirePush = (): A2APushOptions => {
    if (!options)
      throw new AgentropyError(
        'UnsupportedOperation',
        'Push notifications are not supported',
        { details: { a2a: -32003 } },
      );
    return options;
  };
  const HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
  const noCtl = (v: unknown, field: string): string | undefined => {
    if (v === undefined || v === '') return undefined;
    if (typeof v !== 'string' || /[\r\n\0]/.test(v))
      throw new AgentropyError('SchemaViolation', `Invalid ${field}`, {
        details: { reason: field },
      });
    return v;
  };
  const pushUrl = (push: A2APushOptions, raw: unknown): string => {
    let u: URL;
    try {
      u = new URL(String(raw));
    } catch {
      throw new AgentropyError('SchemaViolation', 'Invalid push URL', {
        details: { reason: 'url' },
      });
    }
    const schemeOk =
      u.protocol === 'https:' || (u.protocol === 'http:' && push.allowHttp);
    if (!schemeOk || u.username || u.password || !push.allowUrl(u))
      throw new AgentropyError('PermissionDenied', 'Push URL not allowed', {
        details: { reason: 'pushUrl' },
      });
    return u.href;
  };
  const view = (c: A2APushConfig): A2APushConfig => ({
    ...c,
    ...(c.authentication
      ? { authentication: { scheme: c.authentication.scheme } }
      : {}),
  });
  const deliver = async (
    push: A2APushOptions,
    c: A2APushConfig,
    payload: unknown,
  ): Promise<void> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'a2a-version': A2A_PROTOCOL_VERSION,
    };
    if (c.token) headers['x-a2a-notification-token'] = c.token;
    if (c.authentication)
      headers.authorization =
        `${c.authentication.scheme} ${c.authentication.credentials ?? ''}`.trim();
    const send: A2APushFetch = push.fetch ?? ((u, i) => fetch(u, i));
    const attempts = Math.max(1, push.maxAttempts ?? 3);
    let status: number | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        status = (
          await send(c.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            redirect: 'manual',
          })
        ).status;
        if (status >= 200 && status < 300) return;
        if (status < 500 && status !== 429) break; // the receiver refused it; retrying will not help
      } catch {
        status = undefined;
      }
      if (attempt < attempts)
        await new Promise((r) =>
          setTimeout(r, (push.retryMs ?? 200) * 2 ** (attempt - 1)),
        );
    }
    push.onDeliveryError?.({
      taskId: c.taskId,
      configId: c.id,
      ...(status !== undefined ? { status } : {}),
    });
  };
  /** Follows the task as its creator and posts every update to the config's URL until terminal or deleted. */
  const watch = (
    push: A2APushOptions,
    key: string,
    first: TaskSnapshot,
    creator: TrustedPrincipal,
  ) => {
    const run: Promise<void> = (async () => {
      let skipped = false;
      for await (const f of follow(null, first, creator)) {
        if (!skipped) {
          skipped = true; // the task frame: the creator already holds that state
          continue;
        }
        const c = pushConfigs.get(key);
        if (!c || f.error) return; // deleted, or the creator lost access to the task
        await deliver(push, c, f.result);
      }
    })()
      .catch(() => undefined)
      .finally(() => watchers.delete(run));
    watchers.add(run);
  };
  const pushMethod = async (
    method: string,
    p: Record<string, unknown>,
    caller: TrustedPrincipal,
  ): Promise<unknown> => {
    const push = requirePush();
    const taskId = p['taskId'];
    if (typeof taskId !== 'string' || !taskId)
      throw new AgentropyError('SchemaViolation', 'taskId required');
    // Every config method re-checks that the caller can still see the task (the AgentService PEP).
    const snap = await target.getTask(taskId, caller);
    const id = typeof p['id'] === 'string' ? p['id'] : undefined;
    switch (method) {
      case 'CreateTaskPushNotificationConfig': {
        if (TERMINAL_A2A.has(TO_A2A[snap.status]))
          throw new AgentropyError(
            'UnsupportedOperation',
            'Task is in a terminal state',
          );
        const url = pushUrl(push, p['url']);
        const token = noCtl(p['token'], 'token');
        const a = p['authentication'] as
          { scheme?: unknown; credentials?: unknown } | undefined;
        if (
          a !== undefined &&
          (typeof a.scheme !== 'string' || !HEADER_TOKEN.test(a.scheme))
        )
          throw new AgentropyError('SchemaViolation', 'Invalid scheme', {
            details: { reason: 'authentication' },
          });
        const credentials = a ? noCtl(a.credentials, 'credentials') : undefined;
        const config: A2APushConfig = {
          id: id || randomUUID(),
          taskId,
          url,
          ...(token ? { token } : {}),
          ...(a
            ? {
                authentication: {
                  scheme: a.scheme as string,
                  ...(credentials ? { credentials } : {}),
                },
              }
            : {}),
        };
        const key = pushKey(caller, taskId, config.id);
        const isNew = !pushConfigs.has(key);
        if (
          isNew &&
          taskConfigs(caller, taskId).length >= (push.maxConfigsPerTask ?? 10)
        )
          throw new AgentropyError(
            'QuotaExceeded',
            'Too many push configs for this task',
          );
        pushConfigs.set(key, config); // same ID replaces the config; the running watcher reads the new one
        if (isNew) watch(push, key, snap, caller);
        return view(config);
      }
      case 'GetTaskPushNotificationConfig': {
        const c = id ? pushConfigs.get(pushKey(caller, taskId, id)) : undefined;
        if (!c) throw new AgentropyError('NotFound', 'Push config not found');
        return view(c);
      }
      case 'ListTaskPushNotificationConfigs':
        return {
          configs: taskConfigs(caller, taskId).map(([, c]) => view(c)),
          nextPageToken: '',
        };
      default: {
        // DeleteTaskPushNotificationConfig
        if (!id || !pushConfigs.delete(pushKey(caller, taskId, id)))
          throw new AgentropyError('NotFound', 'Push config not found');
        return {};
      }
    }
  };
  return {
    method: pushMethod,
    /** Resolves once every watcher has finished. */
    async idle() {
      while (watchers.size) await Promise.allSettled([...watchers]);
    },
  };
}
