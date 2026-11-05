/**
 * Out-of-process activation ingress (M2-02, FEAT-027.3): a transport-neutral handler that HTTP endpoints, queue
 * consumers or webhooks call with an `AgentMessage` envelope and the principal *their* authentication produced.
 *
 * - The envelope is validated (`validateAgentMessage`); actor and tenant claims in it are ignored — the trusted
 *   principal from the transport is the only identity (AC-09).
 * - `agent.delegate` (command) accepts a task: the envelope `idempotencyKey` deduplicates redeliveries.
 * - `agent.event` and `agent.callback` (event/command) publish an inbound event: the envelope `messageId` is the
 *   event ID, so a redelivered message is recorded once and wakes nothing twice.
 * - Errors come back as the public Errors v1 shape; nothing internal leaks.
 */
import {
  AgentropyError,
  enforcePolicy,
  sanitizeTraceparent,
  toAgentropyError,
  validateAgentMessage,
  type AgentropyErrorShape,
  type TrustedPrincipal,
} from '@agentropy/core';
import type { LocalApp } from './app.js';

export type IngressResult =
  | { status: 'accepted'; taskId: string; durability: string }
  | { status: 'recorded'; eventId: string }
  | { status: 'duplicate'; eventId: string }
  | { status: 'rejected'; error: AgentropyErrorShape };

/** Inbound callback events use this source; handlers subscribe with `{ source: CALLBACK_SOURCE, filter: { callbackId } }`. */
export const CALLBACK_SOURCE = 'callback';

export interface ActivationIngress {
  receive(
    message: unknown,
    principal: TrustedPrincipal,
    transport?: { traceparent?: string },
  ): Promise<IngressResult>;
}

export function createActivationIngress(app: LocalApp): ActivationIngress {
  return {
    async receive(message, principal, transport = {}) {
      try {
        if (!principal?.id || !principal.tenantId)
          throw new AgentropyError('Unauthenticated', 'No trusted principal');
        const m = validateAgentMessage(message);
        const traceparent = sanitizeTraceparent(transport.traceparent);
        switch (m.name) {
          case 'agent.delegate': {
            if (m.kind !== 'command')
              throw new AgentropyError(
                'SchemaViolation',
                'agent.delegate must be a command',
              );
            const p = m.payload as {
              target?: { instanceId?: string };
              input?: unknown;
              deadline?: string;
            };
            if (!p?.target?.instanceId)
              throw new AgentropyError(
                'SchemaViolation',
                'agent.delegate needs payload.target.instanceId',
              );
            const handle = await app.delegate(
              {
                target: { instanceId: p.target.instanceId },
                input: p.input,
                idempotencyKey: m.idempotencyKey!,
                correlationId: m.correlationId,
                ...(p.deadline ? { deadline: p.deadline } : {}),
              },
              principal,
              traceparent ? { traceparent } : {},
            );
            return {
              status: 'accepted',
              taskId: handle.taskId,
              durability: handle.durability,
            };
          }
          case 'agent.event':
          case 'agent.callback': {
            const p = m.payload as {
              source?: string;
              callbackId?: string;
              data?: unknown;
            };
            const source =
              m.name === 'agent.callback' ? CALLBACK_SOURCE : p?.source;
            if (!source || (m.name === 'agent.callback' && !p.callbackId))
              throw new AgentropyError(
                'SchemaViolation',
                m.name === 'agent.callback'
                  ? 'agent.callback needs payload.callbackId'
                  : 'agent.event needs payload.source',
              );
            await enforcePolicy(app.tasks.o.pdp, {
              principal,
              action: 'event:publish',
              resource: {
                type: 'event-source',
                id: source,
                tenantId: principal.tenantId,
              },
            });
            const fresh = await app.publishEvent({
              eventId: m.messageId,
              source,
              // The transport's principal decides the tenant, never the envelope.
              tenantId: principal.tenantId,
              payload:
                m.name === 'agent.callback'
                  ? { callbackId: p.callbackId, data: p.data }
                  : p.data,
              ...(traceparent ? { traceparent } : {}),
            });
            return fresh
              ? { status: 'recorded', eventId: m.messageId }
              : { status: 'duplicate', eventId: m.messageId };
          }
          default:
            throw new AgentropyError(
              'UnsupportedOperation',
              `Unknown message ${m.name}`,
            );
        }
      } catch (err) {
        return {
          status: 'rejected',
          error: toAgentropyError(err).toJSON(),
        };
      }
    },
  };
}
