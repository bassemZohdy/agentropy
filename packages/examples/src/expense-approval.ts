/**
 * J2 — Expense approval with a fake model and a human action (docs/poc-scope.md#journeys, AC-08).
 *
 * 1. A task agent receives `{ amount, description }` through `AgentService.delegate`.
 * 2. It asks `reasoning.complete` (an offline FakeModel) for a risk summary, then `human-input.requestAction`
 *    (step key `approval`, due in 48 h, `onExpiry: "fail-task"`) and waits on that request.
 * 3. The `humanActionRequested` event projects an inbox entry for the approver, who approves it through
 *    `AgentService.provideHumanInput`.
 * 4. The agent resumes with the resolved outcome, calls the `finance.payout` tool (step key `payout`) and
 *    completes; the result is read with `getResult`.
 *
 * Run: `pnpm example:expense-approval`
 */
import type {
  Agent,
  HumanActionRequest,
  ToolDescriptor,
  ToolInvocationContext,
} from '@agentropy/core';
import {
  DefaultToolExecutor,
  DirectToolProvider,
  InMemoryToolRegistry,
  ToolProviderRegistry,
  createLocalApp,
} from '@agentropy/runtime';
import { FakeAudit, FakeModel } from '@agentropy/testkit';
import {
  SameTenantPolicy,
  definition,
  isMain,
  tempStore,
  user,
} from './common.js';

export interface ExpenseApprovalResult {
  taskId: string;
  status: string;
  output: { riskSummary: string; paymentId: string } | undefined;
  request: HumanActionRequest;
  payouts: number;
  audit: string[];
}

