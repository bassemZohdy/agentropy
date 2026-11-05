// CT-SCHEMAS: Agent v1 rev 7 schemas — mandatory/optional fields, selections, tool and skill metadata.
import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '../src/agent.js';
import { isAgentropyError } from '../src/errors.js';
import {
  AGENT_DEFINITION_SCHEMA,
  validateAgainst,
  validateAgentDefinition,
  validateSkillMetadata,
  validateToolBinding,
  validateToolDescriptor,
} from '../src/schemas.js';

const minimal: AgentDefinition = {
  id: 'price-watch',
  version: '1.0.0',
  displayName: 'Price watch',
  profile: { id: 'monitoring', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id: 'price-watch', version: '1.0.0' },
  },
  inputSchema: {
    type: 'object',
    properties: { symbol: { type: 'string' }, below: { type: 'number' } },
    required: ['symbol', 'below'],
  },
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
};

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
    expect.fail(`expected ${code}`);
  } catch (err) {
    expect(isAgentropyError(err), String(err)).toBe(true);
    expect((err as { code: string }).code).toBe(code);
  }
};

describe('AgentDefinition schema (CT-SCHEMAS)', () => {
  it('accepts a definition with only the eight mandatory fields', () => {
    expect(validateAgentDefinition(structuredClone(minimal))).toEqual(minimal);
    expect(AGENT_DEFINITION_SCHEMA.required).toEqual([
      'id',
      'version',
      'displayName',
      'profile',
      'implementation',
      'inputSchema',
      'runtimeRequirements',
      'policyRef',
    ]);
  });

  it.each(AGENT_DEFINITION_SCHEMA.required)(
    'rejects a definition missing %s',
    (field) => {
      const def = structuredClone(minimal) as unknown as Record<
        string,
        unknown
      >;
      delete def[field];
      expectCode(() => validateAgentDefinition(def), 'SchemaViolation');
    },
  );

  it('accepts every optional field, including tools, skills and capability removals', () => {
    const full: AgentDefinition = {
      ...structuredClone(minimal),
      description: 'Watches a price',
      capabilities: [
        { id: 'notification', versionRange: '^1.0.0', remove: true },
        { id: 'tool-use', versionRange: '^1.0.0', providerId: 'tools' },
      ],
      skills: [
        { id: 'pdf-processing', versionRange: '^1.0.0', required: false },
      ],
      tools: [
        { id: 'finance.quote', versionRange: '~2.1.0', bindingId: 'direct' },
      ],
      outputSchema: true,
      modelRef: { id: 'fake-model', version: '1.0.0' },
      memoryRef: { id: 'mem', version: '1.0.0' },
      communicationRef: { id: 'direct', version: '1.0.0' },
      retryPolicy: {
        maxAttempts: 3,
        backoff: { initialMs: 1000, maxMs: 300000, multiplier: 2 },
      },
    };
    expect(validateAgentDefinition(full)).toEqual(full);
  });

  it('a permissive input schema is valid for unstructured input', () => {
    expect(
      validateAgentDefinition({
        ...structuredClone(minimal),
        inputSchema: true,
      }).inputSchema,
    ).toBe(true);
  });

  it('rejects unknown top-level properties, non-SemVer versions, invalid ranges and duplicate selections', () => {
    expectCode(
      () => validateAgentDefinition({ ...minimal, executable: 'rm -rf /' }),
      'SchemaViolation',
    );
    expectCode(
      () => validateAgentDefinition({ ...minimal, version: 'v1' }),
      'SchemaViolation',
    );
    expectCode(
      () =>
        validateAgentDefinition({
          ...minimal,
          tools: [{ id: 'a.b', versionRange: 'not a range' }],
        }),
      'SchemaViolation',
    );
    expectCode(
      () =>
        validateAgentDefinition({
          ...minimal,
          skills: [
            { id: 's', versionRange: '1.x' },
            { id: 's', versionRange: '2.x' },
          ],
        }),
      'SchemaViolation',
    );
    expectCode(
      () =>
        validateAgentDefinition({
          ...minimal,
          retryPolicy: {
            maxAttempts: 3,
            backoff: { initialMs: 10, maxMs: 1, multiplier: 2 },
          },
        }),
      'SchemaViolation',
    );
  });

  it('an invalid inputSchema document is InvalidConfiguration, not SchemaViolation', () => {
    expectCode(
      () =>
        validateAgentDefinition({
          ...minimal,
          inputSchema: { type: 'not-a-type' },
        }),
      'InvalidConfiguration',
    );
  });

  it('validates task input against the definition input schema', () => {
    validateAgainst(
      minimal.inputSchema,
      { symbol: 'ACME', below: 100 },
      'input',
    );
    expectCode(
      () => validateAgainst(minimal.inputSchema, { symbol: 'ACME' }, 'input'),
      'SchemaViolation',
    );
  });
});

