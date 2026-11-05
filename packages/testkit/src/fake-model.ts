/** Deterministic fake text completion for offline integration tests. */
export class FakeModel {
  private readonly responses = new Map<string, string>();
  private readonly prompts: string[] = [];
  private fallback: string | undefined;

  setResponse(prompt: string, response: string): void {
    this.responses.set(prompt, response);
  }

  setFallback(response: string): void {
    this.fallback = response;
  }

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const result = this.responses.get(prompt) ?? this.fallback;
    if (result === undefined) {
      throw new Error('No fake response configured for prompt');
    }
    return result;
  }

  history(): readonly string[] {
    return [...this.prompts];
  }

  reset(): void {
    this.responses.clear();
    this.prompts.length = 0;
    this.fallback = undefined;
  }
}
