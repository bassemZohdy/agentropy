#!/usr/bin/env bash
# A2A HTTP binding smoke test (FEAT-034.1) against a running host started with
#   AGENTROPY_A2A_TOKENS=<token>=<principal>  AGENTROPY_ALLOW=delegation:delegate,task:dispatch,capability:notification:use
# Checks the AgentCard, that an unauthenticated call is refused, and that a task sent over JSON-RPC completes.
#   deploy/a2a-smoke.sh <host:port> <token>
set -euo pipefail
base="http://${1:?host:port}"
token="${2:?bearer token}"

rpc() {
  curl -sS -H 'content-type: application/json' -H 'a2a-version: 1.0' -H "authorization: Bearer ${token}" \
    -d "$1" "${base}/a2a"
}

# Output is captured first: `curl | grep -q` under pipefail fails (curl exit 23) when grep stops reading early.
card=$(curl -fsS "${base}/.well-known/agent-card.json")
grep -q '"protocolBinding":"JSONRPC"' <<<"${card}"

status=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"x"}}' "${base}/a2a")
test "${status}" = "401"

sent=$(rpc '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"role":"ROLE_USER","messageId":"smoke-'"$$"'","parts":[{"text":"hello"}]}}}')
task=$(printf '%s' "${sent}" | sed -n 's/.*"task":{"id":"\([^"]*\)".*/\1/p')
if [ -z "${task}" ]; then
  echo "SendMessage did not return a task: ${sent}" >&2
  exit 1
fi

get='{"jsonrpc":"2.0","id":2,"method":"GetTask","params":{"id":"'"${task}"'"}}'
for _ in $(seq 1 30); do
  got=$(rpc "${get}")
  if grep -q TASK_STATE_COMPLETED <<<"${got}"; then
    echo "a2a smoke: task ${task} completed"
    exit 0
  fi
  sleep 1
done
echo "task ${task} did not complete: $(rpc "${get}")" >&2
exit 1
