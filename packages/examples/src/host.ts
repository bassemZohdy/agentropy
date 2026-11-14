/**
 * Container host (FEAT-028.8, M3-08): runs one Agentropy runtime as a long-lived process with health endpoints, for
 * the image in deploy/Dockerfile and the Kubernetes/OpenShift manifests in deploy/. Applications replace
 * `defineAgents` with their own definitions and plug in their real policy point, audit sink and credentials.
 *
 * Configuration (environment):
 * - AGENTROPY_DB          SQLite file path on a persistent volume (default /data/agentropy.db)
 * - AGENTROPY_PG_URL      PostgreSQL connection URL: use PostgreSQL instead of SQLite (the `pg` driver is an optional
 *                         dependency loaded only then); several replicas may share the database, the pod name
 *                         (HOSTNAME) becomes the worker and outbox-relay ID
 * - AGENTROPY_PG_CONNECT_TIMEOUT_MS, AGENTROPY_PG_STATEMENT_TIMEOUT_MS, AGENTROPY_PG_LOCK_TIMEOUT_MS
 *                         how long the pool waits for a connection (default 10000), and the per-transaction
 *                         `statement_timeout` (30000) and `lock_timeout` (10000); positive integers in ms. A dropped idle
 *                         connection is logged as one JSON line (`event: pg.pool.error`), not fatal
 * - PORT                  health port (default 8080)
 * - AGENTROPY_ALLOW       comma-separated policy actions the sample policy allows; everything else is denied (with the
 *                         A2A endpoint the host's own setup needs `agent:create` and `agent:share`)
 * - AGENTROPY_TICK_MS     scheduler interval (default 250)
 * - AGENTROPY_OUTBOX_POISON_AFTER  give up on an outbox row after this many failed deliveries (default: never, which keeps
 *                         event order but lets one failing consumer hold back every later row; /readyz reports
 *                         `outboxStuck` while rows are held back)
 * - AGENTROPY_OTLP_ENDPOINT  base URL of an OTLP/HTTP collector (e.g. http://collector:4318): traces and metrics are
 *                         exported to `<base>/v1/traces` and `<base>/v1/metrics` (the OpenTelemetry packages are optional
 *                         dependencies loaded only then); AGENTROPY_SERVICE_NAME names the service (default agentropy-host)
 * - AGENTROPY_A2A_TOKENS  enables the A2A endpoint: comma-separated `token=principalId` bearer tokens (sample
 *                         authentication; replace `bearerTokens` with your identity provider)
 * - AGENTROPY_TENANT      tenant of those principals and of the exposed instance (default `default`)
 * - AGENTROPY_PUBLIC_URL  external base URL written into the AgentCard (default http://localhost:PORT)
 *
 * Endpoints: GET /healthz (process alive), GET /readyz (store answers a transaction, the scheduler loop is not
 * stalled, not shutting down); with AGENTROPY_A2A_TOKENS also POST /a2a (A2A JSON-RPC, SSE streaming) and
 * GET /.well-known/agent-card.json. A scheduler tick that fails is logged to stderr and the loop goes on. A request
 * whose handler fails is answered 500 and logged as one JSON line (`hostRequestListener`).
 * SIGTERM (see `shutdownHost`): readiness drops, the listener closes and open connections (A2A streams) are cut, the
 * scheduler stops and running executions finish, then the store closes. An unhandled rejection is logged as one
 * JSON line and ends the process with status 1.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  AgentropyError,
  BUILTIN_PROFILES,
  type PolicyDecision,
  type PolicyDecisionPoint,
  type PolicyRequest,
  type TrustedPrincipal,
} from '@agentropy/core';
import {
  agentCardForDefinition,
  openTelemetry,
  createA2AHttpHandler,
  createA2AServer,
  createLocalApp,
  localAppTarget,
  type A2AHttpHandler,
  type LocalApp,
  type SchedulerStatus,
} from '@agentropy/runtime';
import { PostgresStore, type PgPool } from '@agentropy/store-postgres';
import type { Store, Telemetry } from '@agentropy/core';
import { SqliteStore } from '@agentropy/store-sqlite';
import { randomUUID } from 'node:crypto';

/** Sample policy: allow-list from configuration, deny by default. Replace with your PDP. */
export class AllowListPolicy implements PolicyDecisionPoint {
  private readonly allowed: Set<string>;
  constructor(actions: string) {
    this.allowed = new Set(
      actions
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    );
  }
  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    return this.allowed.has(request.action)
      ? { effect: 'allow' }
      : { effect: 'deny', reason: 'not in AGENTROPY_ALLOW' };
  }
}

export interface HostState {
  shuttingDown: boolean;
}

