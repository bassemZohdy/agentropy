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
const served = new Set(
  [...host.matchAll(/req\.url === '([^']+)'/g)].map((m) => m[1]),
);

const dir = join(root, 'deploy/kubernetes');
const docs = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
  for (const d of YAML.parseAllDocuments(
    readFileSync(join(dir, file), 'utf8'),
  )) {
    if (d.errors.length) fail(`${file}: ${d.errors[0].message}`);
    else docs.push({ file, obj: d.toJS() });
  }
}

// The PostgreSQL variant (FEAT-041.4): a Deployment overlay that replaces the StatefulSet, held to the same pod rules.
const pgDir = join(root, 'deploy/kubernetes-postgres');
const pgDocs = [];
for (const file of readdirSync(pgDir).filter((f) => f.endsWith('.yaml'))) {
  for (const d of YAML.parseAllDocuments(
    readFileSync(join(pgDir, file), 'utf8'),
  )) {
    if (d.errors.length)
      fail(`kubernetes-postgres/${file}: ${d.errors[0].message}`);
    else pgDocs.push({ file: `kubernetes-postgres/${file}`, obj: d.toJS() });
  }
}
const pgKustomization = pgDocs.find(
  (d) => d.obj?.kind === 'Kustomization',
)?.obj;
if (!pgKustomization?.resources?.includes('deployment.yaml'))
  fail('kubernetes-postgres/kustomization.yaml: must list deployment.yaml');
if (!pgKustomization?.resources?.includes('../kubernetes'))
  fail(
    'kubernetes-postgres/kustomization.yaml: must build on the base (../kubernetes)',
  );
if (!JSON.stringify(pgKustomization?.patches ?? []).includes('$patch: delete'))
  fail(
    'kubernetes-postgres/kustomization.yaml: must delete the SQLite StatefulSet',
  );
const pgDeployment = pgDocs.find((d) => d.obj?.kind === 'Deployment')?.obj;
if (!pgDeployment) fail('kubernetes-postgres: no Deployment');
else if (!(pgDeployment.spec?.replicas > 1))
  fail(
    'kubernetes-postgres/deployment.yaml: the variant exists for several replicas',
  );
else if (
  !pgDeployment.spec.template.spec.containers.some((c) =>
    (c.env ?? []).some(
      (e) => e.name === 'AGENTROPY_PG_URL' && e.valueFrom?.secretKeyRef,
    ),
  )
)
  fail(
    'kubernetes-postgres/deployment.yaml: AGENTROPY_PG_URL must come from a Secret',
  );

// TASK-076: voluntary disruptions (a node drain) must leave a replica serving.
const pdb = pgDocs.find((d) => d.obj?.kind === 'PodDisruptionBudget');
if (!pdb) fail('kubernetes-postgres: no PodDisruptionBudget');
else {
  if (!pgKustomization?.resources?.includes('poddisruptionbudget.yaml'))
    fail(
      'kubernetes-postgres/kustomization.yaml: must list poddisruptionbudget.yaml',
    );
  const s = pdb.obj.spec ?? {};
  if (s.minAvailable === undefined && s.maxUnavailable === undefined)
    fail(`${pdb.file}: set minAvailable or maxUnavailable`);
  if (s.minAvailable !== undefined && !(Number(s.minAvailable) >= 1))
    fail(`${pdb.file}: minAvailable must keep at least one replica`);
  const want = pgDeployment?.spec?.selector?.matchLabels ?? {};
  const have = s.selector?.matchLabels ?? {};
  if (
    !Object.keys(want).length ||
    Object.entries(want).some(([k, v]) => have[k] !== v)
  )
    fail(`${pdb.file}: selector must match the Deployment's pods`);
}

const kinds = new Set(docs.map((d) => d.obj?.kind));
for (const k of [
  'StatefulSet',
  'NetworkPolicy',
  'ConfigMap',
  'Kustomization',
  'Service',
])
  if (!kinds.has(k)) fail(`deploy/kubernetes: no ${k}`);

const kustomization = docs.find((d) => d.obj?.kind === 'Kustomization')?.obj;
for (const d of docs)
  if (
    d.obj?.kind !== 'Kustomization' &&
    !kustomization?.resources?.includes(d.file)
  )
    fail(`${d.file}: not listed in kustomization.yaml`);

