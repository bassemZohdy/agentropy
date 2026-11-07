# Self-hosting: container, Kubernetes, OpenShift and air-gapped installs

**Status:** FEAT-028.8 (2026-11-06), M3-08. Files: [`deploy/Dockerfile`](../deploy/Dockerfile), [`deploy/kubernetes/`](../deploy/kubernetes/), host process [`packages/examples/src/host.ts`](../packages/examples/src/host.ts). Checked offline by `node scripts/check-deploy.mjs`; CI also builds the image and runs it read-only, without capabilities, as the image user and as an arbitrary UID in group 0, and requires a clean exit on SIGTERM.

## What runs

The host process runs one runtime (`createLocalApp`) with its scheduler loop and serves two unauthenticated endpoints on `PORT` (8080): `GET /healthz` (process alive) and `GET /readyz` (store answers a transaction, the scheduler loop is not stalled and the process is not shutting down). A scheduler tick that fails is logged to stderr and counted (`agentropy.scheduler.errors`); the loop keeps running, and `/readyz` answers `503 scheduler-stalled` after three failed ticks in a row or when no tick has succeeded for 30 s (`LocalApp.schedulerStatus()`). With `AGENTROPY_A2A_TOKENS` set (comma-separated `token=principalId`) it also serves the A2A HTTP binding (FEAT-034.1): `POST /a2a` (JSON-RPC; `SendStreamingMessage` and `SubscribeToTask` answer Server-Sent Events) and `GET /.well-known/agent-card.json`, exposing the sample agent to principals of `AGENTROPY_TENANT` (default `default`) — each token's principal is a `user` the instance is shared with, so a peer sees, lists and cancels only the tasks it delegated (a `service` principal would be tenant-wide, so map your peers to users, never services); `AGENTROPY_PUBLIC_URL` sets the URL the card advertises. The static bearer tokens are a sample: build your own host with `createA2AHttpHandler` and an `authenticate` function backed by your identity provider (OIDC/JWT, mTLS or a trusted gateway), and put TLS in front (ingress or service mesh). The delegation also needs `capability:notification:use` in `AGENTROPY_ALLOW`. CI checks the binding in the image with `deploy/a2a-smoke.sh`. Other transports (your own HTTP API, queue consumers) sit in front of `AgentService` the same way. The sample registers one `echo` agent and a deny-by-default allow-list policy (`AGENTROPY_ALLOW`); replace both with your definitions and your policy decision point, audit sink and credential provider.

On SIGTERM it marks itself not ready, closes the listener and cuts open connections (A2A streams), stops the scheduler, waits for running executions, closes the store and exits 0 (`shutdownHost`). An unhandled rejection is logged as one JSON line and ends the process with status 1. Set `terminationGracePeriodSeconds` above your longest handler; anything still running at the deadline is recovered by lease expiry after restart.

## Build

```sh
docker build -f deploy/Dockerfile -t registry.example.com/agentropy/agentropy-host:0.0.0 .
```

Two stages on `node:24-bookworm-slim`: install with `--frozen-lockfile`, build, `pnpm deploy --prod` of the examples package; the final stage runs as UID 1001 with `/data` owned by group 0 and group-writable. The base image is pinned by digest (`node:24-bookworm-slim@sha256:…`).

**Supply chain (TASK-030.1):** the base image and the CI PostgreSQL service image are pinned by digest, and every GitHub Action by commit SHA (the tag in a trailing comment). Dependabot (`.github/dependabot.yml`) proposes weekly npm, Actions and base-image updates. CI fails on a known vulnerability in a production dependency (`pnpm audit --prod`). `node scripts/check-deploy.mjs` enforces the pins, the audit step and the Dependabot ecosystems. Development-only advisories are reviewed when they appear and not gated: on 2026-11-06 the only one left was minimatch 10 (a ReDoS) through typescript-eslint, which matches only patterns from the repository's own configuration and has no fixed release within typescript-eslint's range yet.

## Kubernetes

```sh
kubectl apply -k deploy/kubernetes
```

