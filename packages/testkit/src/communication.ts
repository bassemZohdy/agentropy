/**
 * Reusable AgentCommunicationProvider conformance suite (R-31, AC-18). Plain functions: pass your test
 * runner's describe/it/expect so provider authors can run it in their own repositories.
 */
import {
  AgentropyError,
  isAgentropyError,
  type AgentCommunicationProvider,
  type AgentEvent,
  type AgentMessage,
  type AgentRef,
  type CallContext,
  type CommunicationRouter,
  type DelegationRequest,
  type TaskSnapshot,
  type TrustedPrincipal,
} from '@agentropy/core';

export interface TestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  expect: (value: unknown) => {
    toBe(v: unknown): void;
    toEqual(v: unknown): void;
  };
}

/** Minimal in-memory target honoring idempotency keys and tenant scoping; stands in for a TaskService. */
export class FakeDirectTarget {
  readonly tasks = new Map<
    string,
    { snapshot: TaskSnapshot; tenantId: string; callerId: string }
  >();
  readonly byKey = new Map<string, { taskId: string; fingerprint: string }>();
  readonly received: AgentMessage[] = [];
  private seq = 0;

  async delegate<I>(
    request: DelegationRequest<I>,
    caller: TrustedPrincipal,
  ): Promise<{ taskId: string }> {
    const key = `${caller.tenantId}|${caller.id}|${request.idempotencyKey}`;
    const fingerprint = JSON.stringify([request.target, request.input]);
    const prior = this.byKey.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new AgentropyError(
          'IdempotencyConflict',
          'Idempotency key reused with a different request',
        );
      return { taskId: prior.taskId };
    }
    const taskId = `task-${++this.seq}`;
    this.tasks.set(taskId, {
      snapshot: { taskId, status: 'created', revision: 1, authority: 'local' },
      tenantId: caller.tenantId,
      callerId: caller.id,
    });
    this.byKey.set(key, { taskId, fingerprint });
    return { taskId };
  }

  private visible(taskId: string, caller: TrustedPrincipal) {
    const t = this.tasks.get(taskId);
    if (!t || t.tenantId !== caller.tenantId)
      throw new AgentropyError('NotFound', 'Task not found');
    return t;
  }

  async getTask(
    taskId: string,
    caller: TrustedPrincipal,
  ): Promise<TaskSnapshot> {
    return structuredClone(this.visible(taskId, caller).snapshot);
  }

  async cancel(
    taskId: string,
    caller: TrustedPrincipal,
  ): Promise<TaskSnapshot> {
    const t = this.visible(taskId, caller);
    if (['completed', 'failed', 'cancelled'].includes(t.snapshot.status))
      throw new AgentropyError('InvalidState', 'Task is terminal');
    t.snapshot = {
      ...t.snapshot,
      status: 'cancelled',
      revision: t.snapshot.revision + 1,
    };
    return structuredClone(t.snapshot);
  }

  async *subscribe(
    taskId: string,
    caller: TrustedPrincipal,
  ): AsyncIterable<AgentEvent> {
    const t = this.visible(taskId, caller);
    yield {
      eventId: `${taskId}:${t.snapshot.revision}`,
      taskId,
      type: 'taskStatusChanged',
      revision: t.snapshot.revision,
      payload: { status: t.snapshot.status },
    };
  }

  async receive(message: AgentMessage): Promise<{ accepted: boolean }> {
    this.received.push(message);
    return { accepted: true };
  }
}

export interface CommunicationConformanceSetup {
  router: CommunicationRouter;
  provider: AgentCommunicationProvider;
  target: AgentRef;
  caller: TrustedPrincipal;
  /** Messages the target observed, for the forged-actor check. */
  received: () => AgentMessage[];
}

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no-error';
  } catch (err) {
    return isAgentropyError(err) ? err.code : 'non-agentropy';
  }
}

