// FEAT-044.4: interoperability with a second, independent A2A 1.0 implementation, the reference Python SDK
// (`a2a-sdk` 1.3.0), over real loopback HTTP. The first direction has Agentropy's A2A provider delegate to a Python
// server (test/python/a2a_peer.py) and read its result; the second has a Python client (test/python/a2a_client.py)
// resolve Agentropy's AgentCard and call SendMessage and GetTask on Agentropy's HTTP binding.
//
// Opt-in, like the other live suites, because it needs Python and PyPI: set AGENTROPY_A2A_PY=auto to create (once) and
// reuse a virtualenv under node_modules/.cache, or to the path of a Python that already has a2a-sdk 1.3.0 and uvicorn.
// Without it the suite is skipped.
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as httpServer, type Server } from 'node:http';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A2ACommunicationProvider,
  A2A_PROTOCOL_VERSION,
  agentCardForDefinition,
  createA2AHttpHandler,
  createA2AServer,
  createLocalApp,
  localAppTarget,
} from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy, allowNetwork } from '../src/index.js';
import { liveFetch } from './live-fetch.js';

const MODE = process.env['AGENTROPY_A2A_PY'];
const live = MODE ? describe : describe.skip;
const here = (f: string) =>
  join(import.meta.dirname, 'python', f).replaceAll('\\', '/');
const caller: TrustedPrincipal = {
  id: 'svc-a',
  type: 'service',
  tenantId: 't-1',
};

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`,
    );
  return r.stdout;
}

/** The Python to use: the given path, or a cached virtualenv created on first use. */
function python(): string {
  if (MODE !== 'auto') return MODE!;
  const venv = join(
    process.cwd(),
    'node_modules',
    '.cache',
    'agentropy-a2a-python',
  );
  const bin =
    process.platform === 'win32'
      ? join(venv, 'Scripts', 'python.exe')
      : join(venv, 'bin', 'python');
  if (!existsSync(bin)) {
    const system = ['python3', 'python'].find(
      (c) => spawnSync(c, ['--version']).status === 0,
    );
    if (!system)
      throw new Error('AGENTROPY_A2A_PY=auto needs python3 or python on PATH');
    run(system, ['-m', 'venv', venv]);
    run(bin, [
      '-m',
      'pip',
      'install',
      '--quiet',
      '--disable-pip-version-check',
      'a2a-sdk[http-server]==1.3.0',
      'uvicorn==0.54.0',
    ]);
  }
  return bin;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = netServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

const def: AgentDefinition = {
  id: 'summarizer',
  version: '1.0.0',
  displayName: 'Summarizer',
  profile: { id: 'task', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id: 'summarizer', version: '1.0.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
};

live('A2A interop with the Python reference SDK (FEAT-044.4)', () => {
  let py = '';
  let peer: ChildProcess | undefined;
  let peerPort = 0;

  beforeAll(async () => {
    py = python();
    peerPort = await freePort();
    allowNetwork([`127.0.0.1:${peerPort}`]);
    peer = spawn(py, [here('a2a_peer.py'), String(peerPort)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    peer.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    const card = `http://127.0.0.1:${peerPort}/.well-known/agent-card.json`;
    let last = '';
    for (let i = 0; i < 60; i++) {
      if (peer.exitCode !== null)
        throw new Error(`the Python peer exited early:
${stderr}`);
      try {
        if ((await liveFetch(card)).status === 200) return;
      } catch (e) {
        last =
          e instanceof Error
            ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}`
            : String(e);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`the Python peer did not start: ${last}
${stderr}`);
  }, 300_000);

  afterAll(() => {
    peer?.kill();
  });

  const route = () => ({
    providerId: 'a2a',
    protocol: 'a2a',
    protocolVersion: A2A_PROTOCOL_VERSION,
    target: {
      definitionId: 'echo',
      tenantId: 't-1',
      endpoint: `http://127.0.0.1:${peerPort}/a2a`,
    },
  });
  const ctx = { caller, correlationId: 'c-1' };

  it('Agentropy’s A2A provider delegates to a Python server and reads its result', async () => {
    const provider = new A2ACommunicationProvider({
      fetch: liveFetch as never,
      maxPolls: 5,
    });
    const ref = await provider.delegate(
      route(),
      {
        target: {},
        input: { doc: 'q5' },
        idempotencyKey: 'k-1',
        correlationId: 'c-1',
      },
      ctx,
    );
    expect(await provider.getTask(ref, ctx)).toMatchObject({
      remoteState: 'TASK_STATE_COMPLETED',
      normalized: 'completed',
      output: 'echo: {"doc":"q5"}',
    });
  });

  it('a peer’s refusal comes back as a typed error: a finished task cannot be cancelled', async () => {
    const provider = new A2ACommunicationProvider({
      fetch: liveFetch as never,
      maxPolls: 5,
    });
    const ref = await provider.delegate(
      route(),
      {
        target: {},
        input: { doc: 'q6' },
        idempotencyKey: 'k-2',
        correlationId: 'c-2',
      },
      ctx,
    );
    expect(await code(provider.cancel(ref, ctx))).toBe('InvalidState');
  });

  it('a Python client resolves Agentropy’s AgentCard and calls SendMessage and GetTask on its HTTP binding', async () => {
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
      profiles: BUILTIN_PROFILES,
    });
    app.define(def, {
      handle: async (inv) => ({
        kind: 'completed',
        output: { summary: `summary of ${JSON.stringify(inv.input)}` },
      }),
    });
    const bob: TrustedPrincipal = { id: 'bob', type: 'user', tenantId: 't-1' };
    const inst = await app.createInstance(
      {
        definition: { id: 'summarizer', version: '1.0.0' },
        ownerId: 'bob',
        idempotencyKey: 's',
      },
      bob,
    );
    const server: Server = httpServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const handler = createA2AHttpHandler(
      createA2AServer(localAppTarget(app), { instanceId: inst.id }),
      {
        authenticate: async () => caller,
        agentCard: agentCardForDefinition(def, `${base}/a2a`, {
          streaming: true,
        }),
      },
    );
    server.on('request', (req, res) => {
      void handler.handle(req, res).then((served) => {
        if (!served) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    // The agent runs when the scheduler ticks; the client's SendMessage returns the task as accepted.
    const ticking = setInterval(() => void app.runUntilIdle(), 50);
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(py, [here('a2a_client.py'), base, '{"doc":"q7"}'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('close', (c) =>
          c === 0
            ? resolve(stdout)
            : reject(new Error(`client exit ${String(c)}\n${stderr}`)),
        );
      });
      const result = JSON.parse(out.trim().split('\n').at(-1)!) as {
        state: string;
        got: string;
        id_matches: boolean;
      };
      expect(result.id_matches).toBe(true);
      expect([
        'TASK_STATE_SUBMITTED',
        'TASK_STATE_WORKING',
        'TASK_STATE_COMPLETED',
      ]).toContain(result.state);
      expect(['TASK_STATE_WORKING', 'TASK_STATE_COMPLETED']).toContain(
        result.got,
      );
    } finally {
      clearInterval(ticking);
      server.close();
    }
  }, 120_000);
});
