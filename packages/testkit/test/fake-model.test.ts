import { describe, expect, it } from 'vitest';
import { FakeModel } from '../src/fake-model.js';

describe('FakeModel', () => {
  it('returns scripted completions without external model calls', async () => {
    const model = new FakeModel();
    model.setResponse('risk summary', 'low risk');
    await expect(model.complete('risk summary')).resolves.toBe('low risk');
    await expect(model.complete('risk summary')).resolves.toBe('low risk');
    expect(model.history()).toEqual(['risk summary', 'risk summary']);
  });

  it('fails explicitly without a script and supports a fallback', async () => {
    const model = new FakeModel();
    await expect(model.complete('unknown')).rejects.toThrow(
      'No fake response configured for prompt',
    );
    model.setFallback('default result');
    await expect(model.complete('unknown')).resolves.toBe('default result');
  });

  it('resets all history and scripted results', async () => {
    const model = new FakeModel();
    model.setFallback('temporary');
    await model.complete('x');
    model.reset();
    expect(model.history()).toEqual([]);
    await expect(model.complete('x')).rejects.toThrow(
      'No fake response configured for prompt',
    );
  });
});
