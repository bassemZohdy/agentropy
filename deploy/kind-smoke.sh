#!/usr/bin/env bash
# Live-cluster deployment test (FEAT-036): apply deploy/kubernetes to a kind cluster, wait for readiness, run the
# A2A smoke test through the Service, roll the StatefulSet, delete the pod without grace, and check that the task
# accepted before the disruption is still completed on the persistent volume afterwards.
#
#   bash deploy/kind-smoke.sh            # creates (and afterwards deletes) the cluster agentropy-smoke
#   VARIANT=postgres bash deploy/kind-smoke.sh   # the PostgreSQL variant (TASK-076): a throwaway PostgreSQL in the
#                                        # cluster, two replicas, rolling restart and pod loss with the work in the database
#   KEEP=1 bash deploy/kind-smoke.sh     # keeps the cluster for inspection
#   KIND_IMAGE=kindest/node:v1.36.1      # node image (default: kind's own default)
#
# Needs docker, kind and kubectl. Uses the cluster's default storage class and the host's A2A endpoint with the
# bearer token below.
set -euo pipefail

cluster="${CLUSTER:-agentropy-smoke}"
variant="${VARIANT:-sqlite}"
image="agentropy-host:kind"
token="kind-token"
principal="kind-peer"
local_port="${LOCAL_PORT:-18080}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
kctl() { kubectl --context "kind-${cluster}" "$@"; }
pf_pid=""

cleanup() {
  [ -n "${pf_pid}" ] && kill "${pf_pid}" 2>/dev/null || true
  if [ "${KEEP:-0}" != "1" ]; then kind delete cluster --name "${cluster}" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }

dump() {
  echo "-- diagnostics" >&2
  kctl get pods,pvc,svc -o wide >&2 || true
  kctl describe pod -l app.kubernetes.io/name=agentropy >&2 || true
  kctl logs -l app.kubernetes.io/name=agentropy --tail=50 >&2 || true
}
trap 'dump' ERR

forward() {
  [ -n "${pf_pid}" ] && kill "${pf_pid}" 2>/dev/null || true
  # A fresh local port each time: a stopped port-forward may still hold the previous one for a moment.
  local_port=$((local_port + 1))
  kctl port-forward svc/agentropy "${local_port}:8080" >/dev/null 2>&1 &
  pf_pid=$!
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${local_port}/readyz" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "the Service did not answer /readyz through the port-forward" >&2
  return 1
}

rpc() {
  curl -sS -H 'content-type: application/json' -H 'a2a-version: 1.0' -H "authorization: Bearer ${token}" \
    -d "$1" "http://127.0.0.1:${local_port}/a2a"
}

wait_ready() {
  if [ "${variant}" = "postgres" ]; then
    kctl rollout status deployment/agentropy --timeout=180s
    # Only pods that are not terminating: after a restart an old pod is still draining and will never be Ready again.
    kctl get pods -l app.kubernetes.io/name=agentropy --no-headers \
      -o custom-columns=NAME:.metadata.name,DELETED:.metadata.deletionTimestamp | awk '$2 == "<none>" { print "pod/" $1 }' \
      | xargs kctl wait --for=condition=Ready --timeout=120s
    return
  fi
  kctl rollout status statefulset/agentropy --timeout=180s
  kctl wait --for=condition=Ready pod/agentropy-0 --timeout=120s
}

# The names of the host's pods, sorted (one pod with SQLite, the replicas with PostgreSQL).
# A pod that is still terminating (its deletionTimestamp is set) belongs to the old set and is not counted.
pods() {
  kctl get pods -l app.kubernetes.io/name=agentropy --no-headers \
    -o custom-columns=UID:.metadata.uid,DELETED:.metadata.deletionTimestamp | awk '$2 == "<none>" { print $1 }' | sort
}

# A throwaway PostgreSQL for the variant, and the egress the default-deny NetworkPolicy has to be given to reach it.
postgres() {
  kctl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: postgres }
spec:
  replicas: 1
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
        - name: postgres
          image: postgres:17
          env: [{ name: POSTGRES_PASSWORD, value: smoke }]
          ports: [{ containerPort: 5432 }]
          readinessProbe: { exec: { command: ["pg_isready", "-U", "postgres"] }, periodSeconds: 2 }
