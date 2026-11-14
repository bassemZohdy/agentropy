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

const text = { type: 'string', minLength: 1 } as const;

/**
 * Input schemas of the built-in operations (Capability v1 revision 15). The runtime validates an invocation's input
 * against its operation's schema before the provider runs, so malformed handler input is a non-retryable
 * `SchemaViolation` instead of a `TypeError` in the provider (which would become a retried `Internal`). They state
 * what the reference providers read; an operation that is absent takes any input.
 */
const OPERATION_INPUTS: Record<string, unknown> = {
  'delegation.delegate': {
    type: 'object',
    required: ['target'],
    properties: {
      target: { type: 'object' },
      deadline: { type: 'string' },
      budget: { type: 'object' },
    },
  },
  'delegation.getTask': {
    type: 'object',
    required: ['taskId'],
    properties: { taskId: text },
  },
  'delegation.cancel': {
    type: 'object',
    required: ['taskId'],
    properties: { taskId: text, reason: { type: 'string' } },
  },
  'event-handling.subscribe': {
    type: 'object',
    required: ['source'],
    properties: { source: text, filter: { type: 'object' } },
  },
  'event-handling.unsubscribe': {
    type: 'object',
    required: ['subscription'],
    properties: { subscription: text },
  },
  'scheduling.nextOccurrence': {
    type: 'object',
    required: ['cron', 'timezone'],
    properties: {
      cron: text,
      timezone: text,
      after: { type: 'string' },
    },
  },
  'reasoning.complete': {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      system: { type: 'string' },
      messages: { type: 'array', items: { type: 'object' } },
      maxTokens: { type: 'integer', minimum: 1 },
      temperature: { type: 'number' },
      tools: { type: 'array', items: { type: 'string' } },
    },
  },
  'tool-use.call': {
    type: 'object',
    required: ['toolId'],
    properties: { toolId: text },
  },
  'workflow.start': {
    type: 'object',
    required: ['workflow'],
    properties: { workflow: text },
  },
  'workflow.status': {
    type: 'object',
    required: ['runId'],
    properties: { runId: text },
  },
};

const op = (
  capability: string,
  name: string,
  effect: OperationEffect,
): OperationContract => ({
  name,
  inputSchema: (OPERATION_INPUTS[`${capability}.${name}`] ?? true) as never,
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
  {
    // N-02: execution isolation the runtime can promise. The local runtime provides `logical` (tenant and
    // app-context separation in one process); process and sandbox isolation need a provider that offers them.
    id: 'isolation',
    version: '1.0.0',
    kind: 'guarantee',
    configSchema: { type: 'object' },
    dependencies: [],
    operations: [],
    levels: ['logical', 'process', 'sandbox'],
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