for (const { file, obj } of [...docs, ...pgDocs]) {
  const pod = obj?.spec?.template?.spec;
  if (!pod) continue;
  if (pod.securityContext?.runAsNonRoot !== true)
    fail(`${file}: pod runAsNonRoot must be true`);
  if (pod.securityContext?.seccompProfile?.type !== 'RuntimeDefault')
    fail(`${file}: seccompProfile RuntimeDefault required`);
  if (pod.automountServiceAccountToken !== false)
    fail(
      `${file}: automountServiceAccountToken must be false (the runtime needs no API access)`,
    );
  if (pod.securityContext?.runAsUser !== undefined)
    fail(`${file}: do not pin runAsUser (OpenShift assigns UIDs)`);
  for (const c of pod.containers ?? []) {
    const where = `${file}: container ${c.name}`;
    const sc = c.securityContext ?? {};
    if (sc.allowPrivilegeEscalation !== false)
      fail(`${where}: allowPrivilegeEscalation must be false`);
    if (sc.readOnlyRootFilesystem !== true)
      fail(`${where}: readOnlyRootFilesystem must be true`);
    if (!sc.capabilities?.drop?.includes('ALL'))
      fail(`${where}: capabilities must drop ALL`);
    if (sc.runAsUser !== undefined) fail(`${where}: do not pin runAsUser`);
    if (!c.resources?.limits?.memory || !c.resources?.limits?.cpu)
      fail(`${where}: cpu and memory limits required`);
    if (!c.image || /:latest$/.test(c.image) || !/:[^/]+$/.test(c.image))
      fail(`${where}: image needs an explicit, non-latest tag or digest`);
    // TASK-076: a start that migrates the schema or opens a large store must not be killed by the liveness probe.
    for (const probe of ['startupProbe', 'livenessProbe', 'readinessProbe']) {
      const path = c[probe]?.httpGet?.path;
      if (!path) fail(`${where}: ${probe} required`);
      else if (!served.has(path))
        fail(`${where}: ${probe} path ${path} is not served by host.ts`);
    }
    const mounts = new Set((c.volumeMounts ?? []).map((m) => m.mountPath));
    // Only the SQLite StatefulSet keeps state on a volume; the PostgreSQL variant needs scratch space alone.
    for (const p of obj.kind === 'StatefulSet' ? ['/data', '/tmp'] : ['/tmp'])
      if (!mounts.has(p))
        fail(
          `${where}: needs a writable mount at ${p} (root filesystem is read-only)`,
        );
  }
}

const policies = docs.filter((d) => d.obj?.kind === 'NetworkPolicy');
const np = policies.find((d) => d.obj.metadata?.name === 'agentropy')?.obj;
if (!np)
  fail('deploy/kubernetes: no default-deny NetworkPolicy named agentropy');
else {
  if (
    !np.spec?.policyTypes?.includes('Ingress') ||
    !np.spec?.policyTypes?.includes('Egress')
  )
    fail('networkpolicy.yaml: must govern Ingress and Egress');
  if ((np.spec?.ingress ?? []).length)
    fail('networkpolicy.yaml: default ingress must be empty');
}
// Additional policies may only open named ports to named sources (never allow-all ingress).
for (const { file, obj } of policies.filter(
  (d) => d.obj.metadata?.name !== 'agentropy',
))
  for (const rule of obj.spec?.ingress ?? [])
    if (!rule.from?.length || !rule.ports?.length)
      fail(`${file}: ingress rules need explicit sources (from) and ports`);
const svc = docs.find((d) => d.obj?.kind === 'Service')?.obj;
if (svc && !svc.spec?.ports?.some((p) => p.targetPort === 'health'))
  fail('service.yaml: must target the container port named health');

// TASK-077: workflow hygiene. A stuck job must not hold a runner for the default six hours, a superseded run of the
// same ref should not go on, and the offline suite runs on the Node version the image ships.
const workflows = join(root, '.github/workflows');
for (const file of readdirSync(workflows).filter((f) => f.endsWith('.yml'))) {
  const wf = YAML.parse(readFileSync(join(workflows, file), 'utf8'));
  for (const [name, job] of Object.entries(wf.jobs ?? {})) {
    const minutes = job['timeout-minutes'];
    if (!(Number.isInteger(minutes) && minutes > 0 && minutes <= 60))
      fail(`${file}: job ${name} needs timeout-minutes (1 to 60)`);
  }
}
const ciYaml = YAML.parse(readFileSync(join(workflows, 'ci.yml'), 'utf8'));
if (!String(ciYaml.concurrency?.group ?? '').includes('github.ref'))
  fail(
    'ci.yml: needs a concurrency group per ref, so a superseded run is cancelled',
  );
