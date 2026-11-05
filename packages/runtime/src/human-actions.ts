/**
 * Human actions (docs/human-actions.md, Agent v1 human-action operations, R-24, AC-08, SEC-07).
 *
 * The runtime is the only authority: `human-input.requestAction` creates the request and its
 * `humanActionRequested` event in one journaled transaction; claim, release and decide are commands that
 * re-check identity, tenant, assignment, delegated authority, policy, revision, deadline and input schema
 * atomically. A decision commits a `humanActionResolved` event; the inbox projects it only after commit and
 * the waiting task resumes through its `human-action` wake-up. Expiry uses the request's `dueAt` only.
 */
import {
  AgentropyError,
  HUMAN_ACTION_MACHINE,
  assertTransition,
  digestOf,
  enforcePolicy,
  isTerminal,
  validateAgainst,
  type CapabilityInvocationContext,
  type HumanActionInput,
  type HumanActionRequest,
  type HumanDecision,
  type StoreTx,
  type StoredDocument,
  type TrustedPrincipal,
} from '@agentropy/core';
import { journaled } from './inbox.js';
import {
  actionUsers,
  type TaskRecord,
  type TaskService,
} from './task-service.js';

/** Stored form; `revision` is the store document revision (the value the user must echo back). */
export interface StoredHumanAction extends Omit<
  HumanActionRequest,
  'revision'
> {
  decisionInput?: unknown;
  decidedBy?: string;
  decidedAt?: string;
  /** Fingerprint of the accepted decision (decider + input), for duplicate detection. */
  decisionFingerprint?: string;
}

export interface HumanActionOptions {
  /** Claim timeout (default 15 minutes). */
  claimMs?: number;
}

const view = (d: StoredDocument<StoredHumanAction>): HumanActionRequest => {
  const {
    decisionInput: _i,
    decidedBy: _b,
    decidedAt: _a,
    decisionFingerprint: _f,
    ...rest
  } = d.value;
  void _i;
  void _b;
  void _a;
  void _f;
  return { ...rest, revision: d.revision };
};

const addMs = (iso: string, ms: number) =>
  new Date(Date.parse(iso) + ms).toISOString();

const KINDS = ['approval', 'choice', 'text', 'form'];

function validateRequest(input: unknown): HumanActionInput {
  const r = input as Partial<HumanActionInput> | null;
  const bad = (why: string) =>
    new AgentropyError('SchemaViolation', `human-input.requestAction: ${why}`);
  if (!r || !KINDS.includes(r.kind as string)) throw bad('unknown kind');
  if (typeof r.prompt !== 'string' || !r.prompt) throw bad('prompt required');
  if (r.inputSchema === undefined) throw bad('inputSchema required');
  if (
    !r.assignees ||
    !(r.assignees.principalIds?.length || r.assignees.roles?.length)
  )
    throw bad('at least one assignee or role required');
  if (r.onExpiry !== 'resume' && r.onExpiry !== 'fail-task')
    throw bad('onExpiry must be "resume" or "fail-task"');
  if (r.dueAt !== undefined && Number.isNaN(Date.parse(r.dueAt)))
    throw bad('dueAt must be an ISO timestamp');
  return {
    kind: r.kind!,
    prompt: r.prompt,
    inputSchema: r.inputSchema,
    assignees: r.assignees,
    ...(r.dueAt ? { dueAt: new Date(r.dueAt).toISOString() } : {}),
    onExpiry: r.onExpiry,
  };
}

export class HumanActionService {
  constructor(
    private readonly tasks: TaskService,
    private readonly options: HumanActionOptions = {},
  ) {}

  private get store() {
    return this.tasks.o.store;
  }
  private now() {
    return this.tasks.o.now();
  }

  /** Built-in `human-input.requestAction` (external effect with a step key; replay returns the original request). */
  async request(
    input: unknown,
    ctx: CapabilityInvocationContext,
  ): Promise<{ requestId: string; dueAt?: string }> {
    const r = validateRequest(input);
    return journaled(
      this.tasks,
      ctx,
      'human-input.requestAction',
      async (tx, task) => {
        const requestId = this.tasks.newId('action');
        assertTransition(HUMAN_ACTION_MACHINE, null, 'pending', 'H-create');
        const doc = await tx.insert<StoredHumanAction>(
          'humanActions',
          requestId,
          {
            ...r,
            requestId,
            taskId: task.id,
            agentInstanceId: task.value.instanceId,
            tenantId: task.value.tenantId,
            requestedBy: ctx.principalId,
            status: 'pending',
          },
        );
        await this.tasks.emit(
          tx,
          task.value,
          task.revision,
          'humanActionRequested',
          {
            requestId,
            revision: doc.revision,
            kind: r.kind,
            prompt: r.prompt,
            assignees: r.assignees,
            ...(r.dueAt ? { dueAt: r.dueAt } : {}),
          },
        );
        return { requestId, ...(r.dueAt ? { dueAt: r.dueAt } : {}) };
      },
    );
  }

