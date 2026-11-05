// FEAT-020: human actions — request, claim/release, decide, expire (AC-08, SEC-07, R-24).
import type { Agent, TrustedPrincipal, WakeReason } from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { alice, bob, code, harness, mallory } from './harness.js';

type H = ReturnType<typeof harness>;

const settle = async (h: H) => {
  for (let i = 0; i < 5; i++) {
    await h.wakeups.poll();
    await h.runtime.runUntilIdle();
  }
};

const approvalSchema = {
  type: 'object',
  properties: {
    decision: { enum: ['approve', 'reject'] },
    comment: { type: 'string' },
  },
  required: ['decision'],
  additionalProperties: false,
};

/** J2 shape without the model/tool parts (those are TASK-023): request approval, wait, act once on the outcome. */
function approver(
  h: H,
  opts: {
    assignees?: string[];
    onExpiry?: 'resume' | 'fail-task';
    dueAt?: string;
  } = {},
) {
  const effects: string[] = [];
  const reasons: (WakeReason | undefined)[] = [];
  const requestIds: string[] = [];
  const agent: Agent<{ amount: number }> = {
    handle: async (inv, ctx) => {
      reasons.push(inv.wakeReason);
      if (inv.activation === 1) {
        // A replay of the same step returns the same request (journaled effect).
        for (let i = 0; i < 2; i++)
          requestIds.push(
            (
              await ctx.capabilities.invoke<unknown, { requestId: string }>(
                'human-input',
                'requestAction',
                {
                  kind: 'approval',
                  prompt: `Approve expense of ${inv.input.amount}?`,
                  inputSchema: approvalSchema,
                  assignees: { principalIds: opts.assignees ?? ['alice'] },
                  dueAt: opts.dueAt ?? '2026-11-07T00:00:00.000Z',
                  onExpiry: opts.onExpiry ?? 'fail-task',
                },
                { stepKey: 'approval' },
              )
            ).requestId,
          );
        return {
          kind: 'waiting',
          wakeup: {
            anyOf: [{ kind: 'human-action', requestId: requestIds[0]! }],
          },
          checkpoint: { requestId: requestIds[0] },
        };
      }
      const r = inv.wakeReason;
      if (
        r?.kind === 'human-action' &&
        r.outcome === 'resolved' &&
        (r.input as { decision: string }).decision === 'approve'
      ) {
        await ctx.capabilities.invoke(
          'notification',
          'notify',
          { severity: 'normal', title: 'Paid out', body: 'payout' },
          { stepKey: 'payout' },
        );
        effects.push('payout');
      }
      return { kind: 'completed', output: r };
    },
  };
  h.define('expense', agent, {
    capabilities: [{ id: 'human-input', versionRange: '^1.0.0' }],
  });
  return {
    effects,
    reasons,
    requestIds,
    async start(key = 'exp') {
      const t = await h.delegate(
        (await h.instance('expense')).id,
        { amount: 4200 },
        key,
      );
      await settle(h);
      return { taskId: t.taskId, requestId: requestIds[0]! };
    },
  };
}

const approve = (requestId: string, expectedRevision: number, key = 'd1') => ({
  requestId,
  expectedRevision,
  input: { decision: 'approve' },
  idempotencyKey: key,
});

