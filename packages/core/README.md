# @agentropy/core

**Contracts, types and pure helpers for Agentropy.** Part of [Agentropy](https://github.com/bassemZohdy/agentropy), a TypeScript framework for durable, capability-driven multi-agent work. Version 0.x: the API can still change between minor versions.

The shared vocabulary of Agentropy: the types of agent definitions, instances, tasks and executions, the lifecycle tables, the error catalog (`AgentropyError` and its codes), JSON Schema validation, the `Store` port that storage adapters implement, and pure resolvers. It performs no I/O and has no runtime of its own.

## Install

```sh
npm install @agentropy/core
```

Node 24 or newer.

## Use

```ts
import { AgentropyError, isAgentropyError } from '@agentropy/core';

try {
  // ...
} catch (err) {
  if (isAgentropyError(err, 'StaleRevision')) {
    // retry
  }
}
```

Install it with `@agentropy/runtime` to build agents; install it alone to write a provider or a store adapter.

## Learn more

- [Agent contract](https://github.com/bassemZohdy/agentropy/blob/main/docs/contracts/agent-v1.md)
- [Errors contract](https://github.com/bassemZohdy/agentropy/blob/main/docs/contracts/errors-v1.md)
- [Every export](https://github.com/bassemZohdy/agentropy/blob/main/docs/api.md)

## License

Apache-2.0. See the [repository](https://github.com/bassemZohdy/agentropy) for the source, issues and contributing guide.
