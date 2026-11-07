/** JSON Schema 2020-12 documents for Agent v1 rev 7, Tool v1 and Skill v1, plus validation (ADR-0027). */
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import semver from 'semver';
import type { AgentDefinition, JsonSchema } from './agent.js';
import type { AgentMessage } from './communication.js';
import { AgentropyError } from './errors.js';
import type { SkillMetadata } from './skill.js';
import type { ToolBinding, ToolDescriptor } from './tool.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

const SEMVER =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$';
const ID = '^[a-z0-9][a-z0-9._/-]{0,127}$';

const nonEmpty = { type: 'string', minLength: 1 } as const;
const versionedRef = {
  type: 'object',
  required: ['id', 'version'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: ID },
    version: { type: 'string', pattern: SEMVER },
  },
} as const;
const jsonSchemaDoc = { type: ['object', 'boolean'] } as const;

export const CAPABILITY_SELECTION_SCHEMA = {
  $id: 'https://agentropy.dev/schemas/v1/capability-selection.json',
  type: 'object',
  required: ['id', 'versionRange'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: ID },
    versionRange: nonEmpty,
    config: { type: 'object' },
    providerId: nonEmpty,
    level: nonEmpty,
    remove: { type: 'boolean' },
  },
} as const;

export const TOOL_SELECTION_SCHEMA = {
  $id: 'https://agentropy.dev/schemas/v1/tool-selection.json',
  type: 'object',
  required: ['id', 'versionRange'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: ID },
    versionRange: nonEmpty,
    required: { type: 'boolean' },
    bindingId: nonEmpty,
  },
} as const;

export const SKILL_SELECTION_SCHEMA = {
  $id: 'https://agentropy.dev/schemas/v1/skill-selection.json',
  type: 'object',
  required: ['id', 'versionRange'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: ID },
    versionRange: nonEmpty,
    required: { type: 'boolean' },
  },
} as const;

export const AGENT_DEFINITION_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://agentropy.dev/schemas/v1/agent-definition.json',
  title: 'AgentDefinition (Agent v1 revision 7)',
  type: 'object',
  required: [
    'id',
    'version',
    'displayName',
    'profile',
    'implementation',
    'inputSchema',
    'runtimeRequirements',
    'policyRef',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: ID },
    version: { type: 'string', pattern: SEMVER },
    displayName: { type: 'string', minLength: 1, maxLength: 200 },
    profile: versionedRef,
    implementation: {
      type: 'object',
      required: ['providerId', 'providerVersion', 'artifact'],
      additionalProperties: false,
      properties: {
        providerId: { type: 'string', pattern: ID },
        providerVersion: { type: 'string', pattern: SEMVER },
        artifact: versionedRef,
      },
    },
    inputSchema: jsonSchemaDoc,
    runtimeRequirements: {
      type: 'object',
      required: ['guarantees'],
      additionalProperties: false,
      properties: {
        guarantees: {
          type: 'array',
          items: { $ref: 'capability-selection.json' },
        },
      },
    },
    policyRef: versionedRef,
    description: { type: 'string', maxLength: 4000 },
    capabilities: {
      type: 'array',
      items: { $ref: 'capability-selection.json' },
    },
    skills: { type: 'array', items: { $ref: 'skill-selection.json' } },
    tools: { type: 'array', items: { $ref: 'tool-selection.json' } },
    outputSchema: jsonSchemaDoc,
    modelRef: versionedRef,
    memoryRef: versionedRef,
    communicationRef: versionedRef,
    retryPolicy: {
      type: 'object',
      required: ['maxAttempts', 'backoff'],
      additionalProperties: false,
      properties: {
        maxAttempts: { type: 'integer', minimum: 1, maximum: 100 },
        backoff: {
          type: 'object',
          required: ['initialMs', 'maxMs', 'multiplier'],
          additionalProperties: false,
          properties: {
            initialMs: { type: 'integer', minimum: 0 },
            maxMs: { type: 'integer', minimum: 0 },
            multiplier: { type: 'number', minimum: 1 },
          },
        },
      },
    },
  },
} as const;

export const TOOL_DESCRIPTOR_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://agentropy.dev/schemas/v1/tool-descriptor.json',
  type: 'object',
  required: [
    'id',
    'version',
    'description',
    'inputSchema',
    'effect',
    'idempotency',
    'permission',
  ],
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      pattern: '^[a-z0-9]+(?:[._-][a-z0-9]+)*$',
      maxLength: 128,
    },
    version: { type: 'string', pattern: SEMVER },
    description: { type: 'string', minLength: 1, maxLength: 2000 },
    inputSchema: jsonSchemaDoc,
    outputSchema: jsonSchemaDoc,
    effect: { enum: ['read', 'internal', 'external'] },
    idempotency: { enum: ['idempotent', 'keyed', 'at-least-once'] },
    permission: nonEmpty,
  },
} as const;