const payoutTool: ToolDescriptor = {
  id: 'finance.payout',
  version: '1.0.0',
  description: 'Pay out an approved expense',
  inputSchema: {
    type: 'object',
    properties: { amount: { type: 'number', minimum: 0 } },
    required: ['amount'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { paymentId: { type: 'string' } },
    required: ['paymentId'],
  },
  effect: 'external',
  idempotency: 'keyed',
  permission: 'tool:finance.payout:call',
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

export async function runExpenseApproval(
  options: {
    log?: (line: string) => void;
    decision?: 'approve' | 'reject';
  } = {},
): Promise<ExpenseApprovalResult> {
  const log = options.log ?? (() => {});
  const pdp = new SameTenantPolicy();
  const audit = new FakeAudit();
  const now = () => new Date().toISOString();

  // Offline model and a keyed payout provider: a replayed step returns the original payment.
  const model = new FakeModel();
  model.setFallback(
    'Risk: medium. Amount above the 1,000 auto-approval limit.',
  );
  const payments = new Map<string, string>();
  const registry = new InMemoryToolRegistry({ pdp, audit, now }, () => true);
  const providers = new ToolProviderRegistry();
  providers.register(
    new DirectToolProvider({
      pay: (_input: unknown, ctx: ToolInvocationContext) => {
        const key = ctx.idempotencyKey!;
        if (!payments.has(key)) payments.set(key, `pay-${payments.size + 1}`);
        return { paymentId: payments.get(key) };
      },
    }),
  );
  const admin = user('finance-admin');
  await registry.register(
    payoutTool,
    [
      {
        bindingId: 'direct',
        toolId: payoutTool.id,
        toolVersion: payoutTool.version,
        providerId: 'direct',
        providerVersion: '1.0.0',
        config: { function: 'pay' },
        default: true,
      },
    ],
    { publisher: 'acme-finance', source: 'examples' },
    admin,
  );
  await registry.activate(
    { id: payoutTool.id, version: payoutTool.version },
    admin,
  );

  const app = createLocalApp({
    store: tempStore('expense-approval'),
    pdp,
    audit,
    now,
    tools: {
      registry,
      providers,
      executor: new DefaultToolExecutor({
        pdp,
        audit,
        now,
        registry,
        providers,
      }),
    },
    operations: {
      complete: async (input) => ({
        text: await model.complete((input as { prompt: string }).prompt),
      }),
    },
  });

  const expense: Agent<{ amount: number; description: string }> = {
    handle: async (inv, ctx) => {
      if (inv.activation === 1) {
        const { text } = await ctx.capabilities.invoke<
          unknown,
          { text: string }
        >('reasoning', 'complete', {
          prompt: `Assess the risk of expense ${inv.input.amount}: ${inv.input.description}`,
        });
        const { requestId } = await ctx.capabilities.invoke<
          unknown,
          { requestId: string }
        >(
          'human-input',
          'requestAction',
          {
            kind: 'approval',
            prompt: `Approve expense of ${inv.input.amount}? ${text}`,
            inputSchema: approvalSchema,
            assignees: { principalIds: ['manager'] },
            dueAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
            onExpiry: 'fail-task',
          },
          { stepKey: 'approval' },
        );
        return {
          kind: 'waiting',
          wakeup: { anyOf: [{ kind: 'human-action', requestId }] },
          checkpoint: { riskSummary: text },
        };
      }
      const reason = inv.wakeReason;
      const { riskSummary } = inv.checkpoint as { riskSummary: string };
      if (
        reason?.kind !== 'human-action' ||
        reason.outcome !== 'resolved' ||
        (reason.input as { decision: string }).decision !== 'approve'
      )
        return {
          kind: 'failed',
          code: 'PermissionDenied',
          message: 'Expense was not approved',
          retryable: false,
        };
      const { output } = await ctx.capabilities.invoke<
        unknown,
        { output: { paymentId: string } }
      >(
        'tool-use',
        'call',
        { toolId: 'finance.payout', input: { amount: inv.input.amount } },
        { stepKey: 'payout' },
      );
      return {
        kind: 'completed',
        output: { riskSummary, paymentId: output.paymentId },
      };
    },
  };

  app.define(
    definition('expense-agent', {
      displayName: 'Expense approval agent',
      capabilities: [
        { id: 'reasoning', versionRange: '^1.0.0' },
        { id: 'human-input', versionRange: '^1.0.0' },
        { id: 'tool-use', versionRange: '^1.0.0' },
      ],
      tools: [{ id: 'finance.payout', versionRange: '^1.0.0' }],
      inputSchema: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          description: { type: 'string' },
        },
        required: ['amount', 'description'],
      },
    }),
    expense,
  );

  const employee = user('employee');
  const manager = user('manager');
  const instance = await app.createInstance(
    {
      definition: { id: 'expense-agent', version: '1.0.0' },
      ownerId: employee.id,
      idempotencyKey: 'expense-agent',
    },
    employee,
  );
  log('employee> submit expense 4200 (team offsite)');
  const handle = await app.delegate(
    {
      target: { instanceId: instance.id },
      input: { amount: 4200, description: 'Team offsite catering' },
      idempotencyKey: 'expense-1',
      correlationId: 'expense-1',
    },
    employee,
  );
  await app.runUntilIdle();
  log(`task: ${(await app.getTask(handle.taskId, employee)).status}`);

  const [entry] = (await app.listInbox({}, manager)).entries;
  if (!entry?.actionRequestId)
    throw new Error('Expected an approval request in the manager inbox');
  log(`manager inbox> ${entry.title}`);
  const request = await app.getHumanAction(entry.actionRequestId, manager);
  const decision = options.decision ?? 'approve';
  await app.provideHumanInput(
    {
      requestId: request.requestId,
      expectedRevision: request.revision,
      input: { decision },
      idempotencyKey: 'decision-1',
    },
    manager,
  );
  log(`manager> ${decision}`);
  await app.runUntilIdle();

  const snapshot = await app.getTask(handle.taskId, employee);
  const output =
    snapshot.status === 'completed'
      ? await app.getResult<{ riskSummary: string; paymentId: string }>(
          handle.taskId,
          employee,
        )
      : undefined;
  log(
    output
      ? `result> paid ${output.paymentId}; ${output.riskSummary}`
      : `result> ${snapshot.status} (${snapshot.outcome?.code})`,
  );
  return {
    taskId: handle.taskId,
    status: snapshot.status,
    output,
    request: await app.getHumanAction(request.requestId, manager),
    payouts: payments.size,
    audit: audit.events.map((e) => e.type),
  };
}

if (isMain(import.meta.url)) {
  runExpenseApproval({ log: (l) => console.log(l) }).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