  async get(
    requestId: string,
    caller: TrustedPrincipal,
  ): Promise<HumanActionRequest> {
    return this.store.transaction(async (tx) =>
      view(await this.visible(tx, requestId, caller)),
    );
  }

  async claim(
    requestId: string,
    caller: TrustedPrincipal,
  ): Promise<HumanActionRequest> {
    await this.authorize(requestId, caller);
    return this.store.transaction(async (tx) => {
      const doc = await this.actionable(tx, requestId, caller);
      const a = doc.value;
      if (a.status === 'claimed') {
        if (a.claimedBy === caller.id) return view(doc);
        throw new AgentropyError(
          'ActionConflict',
          'Request is claimed by someone else',
        );
      }
      assertTransition(HUMAN_ACTION_MACHINE, a.status, 'claimed', 'H-claim');
      return view(
        await tx.update<StoredHumanAction>(
          'humanActions',
          doc.id,
          doc.revision,
          {
            ...a,
            status: 'claimed',
            claimedBy: caller.id,
            claimExpiresAt: addMs(
              this.now(),
              this.options.claimMs ?? 15 * 60_000,
            ),
          },
        ),
      );
    });
  }

  async release(
    requestId: string,
    caller: TrustedPrincipal,
  ): Promise<HumanActionRequest> {
    await this.authorize(requestId, caller);
    return this.store.transaction(async (tx) => {
      const doc = await this.actionable(tx, requestId, caller);
      if (doc.value.status === 'pending') return view(doc);
      if (doc.value.claimedBy !== caller.id)
        throw new AgentropyError(
          'NotAssignee',
          'Only the claimant may release',
        );
      return view(await this.unclaim(tx, doc));
    });
  }

  /** `AgentService.provideHumanInput`: the single command boundary for chat, UI and API decisions. */
  async decide(
    decision: HumanDecision,
    caller: TrustedPrincipal,
  ): Promise<void> {
    if (!decision?.idempotencyKey)
      throw new AgentropyError(
        'SchemaViolation',
        'A decision needs an idempotency key',
      );
    await this.authorize(decision.requestId, caller);
    await this.store.transaction(async (tx) => {
      const doc = await this.visible(tx, decision.requestId, caller);
      const a = doc.value;
      const fingerprint = digestOf({ by: caller.id, input: decision.input });
      // Duplicate identical decision → no-op, even with the pre-decision revision; anything else after resolution conflicts.
      if (a.status === 'resolved') {
        if (a.decisionFingerprint === fingerprint) return;
        throw new AgentropyError(
          'ActionConflict',
          'Request was already decided differently',
        );
      }
      await this.expireIfDue(tx, doc);
      const live = await this.actionable(tx, decision.requestId, caller);
      if (live.revision !== decision.expectedRevision)
        throw new AgentropyError(
          'StaleRevision',
          'Request changed since it was presented',
          {
            details: {
              expected: decision.expectedRevision,
              actual: live.revision,
            },
          },
        );
      if (live.value.status === 'claimed' && live.value.claimedBy !== caller.id)
        throw new AgentropyError(
          'NotAssignee',
          'Request is claimed by someone else',
        );
      validateAgainst(
        live.value.inputSchema,
        decision.input,
        'human decision input',
      );
      const task = (await tx.get<TaskRecord>('tasks', live.value.taskId))!;
      await this.tasks.audit(tx, caller, {
        type: 'human-action.decide',
        action: 'human-input:decide',
        resource: { type: 'human-action', id: live.id },
        decision: 'allow',
        correlationId: task.value.correlationId,
        taskId: task.id,
      });
      assertTransition(
        HUMAN_ACTION_MACHINE,
        live.value.status,
        'resolved',
        'H-resolve',
      );
      const resolved = await tx.update<StoredHumanAction>(
        'humanActions',
        live.id,
        live.revision,
        {
          ...live.value,
          status: 'resolved',
          decisionInput: decision.input,
          decidedBy: caller.id,
          decidedAt: this.now(),
          decisionFingerprint: fingerprint,
        },
      );
      await this.tasks.emit(
        tx,
        task.value,
        task.revision,
        'humanActionResolved',
        {
          requestId: live.id,
          revision: resolved.revision,
          outcome: 'resolved',
          decidedBy: caller.id,
          assignees: actionUsers(live.value, task.value),
        },
      );
    });
  }

  /** Expire requests past `dueAt` and return lapsed claims to `pending`. Safe to call repeatedly. */
  async sweep(): Promise<number> {
    const open = await this.store.transaction(async (tx) => [
      ...(await tx.find<StoredHumanAction>('humanActions', {
        where: { status: 'pending' },
      })),
      ...(await tx.find<StoredHumanAction>('humanActions', {
        where: { status: 'claimed' },
      })),
    ]);
    let changed = 0;
    const now = this.now();
    for (const a of open) {
      const due = a.value.dueAt && a.value.dueAt <= now;
      const lapsed =
        a.value.status === 'claimed' &&
        a.value.claimExpiresAt &&
        a.value.claimExpiresAt <= now;
      if (!due && !lapsed) continue;
      await this.store.transaction(async (tx) => {
        const cur = await tx.get<StoredHumanAction>('humanActions', a.id);
        if (!cur || cur.revision !== a.revision) return;
        if (due) await this.expireIfDue(tx, cur);
        else await this.unclaim(tx, cur);
        changed++;
      });
    }
    return changed;
  }

