#!/usr/bin/env node
// Software bill of materials (TASK-030.2, R-16): one CycloneDX 1.5 JSON document per library package, listing every
// production dependency the package installs (transitively, from the lockfile-resolved tree), with version, purl,
// license and the dependency graph. The output is deterministic for a given lockfile (no timestamp, no random
// serial number), so it can be reviewed and diffed.
//
//   node scripts/sbom.mjs [out-dir]   # default: sbom/  (gitignored)
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');

/** Licenses a production dependency may carry without review (permissive, compatible with Apache-2.0). */
export const ALLOWED_LICENSES = new Set([
  'Apache-2.0',
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
]);

/** `pkg:npm` package URL (scoped names percent-encode the `@`). */
export const purl = (name, version) =>
  `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;

function licenseOf(path, fallback) {
  try {
    const j = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    const l = j.license ?? j.licenses?.[0]?.type;
    return typeof l === 'string' ? l : fallback;
  } catch {
    return fallback;
  }
}

/** The CycloneDX document for one library under `packages/<dir>`. */
export function sbomFor(dir) {
  const cwd = join(root, 'packages', dir);
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  // One command string: on Windows the pnpm shim needs a shell, and a shell must not be handed an argument list.
  const r = spawnSync('pnpm list --prod --json --depth Infinity', {
    cwd,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new Error(`pnpm list failed in packages/${dir}:\n${r.stderr}`);
  const tree = JSON.parse(r.stdout)[0];

  const components = new Map();
  const graph = new Map();
  const ref = (name, version) => purl(name, version);
  const self = ref(pkg.name, pkg.version);
  graph.set(self, new Set());

  const walk = (parent, deps) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      const local = String(d.version).startsWith('link:');
      const version = local
        ? JSON.parse(readFileSync(join(d.path, 'package.json'), 'utf8')).version
        : d.version;
      const id = ref(name, version);
      graph.get(parent).add(id);
      if (!components.has(id))
        components.set(id, {
          type: 'library',
          'bom-ref': id,
          name,
          version,
          purl: id,
          licenses: [{ license: { id: licenseOf(d.path, 'NOASSERTION') } }],
          ...(local
            ? { properties: [{ name: 'agentropy:workspace', value: 'true' }] }
            : {}),
        });
      if (!graph.has(id)) graph.set(id, new Set());
      // pnpm lists optional dependencies under their own key; they ship in the image and belong in the SBOM.
      walk(id, d.dependencies);
      walk(id, d.optionalDependencies);
    }
  };
  walk(self, tree.dependencies);
  walk(self, tree.optionalDependencies);

  const sorted = [...components.values()].sort((a, b) =>
    a['bom-ref'].localeCompare(b['bom-ref']),
  );
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      tools: {
        components: [
          { type: 'application', name: 'agentropy scripts/sbom.mjs' },
        ],
      },
      component: {
        type: 'library',
        'bom-ref': self,
        name: pkg.name,
        version: pkg.version,
        purl: self,
        licenses: [{ license: { id: pkg.license } }],
      },
    },
    components: sorted,
    dependencies: [...graph.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, on]) => ({ ref: id, dependsOn: [...on].sort() })),
  };
}

/** Library packages (published ones: everything with `exports` except the examples). */
export const libraries = () =>
  readdirSync(join(root, 'packages')).filter((d) => {
    const j = JSON.parse(
      readFileSync(join(root, 'packages', d, 'package.json'), 'utf8'),
    );
    return d !== 'examples' && j.exports;
  });

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const out = resolve(process.argv[2] ?? join(root, 'sbom'));
  mkdirSync(out, { recursive: true });
  // `examples` is the application layer of the host image (deploy/Dockerfile deploys it with --prod).
  for (const dir of [...libraries(), 'examples']) {
    const bom = sbomFor(dir);
    const file = join(out, `${dir === 'examples' ? 'host-app' : dir}.cdx.json`);
    writeFileSync(file, JSON.stringify(bom, null, 2) + '\n');
    console.log(`${file}: ${bom.components.length} components`);
  }
}
