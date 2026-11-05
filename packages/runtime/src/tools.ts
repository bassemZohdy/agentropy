/** Tool v1: registry with governed lifecycle, provider registry, executor (PEP + audit) and two direct adapters. */
import { createHash } from 'node:crypto';
import {
  AgentropyError,
  digestOf,
  enforcePolicy,
  isAgentropyError,
  validateAgainst,
  validateToolBinding,
  validateToolDescriptor,
  type AuditEvent,
  type AuditIntentWriter,
  type CredentialProvider,
  type PolicyDecisionPoint,
  type ToolBinding,
  type ToolDescriptor,
  type ToolExecutor,
  type ToolInvocationContext,
  type ToolPin,
  type ToolProvenance,
  type ToolProvider,
  type ToolRecord,
  type ToolRegistry,
  type TrustedPrincipal,
  type VersionedRef,
} from '@agentropy/core';

export interface SecurityServices {
  pdp: PolicyDecisionPoint;
  audit: AuditIntentWriter;
  now: () => string;
}

/** Writes mandatory audit intent; any failure is AuditCommitUnavailable and the protected operation must not proceed. */
export async function recordAudit(
  audit: AuditIntentWriter,
  event: AuditEvent,
): Promise<void> {
  try {
    await audit.record(event);
  } catch (cause) {
    throw new AgentropyError(
      'AuditCommitUnavailable',
      'Mandatory audit intent could not be committed',
      { details: { action: event.action }, cause },
    );
  }
}