/** Ticks that may fail in a row before readiness drops. */
const STALLED_AFTER_FAILURES = 3;

/**
 * A started scheduler loop counts as stalled when its last good tick is older than 30 s (or 20 intervals, whichever
 * is longer) or when `STALLED_AFTER_FAILURES` ticks failed in a row (FEAT-037.1).
 */
export function schedulerStalled(s: SchedulerStatus, nowMs: number): boolean {
  if (!s.running) return false;
  if (s.consecutiveFailures >= STALLED_AFTER_FAILURES) return true;
  const last = Date.parse(s.lastTickAt ?? s.startedAt ?? '');
  return (
    Number.isFinite(last) &&
    nowMs - last > Math.max(30_000, 20 * (s.intervalMs ?? 250))
  );
}

/** Request handler for the health port; exported for tests (no socket needed). */
export function healthHandler(
  app: LocalApp,
  state: HostState,
  now: () => number = Date.now,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (req.url === '/healthz') return send(200, { status: 'ok' });
    if (req.url === '/readyz') {
      if (state.shuttingDown) return send(503, { status: 'shutting-down' });
      try {
        await app.store.transaction((tx) =>
          tx.get('leases', 'readiness-probe'),
        );
      } catch {
        // No error details on an unauthenticated endpoint.
        return send(503, { status: 'store-unavailable' });
      }
      if (schedulerStalled(app.schedulerStatus(), now()))
        return send(503, { status: 'scheduler-stalled' });
      // Rows a failing consumer holds back are a detail, not a reason to leave the service: the pod still serves.
      const stuck = await app.relay.stuck(5).catch(() => []);
      return send(200, {
        status: 'ready',
        ...(stuck.length ? { outboxStuck: stuck.length } : {}),
      });
    }
    return send(404, { error: 'not found' });
  };
}

/**
 * The host's request listener (FIX-049): the A2A endpoint first, when there is one, then the health handler. A
 * handler that rejects is contained here: the request is answered `500` without details (or its connection is cut
 * when the response already started) and logged as one line, so no request can end the process through the
 * unhandled-rejection handler. The returned promise never rejects.
 */
export function hostRequestListener(
  a2a: A2AHttpHandler | undefined,
  health: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      if (a2a && (await a2a.handle(req, res))) return;
      await health(req, res);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'http.request',
          error: err instanceof Error ? err.name : 'Error',
        }),
      );
      try {
        if (res.headersSent) res.destroy();
        else {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"error":"internal error"}');
        }
      } catch {
        // The connection is already gone.
      }
    }
  };
}

const digest = (s: string) => createHash('sha256').update(s).digest();

const parseTokens = (spec: string) =>
  spec
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const i = e.indexOf('=');
      if (i <= 0 || i === e.length - 1)
        throw new Error('AGENTROPY_A2A_TOKENS entries are token=principalId');
      return { token: e.slice(0, i), id: e.slice(i + 1) };
    });

/** The peer principal IDs named in a token spec. */
export const tokenPrincipals = (spec: string): string[] => [
  ...new Set(parseTokens(spec).map((e) => e.id)),
];

/**
 * Sample A2A authentication: static bearer tokens (`token=principalId`, comma-separated), all principals in one
 * tenant. Tokens are compared in constant time. Peers are `user` principals, not `service` ones: a service is
 * tenant-wide (it sees and can cancel every task of the tenant), a peer must see only the tasks it delegated
 * (TASK-035.1). Replace with your identity provider (OIDC/JWT verification, mTLS, or headers from a trusted
 * gateway).
 */
export function bearerTokens(
  spec: string,
  tenantId: string,
): (req: IncomingMessage) => Promise<TrustedPrincipal | undefined> {
  const entries = parseTokens(spec).map((e) => ({
    digest: digest(e.token),
    id: e.id,
  }));
  return async (req) => {
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
    if (!m) return undefined;
    const d = digest(m[1]!);
    const hit = entries.find((e) => timingSafeEqual(e.digest, d));
    return hit ? { id: hit.id, type: 'user', tenantId } : undefined;
  };
}