describe('Tool descriptor and binding schemas (CT-SCHEMAS)', () => {
  const descriptor = {
    id: 'finance.payout',
    version: '1.0.0',
    description: 'Pay out an approved expense',
    inputSchema: {
      type: 'object',
      properties: { amount: { type: 'number' } },
      required: ['amount'],
    },
    effect: 'external',
    idempotency: 'keyed',
    permission: 'tool:finance.payout:call',
  };

  it('accepts a canonical descriptor and rejects unknown effect classes or extra fields', () => {
    expect(validateToolDescriptor(descriptor).id).toBe('finance.payout');
    expectCode(
      () => validateToolDescriptor({ ...descriptor, effect: 'write' }),
      'SchemaViolation',
    );
    expectCode(
      () => validateToolDescriptor({ ...descriptor, url: 'https://example' }),
      'SchemaViolation',
    );
    expectCode(
      () => validateToolDescriptor({ ...descriptor, id: 'Finance Payout' }),
      'SchemaViolation',
    );
  });

  it('validates bindings and rejects inline secrets fields', () => {
    const binding = {
      bindingId: 'direct',
      toolId: 'finance.payout',
      toolVersion: '1.0.0',
      providerId: 'direct',
      providerVersion: '1.0.0',
      config: {},
    };
    expect(validateToolBinding(binding).bindingId).toBe('direct');
    expectCode(
      () => validateToolBinding({ ...binding, apiKey: 'secret' }),
      'SchemaViolation',
    );
  });
});

describe('Agent Skills frontmatter schema (CT-SCHEMAS)', () => {
  it('accepts the specification examples', () => {
    expect(
      validateSkillMetadata({
        name: 'skill-name',
        description:
          'A description of what this skill does and when to use it.',
      }).name,
    ).toBe('skill-name');
    expect(
      validateSkillMetadata({
        name: 'pdf-processing',
        description:
          'Extract PDF text, fill forms, merge files. Use when handling PDFs.',
        license: 'Apache-2.0',
        metadata: { author: 'example-org', version: '1.0' },
      }).metadata,
    ).toEqual({ author: 'example-org', version: '1.0' });
  });

  it.each([
    'PDF-Processing',
    '-pdf',
    'pdf-',
    'pdf--processing',
    'a'.repeat(65),
    '',
  ])('rejects invalid name %j', (name) => {
    expectCode(
      () => validateSkillMetadata({ name, description: 'd' }),
      'SchemaViolation',
    );
  });

  it('enforces description and compatibility length limits and string-only metadata', () => {
    expectCode(
      () => validateSkillMetadata({ name: 'x', description: '' }),
      'SchemaViolation',
    );
    expectCode(
      () => validateSkillMetadata({ name: 'x', description: 'd'.repeat(1025) }),
      'SchemaViolation',
    );
    expectCode(
      () =>
        validateSkillMetadata({
          name: 'x',
          description: 'd',
          compatibility: 'c'.repeat(501),
        }),
      'SchemaViolation',
    );
    expectCode(
      () =>
        validateSkillMetadata({
          name: 'x',
          description: 'd',
          metadata: { version: 1 },
        }),
      'SchemaViolation',
    );
  });
});
