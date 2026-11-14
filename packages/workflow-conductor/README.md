# @agentropy/workflow-conductor

**Conductor workflow engine for Agentropy.** Part of [Agentropy](https://github.com/bassemZohdy/agentropy), a TypeScript framework for durable, capability-driven multi-agent work. Version 0.x: the API can still change between minor versions.

A `WorkflowEngine` adapter for Conductor over its REST API: it starts a run per task with an idempotent correlation ID, reports finished runs through webhooks or polling, and keeps each run bound to its tenant. It passes the shared workflow-engine conformance suite.

## Install

```sh
npm install @agentropy/workflow-conductor
```

Node 24 or newer.

## Use

```ts
import { ConductorWorkflowEngine } from '@agentropy/workflow-conductor';

const engine = new ConductorWorkflowEngine({
  baseUrl: 'https://conductor.internal',
  fetch,
  headers: async () => ({ 'x-authorization': await token() }),
});
```

Pass the engine to `createLocalApp` through its `workflow` option.

## Learn more

- [Conformance kit](https://github.com/bassemZohdy/agentropy/blob/main/docs/conformance-kit.md)
- [Capability contract](https://github.com/bassemZohdy/agentropy/blob/main/docs/contracts/capability-v1.md)
- [Every export](https://github.com/bassemZohdy/agentropy/blob/main/docs/api.md)

## License

Apache-2.0. See the [repository](https://github.com/bassemZohdy/agentropy) for the source, issues and contributing guide.
