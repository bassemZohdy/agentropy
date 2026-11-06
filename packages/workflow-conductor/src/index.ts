/**
 * @agentropy/workflow-conductor — WorkflowEngine adapter for Conductor (Conductor OSS and Orkes Conductor) over
 * its REST API (FEAT-028.6, M3-01). The second workflow adapter after the in-memory fake; it shows how an external
 * engine plugs into the WorkflowEngine SPI without Agentropy taking on any workflow semantics.
 *
 * Mapping:
 * - `start` → `POST /api/workflow` with `{ name, version?, input, correlationId }`. The correlation ID is
 *   `<tenantId>:<idempotencyKey>`, which also scopes reads to the tenant.
 * - Idempotency (`idempotency` option): `server` (default) also sends `idempotencyKey` +
 *   `idempotencyStrategy: RETURN_EXISTING` (enforced by servers that support it, e.g. Orkes); `lookup` first asks
 *   `GET /api/workflow/{name}/correlated/{correlationId}` and reuses an existing run (for servers without
 *   idempotency keys; two truly concurrent starts can still race).
 * - `status` → `GET /api/workflow/{id}?includeTasks=false`; RUNNING/PAUSED → running, COMPLETED → completed
 *   (`output`), FAILED → failed `TaskFailed`, TIMED_OUT → failed `Timeout`, TERMINATED → failed `TaskCancelled`.
 *   A run of another tenant, or an unknown run, is `failed` with code `NotFound` (no disclosure).
 * - Completion: Conductor reports through a status webhook (`handleStatusEvent`) or the adapter polls the runs it
 *   started (`poll`). `reconcile(runIds)` re-checks runs after a restart, since the adapter keeps no state of its
 *   own. Each terminal run is reported to `onFinished` once per adapter instance; the runtime's event ingress
 *   deduplicates across instances.
 *
 * Not supported by the SPI and therefore not mapped: pause/resume, terminate, task-level visibility.
 */
import {
  AgentropyError,
  type WorkflowEngine,
  type WorkflowRun,
} from '@agentropy/core';

export interface ConductorHttpResponse {
  status: number;
  text(): Promise<string>;
}

/** The only transport the adapter needs; `globalThis.fetch` fits. */
export type ConductorFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<ConductorHttpResponse>;

export interface ConductorEngineOptions {
  /** Base URL of the Conductor server, e.g. `https://conductor.internal`. */
  baseUrl: string;
  fetch: ConductorFetch;
  /** Extra headers per request, e.g. an Orkes `X-Authorization` token. Values are never logged or returned. */
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
  /** Workflow version per name; latest when absent. */
  versions?: Record<string, number>;
  idempotency?: 'server' | 'lookup';
}

type ConductorStatus =
  'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'TERMINATED';

interface ConductorWorkflow {
  workflowId: string;
  status: ConductorStatus;
  correlationId?: string;
  output?: unknown;
  workflowName?: string;
}

const TERMINAL_CODE: Partial<Record<ConductorStatus, string>> = {
  FAILED: 'TaskFailed',
  TIMED_OUT: 'Timeout',
  TERMINATED: 'TaskCancelled',
};

export class ConductorWorkflowEngine implements WorkflowEngine {
  readonly id = 'conductor';
  private readonly listeners: ((
    run: WorkflowRun & { tenantId: string },
  ) => void)[] = [];
  /** Runs started by this instance that have not finished yet: runId → tenant. */
  private readonly open = new Map<string, string>();
  private readonly reported = new Set<string>();

