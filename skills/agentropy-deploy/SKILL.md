---
name: agentropy-deploy
description: Deploy and verify an Agentropy runtime host as a container or on Kubernetes or OpenShift. Use when the user wants to build the host image, configure its environment, run it on SQLite or PostgreSQL, apply the manifests, check readiness, test rollout or pod loss on a kind cluster, or prepare an air-gapped install.
license: Apache-2.0
compatibility: Needs docker. The cluster test needs kind and kubectl. Run it from a checkout of https://github.com/bassemZohdy/agentropy (the Dockerfile and manifests are under deploy/).
metadata:
  project: agentropy
  audience: operators
---

# Deploy the Agentropy host

The host (`packages/examples/src/host.ts`) runs one runtime as a long-lived process with health endpoints. Applications replace its sample `defineAgents` and policy with their own. The full guide is `docs/deployment.md`.

## Build and run the image

```sh
docker build -f deploy/Dockerfile -t agentropy-host:0.0.0 .
docker run -d --name host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -v agentropy-data:/data -p 8080:8080 agentropy-host:0.0.0
curl -fsS localhost:8080/readyz
```

The image runs as user 1001 in group 0, so it also works with an arbitrary UID under the OpenShift `restricted-v2` SCC. The base image is pinned by digest.

## Environment

| Variable | Meaning |
|---|---|
| `AGENTROPY_DB` | SQLite file on a persistent volume (default `/data/agentropy.db`) |
| `AGENTROPY_PG_URL` | Use PostgreSQL instead. Several replicas may share the database, and the pod name (`HOSTNAME`) becomes the worker and outbox-relay ID |
| `PORT` | Health and A2A port (default 8080) |
| `AGENTROPY_ALLOW` | Comma-separated actions the **sample** policy allows. Everything else is denied. Replace the policy for real use |
| `AGENTROPY_TICK_MS` | Scheduler interval (default 250) |
| `AGENTROPY_OUTBOX_POISON_AFTER` | Give up on an outbox row after N failed deliveries. Off by default, which keeps event order |
| `AGENTROPY_OTLP_ENDPOINT`, `AGENTROPY_SERVICE_NAME` | Export traces and metrics to an OTLP/HTTP collector |
| `AGENTROPY_A2A_TOKENS`, `AGENTROPY_TENANT`, `AGENTROPY_PUBLIC_URL` | Enable and configure the A2A endpoint, see the `agentropy-a2a` skill |

## Endpoints and signals

- `GET /healthz` answers 200 while the process lives.
- `GET /readyz` answers `{"status":"ready"}`, or 503 with `store-unavailable`, `scheduler-stalled` or `shutting-down`. It adds `outboxStuck` as a detail while a failing consumer blocks rows. That detail does not take the pod out of service.
- SIGTERM drops readiness, closes the listener, cuts streams, lets running executions finish and closes the store. Give the pod `terminationGracePeriodSeconds: 60`.

## Kubernetes and OpenShift

- `deploy/kubernetes`: StatefulSet (one replica, SQLite on a 1 Gi volume), ConfigMap policy, Service, and two NetworkPolicies (deny-all, plus an opt-in A2A ingress for namespaces labelled `agentropy.io/a2a-peer=true`).
- `deploy/kubernetes-postgres`: overlay that swaps the StatefulSet for a two-replica Deployment on `AGENTROPY_PG_URL`.
- Render with `kubectl kustomize deploy/kubernetes`. Replace the placeholder image `registry.example.com/agentropy/agentropy-host:0.0.0`, and pin it by digest.
- Create the Secret `agentropy-a2a` (key `tokens`) **before** the pod starts if you want the A2A endpoint. It is optional.
- SQLite is single-node by design. Scale out with PostgreSQL, never by adding StatefulSet replicas.

## Verify

1. `node scripts/check-deploy.mjs` is the static check (manifests, Dockerfile, pinned actions and images, the kind job).
2. `bash deploy/a2a-smoke.sh <host:port> <token>` checks the AgentCard, a 401 without a token, and a task completing over JSON-RPC.
3. `bash deploy/kind-smoke.sh` is the live test. It creates a throwaway kind cluster, applies the manifests, checks readiness through the Service, runs the A2A smoke test, rolls the StatefulSet, deletes the pod with no grace and requires the accepted task to still be completed. `KEEP=1` keeps the cluster, and `KIND_IMAGE=kindest/node:<tag>` picks the node image.

Known limits of that test: it does not cover the PostgreSQL overlay, OpenShift itself, or NetworkPolicy enforcement (a port-forward bypasses it).

## Air-gapped installs

Mirror the image, its signature and attestations together. The release plan in `docs/release.md` covers SBOMs, cosign signing and provenance. Nothing is published yet, so build from source today.

## PostgreSQL notes

- Statement and lock timeouts are configurable (`statementTimeoutMs`, `lockTimeoutMs`). Timeouts surface as `Timeout`, not as a hang.
- Latency scales with the round trip to the database. Measure on your own network with `pnpm exec vitest run packages/testkit/test/benchmarks.test.ts` and compare against `docs/slo.md`.
