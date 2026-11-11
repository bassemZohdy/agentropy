# FEAT-048 plan: outbound push config at A2A peers

- Status: Plan (2026-11-11), scheduled by the owner. Built by FEAT-048.2 and FEAT-048.3; revised here if the build finds a flaw.
- Contract: [Communication v1](../contracts/communication-v1.md) (A2A section, revision 11 when built). Threat model: [TM-49 to TM-51](../security/threat-model.md).

## Problem

An Agentropy runtime that delegates to an A2A peer learns about the remote task by polling `GetTask` (FEAT-039.2 backs the polling off exponentially, up to 30 s) or by reading `SubscribeToTask` over SSE. A peer that supports push notifications (A2A 1.0 `TaskPushNotificationConfig`) could tell the runtime when the task changes, so a waiting parent task wakes in milliseconds and the polling can stay slow. The runtime side has no way to register a webhook at a peer and no endpoint that receives one; `features.pushNotifications` is `false`.

## Decision: a notification is a wake-up signal, not data

The receiver does **not** read the payload of a notification. A valid notification for a remote projection makes the runtime ask the peer for that task right now (`GetTask`, the call it already makes) and apply the answer through the existing path. Consequences:

- One code path validates and maps peer data (state mapping, output decoding, error codes). A webhook adds no second parser.
- A forged or replayed notification can cost one rate-limited `GetTask` to a peer the runtime already trusts with that task, and nothing else.
- Missing, late or duplicated notifications are harmless: the polling stays as the fallback (it is only slower), so delivery guarantees of the peer's webhooks do not matter.

## Design

1. **Provider option.** `new A2ACommunicationProvider({ push: { publicUrl, secret, allowHttp? } })`. `publicUrl` is the externally reachable base URL of this runtime's receiver (https unless `allowHttp`, no credentials, no query or fragment); `secret` is at least 32 bytes of configuration. Without `push` nothing changes. With it `features.pushNotifications` is `true`.
2. **Registration.** After a successful `SendMessage`, the provider calls `CreateTaskPushNotificationConfig` at the peer with `{ taskId: <remote id>, id: "agentropy", url: <publicUrl>/a2a/push/<local task id, URL-encoded>, token }`. It is best effort: any failure (the peer answers −32003 because it has no push, a network error, a refusal) is ignored and polling carries on. It never fails the delegation.
3. **Token.** `token = base64url(HMAC-SHA256(secret, "agentropy/a2a-push/v1:" + localTaskId))`. It is derived, not stored: nothing is persisted, rotating the secret invalidates old tokens (and polling covers the gap), and a token for one projection is useless for another. The peer sends it back in `X-A2A-Notification-Token`.
4. **Receiver.** `createA2APushReceiver({ secret, refresh, path?, maxBodyBytes?, minIntervalMs? })` returns `{ notify(localTaskId, token), handle(req, res) }`, like the other A2A HTTP pieces (`handle` returns `false` when the path is not its own). `POST <path>/<local task id>`:
   - authenticates **before reading the body**: the token is recomputed and compared in constant time; a missing or wrong token is `401` and the body is never read;
   - bounds the body (default 64 KiB, `413`) and drains it unread: it is discarded, not parsed;
   - calls `refresh(localTaskId)` at most once per `minIntervalMs` (default 1 s) per task, in memory; faster notifications are coalesced and still answered `202`;
   - answers `202` once the refresh is scheduled or coalesced, `404` when the projection does not exist (a compacted or never-created task), `405` for other methods.
5. **Refresh.** `RemoteDelegationService.refresh(localTaskId)` asks the provider for that projection now and applies the answer; a terminal projection is left alone. `LocalApp.refreshRemote(localTaskId)` exposes it to trusted host code only (the host calls it after the receiver authenticated the notification); it is not an `AgentService` operation and takes no principal.
6. **Host.** The example host mounts the receiver when `AGENTROPY_PUSH_PUBLIC_URL` and `AGENTROPY_PUSH_SECRET` are set. It is not required for the library and is out of FEAT-048's tests beyond a smoke check.

## Threat model (rows added with FEAT-048.3)

| ID | Threat | Mitigation |
|---|---|---|
| TM-49 | A third party forges a notification to make the runtime poll a peer, or probes which task IDs exist | HMAC token per task, constant-time compare, checked before the body is read; `401` without distinguishing unknown tasks; forging one needs the secret |
| TM-50 | A peer, or anyone holding a leaked token, floods the receiver | Body bound and unread; per-task coalescing (`minIntervalMs`) so a flood becomes at most one `GetTask` per task per interval; the token only reaches one projection |
| TM-51 | A hostile peer uses the webhook channel to inject data into a projection | The payload is never parsed: the notification only triggers a `GetTask` through the validated path; the peer was already the authority for that task |

## Contract change (Communication v1, revision 11)

The A2A section drops "The outbound provider does not configure push at peers" and gains the option, the registration call, the token derivation, the receiver's responses and the guarantee that notifications are hints on top of polling.

## Tests

- `a2a-push-refresh.test.ts` (FEAT-048.2): refresh applies the peer's state now; terminal and unknown projections; the rate limit; the poller still works.
- `a2a-push-outbound.test.ts` (FEAT-048.3): two runtimes where the peer's webhook transport is wired to the receiver and the caller's own polling is switched off, so only the push can complete the projection; registration failure does not fail the delegation; wrong, missing and other-task tokens are `401` and read no body; oversized body `413`; a flood is coalesced; configuration validation; a real HTTP server for the transport details.

## Not in scope

Webhook authentication schemes other than the shared token (the peer's `authentication` is not used: we are the receiver), delivery retries (the peer's job; polling covers loss), persisting tokens, per-peer secrets, and mTLS between peers.
