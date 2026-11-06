/**
 * A2A provider (C-03, FEAT-027.8): JSON-RPC binding of the A2A protocol, pinned to protocol version 1.0
 * (a2a-protocol.org specification 1.0.0; the normative field list is the spec's `a2a.proto`).
 *
 * - Outbound: `A2ACommunicationProvider` implements the Communication SPI for targets with an `endpoint`. It sends
 *   `SendMessage`, `GetTask` and `CancelTask` with the `A2A-Version` header and a credential resolved per call for
 *   this runtime's own service identity. Local grants never cross the boundary; the caller's identity is not
 *   forwarded as authority (threat model TM-27/TM-28). The remote task stays authoritative; local state is a
 *   normalized projection.
 * - Inbound: `createA2AServer` maps the same methods onto a `DirectTarget` (e.g. `localAppTarget(app, …)`), with the
 *   principal produced by the transport's authentication. It reuses the AgentService PEPs.
 *
 * - Streaming (FEAT-029.1): `A2AServer.stream` serves `SendStreamingMessage` and `SubscribeToTask` as JSON-RPC
 *   `StreamResponse` frames (serialize with `sseFrames`). With `streaming: true` the provider's `subscribe` reads
 *   `SubscribeToTask` over SSE and falls back to polling `GetTask` when the peer declines or the stream breaks.
 *
 * - Push notifications (FEAT-029.2): with `push` options the server serves the four TaskPushNotificationConfig
 *   methods and POSTs each `StreamResponse` update to allow-listed webhook URLs (best-effort; configs in memory or,
 *   with `push.store`, stored and resumed, FEAT-034.3).
 *
 * HTTP: `createA2AHttpHandler` (a2a-http) serves an A2AServer on a Node `http` server: JSON-RPC POST, SSE for the
 * streaming methods, the AgentCard at `/.well-known/agent-card.json`, principal from the application's
 * `authenticate`.
 *
 * FEAT-034.4: `ListTasks` (the caller's tasks on this endpoint, newest status first, cursor pages), continuing a
 * task waiting for input with a `message.taskId` (answers its human action), and A2A 1.0 parts (`text`, `raw`,
 * `url`, `data`; several parts or file parts reach the agent as `{ parts }`, URLs are never fetched).
 * Agentropy-to-Agentropy envelopes (`send`) travel as a `SendMessage` whose `metadata["agentropy/envelope"]`
 * carries the AgentMessage; that key is an Agentropy extension, ignored by other peers.
 *
 * Modules (TASK-031): `a2a-protocol` (shapes and mappings), `a2a-server` (inbound), `a2a-push` (push
 * notifications), `a2a-sse` (SSE framing), `a2a-http` (Node HTTP binding, FEAT-034.1) and `a2a-client` (outbound,
 * AgentCard). This file re-exports their
 * public API.
 */
export {
  A2A_PROTOCOL_VERSION,
  type A2AMessage,
  type A2APart,
  type A2ATask,
  type A2ATaskState,
} from './a2a-protocol.js';
export {
  createA2AServer,
  localAppTarget,
  type A2AHttpResponse,
  type A2AServer,
  type A2AServerOptions,
  type A2AStreamFrame,
  type A2AStreamResult,
} from './a2a-server.js';
export type {
  A2APushConfig,
  A2APushFetch,
  A2APushOptions,
  A2ASecretSealer,
} from './a2a-push.js';
export { sseFrames } from './a2a-sse.js';
export {
  AGENT_CARD_PATH,
  createA2AHttpHandler,
  type A2AHttpHandler,
  type A2AHttpOptions,
} from './a2a-http.js';
export {
  A2ACommunicationProvider,
  a2aAgentCard,
  type A2AProviderOptions,
} from './a2a-client.js';
