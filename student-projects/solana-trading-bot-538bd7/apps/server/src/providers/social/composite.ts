import type { SocialSnapshot } from '../../core/types.js';
import type { SocialDataProvider } from '../interfaces.js';

/**
 * Layers a primary social provider over a free fallback.
 *
 * Built for LunarCrush: its public v4 endpoints now answer 402 (payment
 * required) on the free tier, which used to leave the social dimension
 * permanently empty. Every call tries the primary first; a null or empty
 * result — no data, rate limited, or the plan no longer covers the endpoint —
 * falls through to the fallback instead.
 *
 * After a run of consecutive failures the primary is skipped for a cooldown
 * window, so a paywalled key does not cost a network round trip (and an
 * activity-log error line) on every single call.
 */
export class CompositeSocialProvider implements SocialDataProvider {
  readonly name: string;
  private consecutiveFailures = 0;
  private disabledUntil = 0;

  constructor(
    private readonly primary: SocialDataProvider,
    private readonly fallback: SocialDataProvider,
    private readonly failureThreshold = 3,
    private readonly cooldownMs = 30 * 60_000,
  ) {
    this.name = `${primary.name}+${fallback.name}`;
  }

  isConfigured(): boolean {
    return this.primary.isConfigured() || this.fallback.isConfigured();
  }

  async healthCheck(): Promise<boolean> {
    const [primaryOk, fallbackOk] = await Promise.all([
      this.primary.healthCheck?.().catch(() => false) ?? Promise.resolve(false),
      this.fallback.healthCheck?.().catch(() => false) ?? Promise.resolve(false),
    ]);
    return primaryOk || fallbackOk;
  }

  async getSocialSnapshot(symbol: string, address: string, name?: string): Promise<SocialSnapshot | null> {
    const fromPrimary = await this.tryPrimary(
      (p) => p.getSocialSnapshot(symbol, address, name),
      (result) => result != null,
    );
    if (fromPrimary) return fromPrimary;
    return this.fallback.getSocialSnapshot(symbol, address, name);
  }

  async getTrending(limit: number): Promise<Array<{ symbol: string; address: string | null }>> {
    const fromPrimary = await this.tryPrimary(
      (p) => p.getTrending(limit),
      (result) => result.length > 0,
    );
    if (fromPrimary) return fromPrimary;
    return this.fallback.getTrending(limit);
  }

  /** Currently skipping the primary because it has failed repeatedly and is inside its cooldown. */
  primaryOnCooldown(): boolean {
    return Date.now() < this.disabledUntil;
  }

  private async tryPrimary<T>(call: (p: SocialDataProvider) => Promise<T>, isUsable: (result: T) => boolean): Promise<T | null> {
    if (!this.primary.isConfigured() || this.primaryOnCooldown()) return null;
    try {
      const result = await call(this.primary);
      if (!isUsable(result)) {
        this.recordFailure();
        return null;
      }
      this.consecutiveFailures = 0;
      return result;
    } catch {
      this.recordFailure();
      return null;
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.disabledUntil = Date.now() + this.cooldownMs;
    }
  }
}
