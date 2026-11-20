/**
 * `reasoning.complete` backed by a ReasoningProvider (M2-08, R-35), with two runtime-enforced bounds:
 *
 * - **Bounded tools:** a request may offer the model only tools pinned in the task's acceptance snapshot; the model
 *   can *propose* calls (`toolCalls`) but never execute them — execution goes through `tool-use.call`, which applies
 *   pins, policy, audit and idempotency.
 * - **Budget:** with `budget.maxCostUnits` on the task, cost units are model tokens. A call is refused with
 *   `BudgetExceeded` once the budget is spent, and `maxTokens` is capped to what remains. Usage is stored per task.
 *
 * `openAICompatibleReasoning` speaks the widely implemented Chat Completions wire format (OpenAI, gateways and
 * proxies such as LiteLLM or agentgateway, vLLM, Ollama). The API key is resolved per call through a
 * CredentialProvider and never stored.
 */
import {
  AgentropyError,
  isAgentropyError,
  type CapabilityInvocationContext,
  type CredentialProvider,
  type ReasoningMessage,
  type ReasoningProvider,
  type ReasoningRequest,
  type ReasoningResult,
  type ReasoningToolSpec,
} from '@agentropy/core';
import { ReplyTooLarge, readBoundedJson } from './bounded-body.js';
import type { TaskRecord, TaskService } from './task-service.js';
import type { InMemoryToolRegistry } from './tools.js';

interface UsageRecord {
  taskId: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /**
   * Output tokens reserved by calls of one activation that have not finished (FEAT-041.3): concurrent calls
   * cannot overspend the budget together. Tagged with the execution, so a reservation left by a crashed
   * activation never blocks its successor.
   */
  reserved?: { executionId: string; tokens: number };
}

/** Routing hints are plain identifiers; anything else is dropped rather than passed on. */
function routeHint(r: unknown): ReasoningRequest['route'] | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const out: NonNullable<ReasoningRequest['route']> = {};
  const v = r as Record<string, unknown>;
  for (const k of ['zone', 'dataClass', 'tier'] as const)
    if (typeof v[k] === 'string' && /^[\w.-]{1,64}$/.test(v[k] as string))
      out[k] = v[k] as string;
  if (v['latency'] === 'low' || v['latency'] === 'normal')
    out.latency = v['latency'];
  return Object.keys(out).length ? out : undefined;
}

/** Tool IDs → provider-safe names and back (`finance.payout` → `finance_payout`). */
const toolName = (id: string) =>
  id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

export function reasoningOperationHandlers(o: {
  tasks: TaskService;
  provider: ReasoningProvider;
  tools?: InMemoryToolRegistry;
  /** Default and maximum `maxTokens` per call (default 1,024 / 8,192). */
  defaultMaxTokens?: number;
  maxTokensCap?: number;
}): Record<
  string,
  (input: unknown, ctx: CapabilityInvocationContext) => Promise<unknown>