/** The A2A endpoint exposing the sample `echo` agent, or undefined when AGENTROPY_A2A_TOKENS is not set. */
export async function a2aEndpoint(
  app: LocalApp,
  env: Record<string, string | undefined>,
): Promise<A2AHttpHandler | undefined> {
  if (!env.AGENTROPY_A2A_TOKENS) return undefined;
  const tenantId = env.AGENTROPY_TENANT ?? 'default';
  const host: TrustedPrincipal = { id: 'host', type: 'service', tenantId };
  const def = app.definitions.get({ id: 'echo', version: '1.0.0' });
  if (!def) throw new Error('echo agent is not defined');
  const inst = await app.createInstance(
    {
      definition: { id: def.id, version: def.version },
      ownerId: host.id,
      idempotencyKey: 'host-a2a-echo',
    },
    host,
  );
  // Peers are not the owner: the instance accepts work only from principals it is shared with, and each peer then
  // sees only its own tasks.
  await app.shareInstance(
    inst.id,
    tokenPrincipals(env.AGENTROPY_A2A_TOKENS),
    host,
  );
  const url = `${env.AGENTROPY_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8080}`}/a2a`;
  return createA2AHttpHandler(
    createA2AServer(localAppTarget(app), { instanceId: inst.id }),
    {
      authenticate: bearerTokens(env.AGENTROPY_A2A_TOKENS, tenantId),
      agentCard: agentCardForDefinition(def, url, {
        securitySchemes: {
          bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
        },
        security: [{ bearer: [] }],
        streaming: true,
      }),
    },
  );
}

/** Sample agent so the image does something; replace with your own definitions. */
export function defineAgents(app: LocalApp): void {
  app.define(
    {
      id: 'echo',
      version: '1.0.0',
      displayName: 'Echo',
      profile: { id: 'task', version: '1.0.0' },
      implementation: {
        providerId: 'native-ts',
        providerVersion: '1.0.0',
        artifact: { id: 'echo', version: '1.0.0' },
      },
      inputSchema: true,
      runtimeRequirements: { guarantees: [] },
      policyRef: { id: 'default', version: '1.0.0' },
    },
    { handle: async (inv) => ({ kind: 'completed', output: inv.input }) },
  );
}

/**
 * Orderly shutdown (FEAT-037.3): mark not ready, stop accepting connections and cut the open ones (SSE streams would
 * otherwise hold the server until the pod's SIGKILL), stop the scheduler and wait for running executions, and only
 * then close the store. Safe to call twice.
 */
export async function shutdownHost(h: {
  state: HostState;
  server: Server;
  stop: () => Promise<void>;
  app: LocalApp;
  /** Flushes telemetry after the last execution finished (spans of the final work are not lost). */
  flush?: () => Promise<void>;
}): Promise<void> {
  if (h.state.shuttingDown) return;
  h.state.shuttingDown = true;
  h.server.close();
  h.server.closeAllConnections();
  await h.stop();
  await h.flush?.().catch(() => undefined);
  await h.app.store.close();
}

/** The OpenTelemetry modules the host loads (all optional dependencies, imported only with an OTLP endpoint). */
export type OtelLoader = (name: string) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Telemetry from the environment (FEAT-037.3): with `AGENTROPY_OTLP_ENDPOINT` spans and metrics go to an OTLP/HTTP
 * collector through the OpenTelemetry SDK; without it nothing is loaded and telemetry is off. `shutdown` flushes and
 * stops the exporters.
 */
export async function telemetryFromEnv(
  env: Record<string, string | undefined>,
  load: OtelLoader = (name) => import(/* @vite-ignore */ name),
): Promise<{ telemetry?: Telemetry; shutdown: () => Promise<void> }> {
  const base = env.AGENTROPY_OTLP_ENDPOINT?.replace(/\/+$/, '');
  if (!base) return { shutdown: async () => undefined };
  const [api, trace, metrics, resources, traceExporter, metricExporter] =
    await Promise.all(
      [
        '@opentelemetry/api',
        '@opentelemetry/sdk-trace-base',
        '@opentelemetry/sdk-metrics',
        '@opentelemetry/resources',
        '@opentelemetry/exporter-trace-otlp-http',
        '@opentelemetry/exporter-metrics-otlp-http',
      ].map((name) => load(name)),
    );
  const resource = resources.resourceFromAttributes({
    'service.name': env.AGENTROPY_SERVICE_NAME ?? 'agentropy-host',
    ...(env.HOSTNAME ? { 'service.instance.id': env.HOSTNAME } : {}),
  });
  const tracerProvider = new trace.BasicTracerProvider({
    resource,
    spanProcessors: [
      new trace.BatchSpanProcessor(
        new traceExporter.OTLPTraceExporter({ url: `${base}/v1/traces` }),
      ),
    ],
  });
  const meterProvider = new metrics.MeterProvider({
    resource,
    readers: [
      new metrics.PeriodicExportingMetricReader({
        exporter: new metricExporter.OTLPMetricExporter({
          url: `${base}/v1/metrics`,
        }),
        exportIntervalMillis: 15_000,
      }),
    ],
  });
  return {
    telemetry: openTelemetry({
      api,
      tracer: tracerProvider.getTracer('agentropy'),
      meter: meterProvider.getMeter('agentropy'),
    }),
    shutdown: async () => {
      await Promise.allSettled([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
      ]);
    },
  };
}

/** The `pg` pool as far as the host uses it: a store pool that is also an event emitter. */
export interface HostPgPool extends PgPool {
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** The `pg` module's `Pool`, as far as the host uses it. */
export interface PgModule {
  Pool: new (options: {
    connectionString: string;
    connectionTimeoutMillis: number;
  }) => HostPgPool;
}

/** A positive integer number of milliseconds from the environment, or the default; anything else is refused. */
function envMs(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const ms = Number(raw);
  if (raw.trim() === '' || !Number.isSafeInteger(ms) || ms < 1)
    throw new AgentropyError(
      'InvalidConfiguration',
      `${name} must be a positive integer number of milliseconds`,
    );
  return ms;
}

/**
 * The store the environment asks for: PostgreSQL with `AGENTROPY_PG_URL` (several replicas can share it; the pod
 * name is the worker and relay ID), otherwise the SQLite file. The `pg` driver is imported only for PostgreSQL, so
 * the SQLite image path never loads it (FEAT-041.2).
 */
export async function openStore(
  env: Record<string, string | undefined>,
  loadPg: () => Promise<PgModule> = () =>
    import(/* @vite-ignore */ 'pg' as string) as Promise<PgModule>,
): Promise<{ store: Store; workerId?: string }> {
  const url = env.AGENTROPY_PG_URL;
  if (!url)
    return {
      store: new SqliteStore({
        path: env.AGENTROPY_DB ?? '/data/agentropy.db',
      }),
    };
  const connectionTimeoutMillis = envMs(
    env,
    'AGENTROPY_PG_CONNECT_TIMEOUT_MS',
    10_000,
  );
  const statementTimeoutMs = envMs(
    env,
    'AGENTROPY_PG_STATEMENT_TIMEOUT_MS',
    30_000,
  );
  const lockTimeoutMs = envMs(env, 'AGENTROPY_PG_LOCK_TIMEOUT_MS', 10_000);
  const { Pool } = await loadPg();
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis });
  // pg emits `error` on the pool when an idle connection is dropped (a database restart or failover); an
  // unhandled `error` event ends the process, and every replica would go at once. The pool discards the connection
  // and the next transaction opens a new one. The message is left out: it can carry the server's address.
  pool.on('error', (err) => {
    const code = (err as { code?: unknown }).code;
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'pg.pool.error',
        error: err instanceof Error ? err.name : 'Error',
        ...(typeof code === 'string' ? { code } : {}),
      }),
    );
  });
  return {
    store: new PostgresStore({
      pool,
      ownsConnection: true,
      statementTimeoutMs,
      lockTimeoutMs,
    }),
    workerId: env.HOSTNAME ?? `host-${randomUUID()}`,
  };
}

export async function main(env = process.env): Promise<void> {
  const { store, workerId } = await openStore(env);
  const otel = await telemetryFromEnv(env);
  const app = createLocalApp({
    store,
    ...(otel.telemetry ? { telemetry: otel.telemetry } : {}),
    ...(env.AGENTROPY_OUTBOX_POISON_AFTER
      ? { outboxPoisonAfter: Number(env.AGENTROPY_OUTBOX_POISON_AFTER) }
      : {}),
    pdp: new AllowListPolicy(env.AGENTROPY_ALLOW ?? ''),
    profiles: BUILTIN_PROFILES,
    // With a shared database every replica is a worker and takes part in the outbox relay lease.
    ...(workerId
      ? { relay: { relayId: workerId }, runtime: { workerId } }
      : {}),
  });
  defineAgents(app);
  const state: HostState = { shuttingDown: false };
  const stop = app.start(Number(env.AGENTROPY_TICK_MS ?? 250), {
    // One line per failed tick, no payloads: the loop itself goes on and readiness reports a stall.
    onError: (error) =>
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'scheduler.tick',
          code: error.code,
          message: error.message,
        }),
      ),
  });
  const a2a = await a2aEndpoint(app, env);
  const listener = hostRequestListener(a2a, healthHandler(app, state));
  const server = createServer((req, res) => void listener(req, res));
  server.listen(Number(env.PORT ?? 8080));
  const shutdown = () =>
    shutdownHost({ state, server, stop, app, flush: otel.shutdown });
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  process.on('unhandledRejection', (reason) => {
    console.error(
      JSON.stringify({
        level: 'fatal',
        event: 'unhandledRejection',
        message: reason instanceof Error ? reason.message : String(reason),
      }),
    );
    process.exit(1);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
