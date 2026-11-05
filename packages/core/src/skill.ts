/** Skill v1 (docs/contracts/skill-v1.md). */
import type { Version } from './agent.js';
import type { CapabilityRequirement } from './capability.js';
import type { ToolId } from './tool.js';

export const AGENT_SKILLS_SPEC_VERSION = 'agentskills-2026-11-05';

export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

export interface SkillRequirements {
  capabilities?: CapabilityRequirement[];
  tools?: { id: ToolId; versionRange: string }[];
}

export type SkillStatus = 'registered' | 'active' | 'revoked';

export interface SkillRecord {
  id: string;
  version: Version;
  specVersion: string;
  metadata: SkillMetadata;
  digest: string;
  provenance: { publisher: string; source: string; verified: boolean };
  requires: SkillRequirements;
  files: string[];
  status: SkillStatus;
  revision: number;
}

export interface SkillPin {
  id: string;
  version: Version;
  digest: string;
}

export interface SkillLoader {
  metadata(pin: SkillPin): Promise<SkillMetadata>;
  instructions(pin: SkillPin): Promise<string>;
  resource(pin: SkillPin, relativePath: string): Promise<Uint8Array>;
}

export interface SkillAccess {
  list(): SkillMetadata[];
  instructions(skillId: string): Promise<string>;
  resource(skillId: string, relativePath: string): Promise<Uint8Array>;
}