export const TOOL_BINDING_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://agentropy.dev/schemas/v1/tool-binding.json',
  type: 'object',
  required: [
    'bindingId',
    'toolId',
    'toolVersion',
    'providerId',
    'providerVersion',
    'config',
  ],
  additionalProperties: false,
  properties: {
    bindingId: nonEmpty,
    toolId: nonEmpty,
    toolVersion: { type: 'string', pattern: SEMVER },
    providerId: nonEmpty,
    providerVersion: { type: 'string', pattern: SEMVER },
    config: { type: 'object' },
    credentialRef: nonEmpty,
    default: { type: 'boolean' },
  },
} as const;

/** Agent Skills specification frontmatter (agentskills.io, 2026-11-05). */
export const SKILL_METADATA_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://agentropy.dev/schemas/v1/skill-metadata.json',
  type: 'object',
  required: ['name', 'description'],
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    },
    description: { type: 'string', minLength: 1, maxLength: 1024 },
    license: { type: 'string' },
    compatibility: { type: 'string', minLength: 1, maxLength: 500 },
    metadata: { type: 'object', additionalProperties: { type: 'string' } },
    allowedTools: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
} as const;

const contractAjv = addFormats(
  new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }),
);
contractAjv
  .addSchema(CAPABILITY_SELECTION_SCHEMA)
  .addSchema(TOOL_SELECTION_SCHEMA)
  .addSchema(SKILL_SELECTION_SCHEMA);
const validators = {
  agentDefinition: contractAjv.compile(AGENT_DEFINITION_SCHEMA),
  toolDescriptor: contractAjv.compile(TOOL_DESCRIPTOR_SCHEMA),
  toolBinding: contractAjv.compile(TOOL_BINDING_SCHEMA),
  skillMetadata: contractAjv.compile(SKILL_METADATA_SCHEMA),
};

/** Separate, non-strict instance for user-supplied schemas (inputSchema, outputSchema, tool and config schemas). */
const userAjv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
const userCache = new WeakMap<object, ValidateFunction>();

