/** @agentropy/testkit — offline fakes and reusable conformance suites. */
export const packageName = '@agentropy/testkit' as const;

export * from './communication.js';
export * from './store.js';
export * from './fakes.js';

export * from './fake-clock.js';
export * from './fault-injector.js';
export * from './fake-model.js';
