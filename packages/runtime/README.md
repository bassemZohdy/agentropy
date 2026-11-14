# @agentropy/runtime

**The durable multi-agent runtime.** Part of [Agentropy](https://github.com/bassemZohdy/agentropy), a TypeScript framework for durable, capability-driven multi-agent work. Version 0.x: the API can still change between minor versions.

Registries, the task service, the scheduler, leases, wake-ups, human actions, the audit chain, communication providers (direct and A2A) and the `createLocalApp` facade that wires them over a `Store`. Work survives restarts: a task waits on a timer, an event, a child task or a person without holding a worker, and resumes from its checkpoint.

## Install

```sh
npm install @agentropy/runtime
```

Node 24 or newer.

## Use

```ts
import { createLocalApp } from '@agentropy/runtime';
import { SqliteStore } from '@agentropy/store-sqlite';

const app = createLocalApp({
  store: new SqliteStore({ path: './agentropy.db' }),
  pdp, // your policy decision point: there is no allow-all default
});
app.define(definition, { handle: async (inv) => ({ kind: 'completed', output: inv.input }) });
const stop = app.start(250); // the scheduler loop
```

It needs a store (`@agentropy/store-sqlite` for one process, `@agentropy/store-postgres` for several) and a policy decision point of your own.

## Learn more

- [Quickstart](https://github.com/bassemZohdy/agentropy/blob/main/docs/quickstart.md)
- [Runtime contract](https://github.com/bassemZohdy/agentropy/blob/main/docs/runtime-contract.md)
- [A2A client and server](https://github.com/bassemZohdy/agentropy/blob/main/skills/agentropy-a2a/SKILL.md)
- [Every export](https://github.com/bassemZohdy/agentropy/blob/main/docs/api.md)

## License

Apache-2.0. See the [repository](https://github.com/bassemZohdy/agentropy) for the source, issues and contributing guide.
