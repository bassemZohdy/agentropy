// FEAT-028.6: Conductor WorkflowEngine adapter (M3-01) against an in-process fake of Conductor's REST API, the
// shared workflow-engine conformance suite (also run on the fake engine), and an agent task on createLocalApp
// that waits for a Conductor run.
import {
  BUILTIN_PROFILES,
  type Agent,
  type TrustedPrincipal,
} from '@agentropy/core';
import {
  FakeClock,
  FakePolicy,
  FakeWorkflowEngine,
  defineWorkflowEngineConformance,
} from '@agentropy/testkit';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_SOURCE, createLocalApp } from '../../runtime/src/index.js';
import { sqliteTempStore } from '../../runtime/test/harness.js';
import { ConductorWorkflowEngine, type ConductorFetch } from '../src/index.js';

interface FakeRun {
  workflowId: string;
  workflowName: string;
  status: string;
  correlationId: string;
  input: unknown;
  output?: unknown;
}

/** In-process stand-in for Conductor's REST API (start, get, correlated search). */
class FakeConductor {
  readonly runs = new Map<string, FakeRun>();
  readonly requests: {
    method: string;
    url: string;
    headers: Record<string, string>;
  }[] = [];
  down = false;
  token = 'tok-1';
  constructor(
    readonly opts: { idempotencyKeys: boolean; known?: string[] } = {
      idempotencyKeys: true,
    },
  ) {}

  fetch: ConductorFetch = async (url, init) => {
    this.requests.push({ method: init.method, url, headers: init.headers });
    const reply = (status: number, body: unknown) => ({
      status,
      text: async () =>
        typeof body === 'string' ? body : JSON.stringify(body),
    });
    if (this.down) throw new Error('ECONNREFUSED');
    if (init.headers['x-authorization'] !== this.token)
      return reply(401, { message: 'unauthorized' });
    const path = new URL(url).pathname;
    if (init.method === 'POST' && path === '/api/workflow') {
      const b = JSON.parse(init.body!) as {
        name: string;
        input: unknown;
        correlationId: string;
        idempotencyKey?: string;
      };
      if (this.opts.known && !this.opts.known.includes(b.name))
        return reply(404, { message: 'no such workflow' });
      if (this.opts.idempotencyKeys && b.idempotencyKey) {
        const existing = [...this.runs.values()].find(
          (r) =>
            r.correlationId === b.idempotencyKey && r.workflowName === b.name,
        );
        if (existing) return reply(200, existing.workflowId);
      }
      const id = `wf-${this.runs.size + 1}`;
      this.runs.set(id, {
        workflowId: id,
        workflowName: b.name,
        status: 'RUNNING',
        correlationId: b.correlationId,
        input: b.input,
      });
      return reply(200, id);
    }
    const correlated = path.match(
      /^\/api\/workflow\/([^/]+)\/correlated\/(.+)$/,
    );
    if (init.method === 'GET' && correlated)
      return reply(
        200,
        [...this.runs.values()].filter(
          (r) =>
            r.workflowName === decodeURIComponent(correlated[1]!) &&
            r.correlationId === decodeURIComponent(correlated[2]!),
        ),
      );
    const one = path.match(/^\/api\/workflow\/([^/]+)$/);
    if (init.method === 'GET' && one) {
      const r = this.runs.get(decodeURIComponent(one[1]!));
      return r ? reply(200, r) : reply(404, { message: 'not found' });
    }
    return reply(500, 'unexpected');
  };

  set(id: string, status: string, output?: unknown) {
    const r = this.runs.get(id)!;
    r.status = status;
    if (output !== undefined) r.output = output;
  }
}

const engineFor = (
  server: FakeConductor,
  idempotency: 'server' | 'lookup' = 'server',
) =>
  new ConductorWorkflowEngine({
    baseUrl: 'https://conductor.example',
    fetch: server.fetch,
    // The client's credential, fixed at configuration time (the server may rotate it).
    headers: ((token) => () => ({ 'x-authorization': token }))(server.token),
    idempotency,
  });

defineWorkflowEngineConformance(
  { describe, it, expect },
  'conductor (webhook, server idempotency)',
  () => {
    const server = new FakeConductor();
    const engine = engineFor(server);
    return {
      engine,
      workflow: 'invoice',
      finish: async (runId, outcome) => {
        if ('failed' in outcome) server.set(runId, 'FAILED');
        else server.set(runId, 'COMPLETED', outcome.output);
        await engine.handleStatusEvent({ workflowId: runId });
      },
    };
  },
);

defineWorkflowEngineConformance(
  { describe, it, expect },
  'conductor (polling, correlation lookup)',
  () => {
    const server = new FakeConductor({ idempotencyKeys: false });
    const engine = engineFor(server, 'lookup');
    return {
      engine,
      workflow: 'invoice',
      finish: async (runId, outcome) => {
        if ('failed' in outcome) server.set(runId, 'TIMED_OUT');
        else server.set(runId, 'COMPLETED', outcome.output);
        await engine.poll();
      },
    };
  },
);

defineWorkflowEngineConformance({ describe, it, expect }, 'fake engine', () => {
  const outcomes = new Map<unknown, { output: unknown } | { failed: true }>();
  const engine = new FakeWorkflowEngine({
    invoice: (input) => {
      const o = outcomes.get(input);
      if (!o || 'failed' in o) throw new Error('failed');
      return o.output;
    },
  });
  return {
    engine,
    workflow: 'invoice',
    finish: async (runId, outcome) => {
      const run = engine.runs.get(runId);
      if (run) outcomes.set(run.input, outcome);
      await engine.finish(runId);
    },
  };
});

