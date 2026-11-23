# Agent Skills for Agentropy

**Status:** TASK-039 (2026-11-08). The repository ships five [Agent Skills](https://agentskills.io) in [`skills/`](../plugins/agentropy/skills/) and packages them as a Claude Code plugin. Every skill is a self-contained folder with a `SKILL.md`, so any harness that reads the Agent Skills format can use them.

| Skill                                                                                 | Use it to                                                                                                |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`agentropy-build-agent`](../plugins/agentropy/skills/agentropy-build-agent/SKILL.md) | Write agent handlers, create the app, delegate tasks, add tools, skills and human approval, test offline |
| [`agentropy-deploy`](../plugins/agentropy/skills/agentropy-deploy/SKILL.md)           | Build the host image, configure it, apply the Kubernetes manifests, run the kind live-cluster test       |
| [`agentropy-a2a`](../plugins/agentropy/skills/agentropy-a2a/SKILL.md)                 | Serve agents over A2A 1.0, call remote agents, discover peers by agent card                              |
| [`agentropy-operate`](../plugins/agentropy/skills/agentropy-operate/SKILL.md)         | Read `/readyz`, unstick tasks, quarantine an instance, plan compaction, read telemetry and SLOs          |
| [`agentropy-contribute`](../plugins/agentropy/skills/agentropy-contribute/SKILL.md)   | Work on this repository: checks, contracts, the backlog format, DCO                                      |

The skills summarise the documents under `docs/` and point at them by repository path. For the best results install them where the harness also has the repository checked out.

## Claude Code

As a plugin from this repository's marketplace:

```text
/plugin marketplace add bassemZohdy/agentropy
/plugin install agentropy@agentropy
```

From a local checkout, load it for one session with `claude --plugin-dir /path/to/agentropy/plugins/agentropy`, or check the manifests with `claude plugin validate /path/to/agentropy` (the marketplace) and `claude plugin validate /path/to/agentropy/plugins/agentropy` (the plugin). The plugin is the folder `plugins/agentropy/` (the root `.claude-plugin/marketplace.json` points at it): its `.claude-plugin/plugin.json` names it, and Claude Code finds the `skills/` folder by convention. It is a folder of its own so that a directory submission scans only the plugin, not the whole repository.

Without the plugin system, copy the skills where Claude Code scans for them: `~/.claude/skills/` for all projects, or `.claude/skills/` in one project.

## Other harnesses

The format is the open Agent Skills layout: one folder per skill, a `SKILL.md` with YAML frontmatter (`name` equal to the folder name, `description`, optional `license`, `compatibility`, `metadata`) and Markdown instructions. Nothing in these skills is specific to one harness.

```sh
node scripts/install-skills.mjs <the folder your harness scans for skills>
node scripts/install-skills.mjs ./some/skills --only agentropy-deploy,agentropy-operate
node scripts/install-skills.mjs ./some/skills --force      # replace existing copies
```

Which folder to use is the harness's own convention, so check its documentation. The script copies, it never edits the target's other contents, and it skips a skill that is already there unless `--force` is given.

Harnesses that read an `AGENTS.md` find [`AGENTS.md`](../AGENTS.md) at the repository root. It names the same skills and the commands an agent needs before it changes code.

## Use them from Agentropy itself

Agentropy loads Agent Skills too ([Skill v1](contracts/skill-v1.md)): register a skill folder in an `InMemorySkillRegistry`, activate it, and list it in an agent definition. A test, `packages/runtime/test/project-skills.test.ts`, checks that these five parse with the project's own loader.

## Keeping them true

- `pnpm check` runs the test above. It fails when a skill's name differs from its folder, its frontmatter is invalid, the plugin manifests disagree, or a skill names a repository path that no longer exists.
- A change to behaviour that a skill describes (an environment variable, a readiness answer, a script) belongs in the same commit as the skill edit.
- Skill versions follow the plugin version in `plugins/agentropy/.claude-plugin/plugin.json`. Raise it when a skill changes in a way users should pick up.
