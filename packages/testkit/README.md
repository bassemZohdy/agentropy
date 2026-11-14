# @agentropy/testkit

**Offline fakes and conformance suites for Agentropy.** Part of [Agentropy](https://github.com/bassemZohdy/agentropy), a TypeScript framework for durable, capability-driven multi-agent work. Version 0.x: the API can still change between minor versions.

Everything needed to test agents and providers without a network: a fake clock, fake model, fake policy, audit and credential fakes, a fault injector, a network guard, a fake workflow engine, and reusable conformance suites (store, communication, workflow engine) for the authors of adapters.

## Install

```sh
npm install @agentropy/testkit
```

Node 24 or newer.

## Use

```ts
import { FakeClock, FakePolicy } from '@agentropy/testkit';

const clock = new FakeClock('2026-01-01T00:00:00.000Z');
const pdp = new FakePolicy(); // allows everything unless you add to pdp.denied
```

Use it as a dev dependency next to `@agentropy/runtime`.

## Learn more

- [Conformance kit](https://github.com/bassemZohdy/agentropy/blob/main/docs/conformance-kit.md)
- [Building agents](https://github.com/bassemZohdy/agentropy/blob/main/skills/agentropy-build-agent/SKILL.md)
- [Every export](https://github.com/bassemZohdy/agentropy/blob/main/docs/api.md)

## License

Apache-2.0. See the [repository](https://github.com/bassemZohdy/agentropy) for the source, issues and contributing guide.
