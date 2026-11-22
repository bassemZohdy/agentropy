// FEAT-027.6 / TASK-026.4: observability (M2-10, D-12, D-13, D-14) — spans for acceptance, execution and capability
// calls joined into one trace through delegation, event links, baseline metrics, carrier sanitization and redaction.
// Verified against the real OpenTelemetry SDK (in-memory exporters).
import * as api from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  TracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import {
  BUILTIN_PROFILES,
  METRICS,
  SPANS,
  sanitizeTraceparent,
  type Agent,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { createLocalApp, openTelemetry } from '../../runtime/src/index.js';
import { sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const INGRESS = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const PRODUCER = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

const def = (
  id: string,
  over: Partial<AgentDefinition> = {},
): AgentDefinition => ({
  id,
  version: '1.0.0',
  displayName: id,
  profile: { id: 'task', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id, version: '1.0.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
  ...over,
});

function setup() {
  const spans = new InMemorySpanExporter();
  const tracerProvider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
  });
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter: metrics,
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [reader] });
  const clock = new FakeClock('2026-11-05T00:00:00.000Z');
  const app = createLocalApp({
    store: sqliteTempStore(),
    pdp: new FakePolicy(),
    now: clock.iso,
    profiles: BUILTIN_PROFILES,
    telemetry: openTelemetry({
      api,
      tracer: tracerProvider.getTracer('agentropy-test'),
      meter: meterProvider.getMeter('agentropy-test'),
    }),
  });
  const metricValues = async () => {
    await reader.forceFlush();
    const out = new Map<string, { attributes: object; value: unknown }[]>();
    for (const rm of metrics.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics)
          out.set(
            m.descriptor.name,
            m.dataPoints.map((d) => ({
              attributes: d.attributes,
              value: d.value,
            })),
          );
    return out;
  };
  return { app, clock, spans, metricValues };
}

const parentSpanId = (s: ReadableSpan) => s.parentSpanContext?.spanId;

