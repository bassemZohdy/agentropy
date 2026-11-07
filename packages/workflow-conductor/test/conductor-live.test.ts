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
  const engine = () =>
    new ConductorWorkflowEngine({
      baseUrl: URL!,
      fetch: (url, init) => liveFetch(url, init),
      headers: () => (TOKEN ? { 'X-Authorization': TOKEN } : {}),
      idempotency: 'lookup', // Conductor OSS has no idempotency keys
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

  it('starts a run idempotently per key, reports it finished through poll, and hides it from another tenant', async () => {
    await register();
    const e = engine();
    const finished: string[] = [];
    e.onFinished((r) => finished.push(`${r.runId}:${r.state}:${r.tenantId}`));
    const c = ctx('a');
    const run = await e.start(NAME, {}, c);
    expect(run.runId).toBeTruthy();
    const again = await e.start(NAME, {}, c);
    expect(again.runId).toBe(run.runId);

    for (let i = 0; i < 30 && !finished.length; i++) {
      await e.poll();
      if (!finished.length) await new Promise((r) => setTimeout(r, 500));
    }
    expect(finished).toEqual([`${run.runId}:completed:t-live`]);
    const done = await e.status(run.runId, { tenantId: 't-live' });
    expect(done).toMatchObject({ state: 'completed', output: { total: 42 } });
    expect((await e.status(run.runId, { tenantId: 't-other' })).code).toBe(
      'NotFound',
    );
  }, 60_000);

  it('an unknown workflow is CapabilityUnavailable', async () => {
    const err = await engine()
      .start('agentropy_no_such_workflow', {}, ctx('b'))
      .catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('CapabilityUnavailable');
  });
});
