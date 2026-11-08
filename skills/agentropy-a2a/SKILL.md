---
name: agentropy-a2a
description: Expose Agentropy agents to other systems, or call agents in other runtimes, over the A2A 1.0 protocol. Use when the user wants an A2A endpoint, an AgentCard, bearer-token peers, SSE streaming, push notification webhooks, agent discovery across runtimes, or to debug a failing A2A call.
license: Apache-2.0
compatibility: Agentropy checkout with Node.js 24 or newer. A2A 1.0 over HTTP JSON-RPC with Server-Sent Events. Other protocol versions are refused.
metadata:
  project: agentropy
  audience: integrators
---

# A2A with Agentropy

The contract is `docs/contracts/communication-v1.md`. The threat model rows TM-36, TM-42, TM-43 and TM-44 in `docs/security/threat-model.md` explain why the rules below exist.

## Serve agents (inbound)

The sample host does this when `AGENTROPY_A2A_TOKENS` is set. Use it as the template for your own host.

```sh
AGENTROPY_A2A_TOKENS=peer-token=ci-peer \
AGENTROPY_ALLOW=delegation:delegate,task:dispatch,capability:notification:use \
AGENTROPY_PUBLIC_URL=https://agents.example.com \
node packages/examples/dist/host.js
bash deploy/a2a-smoke.sh localhost:8080 peer-token
```

In your own code:

- `createA2AServer(localAppTarget(app), options)` exposes a `LocalApp` over A2A and reuses every `AgentService` check, so a peer gets no more access than any other caller. `packages/examples/src/host.ts` shows how the sample host picks the exposed instance and shares it with its peers.
- `createA2AHttpHandler` serves `POST /a2a` (JSON-RPC; streaming methods answer SSE) and `GET /.well-known/agent-card.json`. Pass an `authenticate` function backed by your identity provider (OIDC or JWT, mTLS, or a trusted gateway). The static bearer tokens of the sample host are for demos.
- `agentCardForDefinition(def, url)` builds the card. The definition ID is the first skill ID. Profile and capabilities become tags.
- Put TLS in front, at the ingress or the mesh.

Rules that matter:

- **Map each peer to a `user` principal**, never a `service` principal. The exposed instance is shared with exactly those users, so a peer sees, lists and cancels only the tasks it created. A `service` principal is tenant-wide.
- The handler authenticates **before** reading a body, bounds bodies and streams, sends `: ping` keep-alives (`keepAliveMs`) and honors write backpressure.
- A failed or cancelled task carries its outcome in `status.message`.
- Delegation also needs `capability:notification:use` in the allow list of the sample policy.

## Call remote agents (outbound)

- `A2ACommunicationProvider` is the client. A peer's `AuthorityExpired` or `PolicyDecisionUnavailable` is reported as `RemoteUnavailable`, and an unreadable acknowledgement becomes a typed error.
- Discovery uses agent cards, not a registry protocol of Agentropy's own. Configure `AgentDirectoryFederation({ peers: [{ id, cardUrl, tenants, allowedOrigins? }] })`. Only configured `https` card URLs are fetched, each peer is visible to its listed tenants only, and cards are untrusted data (size and field limits apply).
- `discover(query, caller)` runs the same `definition:discover` policy check as local discovery and fails closed. Each result has a `target.remote` you pass to `delegate`.
- Cards are cached and refreshed every 5 minutes. A failed fetch keeps the last good card, marked stale, for up to 24 hours.

## Push notifications

Push configs are stored durably with their secrets sealed (`A2ASecretSealer`), resumed on start and released on delete. A webhook attempt aborts after `push.timeoutMs`, and redirects are not followed. With several servers resuming push, a webhook can see an update twice, so receivers must be idempotent.

## Not implemented

Push-config paging and message history. `ListTasks`, task continuation through `message.taskId` (it answers a pending human action) and A2A 1.0 file and data parts are implemented.

## Test it

- Interop with the reference SDK `@a2a-js/sdk` 1.3.0 is tested in both directions in `packages/testkit/test/a2a-interop.test.ts`.
- `defineCommunicationConformance` runs the shared provider suite against any new provider.
- Typical failures: `401` means the token or principal map is wrong. A task that never completes usually means `AGENTROPY_ALLOW` is missing `capability:notification:use`. A card with the wrong URL means `AGENTROPY_PUBLIC_URL` is unset.