> {
  return {
    complete: async (raw, ctx) => {
      const input = (raw ?? {}) as {
        prompt?: string;
        system?: string;
        messages?: ReasoningMessage[];
        maxTokens?: number;
        temperature?: number;
        tools?: string[];
        route?: ReasoningRequest['route'];
      };
      const messages: ReasoningMessage[] = input.messages ?? [
        ...(input.system
          ? [{ role: 'system' as const, content: input.system }]
          : []),
        ...(typeof input.prompt === 'string'
          ? [{ role: 'user' as const, content: input.prompt }]
          : []),
      ];
      if (
        !messages.length ||
        messages.some(
          (m) =>
            !['system', 'user', 'assistant'].includes(m?.role) ||
            typeof m.content !== 'string',
        )
      )
        throw new AgentropyError(
          'SchemaViolation',
          'reasoning.complete needs a prompt or messages',
        );
      const task = await o.tasks.o.store.transaction((tx) =>
        tx.get<TaskRecord>('tasks', ctx.taskId),
      );
      if (!task || task.value.tenantId !== ctx.tenantId)
        throw new AgentropyError('NotFound', 'Task not found');

      // Bounded tools: only pins from the acceptance snapshot.
      const byName = new Map<string, string>();
      const tools: ReasoningToolSpec[] = [];
      for (const id of input.tools ?? []) {
        const pin = task.value.snapshot.tools?.find((p) => p.toolId === id);
        // The stored status (FIX-084): a tool suspended or revoked on another worker since acceptance is not offered.
        const record = pin
          ? await o.tools?.refreshed({
              id: pin.toolId,
              version: pin.toolVersion,
            })
          : undefined;
        if (!pin || !record)
          throw new AgentropyError(
            'CapabilityNotDeclared',
            `Tool ${id} is not pinned for this task`,
            { details: { id } },
          );
        if (record.status !== 'active')
          throw new AgentropyError(
            'PermissionDenied',
            `Tool ${id} is ${record.status}`,
            { details: { status: record.status } },
          );
        const name = toolName(id);
        // Two tool IDs that map to one function name would hand the handler the wrong tool back.
        if (byName.has(name) && byName.get(name) !== id)
          throw new AgentropyError(
            'InvalidConfiguration',
            `Tools ${byName.get(name)} and ${id} map to the same function name`,
            { details: { reason: 'toolName' } },
          );
        byName.set(name, id);
        tools.push({
          name,
          description: record.descriptor.description,
          inputSchema: record.descriptor.inputSchema,
        });
      }

      // Budget: tokens spent so far (and reserved by this activation's calls in flight) against maxCostUnits. The
      // check and the reservation are one transaction, so concurrent calls cannot overspend together.
      const budget = task.value.budget?.maxCostUnits;
      const cap = o.maxTokensCap ?? 8_192;
      const wanted = Math.min(
        input.maxTokens ?? o.defaultMaxTokens ?? 1_024,
        cap,
      );
      const maxTokens = await o.tasks.o.store.transaction(async (tx) => {
        const usage = await tx.get<UsageRecord>('usage', ctx.taskId);
        const spent = usage
          ? usage.value.inputTokens + usage.value.outputTokens
          : 0;
        const mine =
          usage?.value.reserved?.executionId === ctx.executionId
            ? usage.value.reserved.tokens
            : 0;
        if (budget !== undefined && spent + mine >= budget)
          throw new AgentropyError(
            'BudgetExceeded',
            'The task has spent its reasoning budget',
            { details: { budget, spent: spent + mine } },
          );
        const grant =
          budget === undefined
            ? wanted
            : Math.min(wanted, budget - spent - mine);
        const next: UsageRecord = {
          taskId: ctx.taskId,
          inputTokens: usage?.value.inputTokens ?? 0,
          outputTokens: usage?.value.outputTokens ?? 0,
          calls: usage?.value.calls ?? 0,
          reserved: { executionId: ctx.executionId, tokens: mine + grant },
        };
        if (usage) await tx.update('usage', usage.id, usage.revision, next);
        else await tx.insert('usage', ctx.taskId, next);
        return grant;
      });
      const release = (used: { input: number; output: number } | undefined) =>
        o.tasks.o.store.transaction(async (tx) => {
          const cur = await tx.get<UsageRecord>('usage', ctx.taskId);
          if (!cur) return;
          const held =
            cur.value.reserved?.executionId === ctx.executionId
              ? cur.value.reserved.tokens
              : 0;
          const { reserved: _old, ...rest } = cur.value;
          void _old;
          const left = Math.max(0, held - maxTokens);
          await tx.update('usage', cur.id, cur.revision, {
            ...rest,
            inputTokens: rest.inputTokens + (used?.input ?? 0),
            outputTokens: rest.outputTokens + (used?.output ?? 0),
            calls: rest.calls + (used ? 1 : 0),
            ...(left > 0
              ? { reserved: { executionId: ctx.executionId, tokens: left } }
              : {}),
          });
        });

      let result: ReasoningResult;
      try {
        result = await o.provider.complete(
          {
            messages,
            maxTokens,
            ...(input.temperature !== undefined
              ? { temperature: input.temperature }
              : {}),
            ...(tools.length ? { tools } : {}),
            ...(routeHint(input.route)
              ? { route: routeHint(input.route)! }
              : {}),
          },
          { tenantId: ctx.tenantId, taskId: ctx.taskId, signal: ctx.signal },
        );
      } catch (err) {
        // A call that failed spent nothing we know of: give its reservation back.
        await release(undefined).catch(() => undefined);
        throw err;
      }
      await release({
        input: result.usage.inputTokens,
        output: result.usage.outputTokens,
      });
      const toolCalls = (result.toolCalls ?? []).map((c) => {
        const id = byName.get(c.name);
        if (!id)
          throw new AgentropyError(
            'SchemaViolation',
            'Model proposed a tool that was not offered',
            { details: { reason: 'unofferedTool' } },
          );
        return { toolId: id, input: c.input };
      });
      return {
        text: result.text,
        ...(toolCalls.length ? { toolCalls } : {}),
        usage: result.usage,
        model: result.model,
      };
    },
    plan: async () => {
      throw new AgentropyError(
        'UnsupportedOperation',
        'reasoning.plan is not offered by this provider; use complete',
      );
    },
  };
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
  headers?: { get(name: string): string | null };
  body?: { cancel(): Promise<unknown> } | null;
}>;

