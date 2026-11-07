/**
 * A2A push notifications (FEAT-029.2): the four TaskPushNotificationConfig methods and best-effort delivery of
 * every `StreamResponse` update to allow-listed webhook URLs. Configs are scoped to tenant + creating principal +
 * task. They live in memory, or in a store (FEAT-034.3): then they survive a restart, `resume()` restarts their
 * watchers and catches a webhook up on a state change it missed, and webhook secrets are stored only sealed.
 * Deleting a config ends its watcher and releases its task subscription at once.
 */
import {
  AgentropyError,
  type Store,
  type TaskSnapshot,
  type TrustedPrincipal,
} from '@agentropy/core';
import { randomUUID } from 'node:crypto';
import type { DirectTarget } from './communication.js';
import {
  A2A_PROTOCOL_VERSION,
  TERMINAL_A2A,
  TO_A2A,
  type A2ATaskState,
} from './a2a-protocol.js';
import type { A2AStreamFrame } from './a2a-server.js';

/** Push delivery transport; `redirect: 'manual'` keeps a webhook from bouncing deliveries elsewhere. */
export type A2APushFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    redirect: 'manual';
    /** Aborts at `timeoutMs`: a webhook that never answers must not hold the watcher. */
    signal: AbortSignal;
  },
) => Promise<{ status: number; body?: { cancel(): Promise<unknown> } | null }>;

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
  /** Time one delivery attempt may take before it is aborted and counted as failed (default 10 s). */
  timeoutMs?: number;
  /** First retry delay in ms (default 200). */
  retryMs?: number;
  /** Configs one principal may hold per task (default 10). */
  maxConfigsPerTask?: number;
  /**
   * Keep configs in this store so they survive a restart; call `A2AServer.resumePush()` when the server starts.
   * Every server that resumes delivers, so with several servers a webhook may get an update more than once.
   */
  store?: Store;
  /**
   * Seals webhook secrets (`token`, `authentication.credentials`) before they are stored, e.g. with a KMS key. With
   * a store and no sealer, configs that carry secrets are refused: secrets are never stored in the clear.
   */
  sealer?: A2ASecretSealer;
  /** Called when a notification is given up on; delivery is best-effort and never fails the task. */
  onDeliveryError?: (e: {
    taskId: string;
    configId: string;
    status?: number;
  }) => void;
}