const refKey = (id: string, version: string) => `${id}@${version}`;

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly records = new Map<string, ToolRecord>();

  constructor(
    private readonly security: SecurityServices,
    /** Decides whether provenance is trusted (signature/allow-list check). Never derived from the manifest itself. */
    private readonly verify: (
      descriptor: ToolDescriptor,
      provenance: Omit<ToolProvenance, 'digest' | 'verified'>,
    ) => boolean,
  ) {}

  private async guard(
    admin: TrustedPrincipal,
    operation: string,
    toolId: string,
  ): Promise<void> {
    await enforcePolicy(this.security.pdp, {
      principal: admin,
      action: `tool-admin:${operation}`,
      resource: { type: 'tool', id: toolId, tenantId: admin.tenantId },
    });
    await recordAudit(this.security.audit, {
      type: `tool.${operation}`,
      tenantId: admin.tenantId,
      principalId: admin.id,
      action: `tool-admin:${operation}`,
      resource: { type: 'tool', id: toolId },
      decision: 'allow',
      at: this.security.now(),
    });
  }

  async register(
    descriptor: ToolDescriptor,
    bindings: ToolBinding[],
    provenance: Omit<ToolProvenance, 'digest' | 'verified'>,
    admin: TrustedPrincipal,
  ): Promise<ToolRecord> {
    const d = validateToolDescriptor(structuredClone(descriptor));
    const bs = bindings.map((b) => validateToolBinding(structuredClone(b)));
    if (
      bs.length === 0 ||
      bs.some((b) => b.toolId !== d.id || b.toolVersion !== d.version)
    ) {
      throw new AgentropyError(
        'InvalidConfiguration',
        'Bindings must target the registered tool version',
        { details: { reason: 'binding', id: d.id } },
      );
    }
    if (new Set(bs.map((b) => b.bindingId)).size !== bs.length)
      throw new AgentropyError(
        'InvalidConfiguration',
        'Duplicate binding IDs',
        { details: { reason: 'binding' } },
      );
    const digest = digestOf(d);
    const existing = this.records.get(refKey(d.id, d.version));
    if (existing) {
      if (existing.provenance.digest === digest)
        return structuredClone(existing);
      throw new AgentropyError(
        'InvalidConfiguration',
        `${d.id}@${d.version} is already registered with different content`,
        { details: { reason: 'immutable', id: d.id } },
      );
    }
    await this.guard(admin, 'register', d.id);
    const record: ToolRecord = {
      descriptor: d,
      provenance: {
        publisher: provenance.publisher,
        source: provenance.source,
        digest,
        verified: this.verify(d, provenance),
      },
      bindings: bs,
      status: 'registered',
      revision: 1,
    };
    this.records.set(refKey(d.id, d.version), record);
    return structuredClone(record);
  }

  async activate(
    ref: VersionedRef,
    admin: TrustedPrincipal,
  ): Promise<ToolRecord> {
    const r = this.require(ref);
    if (!r.provenance.verified)
      throw new AgentropyError(
        'PermissionDenied',
        'Unverified tools cannot be activated',
        { details: { reason: 'unverified', id: ref.id } },
      );
    return this.move(
      r,
      admin,
      'activate',
      ['registered', 'suspended'],
      'active',
    );
  }

  async suspend(
    ref: VersionedRef,
    admin: TrustedPrincipal,
  ): Promise<ToolRecord> {
    return this.move(
      this.require(ref),
      admin,
      'suspend',
      ['active'],
      'suspended',
    );
  }

  async revoke(
    ref: VersionedRef,
    admin: TrustedPrincipal,
  ): Promise<ToolRecord> {
    return this.move(
      this.require(ref),
      admin,
      'revoke',
      ['registered', 'active', 'suspended'],
      'revoked',
    );
  }

  get(ref: VersionedRef): ToolRecord | undefined {
    const r = this.records.get(refKey(ref.id, ref.version));
    return r ? structuredClone(r) : undefined;
  }

  versions(id: string): ToolRecord[] {
    return [...this.records.values()]
      .filter((r) => r.descriptor.id === id)
      .map((r) => structuredClone(r));
  }

  /** Metadata only. Discovery never implies invocation permission. */
  async discover(
    query: { text?: string },
    caller: TrustedPrincipal,
  ): Promise<ToolDescriptor[]> {
    void caller;
    const text = query.text?.toLowerCase();
    return [...this.records.values()]
      .filter((r) => r.status !== 'revoked')
      .filter((r) =>
        text
          ? `${r.descriptor.id} ${r.descriptor.description}`
              .toLowerCase()
              .includes(text)
          : true,
      )
      .sort(
        (a, b) =>
          a.descriptor.id.localeCompare(b.descriptor.id) ||
          a.descriptor.version.localeCompare(b.descriptor.version),
      )
      .map((r) => structuredClone(r.descriptor));
  }

  private require(ref: VersionedRef): ToolRecord {
    const r = this.records.get(refKey(ref.id, ref.version));
    if (!r)
      throw new AgentropyError(
        'NotFound',
        `Tool ${ref.id}@${ref.version} not found`,
        { details: { kind: 'tool' } },
      );
    return r;
  }

  private async move(
    r: ToolRecord,
    admin: TrustedPrincipal,
    operation: string,
    from: ToolRecord['status'][],
    to: ToolRecord['status'],
  ): Promise<ToolRecord> {
    if (!from.includes(r.status))
      throw new AgentropyError(
        'InvalidState',
        `Cannot ${operation} a ${r.status} tool`,
        { details: { status: r.status } },
      );
    await this.guard(admin, operation, r.descriptor.id);
    r.status = to;
    r.revision += 1;
    return structuredClone(r);
  }
}

export class ToolProviderRegistry {
  private readonly providers = new Map<string, ToolProvider>();

  register(provider: ToolProvider): void {
    this.providers.set(refKey(provider.id, provider.version), provider);
  }

  has(id: string, version: string): boolean {
    return this.providers.has(refKey(id, version));
  }

  get(id: string, version: string): ToolProvider {
    const p = this.providers.get(refKey(id, version));
    if (!p)
      throw new AgentropyError(
        'ProviderUnavailable',
        `Tool provider ${id}@${version} is not registered`,
        { details: { kind: 'tool-provider' } },
      );
    return p;
  }
}