---
apiVersion: v1
kind: Service
metadata: { name: postgres }
spec:
  selector: { app: postgres }
  ports: [{ port: 5432 }]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: agentropy-to-postgres }
spec:
  podSelector: { matchLabels: { app.kubernetes.io/name: agentropy } }
  policyTypes: [Egress]
  egress:
    - to: [{ podSelector: { matchLabels: { app: postgres } } }]
      ports: [{ port: 5432 }]
EOF
  kctl rollout status deployment/postgres --timeout=180s
  kctl create secret generic agentropy-pg --from-literal="url=postgres://postgres:smoke@postgres:5432/postgres" \
    --dry-run=client -o yaml | kctl apply -f -
}

step "cluster ${cluster}"
if ! kind get clusters 2>/dev/null | grep -qx "${cluster}"; then
  kind create cluster --name "${cluster}" ${KIND_IMAGE:+--image "${KIND_IMAGE}"} --wait 120s
fi

step "image"
docker build -f "${root}/deploy/Dockerfile" -t "${image}" "${root}"
kind load docker-image "${image}" --name "${cluster}"

step "apply manifests"
kctl create secret generic agentropy-a2a --from-literal="tokens=${token}=${principal}" \
  --dry-run=client -o yaml | kctl apply -f -
if [ "${variant}" = "postgres" ]; then postgres; fi
manifests="${root}/deploy/kubernetes"
if [ "${variant}" = "postgres" ]; then manifests="${root}/deploy/kubernetes-postgres"; fi
kubectl kustomize "${manifests}" \
  | sed "s#registry.example.com/agentropy/agentropy-host:0.0.0#${image}#" \
  | kctl apply -f -
wait_ready

step "readiness through the Service"
forward
curl -fsS "http://127.0.0.1:${local_port}/healthz" >/dev/null
ready=$(curl -fsS "http://127.0.0.1:${local_port}/readyz")
grep -q '"status":"ready"' <<<"${ready}" || { echo "not ready: ${ready}" >&2; exit 1; }

step "A2A smoke test"
out=$(bash "${root}/deploy/a2a-smoke.sh" "127.0.0.1:${local_port}" "${token}")
echo "${out}"
task=$(sed -n 's/.*task \([^ ]*\) completed.*/\1/p' <<<"${out}")
test -n "${task}"
get='{"jsonrpc":"2.0","id":9,"method":"GetTask","params":{"id":"'"${task}"'"}}'

step "rolling restart"
uid_before=$(pods)
if [ "${variant}" = "postgres" ]; then kctl rollout restart deployment/agentropy; else kctl rollout restart statefulset/agentropy; fi
sleep 3
wait_ready
# No pod of the old set is left.
test -z "$(comm -12 <(echo "${uid_before}") <(pods))" || { echo "an old pod survived the rollout" >&2; exit 1; }
forward
grep -q TASK_STATE_COMPLETED <<<"$(rpc "${get}")" || { echo "task ${task} lost across the rollout" >&2; exit 1; }
echo "task ${task} survived the rollout"

step "pod loss"
victim=$(kctl get pods -l app.kubernetes.io/name=agentropy -o jsonpath='{.items[0].metadata.name}')
uid_before=$(kctl get pod "${victim}" -o jsonpath='{.metadata.uid}')
kctl delete pod "${victim}" --grace-period=0 --force --wait=false
for _ in $(seq 1 60); do
  # StatefulSet: the same name with a new UID; Deployment: the old UID is gone and the replacement is listed.
  if ! pods | grep -qx "${uid_before}"; then break; fi
  sleep 1
done
wait_ready
forward
grep -q TASK_STATE_COMPLETED <<<"$(rpc "${get}")" || { echo "task ${task} lost after the pod was deleted" >&2; exit 1; }
echo "task ${task} survived pod loss"
bash "${root}/deploy/a2a-smoke.sh" "127.0.0.1:${local_port}" "${token}"

step "kind smoke: ok"