export function defineCommunicationConformance(
  t: TestApi,
  name: string,
  setup: () => CommunicationConformanceSetup,
): void {
  const ctx = (caller: TrustedPrincipal): CallContext => ({
    caller,
    correlationId: 'corr-1',
  });
  const request = (
    key: string,
    input: unknown = { x: 1 },
  ): DelegationRequest => ({
    target: {},
    input,
    idempotencyKey: key,
    correlationId: 'corr-1',
  });

  t.describe(`communication provider conformance: ${name} (AC-18)`, () => {
    t.it('delegate → getTask → cancel through a pinned route', async () => {
      const s = setup();
      const route = await s.router.selectRoute(
        s.target,
        'delegate',
        ctx(s.caller),
      );
      t.expect(route.providerId).toBe(s.provider.id);
      const p = s.router.provider(route);
      const ref = await p.delegate(route, request('k1'), ctx(s.caller));
      t.expect((await p.getTask(ref, ctx(s.caller))).normalized).toBe(
        'created',
      );
      t.expect((await p.cancel(ref, ctx(s.caller))).normalized).toBe(
        'cancelled',
      );
      t.expect(await errorCode(p.cancel(ref, ctx(s.caller)))).toBe(
        'InvalidState',
      );
    });

    t.it(
      'duplicate delegation with the same key returns the original task; a different payload conflicts',
      async () => {
        const s = setup();
        const route = await s.router.selectRoute(
          s.target,
          'delegate',
          ctx(s.caller),
        );
        const p = s.router.provider(route);
        const a = await p.delegate(route, request('dup'), ctx(s.caller));
        const b = await p.delegate(route, request('dup'), ctx(s.caller));
        t.expect(b.remoteTaskId).toBe(a.remoteTaskId);
        t.expect(
          await errorCode(
            p.delegate(route, request('dup', { x: 2 }), ctx(s.caller)),
          ),
        ).toBe('IdempotencyConflict');
      },
    );

    t.it('subscribe yields revisioned task events', async () => {
      const s = setup();
      const route = await s.router.selectRoute(
        s.target,
        'subscribe',
        ctx(s.caller),
      );
      const p = s.router.provider(route);
      const ref = await p.delegate(route, request('sub'), ctx(s.caller));
      const events: AgentEvent[] = [];
      for await (const e of p.subscribe(ref, ctx(s.caller))) events.push(e);
      t.expect(
        events.length > 0 &&
          events.every(
            (e) =>
              e.taskId === ref.remoteTaskId && typeof e.revision === 'number',
          ),
      ).toBe(true);
    });

    t.it(
      'cross-tenant targets are refused before route selection',
      async () => {
        const s = setup();
        t.expect(
          await errorCode(
            s.router.selectRoute(
              { ...s.target, tenantId: 'other-tenant' },
              'delegate',
              ctx(s.caller),
            ),
          ),
        ).toBe('TenantMismatch');
      },
    );

    t.it(
      'a forged envelope actor is replaced by the verified caller',
      async () => {
        const s = setup();
        const route = await s.router.selectRoute(
          s.target,
          'send',
          ctx(s.caller),
        );
        const forged: AgentMessage = {
          schemaVersion: 1,
          kind: 'command',
          name: 'ping',
          messageId: 'm-1',
          correlationId: 'corr-1',
          idempotencyKey: 'm-1',
          tenantId: 'other-tenant',
          actor: { principalId: 'root', principalType: 'service' },
          createdAt: '2026-11-05T00:00:00.000Z',
          payload: {},
        };
        await s.router.provider(route).send(route, forged, ctx(s.caller));
        const got = s.received().at(-1)!;
        t.expect(got.actor.principalId).toBe(s.caller.id);
        t.expect(got.tenantId).toBe(s.caller.tenantId);
      },
    );

    t.it(
      'undeclared requirements fail explicitly, never by silent downgrade',
      async () => {
        const s = setup();
        t.expect(
          await errorCode(
            s.router.selectRoute(s.target, 'delegate', ctx(s.caller), {
              durability: 'durable-execution',
            }),
          ),
        ).toBe(
          s.provider.features.durability === 'durable-execution'
            ? 'no-error'
            : 'GuaranteeUnavailable',
        );
        t.expect(
          await errorCode(
            s.router.selectRoute(s.target, 'delegate', ctx(s.caller), {
              extensions: ['urn:x:streaming-messages'],
            }),
          ),
        ).toBe('UnsupportedOperation');
      },
    );

    t.it(
      'a pinned route whose provider is gone fails NoCompatibleRoute',
      async () => {
        const s = setup();
        const route = await s.router.selectRoute(
          s.target,
          'delegate',
          ctx(s.caller),
        );
        t.expect(
          await errorCode(
            Promise.resolve().then(() =>
              s.router.provider({ ...route, providerId: 'vanished' }),
            ),
          ),
        ).toBe('NoCompatibleRoute');
      },
    );
  });
}