/** Derived idempotency key: hash(tenantId, taskId, capabilityId, operation, stepKey) — Agent v1 "Idempotent side effects". */
export function deriveIdempotencyKey(
  tenantId: string,
  taskId: string,
  capabilityId: string,
  operation: string,
  stepKey: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([tenantId, taskId, capabilityId, operation, stepKey]),
    )
    .digest('hex');
}

export interface ToolExecutorOptions extends SecurityServices {
  registry: InMemoryToolRegistry;
  providers: ToolProviderRegistry;
  credentials?: CredentialProvider;
  /** Default per-invocation timeout; a binding may set config.timeoutMs. */
  defaultTimeoutMs?: number;
}

const TRANSPORT_CODES = new Set([
  'ProviderUnavailable',
  'Timeout',
  'UnknownAcceptance',
  'RemoteUnavailable',
  'QuotaExceeded',
]);

export class DefaultToolExecutor implements ToolExecutor {
  constructor(private readonly o: ToolExecutorOptions) {}

  async invoke(
    pin: ToolPin,
    input: unknown,
    ctx: ToolInvocationContext & { stepKey?: string },
  ): Promise<unknown> {
    // 1. The pinned record must still exist unchanged.
    const record = this.o.registry.get({
      id: pin.toolId,
      version: pin.toolVersion,
    });
    if (!record || record.provenance.digest !== pin.digest) {
      throw new AgentropyError(
        'IncompatibleVersion',
        `Pinned tool ${pin.toolId}@${pin.toolVersion} is no longer available unchanged`,
        { details: { kind: 'tool' } },
      );
    }
    // 2. Lifecycle status.
    if (record.status !== 'active')
      throw new AgentropyError(
        'PermissionDenied',
        `Tool ${pin.toolId} is ${record.status}`,
        { details: { status: record.status } },
      );
    const d = record.descriptor;
    // 3–4. Tenant, then a fresh PDP decision (never an acceptance-time Allow).
    await enforcePolicy(
      this.o.pdp,
      {
        principal: ctx.principal,
        action: d.permission,
        resource: { type: 'tool', id: d.id, tenantId: ctx.tenantId },
      },
      ctx.signal,
    );
    // 5. Step key for external effects.
    if (d.effect === 'external' && !ctx.stepKey)
      throw new AgentropyError(
        'SchemaViolation',
        `Tool ${d.id} has an external effect and requires a stepKey`,
        { details: { reason: 'missingStepKey' } },
      );
    // 6. Input schema.
    validateAgainst(d.inputSchema, input, `${d.id} input`);
    // 7a. Binding and provider; a provider that cannot honor idempotency keys may only serve an external tool
    // that explicitly declares at-least-once semantics (Tool v1 step 8, R-34, AC-07).
    const binding = record.bindings.find((b) => b.bindingId === pin.bindingId);
    if (!binding)
      throw new AgentropyError(
        'IncompatibleVersion',
        `Binding ${pin.bindingId} no longer exists`,
        { details: { kind: 'tool-binding' } },
      );
    const provider = this.o.providers.get(
      binding.providerId,
      binding.providerVersion,
    );
    if (
      d.effect === 'external' &&
      d.idempotency !== 'at-least-once' &&
      !provider.features.idempotencyKeys
    )
      throw new AgentropyError(
        'InvalidConfiguration',
        `Provider ${provider.id} cannot honor idempotency keys; ${d.id} must declare idempotency "at-least-once"`,
        { details: { kind: 'tool-binding', bindingId: binding.bindingId } },
      );
    // 7b. Audit intent before dispatch.
    await recordAudit(this.o.audit, {
      type: 'tool.invoke',
      tenantId: ctx.tenantId,
      principalId: ctx.principal.id,
      action: d.permission,
      resource: { type: 'tool', id: d.id },
      decision: 'allow',
      taskId: ctx.taskId,
      details: {
        toolVersion: d.version,
        bindingId: pin.bindingId,
        providerId: pin.providerId,
      },
      at: this.o.now(),
    });
    // 8. Dispatch.
    const idempotencyKey =
      ctx.idempotencyKey ??
      (ctx.stepKey
        ? deriveIdempotencyKey(
            ctx.tenantId,
            ctx.taskId,
            'tool-use',
            `call:${d.id}`,
            ctx.stepKey,
          )
        : undefined);
    const attempt = async (b: ToolBinding, p: ToolProvider) => {
      const credential = b.credentialRef
        ? await this.resolveCredential(b.credentialRef, ctx)
        : undefined;
      const timeoutMs =
        typeof b.config.timeoutMs === 'number'
          ? b.config.timeoutMs
          : (this.o.defaultTimeoutMs ?? 30_000);
      return this.dispatch(
        p,
        b,
        d,
        input,
        { ...ctx, idempotencyKey, credential },
        timeoutMs,
      );
    };
    let output: unknown;
    try {
      output = await attempt(binding, provider);
    } catch (err) {
      // D-04 failover (opt-in): a read-only tool may move to the bindings its pinned binding lists in
      // `config.fallbackBindings`, in that order, after an outage or timeout. Tools with effects never fail over
      // (a second provider could not deduplicate the first one's effect); the task-level retry handles them.
      const fallbacks = Array.isArray(binding.config.fallbackBindings)
        ? (binding.config.fallbackBindings as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          )
        : [];
      if (
        d.effect !== 'read' ||
        !(
          isAgentropyError(err, 'ProviderUnavailable') ||
          isAgentropyError(err, 'Timeout')
        )
      )
        throw err;
      let last: unknown = err;
      let recovered = false;
      for (const id of fallbacks) {
        const alt = record.bindings.find((b) => b.bindingId === id);
        if (!alt || alt.bindingId === binding.bindingId) continue;
        if (!this.o.providers.has(alt.providerId, alt.providerVersion))
          continue;
        try {
          output = await attempt(
            alt,
            this.o.providers.get(alt.providerId, alt.providerVersion),
          );
          recovered = true;
          break;
        } catch (e) {
          last = e;
        }
      }
      if (!recovered) throw last;
    }
    // 9. Output schema.
    if (d.outputSchema !== undefined)
      validateAgainst(d.outputSchema, output, `${d.id} output`);
    return output;
  }

