// FIX-084: task acceptance (and the reasoning tool lookup) on one worker acts on the tool and skill lifecycle status
// kept in the store (FEAT-074), not on what this process last saw. Two apps on one SQLite store, each with its own
// registries: an activation or a revoke through one is seen by the other at its next acceptance.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_PROFILES,
  type AcceptanceSnapshot,
  type AgentDefinition,
  type ReasoningProvider,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  DefaultToolExecutor,
  DirectToolProvider,
  FileSystemSkillLoader,
  InMemorySkillRegistry,
  InMemoryToolRegistry,
  ToolProviderRegistry,
  createLocalApp,
} from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeAudit, FakePolicy } from '../src/index.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const skillFixtures = fileURLToPath(
  new URL('../../runtime/test/fixtures/skills/', import.meta.url),
);
const tool = {
  id: 'bank.transfer',
  version: '1.0.0',
  description: 'transfer',
  inputSchema: true as const,
  effect: 'external' as const,
  idempotency: 'at-least-once' as const,
  permission: 'tool:bank.transfer:call',
};
const bindings = [
  {
    bindingId: 'direct',
    toolId: tool.id,
    toolVersion: tool.version,
    providerId: 'direct',
    providerVersion: '1.0.0',
    config: { function: 'transfer' },
    default: true,
  },
];
const toolRef = { id: tool.id, version: tool.version };
const skillRef = { id: 'pdf-processing', version: '1.0.0' };