- `StatefulSet` with **one replica** and a 1 GiB `ReadWriteOnce` volume at `/data`: SQLite is single-writer (ADR-0017). Do not raise replicas on SQLite.
- Pod security matches the Pod Security "restricted" profile: non-root, `RuntimeDefault` seccomp, no privilege escalation, all capabilities dropped, read-only root filesystem with writable `/data` and `/tmp`, no service-account token.
- `NetworkPolicy` denies all ingress (probes come from the kubelet) and all egress except DNS; a second policy (`networkpolicy-a2a.yaml`) opens only the A2A port to namespaces labelled `agentropy.io/a2a-peer=true`, and `service.yaml` gives the pod a cluster address. The A2A endpoint is off until you create the Secret `agentropy-a2a` with a `tokens` key (`token=principalId,…`); `tenant` and `publicUrl` are optional ConfigMap keys. Add egress rules for every provider the deployment uses (PostgreSQL, policy point, model and tool endpoints, A2A peers, Conductor).
- Liveness `/healthz`, readiness `/readyz`; requests 250m/256Mi, limits 1 CPU/512Mi (the [SLOs](slo.md) were measured at 2 vCPU).

## OpenShift

The same manifests apply unchanged under the `restricted-v2` SCC: no `runAsUser` is set (OpenShift assigns a UID from the project range), and the image's group-0 ownership lets that UID write `/data`. `oc apply -k deploy/kubernetes`. No Route is needed because the host serves only probes.

## Scaling out with PostgreSQL

Several replicas need the PostgreSQL adapter ([ADR-0028](adr/0028-postgresql-store-adapter.md)). The sample host does this when `AGENTROPY_PG_URL` is set: it builds `new PostgresStore({ pool })` over node-postgres (`pg`, an optional dependency of the examples package that is loaded only in this mode), uses the pod name (`HOSTNAME`) as worker and outbox-relay ID so one replica leads the relay (subscribers on the other replicas are still woken by their own relay), and ignores `AGENTROPY_DB`. Deploy it as a `Deployment` with several replicas (a manifest variant is tracked as FEAT-041.4); for your own host, build the store the same way. Workers coordinate only through the database ([runtime contract](runtime-contract.md), several workers). Set `statementTimeoutMs` and `lockTimeoutMs` on the store so a stuck statement or a row-lock wait fails the transaction with `Timeout` instead of holding a connection (and, at commit, the seq lock); a new index field is backfilled by one server-side statement at start. No PostgreSQL SLOs exist until measured on a server ([SLOs](slo.md)).

## Air-gapped installation

Nothing in the runtime calls out at run time except the providers you configure, and the whole test suite runs with the network blocked. To build and install without internet access:

1. **On a connected machine:** mirror the base image by digest into your registry (`docker pull node:24-bookworm-slim@sha256:…`, `docker save`), and fill a pnpm store with `pnpm fetch` from `pnpm-lock.yaml` (or mirror the npm registry, e.g. Verdaccio/Nexus/Artifactory). Corepack needs the pinned pnpm (`packageManager` in `package.json`) — mirror it too, or set `COREPACK_NPM_REGISTRY` to your mirror.
2. **Move** the saved image, the pnpm store and the repository snapshot into the isolated network.
3. **Build** with the base image from the internal registry and `pnpm install --offline --frozen-lockfile` (adjust the first stage, or build outside Docker and copy `pnpm deploy` output into the final stage).
4. **Verify** offline: `pnpm check`, `node scripts/check-deploy.mjs`, then run the image as in CI and probe `/readyz`.
5. **Push** to the internal registry and change `image:` in `statefulset.yaml` to that reference.

## Data residency, backup and upgrades

- **Residency** ([ADR-0030](adr/0030-hardening-and-d24-decisions.md)): all state lives in the configured store. Run one deployment (and store) per residency zone and restrict remote routes and provider egress per zone; the runtime does not tag records by region.
- **Backup:** SQLite — snapshot the volume while the pod is stopped, or copy the database with SQLite's online backup; PostgreSQL — your usual backup and point-in-time recovery. Restoring an older backup is safe for the schema (additive evolution) but loses newer tasks; verify the audit chain after restore (`auditLog.verify` with your published anchors).
- **Upgrades** ([ADR-0029](adr/0029-upgrades-and-version-migration.md)): roll the image; the store adds new collections and index columns on start, and refuses a database written by a newer release. Accepted tasks stay pinned to their definition versions; checkpoint codecs handle changed checkpoint shapes.
