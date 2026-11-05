/**
 * OpenTelemetry adapter for the observability port (observability contract, M2-10).
 *
 * Structural: pass the `@opentelemetry/api` module plus a Tracer and Meter from your SDK; Agentropy itself does not
 * depend on OpenTelemetry packages. Remote parents and links are rebuilt from sanitized W3C traceparents.
 */
import {
  formatTraceparent,
  parseTraceparent,
  type Attributes,
  type SpanOptions,
  type Telemetry,
  type TelemetrySpan,
} from '@agentropy/core';

interface OtelSpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote?: boolean;
}
interface OtelSpan {
  spanContext(): OtelSpanContext;
  setAttributes(a: Attributes): unknown;
  setStatus(s: { code: number; message?: string }): unknown;
  end(): void;
}
interface OtelTracer {
  startSpan(
    name: string,
    options: {
      kind?: number;
      attributes?: Attributes;
      links?: { context: OtelSpanContext }[];
    },
    context?: unknown,
  ): OtelSpan;
}
interface OtelMeter {
  createCounter(
    name: string,
    o?: { unit?: string },
  ): {
    add(v: number, a?: Attributes): void;
  };
  createHistogram(
    name: string,
    o?: { unit?: string },
  ): {
    record(v: number, a?: Attributes): void;
  };
}
/** The parts of `@opentelemetry/api` the adapter uses. */
export interface OtelApi {
  ROOT_CONTEXT: unknown;
  trace: {
    setSpanContext(context: unknown, spanContext: OtelSpanContext): unknown;
  };
  SpanKind: Record<
    'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER',
    number
  >;
  SpanStatusCode: { ERROR: number };
}

const remote = (traceparent: string): OtelSpanContext | undefined => {
  const p = parseTraceparent(traceparent);
  return p
    ? {
        traceId: p.traceId,
        spanId: p.spanId,
        traceFlags: p.sampled ? 1 : 0,
        isRemote: true,
      }
    : undefined;
};

export function openTelemetry(o: {
  api: OtelApi;
  tracer: OtelTracer;
  meter?: OtelMeter;
}): Telemetry {
  const counters = new Map<string, ReturnType<OtelMeter['createCounter']>>();
  const histograms = new Map<
    string,
    ReturnType<OtelMeter['createHistogram']>
  >();
  const kinds = {
    internal: o.api.SpanKind.INTERNAL,
    server: o.api.SpanKind.SERVER,
    client: o.api.SpanKind.CLIENT,
    producer: o.api.SpanKind.PRODUCER,
    consumer: o.api.SpanKind.CONSUMER,
  };
  return {
    startSpan(name: string, options: SpanOptions = {}): TelemetrySpan {
      const parent = options.parent ? remote(options.parent) : undefined;
      const ctx = parent
        ? o.api.trace.setSpanContext(o.api.ROOT_CONTEXT, parent)
        : o.api.ROOT_CONTEXT;
      const links = (options.links ?? [])
        .map(remote)
        .filter((c): c is OtelSpanContext => !!c)
        .map((context) => ({ context }));
      const span = o.tracer.startSpan(
        name,
        {
          kind: kinds[options.kind ?? 'internal'],
          ...(options.attributes ? { attributes: options.attributes } : {}),
          ...(links.length ? { links } : {}),
        },
        ctx,
      );
      const sc = span.spanContext();
      return {
        traceparent: /^0+$/.test(sc.traceId)
          ? undefined
          : formatTraceparent(sc.traceId, sc.spanId, (sc.traceFlags & 1) === 1),
        setAttributes: (a) => void span.setAttributes(a),
        fail: (code) =>
          void (span.setAttributes({ 'agentropy.error.code': code }),
          span.setStatus({ code: o.api.SpanStatusCode.ERROR, message: code })),
        end: () => span.end(),
      };
    },
    count(name, value, attributes) {
      if (!o.meter) return;
      let c = counters.get(name);
      if (!c) counters.set(name, (c = o.meter.createCounter(name)));
      c.add(value, attributes);
    },
    record(name, value, attributes) {
      if (!o.meter) return;
      let h = histograms.get(name);
      if (!h)
        histograms.set(
          name,
          (h = o.meter.createHistogram(name, { unit: 'ms' })),
        );
      h.record(value, attributes);
    },
  };
}