  private async resolveCredential(
    ref: string,
    ctx: ToolInvocationContext,
  ): Promise<unknown> {
    if (!this.o.credentials)
      throw new AgentropyError(
        'InvalidConfiguration',
        'Binding needs a credential but no CredentialProvider is configured',
        { details: { reason: 'credential' } },
      );
    try {
      return await this.o.credentials.resolve(ref, {
        tenantId: ctx.tenantId,
        principal: ctx.principal,
        purpose: 'tool-invocation',
      });
    } catch (err) {
      if (isAgentropyError(err)) throw err;
      throw new AgentropyError(
        'ProviderUnavailable',
        'Credential could not be resolved',
        { details: { kind: 'credential' } },
      );
    }
  }

  private async dispatch(
    provider: ToolProvider,
    binding: ToolBinding,
    d: ToolDescriptor,
    input: unknown,
    ctx: ToolInvocationContext,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('timeout'));
        // For a read the effect is known not to have happened; for anything else the outcome is unknown.
        reject(
          d.effect === 'read'
            ? new AgentropyError('Timeout', `Tool ${d.id} timed out`, {
                details: { kind: 'tool' },
              })
            : new AgentropyError(
                'UnknownAcceptance',
                `Tool ${d.id} outcome unknown after timeout`,
                { details: { kind: 'tool' } },
              ),
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        provider.invoke(binding, d, input, {
          ...ctx,
          signal: controller.signal,
        }),
        timeout,
      ]);
    } catch (err) {
      if (
        isAgentropyError(err) &&
        (TRANSPORT_CODES.has(err.code) || err.code === 'SchemaViolation')
      )
        throw err;
      // An unclassified failure of a non-read call may have had an effect.
      throw d.effect === 'read'
        ? new AgentropyError('ProviderUnavailable', `Tool ${d.id} failed`, {
            details: { kind: 'tool' },
            cause: err,
          })
        : new AgentropyError(
            'UnknownAcceptance',
            `Tool ${d.id} outcome unknown`,
            { details: { kind: 'tool' }, cause: err },
          );
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }
}