const formatErrors = (errors: ErrorObject[] | null | undefined): string[] =>
  (errors ?? [])
    .slice(0, 10)
    .map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`);

function schemaViolation(
  what: string,
  errors: string[],
  reason?: string,
): AgentropyError {
  return new AgentropyError(
    'SchemaViolation',
    `${what} does not match its schema`,
    { details: { what, errors, ...(reason ? { reason } : {}) } },
  );
}

/** Compile a user-supplied JSON Schema; an invalid schema is a configuration error, not a data error. */
export function compileUserSchema(
  schema: JsonSchema,
  what = 'schema',
): ValidateFunction {
  if (typeof schema === 'boolean') return userAjv.compile(schema);
  const cached = userCache.get(schema);
  if (cached) return cached;
  try {
    const fn = userAjv.compile(schema);
    userCache.set(schema, fn);
    return fn;
  } catch (cause) {
    throw new AgentropyError(
      'InvalidConfiguration',
      `${what} is not a valid JSON Schema 2020-12 document`,
      { details: { what }, cause },
    );
  }
}

/** Validate a value against a user-supplied schema; throws SchemaViolation. */
export function validateAgainst(
  schema: JsonSchema,
  value: unknown,
  what: string,
): void {
  const fn = compileUserSchema(schema, what);
  if (!fn(value)) throw schemaViolation(what, formatErrors(fn.errors));
}

function selectionsSemantics(
  kind: string,
  items: { id: string; versionRange: string }[] | undefined,
  errors: string[],
): void {
  const seen = new Set<string>();
  for (const [i, s] of (items ?? []).entries()) {
    if (semver.validRange(s.versionRange) === null)
      errors.push(`/${kind}/${i}/versionRange is not a valid SemVer range`);
    if (seen.has(s.id)) errors.push(`/${kind}/${i} duplicates ${s.id}`);
    seen.add(s.id);
  }
}

/** Structural + semantic validation of an AgentDefinition. Returns the typed value or throws SchemaViolation/InvalidConfiguration. */
export function validateAgentDefinition(value: unknown): AgentDefinition {
  if (!validators.agentDefinition(value))
    throw schemaViolation(
      'AgentDefinition',
      formatErrors(validators.agentDefinition.errors),
    );
  const def = value as unknown as AgentDefinition;
  const errors: string[] = [];
  selectionsSemantics('capabilities', def.capabilities, errors);
  selectionsSemantics('tools', def.tools, errors);
  selectionsSemantics('skills', def.skills, errors);
  selectionsSemantics(
    'runtimeRequirements/guarantees',
    def.runtimeRequirements.guarantees,
    errors,
  );
  if (
    def.retryPolicy &&
    def.retryPolicy.backoff.maxMs < def.retryPolicy.backoff.initialMs
  )
    errors.push('/retryPolicy/backoff maxMs < initialMs');
  if (errors.length) throw schemaViolation('AgentDefinition', errors);
  compileUserSchema(def.inputSchema, 'AgentDefinition.inputSchema');
  if (def.outputSchema !== undefined)
    compileUserSchema(def.outputSchema, 'AgentDefinition.outputSchema');
  return def;
}

export function validateToolDescriptor(value: unknown): ToolDescriptor {
  if (!validators.toolDescriptor(value))
    throw schemaViolation(
      'ToolDescriptor',
      formatErrors(validators.toolDescriptor.errors),
    );
  const d = value as unknown as ToolDescriptor;
  compileUserSchema(d.inputSchema, 'ToolDescriptor.inputSchema');
  if (d.outputSchema !== undefined)
    compileUserSchema(d.outputSchema, 'ToolDescriptor.outputSchema');
  return d;
}

export function validateToolBinding(value: unknown): ToolBinding {
  if (!validators.toolBinding(value))
    throw schemaViolation(
      'ToolBinding',
      formatErrors(validators.toolBinding.errors),
    );
  return value as unknown as ToolBinding;
}

export function validateSkillMetadata(value: unknown): SkillMetadata {
  if (!validators.skillMetadata(value))
    throw schemaViolation(
      'SkillMetadata',
      formatErrors(validators.skillMetadata.errors),
    );
  return value as unknown as SkillMetadata;
}

const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A point in time the scheduler compares as a string (deadlines, timers, timeouts): an ISO-8601 instant with an
 * explicit time zone, returned as UTC `toISOString()` form so string order is time order. Anything else — a date
 * without a zone (local time is ambiguous), free text — is a `SchemaViolation` (FEAT-038.3).
 */
export function normalizeInstant(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    !INSTANT.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    throw new AgentropyError(
      'SchemaViolation',
      `${what} must be an ISO-8601 instant with a time zone`,
      { details: { reason: what } },
    );
  return new Date(value).toISOString();
}

/** Envelope schema version this build accepts (messaging contract). */
export const MESSAGE_SCHEMA_VERSION = 1;

const agentMessageSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'kind',
    'name',
    'messageId',
    'correlationId',
    'tenantId',
    'actor',
    'createdAt',
    'payload',
  ],
  properties: {
    schemaVersion: { type: 'integer' },
    kind: { enum: ['command', 'query', 'event'] },
    name: { type: 'string', minLength: 1 },
    messageId: { type: 'string', minLength: 1 },
    correlationId: { type: 'string', minLength: 1 },
    causationId: { type: 'string' },
    idempotencyKey: { type: 'string', minLength: 1 },
    tenantId: { type: 'string', minLength: 1 },
    actor: {
      type: 'object',
      required: ['principalId', 'principalType'],
      properties: {
        principalId: { type: 'string', minLength: 1 },
        principalType: { enum: ['user', 'service', 'agent'] },
        delegatedBy: { type: 'string' },
      },
    },
    createdAt: { type: 'string', minLength: 1 },
  },
} as const;

/**
 * Boundary validation of an AgentMessage envelope (AC-17): malformed envelopes, an unsupported
 * `schemaVersion` and a command without an idempotency key are rejected with SchemaViolation.
 */
export function validateAgentMessage(value: unknown): AgentMessage {
  validateAgainst(agentMessageSchema, value, 'AgentMessage');
  const m = value as AgentMessage;
  if (m.schemaVersion !== MESSAGE_SCHEMA_VERSION)
    throw new AgentropyError(
      'SchemaViolation',
      `Unsupported AgentMessage schemaVersion ${m.schemaVersion}`,
      {
        details: { reason: 'schemaVersion', supported: MESSAGE_SCHEMA_VERSION },
      },
    );
  if (m.kind === 'command' && !m.idempotencyKey)
    throw new AgentropyError(
      'SchemaViolation',
      'A command needs an idempotency key',
      { details: { reason: 'missingIdempotencyKey' } },
    );
  if (Number.isNaN(Date.parse(m.createdAt)))
    throw new AgentropyError('SchemaViolation', 'createdAt must be ISO 8601', {
      details: { reason: 'createdAt' },
    });
  return m;
}