if (!ciYaml.concurrency?.['cancel-in-progress'])
  fail('ci.yml: concurrency must cancel in-progress runs (of branches)');
const imageNode = /^FROM node:(\d+)/m.exec(
  readFileSync(join(root, 'deploy/Dockerfile'), 'utf8'),
)?.[1];
const onImageNode = Object.values(ciYaml.jobs ?? {}).some((job) =>
  (job.steps ?? []).some(
    (s) => String(s.with?.['node-version'] ?? '').split('.')[0] === imageNode,
  ),
);
if (!imageNode) fail('Dockerfile: cannot read the Node major of the image');
else if (!onImageNode)
  fail(`ci.yml: no job runs on Node ${imageNode}, the image's runtime`);

const dockerfile = readFileSync(join(root, 'deploy/Dockerfile'), 'utf8');
const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
if (!froms.length) fail('Dockerfile: no FROM');
for (const f of froms)
  if (!/@sha256:[0-9a-f]{64}$/.test(f))
    fail(`Dockerfile: base image ${f} must be pinned by digest (TASK-030.1)`);
const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
if (!users.length || ['root', '0'].includes(users.at(-1)))
  fail('Dockerfile: final stage must run as a non-root USER');
if (!/--frozen-lockfile/.test(dockerfile))
  fail('Dockerfile: install must use --frozen-lockfile');
// TASK-041: Node 25 and newer images do not ship corepack (`corepack enable` exits 127), so the image installs the
// pnpm that package.json pins by itself.
if (/\bcorepack\b/.test(dockerfile))
  fail(
    'Dockerfile: do not use corepack, Node 25+ images do not ship it (TASK-041)',
  );
const pnpmPin = /^pnpm@(\d+\.\d+\.\d+)$/.exec(
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager ??
    '',
)?.[1];
if (!pnpmPin)
  fail('package.json: packageManager must pin pnpm@<major.minor.patch>');
else if (
  !new RegExp(
    `npm install --global pnpm@${pnpmPin.replaceAll('.', '\\.')}(\\s|$)`,
  ).test(dockerfile)
)
  fail(
    `Dockerfile: install the pinned pnpm with "npm install --global pnpm@${pnpmPin}" (TASK-041)`,
  );