export type ToolFunction = (
  input: unknown,
  ctx: ToolInvocationContext,
) => Promise<unknown> | unknown;

/** Direct adapter: calls an in-process function selected by `config.function`. */
export class DirectToolProvider implements ToolProvider {
  readonly id = 'direct';
  readonly version = '1.0.0';
  readonly features = {
    protocol: 'direct',
    protocolVersion: '1',
    cancellation: true,
    idempotencyKeys: true,
    streaming: false,
  };
  constructor(private readonly functions: Record<string, ToolFunction>) {}

  async invoke(
    binding: ToolBinding,
    _d: ToolDescriptor,
    input: unknown,
    ctx: ToolInvocationContext,
  ): Promise<unknown> {
    const fn = this.functions[String(binding.config.function)];
    if (!fn)
      throw new AgentropyError(
        'ProviderUnavailable',
        'Direct tool function not found',
        { details: { kind: 'tool-function' } },
      );
    return fn(input, ctx);
  }
}

/** A JSON-RPC-shaped request as it would cross a protocol boundary; payloads are serialized, never shared by reference. */
export interface LoopbackRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: { arguments: unknown; idempotencyKey?: string };
}
export type LoopbackTransport = (request: string) => Promise<string>;

/** Second adapter: serializes calls into a JSON-RPC envelope over an injected transport (protocol-shaped, offline). */
export class LoopbackJsonRpcToolProvider implements ToolProvider {
  readonly id = 'loopback';
  readonly version = '1.0.0';
  readonly features = {
    protocol: 'jsonrpc-loopback',
    protocolVersion: '2.0',
    cancellation: false,
    idempotencyKeys: true,
    streaming: false,
  };
  private seq = 0;
  constructor(private readonly transport: LoopbackTransport) {}

  async invoke(
    binding: ToolBinding,
    d: ToolDescriptor,
    input: unknown,
    ctx: ToolInvocationContext,
  ): Promise<unknown> {
    const request: LoopbackRequest = {
      jsonrpc: '2.0',
      id: String(++this.seq),
      method: String(binding.config.method ?? d.id),
      params: {
        arguments: input,
        ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
      },
    };
    const raw = await this.transport(JSON.stringify(request));
    let response: {
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      response = JSON.parse(raw) as typeof response;
    } catch {
      throw new AgentropyError(
        'ProviderUnavailable',
        'Malformed tool response',
        { details: { kind: 'tool' } },
      );
    }
    if (response.error) {
      // Remote error text is untrusted: keep only its numeric code.
      throw new AgentropyError('ProviderUnavailable', 'Remote tool error', {
        details: { kind: 'tool', remoteCode: response.error.code },
      });
    }
    return response.result;
  }
}

/** The handler-facing `tool-use` capability over a task's pinned tools (Capability v1 operation I/O). */
export class ToolUseCapability {
  constructor(
    private readonly executor: ToolExecutor,
    private readonly registry: InMemoryToolRegistry,
    private readonly pins: readonly ToolPin[],
  ) {}

  listTools(): { tools: ToolDescriptor[] } {
    return {
      tools: this.pins
        .map(
          (p) =>
            this.registry.get({ id: p.toolId, version: p.toolVersion })
              ?.descriptor,
        )
        .filter((d): d is ToolDescriptor => d !== undefined),
    };
  }

  async call(
    input: { toolId: string; input: unknown },
    ctx: ToolInvocationContext & { stepKey?: string },
  ): Promise<{ output: unknown }> {
    const pin = this.pins.find((p) => p.toolId === input.toolId);
    if (!pin)
      throw new AgentropyError(
        'CapabilityNotDeclared',
        `Tool ${input.toolId} is not pinned for this task`,
        { details: { kind: 'tool' } },
      );
    return { output: await this.executor.invoke(pin, input.input, ctx) };
  }
}