/** Seals and opens webhook secrets at rest (FEAT-034.3). */
export interface A2ASecretSealer {
  seal(plain: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

/** A2A `TaskPushNotificationConfig` (credentials are write-only: reads return the scheme alone). */
export interface A2APushConfig {
  id: string;
  taskId: string;
  url: string;
  token?: string;
  authentication?: { scheme: string; credentials?: string };
}

/** A stored config: its creator (the watcher follows the task as them) and the last state delivered. */
interface PushRecord {
  tenantId: string;
  taskId: string;
  creator: TrustedPrincipal;
  config: A2APushConfig;
  lastState: A2ATaskState;
}

/** Where configs live: memory, or a store with sealed secrets. */
interface PushRepo {
  get(key: string): Promise<PushRecord | undefined>;
  list(c: TrustedPrincipal, taskId: string): Promise<PushRecord[]>;
  all(): Promise<[string, PushRecord][]>;
  put(key: string, r: PushRecord): Promise<void>;
  delete(key: string): Promise<boolean>;
  mark(key: string, state: A2ATaskState): Promise<void>;
}

function memoryRepo(): PushRepo {
  const m = new Map<string, PushRecord>();
  return {
    get: async (k) => m.get(k),
    list: async (c, taskId) =>
      [...m.values()].filter(
        (r) =>
          r.tenantId === c.tenantId &&
          r.creator.id === c.id &&
          r.taskId === taskId,
      ),
    all: async () => [...m.entries()],
    put: async (k, r) => void m.set(k, r),
    delete: async (k) => m.delete(k),
    mark: async (k, state) => {
      const r = m.get(k);
      if (r) r.lastState = state;
    },
  };
}

function storeRepo(
  store: Store,
  sealer: A2ASecretSealer | undefined,
): PushRepo {
  const open = async (r: PushRecord): Promise<PushRecord> => {
    const c = r.config;
    if (!c.token && !c.authentication?.credentials) return r;
    if (!sealer)
      throw new AgentropyError(
        'InvalidConfiguration',
        'Stored push config has secrets but no sealer is configured',
      );
    return {
      ...r,
      config: {
        ...c,
        ...(c.token ? { token: await sealer.open(c.token) } : {}),
        ...(c.authentication
          ? {
              authentication: {
                scheme: c.authentication.scheme,
                ...(c.authentication.credentials
                  ? {
                      credentials: await sealer.open(
                        c.authentication.credentials,
                      ),
                    }
                  : {}),
              },
            }
          : {}),
      },
    };
  };
  const sealed = async (r: PushRecord): Promise<PushRecord> => {
    const c = r.config;
    if (!c.token && !c.authentication?.credentials) return r;
    if (!sealer)
      throw new AgentropyError(
        'UnsupportedOperation',
        'Webhook token and credentials need a sealer to be stored',
        { details: { reason: 'sealer' } },
      );
    return {
      ...r,
      config: {
        ...c,
        ...(c.token ? { token: await sealer.seal(c.token) } : {}),
        ...(c.authentication
          ? {
              authentication: {
                scheme: c.authentication.scheme,
                ...(c.authentication.credentials
                  ? {
                      credentials: await sealer.seal(
                        c.authentication.credentials,
                      ),
                    }
                  : {}),
              },
            }
          : {}),
      },
    };
  };
  return {
    get: async (k) => {
      const d = await store.transaction((tx) =>
        tx.get<PushRecord>('pushConfigs', k),
      );
      return d ? open(d.value) : undefined;
    },
    list: async (c, taskId) => {
      const docs = await store.transaction((tx) =>
        tx.find<PushRecord>('pushConfigs', {
          where: { tenantId: c.tenantId, taskId },
        }),
      );
      return Promise.all(
        docs
          .filter((d) => d.value.creator.id === c.id)
          .map((d) => open(d.value)),
      );
    },
    all: async () => {
      const docs = await store.transaction((tx) =>
        tx.find<PushRecord>('pushConfigs', {}),
      );
      return Promise.all(
        docs.map(
          async (d) => [d.id, await open(d.value)] as [string, PushRecord],
        ),
      );
    },
    put: async (k, r) => {
      const value = await sealed(r);
      await store.transaction(async (tx) => {
        const cur = await tx.get<PushRecord>('pushConfigs', k);
        if (cur) await tx.update('pushConfigs', k, cur.revision, value);
        else await tx.insert('pushConfigs', k, value);
      });
    },
    delete: (k) =>
      store.transaction(async (tx) => {
        const cur = await tx.get('pushConfigs', k);
        if (!cur) return false;
        await tx.remove('pushConfigs', k, cur.revision);
        return true;
      }),
    mark: (k, state) =>
      store.transaction(async (tx) => {
        const cur = await tx.get<PushRecord>('pushConfigs', k);
        if (cur && cur.value.lastState !== state)
          await tx.update('pushConfigs', k, cur.revision, {
            ...cur.value,
            lastState: state,
          });
      }),
  };
}

/** The task state a stream frame reports, if it reports one. */
function stateOf(result: unknown): A2ATaskState | undefined {
  const r = result as
    | {
        task?: { status?: { state?: A2ATaskState } };
        statusUpdate?: { status?: { state?: A2ATaskState } };
      }
    | undefined;
  return r?.task?.status?.state ?? r?.statusUpdate?.status?.state;
}

/** Push config methods and watchers for one server. */
export function createPushNotifications(
  target: DirectTarget,
  options: A2APushOptions | undefined,
  follow: (
    id: unknown,
    first: TaskSnapshot,
    principal: TrustedPrincipal,
    contextId?: string,
    signal?: AbortSignal,
  ) => AsyncIterable<A2AStreamFrame>,
) {
  const repo: PushRepo = options?.store
    ? storeRepo(options.store, options.sealer)
    : memoryRepo();
  const watchers = new Map<
    string,
    { run: Promise<void>; stop: AbortController }
  >();
  const pushKey = (c: TrustedPrincipal, taskId: string, id: string) =>
    JSON.stringify([c.tenantId, c.id, taskId, id]);
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
  ): Promise<boolean> => {
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
        const res = await send(c.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          redirect: 'manual',
          signal: AbortSignal.timeout(push.timeoutMs ?? 10_000),
        });
        status = res.status;
        // The reply body is not read: release the connection.
        void res.body?.cancel().catch(() => undefined);
        if (status >= 200 && status < 300) return true;
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
    return false;
  };
  /**
   * Follows the task as its creator and posts every update to the config's URL until terminal or deleted. The
   * first frame (the task's current state) is posted only when it differs from the last state delivered, which
   * after a restart catches the webhook up on what it missed.
   */
  const watch = (
    push: A2APushOptions,
    key: string,
    first: TaskSnapshot,
    creator: TrustedPrincipal,
    lastState: A2ATaskState,
  ) => {
    const stop = new AbortController();
    const run: Promise<void> = (async () => {
      let isFirst = true;
      for await (const f of follow(
        null,
        first,
        creator,
        undefined,
        stop.signal,
      )) {
        const state = stateOf(f.result);
        if (isFirst) {
          isFirst = false;
          if (state === lastState) continue;
        }
        const r = await repo.get(key);
        if (!r || f.error || stop.signal.aborted) return; // deleted, or the creator lost access to the task
        if ((await deliver(push, r.config, f.result)) && state)
          await repo.mark(key, state).catch(() => undefined);
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        if (watchers.get(key)?.run === run) watchers.delete(key);
      });
    watchers.set(key, { run, stop });
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
        const existing = await repo.get(key);
        if (
          !existing &&
          (await repo.list(caller, taskId)).length >=
            (push.maxConfigsPerTask ?? 10)
        )
          throw new AgentropyError(
            'QuotaExceeded',
            'Too many push configs for this task',
          );
        const lastState = existing?.lastState ?? TO_A2A[snap.status];
        // Same ID replaces the config; the running watcher reads the new one.
        await repo.put(key, {
          tenantId: caller.tenantId,
          taskId,
          creator: caller,
          config,
          lastState,
        });
        if (!watchers.has(key)) watch(push, key, snap, caller, lastState);
        return view(config);
      }
      case 'GetTaskPushNotificationConfig': {
        const r = id ? await repo.get(pushKey(caller, taskId, id)) : undefined;
        if (!r) throw new AgentropyError('NotFound', 'Push config not found');
        return view(r.config);
      }
      case 'ListTaskPushNotificationConfigs':
        return {
          configs: (await repo.list(caller, taskId)).map((r) => view(r.config)),
          nextPageToken: '',
        };
      default: {
        // DeleteTaskPushNotificationConfig
        const key = id ? pushKey(caller, taskId, id) : undefined;
        if (!key || !(await repo.delete(key)))
          throw new AgentropyError('NotFound', 'Push config not found');
        watchers.get(key)?.stop.abort();
        return {};
      }
    }
  };
  return {
    method: pushMethod,
    /**
     * Restarts a watcher for every stored config whose task is still live and whose creator can still see it.
     * Returns how many were started.
     */
    async resume(): Promise<number> {
      if (!options) return 0;
      let started = 0;
      for (const [key, r] of await repo.all()) {
        if (watchers.has(key) || TERMINAL_A2A.has(r.lastState)) continue;
        const snap = await target
          .getTask(r.taskId, r.creator)
          .catch(() => undefined);
        if (!snap) continue; // gone, or the creator lost access: nothing to deliver
        watch(options, key, snap, r.creator, r.lastState);
        started++;
      }
      return started;
    },
    /** Resolves once every watcher has finished. */
    async idle() {
      while (watchers.size)
        await Promise.allSettled([...watchers.values()].map((w) => w.run));
    },
  };
}