// TASK-030.1 (R-15): third-party actions and service images pinned immutably; update automation configured.
const wfDir = join(root, '.github/workflows');
for (const file of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(join(wfDir, file), 'utf8');
  const parsed = YAML.parseDocument(text); // TASK-043.1: a workflow that does not parse never runs
  if (parsed.errors.length)
    fail(`${file}: ${parsed.errors[0].message.split('\n')[0]}`);
  for (const m of text.matchAll(/^[ \t]*-?[ \t]*uses:[ \t]*(\S+)/gm))
    if (!m[1].startsWith('./') && !/@[0-9a-f]{40}$/.test(m[1]))
      fail(`${file}: action ${m[1]} must be pinned by commit SHA`);
  for (const m of text.matchAll(/^[ \t]+image:[ \t]*([^\s#]+)/gm))
    if (!/@sha256:[0-9a-f]{64}$/.test(m[1]))
      fail(`${file}: service image ${m[1]} must be pinned by digest`);
}
// FEAT-036 (R-14): the manifests are applied to a live kind cluster in CI, with rollout and pod loss exercised.
const ci = readFileSync(join(wfDir, 'ci.yml'), 'utf8');
if (!/bash deploy\/kind-smoke\.sh/.test(ci))
  fail(
    'ci.yml: the kind live-cluster job (bash deploy/kind-smoke.sh) is missing',
  );
let kindSmoke = '';
try {
  kindSmoke = readFileSync(join(root, 'deploy/kind-smoke.sh'), 'utf8');
} catch {
  fail('deploy/kind-smoke.sh missing');
}
for (const needle of [
  'kubectl kustomize',
  'rollout restart',
  'delete pod',
  'a2a-smoke.sh',
])
  if (!kindSmoke.includes(needle))
    fail(`deploy/kind-smoke.sh must exercise: ${needle}`);
// FEAT-044.4: the Python-SDK interop test has its own CI job, with the virtualenv created by the test itself.
if (
  !ci.includes(
    'AGENTROPY_A2A_PY=auto pnpm exec vitest run packages/testkit/test/a2a-interop-second.test.ts',
  )
)
  fail(
    'ci.yml: the Python A2A interop job (AGENTROPY_A2A_PY=auto ... a2a-interop-second.test.ts) is missing',
  );
// FEAT-042 (R-12): the live model API suite runs in CI only where the key exists: the key comes from a secret into the
// job's environment, the step is gated on it, and pull requests (which a fork controls) never run it.
if (!/providers-live\.test\.ts/.test(ci))
  fail('ci.yml: the live model API job (providers-live.test.ts) is missing');
else {
  if (
    !/AGENTROPY_LLM_API_KEY:\s*\$\{\{\s*secrets\.AGENTROPY_LLM_API_KEY\s*\}\}/.test(
      ci,
    )
  )
    fail(
      'ci.yml: the live model API job must take AGENTROPY_LLM_API_KEY from secrets.AGENTROPY_LLM_API_KEY',
    );
  if (!/if:\s*env\.AGENTROPY_LLM_API_KEY\s*!=\s*''/.test(ci))
    fail(
      "ci.yml: the live model API step must be gated on if: env.AGENTROPY_LLM_API_KEY != ''",
    );
  if (!/github\.event_name\s*!=\s*'pull_request'/.test(ci))
    fail('ci.yml: the live model API job must not run for pull requests');
}
if (!/pnpm audit --prod/.test(ci))
  fail('ci.yml: production dependency audit (pnpm audit --prod) missing');
let dependabot = '';
try {
  dependabot = readFileSync(join(root, '.github/dependabot.yml'), 'utf8');
} catch {
  fail('.github/dependabot.yml missing');
}
for (const eco of ['npm', 'github-actions', 'docker'])
  if (
    dependabot &&
    !new RegExp(`package-ecosystem:\\s*${eco}\\b`).test(dependabot)
  )
    fail(`.github/dependabot.yml: no ${eco} updates`);
if (!/CMD \["node", "dist\/host\.js"\]/.test(dockerfile))
  fail('Dockerfile: CMD must start dist/host.js');

// TASK-043.1 (R-17, docs/release.md): the tag-driven release workflow. Every action in it is already held to the SHA
// pin above; this holds the accepted decisions: verify first, trusted publishing with provenance under the `next`
// tag and no long-lived npm token, a digest-addressed signed image on GHCR without a `latest` tag, and a GitHub release.
let release = '';
try {
  release = readFileSync(join(wfDir, 'release.yml'), 'utf8');
} catch {
  fail('.github/workflows/release.yml missing');
}
if (release) {
  const need = [
    [/^\s{2}push:\s*\n\s{4}tags:/m, 'trigger on a pushed version tag'],
    [/pnpm check\b/, 'run pnpm check before publishing'],
    [
      /node scripts\/check-pack\.mjs/,
      'run scripts/check-pack.mjs before publishing',
    ],
    [/pnpm audit --prod/, 'audit production dependencies before publishing'],
    [
      /id-token:\s*write/,
      'request an OIDC token (trusted publishing, keyless signing)',
    ],
    [
      /pnpm -r publish\b[^\n]*--provenance\b[^\n]*--tag next\b/,
      'publish with --provenance under the next dist-tag',
    ],
    [/ghcr\.io\//, 'publish the image to ghcr.io'],
    [/cosign sign\b/, 'sign the image digest with cosign'],
    [
      /cosign attest\b[^\n]*--type cyclonedx/,
      'attach the SBOM as a cyclonedx attestation',
    ],
    [/gh release create\b/, 'create the GitHub release'],
  ];
  for (const [re, what] of need)
    if (!re.test(release)) fail(`release.yml: must ${what}`);
  if (/NPM_TOKEN|NODE_AUTH_TOKEN/.test(release))
    fail('release.yml: no long-lived npm token, use trusted publishing');
  if (/:latest\b/.test(release))
    fail('release.yml: never tag the image latest');
}

if (problems.length) {
  for (const p of problems) console.log(`FAIL ${p}`);
  process.exit(1);
}
console.log(
  `Deployment check passed: ${docs.length} manifests, Dockerfile with ${froms.length} stages.`,
);
