# @agentropy/store-sqlite

**SQLite store for Agentropy.** Part of [Agentropy](https://github.com/bassemZohdy/agentropy), a TypeScript framework for durable, capability-driven multi-agent work. Version 0.x: the API can still change between minor versions.

The `Store` adapter on `node:sqlite` for a single process: one file, atomic transactions, the same conformance suite as every other adapter. Use `:memory:` for tests.

## Install

```sh
npm install @agentropy/store-sqlite
```

Node 24 or newer.

## Use

```ts
import { SqliteStore } from '@agentropy/store-sqlite';

const store = new SqliteStore({ path: './agentropy.db' });
```

Several processes that must share one database need `@agentropy/store-postgres`.

## Learn more

- [Deployment guide](https://github.com/bassemZohdy/agentropy/blob/main/docs/deployment.md)
- [Operations](https://github.com/bassemZohdy/agentropy/blob/main/docs/operations.md)
- [Every export](https://github.com/bassemZohdy/agentropy/blob/main/docs/api.md)

## License

Apache-2.0. See the [repository](https://github.com/bassemZohdy/agentropy) for the source, issues and contributing guide.