describe('Conductor adapter specifics', () => {
  it('maps terminal states and transport failures to Errors v1 codes without leaking credentials', async () => {
    const server = new FakeConductor();
    const engine = engineFor(server);
    const ctx = { tenantId: 't-1', taskId: 't', idempotencyKey: 'k' };
    const a = await engine.start('invoice', {}, ctx);
    server.set(a.runId, 'TERMINATED');
    expect((await engine.status(a.runId, { tenantId: 't-1' })).code).toBe(
      'TaskCancelled',
    );
    server.set(a.runId, 'PAUSED');
    expect((await engine.status(a.runId, { tenantId: 't-1' })).state).toBe(
      'running',
    );

    server.token = 'rotated';
    const denied = await engine
      .start('invoice', {}, { ...ctx, idempotencyKey: 'k2' })
      .catch((e: unknown) => e);
    expect(denied).toMatchObject({
      code: 'AuthorityExpired',
      details: { kind: 'credential' },
    });
    expect(JSON.stringify(denied)).not.toContain('tok-1');

    server.down = true;
    expect(
      await engine
        .status(a.runId, { tenantId: 't-1' })
        .catch((e: { code: string }) => e.code),
    ).toBe('ProviderUnavailable');
  });

  it('an unregistered workflow is CapabilityUnavailable', async () => {
    const server = new FakeConductor({
      idempotencyKeys: true,
      known: ['invoice'],
    });
    expect(
      await engineFor(server)
        .start(
          'nope',
          {},
          { tenantId: 't-1', taskId: 't', idempotencyKey: 'k' },
        )
        .catch((e: { code: string }) => e.code),
    ).toBe('CapabilityUnavailable');
  });

  it('a forged webhook for a running run reports nothing; reconcile recovers runs after a restart', async () => {
    const server = new FakeConductor();
    const first = engineFor(server);
    const run = await first.start(
      'invoice',
      {},
      {
        tenantId: 't-1',
        taskId: 't',
        idempotencyKey: 'k',
      },
    );
    const seen: string[] = [];
    first.onFinished((r) => seen.push(r.state));
    expect(
      await first.handleStatusEvent({
        workflowId: run.runId,
        status: 'COMPLETED',
      }),
    ).toBe(false);
    expect(await first.handleStatusEvent({ nope: 1 })).toBe(false);
    expect(seen).toEqual([]);

    // A new adapter instance (process restart) knows nothing; reconcile re-reads the run.
    server.set(run.runId, 'COMPLETED', { ok: true });
    const second = engineFor(server);
    const after: unknown[] = [];
    second.onFinished((r) => after.push([r.state, r.output, r.tenantId]));
    expect(await second.reconcile([run.runId])).toBe(1);
    expect(after).toEqual([['completed', { ok: true }, 't-1']]);
  });

  it('runs a workflow-backed agent task end to end on createLocalApp', async () => {
    const alice: TrustedPrincipal = {
      id: 'alice',
      type: 'user',
      tenantId: 't-1',
    };
    const server = new FakeConductor();
    const engine = engineFor(server);
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
      profiles: BUILTIN_PROFILES,
      workflow: engine,
    });
    const agent: Agent<{ amount: number }> = {
      handle: async (inv, ctx) => {
        const cp = inv.checkpoint as { runId: string } | undefined;
        if (inv.wakeReason?.kind === 'event' && cp) {
          const run = await ctx.capabilities.invoke<
            unknown,
            { state: string; output?: unknown }
          >('workflow', 'status', { runId: cp.runId });
          return { kind: 'completed', output: run.output };
        }
        const run = await ctx.capabilities.invoke<unknown, { runId: string }>(
          'workflow',
          'start',
          { workflow: 'invoice', input: { amount: inv.input.amount } },
          { stepKey: 'start' },
        );
        const { subscription } = await ctx.capabilities.invoke<
          unknown,
          { subscription: string }
        >(
          'event-handling',
          'subscribe',
          { source: WORKFLOW_SOURCE, filter: { runId: run.runId } },
          { stepKey: 'wait' },
        );
        return {
          kind: 'waiting',
          wakeup: { anyOf: [{ kind: 'event', subscription }] },
          checkpoint: { runId: run.runId },
        };
      },
    };
    app.define(
      {
        id: 'invoicer',
        version: '1.0.0',
        displayName: 'invoicer',
        profile: { id: 'task', version: '1.0.0' },
        implementation: {
          providerId: 'native-ts',
          providerVersion: '1.0.0',
          artifact: { id: 'invoicer', version: '1.0.0' },
        },
        inputSchema: true,
        runtimeRequirements: { guarantees: [] },
        policyRef: { id: 'default', version: '1.0.0' },
        capabilities: [
          { id: 'workflow', versionRange: '^1.0.0' },
          { id: 'event-handling', versionRange: '^1.0.0' },
        ],
      },
      agent,
    );
    const inst = await app.createInstance(
      {
        definition: { id: 'invoicer', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'i',
      },
      alice,
    );
    const task = await app.delegate(
      {
        target: { instanceId: inst.id },
        input: { amount: 250 },
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      alice,
    );
    await app.runUntilIdle();
    expect((await app.getTask(task.taskId, alice)).status).toBe('waiting');
    const [runId] = [...server.runs.keys()];
    expect(server.runs.get(runId!)!.correlationId.startsWith('t-1:')).toBe(
      true,
    );
    server.set(runId!, 'COMPLETED', { invoiceId: 'inv-9' });
    await engine.poll();
    await app.runUntilIdle();
    expect(await app.getResult(task.taskId, alice)).toEqual({
      invoiceId: 'inv-9',
    });
  });
});
