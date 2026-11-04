import { HttpClient } from '../http.js';
import type { LlmProvider } from '../interfaces.js';

/**
 * OpenRouter.
 *
 * Used for one thing only: turning a decision the engine already made into a
 * sentence a person can read. It never decides whether to trade, never sees a
 * private key, and every failure returns null so the deterministic reason
 * string stands on its own.
 */

const BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterProvider implements LlmProvider {
  readonly name = 'openrouter';
  private readonly http: HttpClient;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
  ) {
    this.http = new HttpClient(this.name, {
      minIntervalMs: 1_500,
      timeoutMs: 25_000,
      maxRetries: 1,
      headers: apiKey
        ? {
            authorization: `Bearer ${apiKey}`,
            'x-title': 'USF Solana Trading Bot',
          }
        : {},
    });
  }

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const reply = await this.explain('Reply with the single word: ready', 8);
    return reply !== null;
  }

  async explain(prompt: string, maxTokens = 220): Promise<string | null> {
    if (!this.isConfigured()) return null;
    try {
      const res = await this.http.postJson<{
        choices?: Array<{ message?: { content?: string } }>;
      }>(`${BASE}/chat/completions`, {
        model: this.model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You explain automated crypto trading decisions in plain language. ' +
              'Use at most three short sentences. State only what the given data supports. ' +
              'Never give financial advice and never invent numbers that are not provided.',
          },
          { role: 'user', content: prompt },
        ],
      });
      const text = res.choices?.[0]?.message?.content?.trim();
      return text && text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }
}
