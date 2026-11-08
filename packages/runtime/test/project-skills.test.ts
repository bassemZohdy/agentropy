// TASK-039: the Agent Skills this repository ships (skills/) and the plugin manifests that package them are valid.
// The skills are checked with Agentropy's own loader (parseSkillMd, digestSkillDirectory), so a skill the project
// publishes is one the project could load. Paths a skill mentions must exist in the repository.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { digestSkillDirectory, parseSkillMd } from '../src/skills.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const skillsDir = join(root, 'skills');
const names = readdirSync(skillsDir).filter((n) =>
  statSync(join(skillsDir, n)).isDirectory(),
);
const json = (rel: string) =>
  JSON.parse(readFileSync(join(root, rel), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('project skills', () => {
  it('ships the five skills', () => {
    expect(names.sort()).toEqual([
      'agentropy-a2a',
      'agentropy-build-agent',
      'agentropy-contribute',
      'agentropy-deploy',
      'agentropy-operate',
    ]);
  });

  describe.each(names)('%s', (name) => {
    const dir = join(skillsDir, name);
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');

    it('is valid Agent Skills metadata whose name is its folder', () => {
      const { metadata, body } = parseSkillMd(text);
      expect(metadata.name).toBe(name);
      expect(metadata.description.length).toBeGreaterThan(80);
      expect(metadata.license).toBe('Apache-2.0');
      expect(body.trim().length).toBeGreaterThan(500);
    });

    it('can be hashed as a registrable skill folder', async () => {
      const digest = await digestSkillDirectory(dir);
      expect(JSON.stringify(digest)).toMatch(/[0-9a-f]{16,}/);
    });

    it('only mentions repository paths that exist', () => {
      const mentioned = new Set(
        [
          ...text.matchAll(
            /`((?:docs|deploy|scripts|packages|\.github|\.todo)\/[A-Za-z0-9_./-]+)`/g,
          ),
        ].map((m) => m[1]!),
      );
      const missing = [...mentioned].filter(
        (p) => !existsSync(join(root, p.replace(/\/+$/, ''))),
      );
      expect(missing).toEqual([]);
    });
  });
});

describe('plugin manifests', () => {
  const plugin = json('.claude-plugin/plugin.json');
  const market = json('.claude-plugin/marketplace.json');

  it('describe one plugin whose name the marketplace lists', () => {
    expect(plugin['name']).toBe('agentropy');
    expect(plugin['license']).toBe('Apache-2.0');
    expect(String(plugin['version'])).toMatch(/^\d+\.\d+\.\d+$/);
    const listed = market['plugins'] as { name: string; source: string }[];
    expect(listed.map((p) => p.name)).toEqual(['agentropy']);
    expect(listed[0]!.source).toBe('./');
  });

  it('use the conventional skills/ folder, which exists', () => {
    // Claude Code discovers skills/ at the plugin root; no custom path may point elsewhere.
    expect(plugin['skills']).toBeUndefined();
    expect(existsSync(skillsDir)).toBe(true);
  });
});
