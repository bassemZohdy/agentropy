import { describe, expect, it } from 'vitest';
import { AGENTROPY_CONTRACT_VERSION } from '../src/index.js';

describe('workspace smoke test', () => {
  it('exposes the scaffold marker', () => {
    expect(AGENTROPY_CONTRACT_VERSION).toBe('v1');
  });
});
