# @agentropy/store-postgres

**PostgreSQL store for Agentropy.** Part of [Agentropy](https://github.com/bassemZohdy/agentropy), a TypeScript framework for durable, capability-driven multi-agent work. Version 0.x: the API can still change between minor versions.

The `Store` adapter for PostgreSQL on a driver-neutral client port: several workers share one database with exactly-once dispatch. Transactions are SERIALIZABLE and retried on conflict; `statementTimeoutMs` and `lockTimeoutMs` bound a stuck statement or lock wait. Bring your own driver: a `pg` pool fits as is.

## Install

```sh
npm install @agentropy/store-postgres
```

Node 24 or newer.

## Use

```ts
import { Pool } from 'pg';
import { PostgresStore } from '@agentropy/store-postgres';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
pool.on('error', (err) => console.error('pg pool error', err.name)); // an idle connection can drop
const store = new PostgresStore({
  pool,
  ownsConnection: true,
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 10_000,
});
```

It does not depend on a driver: install `pg` (or any client with the same `query` shape) yourself.

## Learn more

- [PostgreSQL adapter decision](https://github.com/bassemZohdy/agentropy/blob/main/docs/adr/0028-postgresql-store-adapter.md)
- [Deployment guide](https://github.com/bassemZohdy/agentropy/blob/main/docs/deployment.md)
- [Every export](https://github.com/bassemZohdy/agentropy/blob/main/docs/api.md)

## License

Apache-2.0. See the [repository](https://github.com/bassemZohdy/agentropy) for the source, issues and contributing guide.
