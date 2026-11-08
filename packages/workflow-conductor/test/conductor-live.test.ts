// FEAT-035.2: the Conductor adapter against a real Conductor server (Conductor OSS or Orkes). Opt-in: set
// AGENTROPY_CONDUCTOR_URL (e.g. http://127.0.0.1:8080) and, when needed, AGENTROPY_CONDUCTOR_TOKEN (sent as
// X-Authorization). Without the URL the suite is skipped and the offline guard stays in force.
// Status: written against Conductor's documented REST API; not yet run against a live server.
import { allowNetwork, endpointOf } from '@agentropy/testkit';
import { describe, expect, it } from 'vitest';
import { liveFetch } from '../../testkit/test/live-fetch.js';
import { ConductorWorkflowEngine } from '../src/index.js';

const URL = process.env['AGENTROPY_CONDUCTOR_URL'];
const TOKEN = process.env['AGENTROPY_CONDUCTOR_TOKEN'];
if (URL) allowNetwork([endpointOf(URL, 8080)]);
const live = URL ? describe : describe.skip;

const NAME = 'agentropy_live_constant';
const headers = (): Record<string, string> => ({
  'content-type': 'application/json',
  ...(TOKEN ? { 'x-authorization': TOKEN } : {}),
});

live('ConductorWorkflowEngine on a live server', () => {
  /** Raw replies, so a failure shows what the server actually answered. */
  const replies: string[] = [];
  const engine = (idempotency: 'server' | 'lookup') =>
    new ConductorWorkflowEngine({
      baseUrl: URL!,
      fetch: async (url, init) => {
        const res = await liveFetch(url, init);
        const text = await res.text();
        replies.push(
          `${init.method} ${url.replace(URL!, '')} -> ${res.status} ${text.slice(0, 300)}`,
        );
        return { status: res.status, text: async () => text };
      },
      headers: () => (TOKEN ? { 'X-Authorization': TOKEN } : {}),
      idempotency,
    });

  /** A workflow that finishes at once with a constant output, registered (or updated) for the run. */
  async function register() {
    const res = await liveFetch(`${URL}/api/metadata/workflow`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify([
        {
          name: NAME,
          version: 1,
          schemaVersion: 2,
          ownerEmail: 'agentropy@example.com',
          tasks: [
            {
              name: 'set',
              taskReferenceName: 'set',
              type: 'SET_VARIABLE',
              inputParameters: { done: true },
            },
          ],
          outputParameters: { total: 42 },
          timeoutSeconds: 0,
        },
      ]),
    });
    expect(res.status).toBeLessThan(300);
  }

  const ctx = (key: string) => ({
    tenantId: 't-live',
    taskId: `task-${key}`,
    idempotencyKey: `${key}-${Date.now()}`,
  });

  // Findings of the first live run (Conductor OSS 3.15.0 standalone), which the adapter documents:
  // - `idempotencyKey` / RETURN_EXISTING in the start request is NOT enforced: the same key starts a second run, so
  //   once-per-key comes from the runtime's own `workflow.start` journal, not from this server;
  // - the correlation search (`/correlated`) returned an empty list for a started, even a finished, run (still empty
  //   20 s later), so `lookup` mode cannot find an earlier run on this server.
  it('starts a run, reports it finished through poll, and hides it from another tenant', async () => {
    await register();
    const e = engine('server');
    const finished: string[] = [];
    e.onFinished((r) => finished.push(`${r.runId}:${r.state}:${r.tenantId}`));
    replies.length = 0;
    const run = await e.start(NAME, {}, ctx('a'));
    expect(run.runId, replies.join(' | ')).toBeTruthy();
    for (let i = 0; i < 30 && !finished.length; i++) {
      await e.poll();
      if (!finished.length) await new Promise((r) => setTimeout(r, 500));
    }
    expect(finished, replies.join(' | ')).toEqual([
      `${run.runId}:completed:t-live`,
    ]);
    const done = await e.status(run.runId, { tenantId: 't-live' });
    expect(done).toMatchObject({ state: 'completed', output: { total: 42 } });
    expect((await e.status(run.runId, { tenantId: 't-other' })).code).toBe(
      'NotFound',
    );
  }, 60_000);

  it('lookup mode still starts runs and reports them finished, though the correlation search finds nothing', async () => {
    await register();
    const e = engine('lookup');
    const finished: string[] = [];
    e.onFinished((r) => finished.push(r.runId));
    const run = await e.start(NAME, {}, ctx('lookup'));
    expect(run.runId).toBeTruthy();
    for (let i = 0; i < 30 && !finished.length; i++) {
      await e.poll();
      if (!finished.length) await new Promise((r) => setTimeout(r, 500));
    }
    expect(finished).toEqual([run.runId]);
  }, 60_000);

  it('an unknown workflow is CapabilityUnavailable', async () => {
    const err = await engine('server')
      .start('agentropy_no_such_workflow', {}, ctx('b'))
      .catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('CapabilityUnavailable');
  });
});
