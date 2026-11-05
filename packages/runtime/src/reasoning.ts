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
import type { TaskRecord, TaskService } from './task-service.js';
import type { InMemoryToolRegistry } from './tools.js';

interface UsageRecord {
  taskId: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
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
        const record = pin
          ? o.tools?.get({ id: pin.toolId, version: pin.toolVersion })
          : undefined;
        if (!pin || !record)
          throw new AgentropyError(
            'CapabilityNotDeclared',
            `Tool ${id} is not pinned for this task`,
            { details: { id } },
          );
        const name = toolName(id);
        byName.set(name, id);
        tools.push({
          name,
          description: record.descriptor.description,
          inputSchema: record.descriptor.inputSchema,
        });
      }

      // Budget: tokens spent so far against maxCostUnits.
      const budget = task.value.budget?.maxCostUnits;
      const usage = await o.tasks.o.store.transaction((tx) =>
        tx.get<UsageRecord>('usage', ctx.taskId),
      );
      const spent = usage
        ? usage.value.inputTokens + usage.value.outputTokens
        : 0;
      if (budget !== undefined && spent >= budget)
        throw new AgentropyError(
          'BudgetExceeded',
          'The task has spent its reasoning budget',
          { details: { budget, spent } },
        );
      const cap = o.maxTokensCap ?? 8_192;
      let maxTokens = Math.min(
        input.maxTokens ?? o.defaultMaxTokens ?? 1_024,
        cap,
      );
      if (budget !== undefined) maxTokens = Math.min(maxTokens, budget - spent);

      const result = await o.provider.complete(
        {
          messages,
          maxTokens,
          ...(input.temperature !== undefined
            ? { temperature: input.temperature }
            : {}),
          ...(tools.length ? { tools } : {}),
        },
        { tenantId: ctx.tenantId, taskId: ctx.taskId, signal: ctx.signal },
      );
      await o.tasks.o.store.transaction(async (tx) => {
        const cur = await tx.get<UsageRecord>('usage', ctx.taskId);
        const next: UsageRecord = {
          taskId: ctx.taskId,
          inputTokens: (cur?.value.inputTokens ?? 0) + result.usage.inputTokens,
          outputTokens:
            (cur?.value.outputTokens ?? 0) + result.usage.outputTokens,
          calls: (cur?.value.calls ?? 0) + 1,
        };
        if (cur) await tx.update('usage', cur.id, cur.revision, next);
        else await tx.insert('usage', ctx.taskId, next);
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
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Chat Completions client (OpenAI-compatible wire format). */
export function openAICompatibleReasoning(o: {
  baseUrl: string;
  model: string;
  /** Opaque credential reference resolved per call (e.g. `openai-api-key`); omit for keyless local servers. */
  credentialRef?: string;
  credentials?: CredentialProvider;
  fetch?: FetchLike;
  timeoutMs?: number;
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
      let res: { status: number; json(): Promise<unknown> };
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
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
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      }
      // Provider error bodies are not passed through: they can echo prompts or keys.
      if (res.status === 401 || res.status === 403)
        throw new AgentropyError(
          'AuthorityExpired',
          'Model provider rejected the credential',
          {
            details: { kind: 'credential', status: 'expired' },
          },
        );
      if (res.status === 429)
        throw new AgentropyError('QuotaExceeded', 'Model provider rate limit', {
          details: { kind: 'reasoning' },
        });
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
      const json = (await res.json()) as {
        model?: string;
        choices?: {
          message?: {
            content?: string | null;
            tool_calls?: { function?: { name?: string; arguments?: string } }[];
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
    },
  };
}