describe('requestAction and the inbox projection', () => {
  it('creates one pending request per step, projects one entry per assignee, and resolves it only after commit', async () => {
    const h = harness({ builtin: true });
    const j = approver(h, { assignees: ['alice', 'bob'] });
    const { taskId, requestId } = await j.start();
    expect(j.requestIds[1]).toBe(requestId);
    expect((await h.tasks.getTask(taskId, alice)).status).toBe('waiting');
    const req = await h.human.get(requestId, alice);
    expect(req).toMatchObject({
      status: 'pending',
      revision: 1,
      kind: 'approval',
      onExpiry: 'fail-task',
      taskId,
    });
    const aliceEntries = (await h.inbox.list({}, alice)).entries;
    const bobEntries = (await h.inbox.list({}, bob)).entries;
    expect(aliceEntries.map((e) => [e.actionRequestId, e.revision])).toEqual([
      [requestId, 1],
    ]);
    expect(bobEntries).toHaveLength(1);
    expect(aliceEntries[0]!.markers.resolvedAt).toBeUndefined();

    await h.human.decide(approve(requestId, 1), alice);
    await settle(h);
    const resolved = (await h.inbox.list({}, bob)).entries[0]!;
    expect(resolved.revision).toBe(2);
    expect(resolved.markers.resolvedAt).toBeDefined();
    expect(await h.tasks.getResult(taskId, alice)).toEqual({
      kind: 'human-action',
      requestId,
      outcome: 'resolved',
      input: { decision: 'approve' },
    });
  });

  it('rejects an invalid request and a human-action wait that also sets timeoutAt', async () => {
    const h = harness({ builtin: true });
    h.define(
      'bad',
      {
        handle: async (inv, ctx) => {
          if ((inv.input as { variant: string }).variant === 'input')
            await ctx.capabilities.invoke(
              'human-input',
              'requestAction',
              { kind: 'approval', prompt: '', assignees: {} },
              { stepKey: 'a' },
            );
          return {
            kind: 'waiting',
            wakeup: {
              anyOf: [{ kind: 'human-action', requestId: 'r' }],
              timeoutAt: '2026-11-06T00:00:00.000Z',
            },
            checkpoint: null,
          };
        },
      },
      { capabilities: [{ id: 'human-input', versionRange: '^1.0.0' }] },
    );
    const id = (await h.instance('bad')).id;
    const a = await h.delegate(id, { variant: 'input' }, 'a');
    const b = await h.delegate(id, { variant: 'timeout' }, 'b');
    await settle(h);
    expect((await h.tasks.getTask(a.taskId, alice)).outcome?.code).toBe(
      'SchemaViolation',
    );
    expect((await h.tasks.getTask(b.taskId, alice)).outcome?.code).toBe(
      'SchemaViolation',
    );
  });
});

describe('decisions (AC-08)', () => {
  it('duplicate approve is a no-op, approve then reject conflicts, and the side effect happens once', async () => {
    const h = harness({ builtin: true });
    const j = approver(h);
    const { taskId, requestId } = await j.start();
    await h.human.decide(approve(requestId, 1), alice);
    await h.human.decide(approve(requestId, 1), alice);
    await h.human.decide(approve(requestId, 1, 'other-key'), alice);
    expect(
      await code(
        h.human.decide(
          {
            requestId,
            expectedRevision: 2,
            input: { decision: 'reject' },
            idempotencyKey: 'd2',
          },
          alice,
        ),
      ),
    ).toBe('ActionConflict');
    await settle(h);
    expect((await h.tasks.getTask(taskId, alice)).status).toBe('completed');
    expect(j.effects).toEqual(['payout']);
    expect(j.reasons.filter((r) => r?.kind === 'human-action')).toHaveLength(1);
  });

  it('stale expectedRevision → StaleRevision; non-assignee → NotAssignee; other tenant → NotFound; bad input → SchemaViolation', async () => {
    const h = harness({ builtin: true });
    const j = approver(h);
    const { requestId } = await j.start();
    expect(await code(h.human.decide(approve(requestId, 0), alice))).toBe(
      'StaleRevision',
    );
    expect(await code(h.human.decide(approve(requestId, 1), bob))).toBe(
      'NotAssignee',
    );
    expect(await code(h.human.decide(approve(requestId, 1), mallory))).toBe(
      'NotFound',
    );
    expect(
      await code(
        h.human.decide(
          {
            requestId,
            expectedRevision: 1,
            input: { decision: 'maybe' },
            idempotencyKey: 'x',
          },
          alice,
        ),
      ),
    ).toBe('SchemaViolation');
    expect(
      await code(
        h.human.decide({ ...approve(requestId, 1), idempotencyKey: '' }, alice),
      ),
    ).toBe('SchemaViolation');
    expect((await h.human.get(requestId, alice)).status).toBe('pending');
  });

  it('AC-08: clock +49h → request expired and task failed (onExpiry fail-task); a late approval is ActionExpired', async () => {
    const h = harness({ builtin: true });
    const j = approver(h, { dueAt: '2026-11-07T00:00:00.000Z' });
    const { taskId, requestId } = await j.start();
    h.clock.advanceBy(49 * 60 * 60 * 1000);
    await settle(h);
    expect((await h.human.get(requestId, alice)).status).toBe('expired');
    const snap = await h.tasks.getTask(taskId, alice);
    expect(snap.status).toBe('failed');
    expect(snap.outcome?.code).toBe('ActionExpired');
    expect(await code(h.human.decide(approve(requestId, 1), alice))).toBe(
      'ActionExpired',
    );
    expect(j.effects).toEqual([]);
  });

  it('a decision after dueAt but before any sweep is refused as expired', async () => {
    const h = harness({ builtin: true });
    const j = approver(h, { dueAt: '2026-11-05T01:00:00.000Z' });
    const { requestId } = await j.start();
    h.clock.advanceBy(2 * 60 * 60 * 1000);
    expect(await code(h.human.decide(approve(requestId, 1), alice))).toBe(
      'ActionExpired',
    );
  });

  it('onExpiry "resume" resumes the task with an expired outcome', async () => {
    const h = harness({ builtin: true });
    const j = approver(h, {
      onExpiry: 'resume',
      dueAt: '2026-11-05T01:00:00.000Z',
    });
    const { taskId, requestId } = await j.start();
    h.clock.advanceBy(60 * 60 * 1000);
    await settle(h);
    expect(await h.tasks.getResult(taskId, alice)).toEqual({
      kind: 'human-action',
      requestId,
      outcome: 'expired',
    });
  });
});