/** Chat Completions client (OpenAI-compatible wire format). */
export function openAICompatibleReasoning(o: {
  baseUrl: string;
  model: string;
  /** Opaque credential reference resolved per call (e.g. `openai-api-key`); omit for keyless local servers. */
  credentialRef?: string;
  credentials?: CredentialProvider;
  fetch?: FetchLike;
  /** One deadline for the call, headers and body (default 60 s). */
  timeoutMs?: number;
  /** Largest reply body read (default 4 MiB); a larger one is `ProviderUnavailable`. */
  maxResponseBytes?: number;
}): ReasoningProvider {
  const doFetch: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
  const url = `${o.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    id: 'openai-compatible',
    async complete(req: ReasoningRequest, ctx): Promise<ReasoningResult> {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (o.credentialRef) {
        if (!o.credentials)
          throw new AgentropyError(
            'InvalidConfiguration',
            'credentialRef needs a CredentialProvider',
          );
        const cred = (await o.credentials.resolve(o.credentialRef, {
          tenantId: ctx.tenantId,
          principal: { id: 'runtime', type: 'service', tenantId: ctx.tenantId },
          purpose: 'reasoning',
        })) as { apiKey?: string };
        if (!cred?.apiKey)
          throw new AgentropyError(
            'AuthorityExpired',
            'Model credential unavailable',
            {
              details: { kind: 'credential', status: 'expired' },
            },
          );
        headers.authorization = `Bearer ${cred.apiKey}`;
      }
      const body = {
        model: o.model,
        messages: req.messages,
        max_tokens: req.maxTokens,
        ...(req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: 'function',
                function: {
                  name: t.name,
                  description: t.description,
                  parameters:
                    t.inputSchema === true ? { type: 'object' } : t.inputSchema,
                },
              })),
            }
          : {}),
      };
      const controller = new AbortController();
      const onAbort = () => controller.abort(ctx.signal.reason);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('timeout')),
        o.timeoutMs ?? 60_000,
      );
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        if (isAgentropyError(err)) throw err;
        throw controller.signal.aborted && !ctx.signal.aborted
          ? new AgentropyError('Timeout', 'Model call timed out', {
              details: { kind: 'reasoning' },
            })
          : new AgentropyError(
              'ProviderUnavailable',
              'Model endpoint unreachable',
              {
                details: { kind: 'reasoning' },
              },
            );
      }
      // The deadline and the caller's abort stay in force until the body has been read: a stalled body is a timeout.
      try {
        // Provider error bodies are not passed through (they can echo prompts or keys) and not read: release them.
        if (res.status >= 400) void res.body?.cancel().catch(() => undefined);
        if (res.status === 401 || res.status === 403)
          throw new AgentropyError(
            'AuthorityExpired',
            'Model provider rejected the credential',
            {
              details: { kind: 'credential', status: 'expired' },
            },
          );
        if (res.status === 429)
          throw new AgentropyError(
            'QuotaExceeded',
            'Model provider rate limit',
            {
              details: { kind: 'reasoning' },
            },
          );
        if (res.status >= 500)
          throw new AgentropyError(
            'ProviderUnavailable',
            'Model provider error',
            {
              details: { kind: 'reasoning', status: res.status },
            },
          );
        if (res.status >= 400)
          throw new AgentropyError(
            'SchemaViolation',
            'Model provider refused the request',
            {
              details: { kind: 'reasoning', status: res.status },
            },
          );
        let parsed: unknown;
        try {
          parsed = await readBoundedJson(
            res,
            o.maxResponseBytes ?? 4 * 1024 * 1024,
            controller.signal,
          );
        } catch (err) {
          if (controller.signal.aborted && !ctx.signal.aborted)
            throw new AgentropyError('Timeout', 'Model call timed out', {
              details: { kind: 'reasoning' },
            });
          throw new AgentropyError(
            'ProviderUnavailable',
            err instanceof ReplyTooLarge
              ? 'Model response too large'
              : 'Malformed model response',
            { details: { kind: 'reasoning' } },
          );
        }
        const json = (parsed ?? {}) as {
          model?: string;
          choices?: {
            message?: {
              content?: string | null;
              tool_calls?: {
                function?: { name?: string; arguments?: string };
              }[];
            };
          }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const msg = json.choices?.[0]?.message;
        if (!msg)
          throw new AgentropyError(
            'ProviderUnavailable',
            'Malformed model response',
            {
              details: { kind: 'reasoning' },
            },
          );
        const toolCalls = (msg.tool_calls ?? []).map((c) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(c.function?.arguments ?? '{}');
          } catch {
            throw new AgentropyError(
              'SchemaViolation',
              'Model returned invalid tool arguments',
              {
                details: { reason: 'toolArguments' },
              },
            );
          }
          return { name: c.function?.name ?? '', input: parsed };
        });
        return {
          text: msg.content ?? '',
          ...(toolCalls.length ? { toolCalls } : {}),
          usage: {
            inputTokens: json.usage?.prompt_tokens ?? 0,
            outputTokens: json.usage?.completion_tokens ?? 0,
          },
          model: json.model ?? o.model,
        };
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
