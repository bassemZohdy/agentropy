/** Canonical capability catalog and built-in profiles (Capability v1 revision 6). */
import type { DurabilityLevel } from './agent.js';
import type {
  AgentProfile,
  CapabilityContract,
  OperationContract,
  OperationEffect,
} from './capability.js';

export const DURABILITY_LEVELS: readonly DurabilityLevel[] = [
  'none',
  'durable-acceptance',
  'durable-execution',
];

export function durabilityRank(level: string): number {
  return DURABILITY_LEVELS.indexOf(level as DurabilityLevel);
}

const op = (
  capability: string,
  name: string,
  effect: OperationEffect,
): OperationContract => ({
  name,
  inputSchema: true,
  permission: `${capability}:${name}`,
  effect,
});

const behavior = (
  id: string,
  ops: [string, OperationEffect][],
): CapabilityContract => ({
  id,
  version: '1.0.0',
  kind: 'behavior',
  configSchema: { type: 'object' },
  dependencies: [],
  operations: ops.map(([name, effect]) => op(id, name, effect)),
});

export const CAPABILITY_CATALOG: readonly CapabilityContract[] = [
  behavior('conversation', [
    ['reply', 'internal'],
    ['briefing', 'read'],
  ]),
  behavior('session-context', [
    ['get', 'read'],
    ['put', 'internal'],
  ]),
  behavior('delegation', [
    ['delegate', 'external'],
    ['getTask', 'read'],
    ['cancel', 'external'],
  ]),
  behavior('notification', [['notify', 'external']]),
  behavior('event-handling', [
    ['subscribe', 'internal'],
    ['unsubscribe', 'internal'],
  ]),
  behavior('scheduling', [['nextOccurrence', 'read']]),
  behavior('human-input', [['requestAction', 'external']]),
  behavior('tool-use', [
    ['listTools', 'read'],
    ['call', 'external'],
  ]),
  behavior('reasoning', [
    ['complete', 'read'],
    ['plan', 'read'],
  ]),
  behavior('memory', [
    ['recall', 'read'],
    ['remember', 'internal'],
  ]),
  behavior('workflow', [
    ['start', 'external'],
    ['status', 'read'],
  ]),
  {
    id: 'durability',
    version: '1.0.0',
    kind: 'guarantee',
    configSchema: { type: 'object' },
    dependencies: [],
    operations: [],
    levels: [...DURABILITY_LEVELS],
  },
];

export const CAPABILITY_IDS = CAPABILITY_CATALOG.map((c) => c.id);

const sel = (id: string, level?: string) => ({
  id,
  versionRange: '^1.0.0',
  ...(level ? { level } : {}),
});
const req = (id: string) => ({ id, versionRange: '^1.0.0' });

export const BUILTIN_PROFILES: readonly AgentProfile[] = [
  {
    id: 'conversational',
    version: '1.0.0',
    required: [sel('conversation'), sel('session-context')],
    defaults: [sel('delegation'), sel('durability', 'durable-acceptance')],
    optional: [req('memory'), req('tool-use'), req('reasoning')],
  },
  {
    id: 'task',
    version: '1.0.0',
    required: [sel('durability', 'durable-execution')],
    defaults: [sel('notification')],
    optional: [
      'scheduling',
      'event-handling',
      'workflow',
      'reasoning',
      'human-input',
      'tool-use',
      'delegation',
    ].map(req),
  },
  {
    id: 'monitoring',
    version: '1.0.0',
    required: [sel('event-handling'), sel('durability', 'durable-execution')],
    defaults: [sel('scheduling'), sel('notification')],
    optional: [req('delegation'), req('reasoning')],
  },
  {
    id: 'coordinator',
    version: '1.0.0',
    required: [sel('delegation'), sel('durability', 'durable-execution')],
    defaults: [sel('notification')],
    optional: [req('conversation'), req('workflow'), req('reasoning')],
  },
  {
    id: 'specialist',
    version: '1.0.0',
    required: [],
    defaults: [sel('tool-use')],
    optional: [
      req('reasoning'),
      req('memory'),
      req('conversation'),
      req('durability'),
    ],
  },
  {
    id: 'generic',
    version: '1.0.0',
    required: [],
    defaults: [],
    optional: CAPABILITY_CATALOG.map((c) => req(c.id)),
  },
];