describe('claims', () => {
  it('only the claimant decides a claimed request; release and claim timeout return it to pending', async () => {
    const h = harness({ builtin: true });
    const j = approver(h, { assignees: ['alice', 'bob'] });
    const { requestId } = await j.start();
    const claimed = await h.human.claim(requestId, alice);
    expect(claimed).toMatchObject({ status: 'claimed', claimedBy: 'alice' });
    expect((await h.human.claim(requestId, alice)).revision).toBe(
      claimed.revision,
    );
    expect(await code(h.human.claim(requestId, bob))).toBe('ActionConflict');
    expect(
      await code(h.human.decide(approve(requestId, claimed.revision), bob)),
    ).toBe('NotAssignee');
    expect(await code(h.human.release(requestId, bob))).toBe('NotAssignee');
    const released = await h.human.release(requestId, alice);
    expect(released.status).toBe('pending');
    const bobs = await h.human.claim(requestId, bob);
    h.clock.advanceBy(15 * 60 * 1000);
    await h.human.sweep();
    const lapsed = await h.human.get(requestId, bob);
    expect(lapsed.status).toBe('pending');
    expect(lapsed.revision).toBe(bobs.revision + 1);
    await h.human.decide(approve(requestId, lapsed.revision), alice);
    expect((await h.human.get(requestId, alice)).status).toBe('resolved');
  });
});

describe('SEC-07: stale or revoked authority', () => {
  const withGrant = (p: TrustedPrincipal, ref: string): TrustedPrincipal => ({
    ...p,
    delegatedAuthorityRef: ref,
  });

  it('an expired or revoked delegated authority cannot approve, and a PDP outage fails closed', async () => {
    const h = harness({ builtin: true });
    const j = approver(h);
    const { requestId } = await j.start();
    h.grants.status.set('g-expired', 'expired');
    h.grants.status.set('g-revoked', 'revoked');
    expect(
      await code(
        h.human.decide(approve(requestId, 1), withGrant(alice, 'g-expired')),
      ),
    ).toBe('AuthorityExpired');
    expect(
      await code(
        h.human.decide(approve(requestId, 1), withGrant(alice, 'g-revoked')),
      ),
    ).toBe('AuthorityExpired');
    h.pdp.denied.add('human-input:decide');
    expect(await code(h.human.decide(approve(requestId, 1), alice))).toBe(
      'PermissionDenied',
    );
    h.pdp.denied.clear();
    h.pdp.down = true;
    expect(await code(h.human.decide(approve(requestId, 1), alice))).toBe(
      'PolicyDecisionUnavailable',
    );
    h.pdp.down = false;
    expect((await h.human.get(requestId, alice)).status).toBe('pending');
    await h.human.decide(approve(requestId, 1), withGrant(alice, 'g-valid'));
    await settle(h);
    expect(j.effects).toEqual(['payout']);
  });

  it('a cancelled task revokes its open request: approval is ActionRevoked and nothing is paid', async () => {
    const h = harness({ builtin: true });
    const j = approver(h);
    const { taskId, requestId } = await j.start();
    await h.tasks.cancel(taskId, alice);
    expect((await h.human.get(requestId, alice)).status).toBe('revoked');
    expect(await code(h.human.decide(approve(requestId, 1), alice))).toBe(
      'ActionRevoked',
    );
    await settle(h);
    expect(j.effects).toEqual([]);
    const [entry] = (await h.inbox.list({}, alice)).entries;
    expect(entry!.markers.resolvedAt).toBeDefined();
  });

  it('a request of another tenant is invisible to claim, release and get', async () => {
    const h = harness({ builtin: true });
    const j = approver(h);
    const { requestId } = await j.start();
    expect(await code(h.human.claim(requestId, mallory))).toBe('NotFound');
    expect(await code(h.human.release(requestId, mallory))).toBe('NotFound');
    expect(await code(h.human.get(requestId, mallory))).toBe('NotFound');
    expect(await code(h.human.get(requestId, bob))).toBe('NotAssignee');
  });
});