  constructor(private readonly o: ConductorEngineOptions) {
    if (!/^https?:\/\//.test(o.baseUrl))
      throw new AgentropyError(
        'InvalidConfiguration',
        'Conductor baseUrl must be an http(s) URL',
      );
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T | string }> {
    let res: ConductorHttpResponse;
    try {
      res = await this.o.fetch(`${this.o.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(await this.o.headers?.()),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AgentropyError(
        'ProviderUnavailable',
        'Conductor is unreachable',
        { details: { provider: this.id } },
      );
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403)
      throw new AgentropyError(
        'AuthorityExpired',
        'Conductor refused the credentials',
        { details: { provider: this.id, kind: 'credential' } },
      );
    if (res.status >= 500 || res.status === 429)
      throw new AgentropyError('ProviderUnavailable', 'Conductor error', {
        details: { provider: this.id, status: res.status },
      });
    let parsed: T | string = text;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      /* plain-text responses (the start call returns the workflow ID as text) */
    }
    return { status: res.status, body: parsed };
  }

  async start(
    workflow: string,
    input: unknown,
    ctx: { tenantId: string; taskId: string; idempotencyKey: string },
  ): Promise<WorkflowRun> {
    const correlationId = `${ctx.tenantId}:${ctx.idempotencyKey}`;
    const name = encodeURIComponent(workflow);
    if (this.o.idempotency === 'lookup') {
      const found = await this.call<ConductorWorkflow[]>(
        'GET',
        `/api/workflow/${name}/correlated/${encodeURIComponent(correlationId)}?includeClosed=true&includeTasks=false`,
      );
      const existing = Array.isArray(found.body) ? found.body[0] : undefined;
      if (existing) return this.track(existing, ctx.tenantId);
    }
    const version = this.o.versions?.[workflow];
    const res = await this.call<string>('POST', '/api/workflow', {
      name: workflow,
      ...(version !== undefined ? { version } : {}),
      input: input ?? {},
      correlationId,
      ...(this.o.idempotency !== 'lookup'
        ? {
            idempotencyKey: correlationId,
            idempotencyStrategy: 'RETURN_EXISTING',
          }
        : {}),
    });
    if (res.status === 404)
      throw new AgentropyError(
        'CapabilityUnavailable',
        `Workflow ${workflow} is not registered in Conductor`,
        { details: { provider: this.id } },
      );
    if (res.status >= 400 || typeof res.body !== 'string' || !res.body)
      throw new AgentropyError('Internal', 'Conductor rejected the start', {
        details: { provider: this.id, status: res.status },
      });
    const runId = res.body.trim().replace(/^"|"$/g, '');
    this.open.set(runId, ctx.tenantId);
    return { runId, state: 'running' };
  }

  private async fetchRun(
    runId: string,
  ): Promise<ConductorWorkflow | undefined> {
    const res = await this.call<ConductorWorkflow>(
      'GET',
      `/api/workflow/${encodeURIComponent(runId)}?includeTasks=false`,
    );
    if (res.status === 404 || typeof res.body !== 'object') return undefined;
    return res.body;
  }

  private owned(w: ConductorWorkflow | undefined, tenantId: string) {
    return w?.correlationId?.startsWith(`${tenantId}:`) === true;
  }

  async status(runId: string, ctx: { tenantId: string }): Promise<WorkflowRun> {
    const w = await this.fetchRun(runId);
    if (!w || !this.owned(w, ctx.tenantId))
      return { runId, state: 'failed', code: 'NotFound' };
    return toRun(w);
  }

  onFinished(
    listener: (run: WorkflowRun & { tenantId: string }) => void,
  ): void {
    this.listeners.push(listener);
  }

  /**
   * Conductor workflow status listener (webhook) payload. Untrusted input: the run is re-read from Conductor
   * before anything is reported, so a forged payload cannot complete a run.
   */
  async handleStatusEvent(payload: unknown): Promise<boolean> {
    const id = (payload as { workflowId?: unknown } | null)?.workflowId;
    if (typeof id !== 'string' || !id) return false;
    return this.check(id);
  }

  /** Re-check every run this instance started and report the finished ones. Returns how many finished. */
  async poll(): Promise<number> {
    let n = 0;
    for (const runId of [...this.open.keys()]) if (await this.check(runId)) n++;
    return n;
  }

  /** After a restart: re-check runs recorded elsewhere (e.g. in task checkpoints). */
  async reconcile(runIds: string[]): Promise<number> {
    let n = 0;
    for (const runId of runIds) if (await this.check(runId)) n++;
    return n;
  }

  private track(w: ConductorWorkflow, tenantId: string): WorkflowRun {
    const run = toRun(w);
    if (run.state === 'running') this.open.set(w.workflowId, tenantId);
    return run;
  }

  private async check(runId: string): Promise<boolean> {
    const w = await this.fetchRun(runId);
    if (!w) return false;
    const tenantId = w.correlationId?.split(':')[0];
    const run = toRun(w);
    if (run.state === 'running' || !tenantId) return false;
    this.open.delete(runId);
    if (this.reported.has(runId)) return false;
    this.reported.add(runId);
    for (const l of this.listeners) l({ ...run, tenantId });
    return true;
  }
}

function toRun(w: ConductorWorkflow): WorkflowRun {
  if (w.status === 'COMPLETED')
    return {
      runId: w.workflowId,
      state: 'completed',
      ...(w.output !== undefined ? { output: w.output } : {}),
    };
  const code = TERMINAL_CODE[w.status];
  if (code) return { runId: w.workflowId, state: 'failed', code };
  return { runId: w.workflowId, state: 'running' };
}