  // --- guards ----------------------------------------------------------------------------------

  /** Authentication, delegated authority and policy before any state is read (SEC-07). */
  private async authorize(
    requestId: string,
    caller: TrustedPrincipal,
  ): Promise<void> {
    if (!caller?.id || !caller.tenantId)
      throw new AgentropyError('Unauthenticated', 'No trusted principal');
    await this.tasks.checkGrant(caller);
    await enforcePolicy(this.tasks.o.pdp, {
      principal: caller,
      action: 'human-input:decide',
      resource: {
        type: 'human-action',
        id: requestId,
        tenantId: caller.tenantId,
      },
    });
  }

  /** Visible = same tenant and the caller is an assignee (by ID, or by a role the policy grants). */
  private async visible(
    tx: StoreTx,
    requestId: string,
    caller: TrustedPrincipal,
  ): Promise<StoredDocument<StoredHumanAction>> {
    if (!caller?.id || !caller.tenantId)
      throw new AgentropyError('Unauthenticated', 'No trusted principal');
    const doc = await tx.get<StoredHumanAction>('humanActions', requestId);
    if (!doc || doc.value.tenantId !== caller.tenantId)
      throw new AgentropyError('NotFound', 'Request not found');
    if (!(await this.eligible(doc.value, caller)))
      throw new AgentropyError(
        'NotAssignee',
        'Caller is not an assignee of this request',
      );
    return doc;
  }

  private async eligible(
    a: StoredHumanAction,
    caller: TrustedPrincipal,
  ): Promise<boolean> {
    if (a.assignees.principalIds?.includes(caller.id)) return true;
    for (const role of a.assignees.roles ?? []) {
      const d = await this.tasks.o.pdp
        .decide({
          principal: caller,
          action: 'human-input:act-as-role',
          resource: { type: 'role', id: role, tenantId: a.tenantId },
        })
        .catch(() => ({ effect: 'deny' as const }));
      if (d.effect === 'allow') return true;
    }
    return false;
  }

  /** Visible and still open; terminal states map to their typed refusals. */
  private async actionable(
    tx: StoreTx,
    requestId: string,
    caller: TrustedPrincipal,
  ): Promise<StoredDocument<StoredHumanAction>> {
    const doc = await this.visible(tx, requestId, caller);
    switch (doc.value.status) {
      case 'expired':
        throw new AgentropyError('ActionExpired', 'Request has expired');
      case 'revoked':
        throw new AgentropyError('ActionRevoked', 'Request was revoked');
      case 'resolved':
        throw new AgentropyError(
          'ActionConflict',
          'Request is already decided',
        );
      default:
        return doc;
    }
  }

  private async unclaim(
    tx: StoreTx,
    doc: StoredDocument<StoredHumanAction>,
  ): Promise<StoredDocument<StoredHumanAction>> {
    assertTransition(
      HUMAN_ACTION_MACHINE,
      doc.value.status,
      'pending',
      'H-release',
    );
    const { claimedBy: _c, claimExpiresAt: _e, ...rest } = doc.value;
    void _c;
    void _e;
    return tx.update<StoredHumanAction>('humanActions', doc.id, doc.revision, {
      ...rest,
      status: 'pending',
    });
  }

  /** Moves a past-due open request to `expired` with its event; the wake-up applies `onExpiry`. */
  private async expireIfDue(
    tx: StoreTx,
    doc: StoredDocument<StoredHumanAction>,
  ): Promise<void> {
    const a = doc.value;
    if (
      !a.dueAt ||
      a.dueAt > this.now() ||
      isTerminal(HUMAN_ACTION_MACHINE, a.status)
    )
      return;
    assertTransition(HUMAN_ACTION_MACHINE, a.status, 'expired', 'H-expire');
    const expired = await tx.update<StoredHumanAction>(
      'humanActions',
      doc.id,
      doc.revision,
      { ...a, status: 'expired' },
    );
    const task = await tx.get<TaskRecord>('tasks', a.taskId);
    if (task)
      await this.tasks.emit(
        tx,
        task.value,
        task.revision,
        'humanActionResolved',
        {
          requestId: a.requestId,
          revision: expired.revision,
          outcome: 'expired',
          assignees: actionUsers(a, task.value),
        },
      );
  }
}

/** Built-in handler for `human-input.requestAction`. */
export function humanActionOperationHandlers(
  human: HumanActionService,
): Record<
  string,
  (input: unknown, ctx: CapabilityInvocationContext) => Promise<unknown>
> {
  return { requestAction: (input, ctx) => human.request(input, ctx) };
}
