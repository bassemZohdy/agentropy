# Self-hosting: container, Kubernetes, OpenShift and air-gapped installs

**Status:** FEAT-028.8 (2026-11-06), M3-08. Files: [`deploy/Dockerfile`](../deploy/Dockerfile), [`deploy/kubernetes/`](../deploy/kubernetes/), host process [`packages/examples/src/host.ts`](../packages/examples/src/host.ts). Checked offline by `node scripts/check-deploy.mjs`; CI also builds the image and runs it read-only, without capabilities, as the image user and as an arbitrary UID in group 0, and requires a clean exit on SIGTERM.

## What runs

The host process runs one runtime (`createLocalApp`) with its scheduler loop and serves two unauthenticated endpoints on `PORT` (8080): `GET /healthz` (process alive) and `GET /readyz` (store answers a transaction and the process is not shutting down). It exposes no task API: applications embed Agentropy and add their own transport (HTTP, A2A server, queue consumer) in front of `AgentService`. The sample registers one `echo` agent and a deny-by-default allow-list policy (`AGENTROPY_ALLOW`); replace both with your definitions and your policy decision point, audit sink and credential provider.

On SIGTERM it stops the scheduler, waits for running executions, closes the store and exits 0. Set `terminationGracePeriodSeconds` above your longest handler; anything still running at the deadline is recovered by lease expiry after restart.

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
- `NetworkPolicy` denies all ingress (probes come from the kubelet) and all egress except DNS. Add egress rules for every provider the deployment uses (PostgreSQL, policy point, model and tool endpoints, A2A peers, Conductor).
- Liveness `/healthz`, readiness `/readyz`; requests 250m/256Mi, limits 1 CPU/512Mi (the [SLOs](slo.md) were measured at 2 vCPU).

## OpenShift

The same manifests apply unchanged under the `restricted-v2` SCC: no `runAsUser` is set (OpenShift assigns a UID from the project range), and the image's group-0 ownership lets that UID write `/data`. `oc apply -k deploy/kubernetes`. No Route is needed because the host serves only probes.

## Scaling out with PostgreSQL

Several replicas need the PostgreSQL adapter ([ADR-0028](adr/0028-postgresql-store-adapter.md)). Write a host like `host.ts` that builds `new PostgresStore({ pool })` from the driver you choose (node-postgres `Pool` fits the pool port), configure `relay: { relayId: <pod name> }` so one replica leads the outbox relay, and deploy it as a `Deployment` with several replicas. Workers coordinate only through the database ([runtime contract](runtime-contract.md), several workers). The sample image does not include a PostgreSQL driver, and no PostgreSQL SLOs exist until measured on a server ([SLOs](slo.md)).

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