const def = (
  id: string,
  over: Partial<AgentDefinition> = {},
): AgentDefinition => ({
  id,
  version: '1.0.0',
  displayName: id,
  profile: { id: 'task', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id, version: '1.0.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
  ...over,
});

const model: ReasoningProvider = {
  id: 'stub',
  complete: async () => ({
    text: 'ok',
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'm',
  }),
};

/** One worker: its own registries, executor and app over the shared store, with the tool and skill registered. */
async function worker(store: ReturnType<typeof sqliteTempStore>) {
  const pdp = new FakePolicy();
  const audit = new FakeAudit();
  const security = { pdp, audit, now: () => '2026-11-20T00:00:00.000Z' };
  const tools = new InMemoryToolRegistry(security, () => true, { store });
  const providers = new ToolProviderRegistry();
  providers.register(
    new DirectToolProvider({ transfer: () => ({ ok: true }) }),
  );
  const skills = new InMemorySkillRegistry(
    security,
    (_m, publisher) => publisher === 'acme',
    { store },
  );
  await tools.register(
    tool,
    bindings,
    { publisher: 'acme', source: 'test' },
    alice,
  );
  await skills.register(
    join(skillFixtures, 'pdf-processing'),
    { version: '1.0.0', publisher: 'acme' },
    alice,
  );
  const app = createLocalApp({
    store,
    pdp,
    audit,
    profiles: BUILTIN_PROFILES,
    reasoning: model,
    tools: {
      registry: tools,
      providers,
      executor: new DefaultToolExecutor({
        ...security,
        registry: tools,
        providers,
      }),
    },
    skills: { registry: skills, loader: new FileSystemSkillLoader(skills) },
  });
  app.define(
    def('mover', {
      capabilities: [
        { id: 'tool-use', versionRange: '^1.0.0' },
        { id: 'reasoning', versionRange: '^1.0.0' },
      ],
      tools: [{ id: tool.id, versionRange: '^1.0.0' }],
    }),
    {
      handle: async (_inv, ctx) => {
        try {
          await ctx.capabilities.invoke('reasoning', 'complete', {
            prompt: 'p',
            tools: [tool.id],
          });
          return { kind: 'completed', output: 'offered' };
        } catch (e) {
          return {
            kind: 'completed',
            output: (e as { code?: string }).code ?? String(e),
          };
        }
      },
    },
  );
  app.define(
    def('reader', { skills: [{ id: skillRef.id, versionRange: '^1.0.0' }] }),
    { handle: async () => ({ kind: 'completed', output: null }) },
  );
  return { app, tools, skills };
}

/** The stored task row: its acceptance snapshot and output. */
const taskRow = async (
  store: ReturnType<typeof sqliteTempStore>,
  taskId: string,
) =>
  (
    await store.transaction((tx) =>
      tx.get<{
        snapshot: AcceptanceSnapshot;
        output?: unknown;
      }>('tasks', taskId),
    )
  )?.value;

describe('acceptance reads the stored tool and skill lifecycle status (FIX-084)', () => {
  let n = 0;
  /** A fresh instance and delegation each time, so an earlier acceptance is never replayed. */
  const delegate = async (
    app: Awaited<ReturnType<typeof worker>>['app'],
    definition: string,
  ) => {
    const key = `${definition}-${++n}`;
    const inst = await app.createInstance(
      {
        definition: { id: definition, version: '1.0.0' },
        ownerId: alice.id,
        idempotencyKey: `i-${key}`,
      },
      alice,
    );
    return app.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: key,
        correlationId: key,
      },
      alice,
    );
  };

  it('FIX-084: a tool activated and then revoked on one worker is accepted and then refused by another', async () => {
    const store = sqliteTempStore();
    const a = await worker(store);
    const b = await worker(store);
    expect(await code(delegate(b.app, 'mover'))).toBe('CapabilityUnavailable');

    await a.tools.activate(toolRef, alice);
    const accepted = await delegate(b.app, 'mover');
    const task = await taskRow(store, accepted.taskId);
    expect(task?.snapshot.tools?.map((p) => p.toolId)).toEqual([tool.id]);

    await a.tools.revoke(toolRef, alice);
    expect(await code(delegate(b.app, 'mover'))).toBe('CapabilityUnavailable');
  });

  it('FIX-084: reasoning on another worker does not offer a pinned tool revoked since acceptance', async () => {
    const store = sqliteTempStore();
    const a = await worker(store);
    const b = await worker(store);
    await a.tools.activate(toolRef, alice);
    const offered = await delegate(b.app, 'mover');
    await b.app.runUntilIdle();
    expect((await taskRow(store, offered.taskId))?.output).toBe('offered');

    const pinned = await delegate(b.app, 'mover');
    await a.tools.revoke(toolRef, alice);
    await b.app.runUntilIdle();
    expect((await taskRow(store, pinned.taskId))?.output).toBe(
      'PermissionDenied',
    );
  });

  it('FIX-084: a skill activated and then revoked on one worker is accepted and then refused by another', async () => {
    const store = sqliteTempStore();
    const a = await worker(store);
    const b = await worker(store);
    expect(await code(delegate(b.app, 'reader'))).toBe('CapabilityUnavailable');

    await a.skills.activate(skillRef, alice);
    const accepted = await delegate(b.app, 'reader');
    const task = await taskRow(store, accepted.taskId);
    expect(task?.snapshot.skills?.map((p) => p.id)).toEqual([skillRef.id]);

    await a.skills.revoke(skillRef, alice);
    expect(await code(delegate(b.app, 'reader'))).toBe('CapabilityUnavailable');
  });

  it('FIX-084: a worker that started with a tool and a skill active refuses them once another worker revokes them', async () => {
    const store = sqliteTempStore();
    const a = await worker(store);
    await a.tools.activate(toolRef, alice);
    await a.skills.activate(skillRef, alice);
    // B starts later: register adopts the stored `active`, so it accepts both without any activation of its own.
    const b = await worker(store);
    await delegate(b.app, 'mover');
    await delegate(b.app, 'reader');

    await a.tools.revoke(toolRef, alice);
    await a.skills.revoke(skillRef, alice);
    expect(await code(delegate(b.app, 'mover'))).toBe('CapabilityUnavailable');
    expect(await code(delegate(b.app, 'reader'))).toBe('CapabilityUnavailable');
  });

  it('FIX-084: refreshedVersions returns the stored status; versions stays this process view', async () => {
    const store = sqliteTempStore();
    const a = await worker(store);
    const b = await worker(store);
    await a.tools.activate(toolRef, alice);
    await a.skills.activate(skillRef, alice);
    expect(b.tools.versions(tool.id).map((r) => r.status)).toEqual([
      'registered',
    ]);
    expect(
      (await b.tools.refreshedVersions(tool.id)).map((r) => r.status),
    ).toEqual(['active']);
    expect(
      (await b.skills.refreshedVersions(skillRef.id)).map((r) => r.status),
    ).toEqual(['active']);
    await a.tools.revoke(toolRef, alice);
    await a.skills.revoke(skillRef, alice);
    expect(
      (await b.tools.refreshedVersions(tool.id)).map((r) => r.status),
    ).toEqual(['revoked']);
    expect(
      (await b.skills.refreshedVersions(skillRef.id)).map((r) => r.status),
    ).toEqual(['revoked']);
    // Without a store the process's own status is the answer.
    const local = new InMemoryToolRegistry(
      { pdp: new FakePolicy(), audit: new FakeAudit(), now: () => 'now' },
      () => true,
    );
    await local.register(
      tool,
      bindings,
      { publisher: 'acme', source: 't' },
      alice,
    );
    await local.activate(toolRef, alice);
    expect(
      (await local.refreshedVersions(tool.id)).map((r) => r.status),
    ).toEqual(['active']);
  });
});
