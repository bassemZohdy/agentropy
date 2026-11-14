# Agentropy Skill Contract v1 — revision 2

**Status:** Accepted for M1 implementation (2026-11-05) of registry, metadata-first loading and resolution. Script execution is **not** supported in v1 (`UnsupportedOperation`).
**Decision:** [ADR-0026](../adr/0026-protocol-agnostic-tool-integration.md#agent-skills-standard-alignment-accepted-2026-11-05). **Format:** [Agent Skills specification](https://agentskills.io/specification), validated against the published text of 2026-11-05 (the specification carries no version identifier; Agentropy records `specVersion: "agentskills-2026-11-05"`). **Errors:** [Errors v1](errors-v1.md).

## Revision history

| Rev | Date | Change |
|---|---|---|
| 1 | 2026-11-05 | `SkillRecord`, `SkillPin`, `SkillRegistry`, `SkillLoader`, `SkillAccess`, resolution and loading rules |
| 2 | 2026-11-14 | FEAT-074 (review N-26): the status an operator sets (activate, revoke) is kept in the store when the registry is given one (`new InMemorySkillRegistry(security, verify, { store })`), one row per version in the `lifecycle` collection, so a revoke or suspend reaches every worker on the store at once and survives a restart: the executor (and skill loader) act on the stored status, not on the process's memory; `register` after a restart adopts it (a suspended or revoked version comes back as such) and returns the effective record, so a bootstrap activates only a `registered` version; `revoked` is final; a row names the content digest it was set for and never applies to different content; a stored `active` does not make unverified content usable |

## Boundaries

A Skill is portable instructions and resources in the open format: a directory with a required `SKILL.md` (YAML frontmatter + Markdown body) and optional `scripts/`, `references/` and `assets/`. Agentropy never rewrites `SKILL.md` and invents no extra file format. A Skill **grants nothing**: it cannot add capabilities, make tools visible, approve tools listed in its `allowed-tools` field, or execute scripts. Dependencies are declared in **platform metadata** supplied at registration, not trusted from Skill text.

## TypeScript contract (normative)

```ts
/** Standard frontmatter, parsed verbatim. */
export interface SkillMetadata {
  name: string;                  // 1-64, [a-z0-9-], no leading/trailing/double hyphen, equals directory name
  description: string;           // 1-1024
  license?: string;
  compatibility?: string;        // 1-500
  metadata?: Record<string, string>;
  allowedTools?: string[];       // from "allowed-tools"; informational request only, never a grant
}

export interface SkillRequirements {      // platform metadata, supplied by the registering administrator
  capabilities?: CapabilityRequirement[];
  tools?: { id: ToolId; versionRange: string }[];
}

export type SkillStatus = "registered" | "active" | "revoked";

export interface SkillRecord {
  id: string;                    // registry identity; defaults to metadata.name
  version: Version;              // registry SemVer, immutable
  specVersion: string;           // "agentskills-2026-11-05"
  metadata: SkillMetadata;
  digest: string;                // sha256 over every file path + content in the skill directory
  provenance: { publisher: string; source: string; verified: boolean };
  requires: SkillRequirements;
  files: string[];               // relative paths, sorted; SKILL.md first
  status: SkillStatus;
  revision: number;
}

export interface SkillPin { id: string; version: Version; digest: string; }

export interface SkillRegistry {
  register(source: SkillSource, opts: { id?: string; version: Version; requires?: SkillRequirements; publisher: string }, admin: TrustedPrincipal): Promise<SkillRecord>;
  activate(ref: VersionedRef, admin: TrustedPrincipal): Promise<SkillRecord>;
  revoke(ref: VersionedRef, admin: TrustedPrincipal): Promise<SkillRecord>;
  get(ref: VersionedRef): SkillRecord | undefined;
  discover(query: { text?: string }, caller: TrustedPrincipal): Promise<Pick<SkillRecord, "id" | "version" | "metadata">[]>;
}

/** Progressive disclosure: metadata → instructions → resources. Never executes anything. */
export interface SkillLoader {
  metadata(pin: SkillPin): Promise<SkillMetadata>;
  instructions(pin: SkillPin): Promise<string>;             // SKILL.md body after frontmatter
  resource(pin: SkillPin, relativePath: string): Promise<Uint8Array>;
}

/** Read-only handler accessor (AgentContext.skills), limited to the task's pinned skills. */
export interface SkillAccess {
  list(): SkillMetadata[];                                   // pinned skills' metadata only
  instructions(skillId: string): Promise<string>;
  resource(skillId: string, relativePath: string): Promise<Uint8Array>;
}
```

`SkillSource` is an adapter input (M1: a local directory read by a filesystem source). Remote distribution is deferred.

## Validation at registration

`SKILL.md` must exist and start with a frontmatter block; `name`/`description` must satisfy the specification constraints; `name` must equal the directory name; unknown frontmatter keys are kept out of `SkillMetadata` but do not fail registration. Violations → `SchemaViolation`. Same `id@version` with the same digest is a no-op; different digest → `InvalidConfiguration`. Registration, activation and revocation are protected administrative operations (`skill-admin:<operation>`), audited; an unverified skill cannot be activated (`PermissionDenied`).

## Resolution at task acceptance

For each `SkillSelection`: highest `active` version in range (none → `CapabilityUnavailable`, details `{ kind: "skill" }`); then every `requires.capabilities` entry must be in the effective capability set and every `requires.tools` entry must be among the task's resolved tool pins, otherwise `CapabilityUnavailable` (`reason: "dependency"`). Dependencies are **checked, never granted**. Failing optional selections are omitted and recorded in `AcceptanceSnapshot.omitted`; failing required selections reject acceptance.

## Loading rules

- Loading verifies the stored digest still matches the content; mismatch → `IncompatibleVersion` (content changed after pinning).
- Resource paths are relative to the skill root; absolute paths, `..` segments or symlink escapes → `PermissionDenied`; a missing file → `NotFound`.
- Revoked skills fail loading with `PermissionDenied`, even for already-pinned tasks.
- Executing `scripts/*` is outside v1 → `UnsupportedOperation`. A later revision may route scripts through an authorized, sandboxed tool binding.

## Conformance checks

Official-format fixture registers without conversion; invalid names/descriptions rejected; metadata-first listing does not read the body; lazy instructions/resources; pinned version and digest per task; content tampering detected; path traversal denied; missing required skill and missing dependency fail typed; optional skill omitted; `allowed-tools` does not make a tool visible or callable; script execution unsupported.