describe('traces (D-13)', () => {
  it('ingress → accept → execute → capability → child accept → child execute form one trace', async () => {
    const { app, spans } = setup();
    const child: Agent = {
      handle: async () => ({ kind: 'completed', output: 'child-done' }),
    };
    let childInstance = '';
    const parent: Agent = {
      handle: async (_inv, ctx) => {
        await ctx.capabilities.invoke(
          'delegation',
          'delegate',
          { target: { instanceId: childInstance }, input: {} },
          { stepKey: 'child' },
        );
        return { kind: 'completed', output: 'parent-done' };
      },
    };
    app.define(def('child'), child);
    app.define(
      def('parent', {
        capabilities: [{ id: 'delegation', versionRange: '^1.0.0' }],
      }),
      parent,
    );
    childInstance = (
      await app.createInstance(
        {
          definition: { id: 'child', version: '1.0.0' },
          ownerId: 'alice',
          idempotencyKey: 'c',
        },
        alice,
      )
    ).id;
    const p = await app.createInstance(
      {
        definition: { id: 'parent', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'p',
      },
      alice,
    );
    await app.delegate(
      {
        target: { instanceId: p.id },
        input: { secret: 'hunter2' },
        idempotencyKey: 'k',
        correlationId: 'corr-1',
      },
      alice,
      { traceparent: INGRESS },
    );
    await app.runUntilIdle();

    const all = spans.getFinishedSpans();
    const byName = (n: string) => all.filter((s) => s.name === n);
    const [acceptParent, acceptChild] = byName(SPANS.accept);
    const executes = byName(SPANS.execute);
    const capability = byName(SPANS.capability).find(
      (s) => s.attributes['agentropy.capability.id'] === 'delegation',
    )!;
    // One trace, rooted at the ingress context.
    expect(new Set(all.map((s) => s.spanContext().traceId))).toEqual(
      new Set(['4bf92f3577b34da6a3ce929d0e0e4736']),
    );
    expect(parentSpanId(acceptParent!)).toBe('00f067aa0ba902b7');
    const parentExec = executes.find(
      (s) => s.attributes['agentropy.agent.id'] === 'parent',
    )!;
    const childExec = executes.find(
      (s) => s.attributes['agentropy.agent.id'] === 'child',
    )!;
    expect(parentSpanId(parentExec)).toBe(acceptParent!.spanContext().spanId);
    expect(parentSpanId(capability)).toBe(parentExec.spanContext().spanId);
    expect(parentSpanId(acceptChild!)).toBe(capability.spanContext().spanId);
    expect(parentSpanId(childExec)).toBe(acceptChild!.spanContext().spanId);
    expect(parentExec.attributes).toMatchObject({
      'agentropy.tenant.id': 't-1',
      'agentropy.activation': 1,
      'agentropy.disposition': 'completed',
    });
    // D-14: no inputs, outputs or payloads in any span.
    expect(JSON.stringify(all.map((s) => s.attributes))).not.toMatch(
      /hunter2|child-done|parent-done/,
    );
  });

  it('an event-triggered activation links to the producer’s trace; failures carry the error code, not the message', async () => {
    const { app, spans } = setup();
    const watcher: Agent = {
      handle: async (inv, ctx) => {
        if (inv.wakeReason?.kind === 'event')
          return {
            kind: 'failed',
            code: 'InvalidState',
            message: 'price 4111-1111 rejected',
            retryable: false,
          };
        const { subscription } = await ctx.capabilities.invoke<
          unknown,
          { subscription: string }
        >(
          'event-handling',
          'subscribe',
          { source: 'price' },
          { stepKey: 'sub' },
        );
        return {
          kind: 'waiting',
          wakeup: { anyOf: [{ kind: 'event', subscription }] },
          checkpoint: null,
        };
      },
    };
    app.define(
      def('watcher', { profile: { id: 'monitoring', version: '1.0.0' } }),
      watcher,
    );
    const inst = await app.createInstance(
      {
        definition: { id: 'watcher', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'w',
      },
      alice,
    );
    await app.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      alice,
    );
    await app.runUntilIdle();
    await app.publishEvent({
      eventId: 'e1',
      source: 'price',
      tenantId: 't-1',
      payload: { price: 1 },
      traceparent: PRODUCER,
    });
    await app.runUntilIdle();
    const second = spans
      .getFinishedSpans()
      .filter((s) => s.name === SPANS.execute)
      .find((s) => s.attributes['agentropy.activation'] === 2)!;
    expect(second.links.map((l) => l.context.spanId)).toEqual([
      'b7ad6b7169203331',
    ]);
    expect(second.attributes).toMatchObject({
      'agentropy.wake.kind': 'event',
      'agentropy.error.code': 'InvalidState',
    });
    expect(second.status.code).toBe(api.SpanStatusCode.ERROR);
    expect(
      JSON.stringify({
        attributes: second.attributes,
        status: second.status,
        events: second.events,
      }),
    ).not.toContain('4111');
  });
});

describe('carrier sanitization (D-14)', () => {
  it('accepts only well-formed version-00 traceparents; malformed carriers are dropped and counted', async () => {
    expect(sanitizeTraceparent(INGRESS)).toBe(INGRESS);
    for (const bad of [
      'garbage',
      INGRESS.toUpperCase(),
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
      'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      `${INGRESS}-extra`,
      42,
    ])
      expect(sanitizeTraceparent(bad)).toBeUndefined();

    const { app, spans, metricValues } = setup();
    app.define(def('echo'), {
      handle: async () => ({ kind: 'completed', output: 1 }),
    });
    const inst = await app.createInstance(
      {
        definition: { id: 'echo', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'e',
      },
      alice,
    );
    await app.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      alice,
      { traceparent: '00-<script>-x-01' },
    );
    await app.runUntilIdle();
    // A fresh root trace instead of the attacker-supplied value.
    const accept = spans
      .getFinishedSpans()
      .find((s) => s.name === SPANS.accept)!;
    expect(accept.parentSpanContext).toBeUndefined();
    expect((await metricValues()).get(METRICS.traceRejected)).toEqual([
      { attributes: { carrier: 'delegate' }, value: 1 },
    ]);
  });
});

describe('baseline metrics (D-12)', () => {
  it('records accepted and finished tasks (with outcome code), execution duration and outbox delivery lag', async () => {
    const { app, metricValues } = setup();
    app.define(def('ok'), {
      handle: async () => ({ kind: 'completed', output: 1 }),
    });
    app.define(def('bad'), {
      handle: async () => ({
        kind: 'failed',
        code: 'InvalidState',
        message: 'no',
        retryable: false,
      }),
    });
    for (const id of ['ok', 'bad']) {
      const inst = await app.createInstance(
        {
          definition: { id, version: '1.0.0' },
          ownerId: 'alice',
          idempotencyKey: id,
        },
        alice,
      );
      await app.delegate(
        {
          target: { instanceId: inst.id },
          input: {},
          idempotencyKey: id,
          correlationId: id,
        },
        alice,
      );
    }
    await app.runUntilIdle();
    const m = await metricValues();
    expect(m.get(METRICS.tasksAccepted)).toEqual([
      {
        attributes: { 'agentropy.agent.id': 'ok', 'agentropy.profile': 'task' },
        value: 1,
      },
      {
        attributes: {
          'agentropy.agent.id': 'bad',
          'agentropy.profile': 'task',
        },
        value: 1,
      },
    ]);
    expect(m.get(METRICS.tasksFinished)).toEqual(
      expect.arrayContaining([
        { attributes: { 'agentropy.task.status': 'completed' }, value: 1 },
        {
          attributes: {
            'agentropy.task.status': 'failed',
            'agentropy.outcome.code': 'InvalidState',
          },
          value: 1,
        },
      ]),
    );
    const durations = m.get(METRICS.executionDuration)!;
    expect(durations).toHaveLength(2);
    expect(m.get(METRICS.outboxLag)).toBeDefined();
  });
});
