#!/usr/bin/env node
// Offline checks for the self-hosting files (FEAT-028.8): the Kubernetes/OpenShift manifests parse, run with the
// restricted security profile OpenShift's restricted-v2 SCC and Pod Security "restricted" require, have probes on
// endpoints the host actually serves, resource limits and a default-deny NetworkPolicy; the Dockerfile builds a
// non-root image without floating "latest" tags. Exit 1 with one line per violation.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(root, 'packages/runtime/package.json'));
const YAML = require('yaml');
const problems = [];
const fail = (msg) => problems.push(msg);

const host = readFileSync(join(root, 'packages/examples/src/host.ts'), 'utf8');
const served = new Set([...host.matchAll(/req\.url === '([^']+)'/g)].map((m) => m[1]));

const dir = join(root, 'deploy/kubernetes');
const docs = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
  for (const d of YAML.parseAllDocuments(readFileSync(join(dir, file), 'utf8'))) {
    if (d.errors.length) fail(`${file}: ${d.errors[0].message}`);
    else docs.push({ file, obj: d.toJS() });
  }
}

const kinds = new Set(docs.map((d) => d.obj?.kind));
for (const k of ['StatefulSet', 'NetworkPolicy', 'ConfigMap', 'Kustomization'])
  if (!kinds.has(k)) fail(`deploy/kubernetes: no ${k}`);

const kustomization = docs.find((d) => d.obj?.kind === 'Kustomization')?.obj;
for (const d of docs)
  if (d.obj?.kind !== 'Kustomization' && !kustomization?.resources?.includes(d.file))
    fail(`${d.file}: not listed in kustomization.yaml`);

for (const { file, obj } of docs) {
  const pod = obj?.spec?.template?.spec;
  if (!pod) continue;
  if (pod.securityContext?.runAsNonRoot !== true) fail(`${file}: pod runAsNonRoot must be true`);
  if (pod.securityContext?.seccompProfile?.type !== 'RuntimeDefault')
    fail(`${file}: seccompProfile RuntimeDefault required`);
  if (pod.automountServiceAccountToken !== false)
    fail(`${file}: automountServiceAccountToken must be false (the runtime needs no API access)`);
  if (pod.securityContext?.runAsUser !== undefined)
    fail(`${file}: do not pin runAsUser (OpenShift assigns UIDs)`);
  for (const c of pod.containers ?? []) {
    const where = `${file}: container ${c.name}`;
    const sc = c.securityContext ?? {};
    if (sc.allowPrivilegeEscalation !== false) fail(`${where}: allowPrivilegeEscalation must be false`);
    if (sc.readOnlyRootFilesystem !== true) fail(`${where}: readOnlyRootFilesystem must be true`);
    if (!sc.capabilities?.drop?.includes('ALL')) fail(`${where}: capabilities must drop ALL`);
    if (sc.runAsUser !== undefined) fail(`${where}: do not pin runAsUser`);
    if (!c.resources?.limits?.memory || !c.resources?.limits?.cpu) fail(`${where}: cpu and memory limits required`);
    if (!c.image || /:latest$/.test(c.image) || !/:[^/]+$/.test(c.image))
      fail(`${where}: image needs an explicit, non-latest tag or digest`);
    for (const probe of ['livenessProbe', 'readinessProbe']) {
      const path = c[probe]?.httpGet?.path;
      if (!path) fail(`${where}: ${probe} required`);
      else if (!served.has(path)) fail(`${where}: ${probe} path ${path} is not served by host.ts`);
    }
    const mounts = new Set((c.volumeMounts ?? []).map((m) => m.mountPath));
    for (const p of ['/data', '/tmp'])
      if (!mounts.has(p)) fail(`${where}: needs a writable mount at ${p} (root filesystem is read-only)`);
  }
}

const np = docs.find((d) => d.obj?.kind === 'NetworkPolicy')?.obj;
if (np) {
  if (!np.spec?.policyTypes?.includes('Ingress') || !np.spec?.policyTypes?.includes('Egress'))
    fail('networkpolicy.yaml: must govern Ingress and Egress');
  if ((np.spec?.ingress ?? []).length) fail('networkpolicy.yaml: default ingress must be empty');
}

const dockerfile = readFileSync(join(root, 'deploy/Dockerfile'), 'utf8');
const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
if (!froms.length) fail('Dockerfile: no FROM');
for (const f of froms)
  if (/:latest$/.test(f) || !/[:@]/.test(f)) fail(`Dockerfile: base image ${f} needs a tag or digest`);
const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
if (!users.length || ['root', '0'].includes(users.at(-1))) fail('Dockerfile: final stage must run as a non-root USER');
if (!/--frozen-lockfile/.test(dockerfile)) fail('Dockerfile: install must use --frozen-lockfile');
if (!/CMD \["node", "dist\/host\.js"\]/.test(dockerfile)) fail('Dockerfile: CMD must start dist/host.js');

if (problems.length) {
  for (const p of problems) console.log(`FAIL ${p}`);
  process.exit(1);
}
console.log(`Deployment check passed: ${docs.length} manifests, Dockerfile with ${froms.length} stages.`);
