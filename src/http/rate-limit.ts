/**
 * In-memory sliding-window rate limiter (default 20 req/min/IP). Single-deploy-per-client,
 * so process-local state is sufficient; a distributed limiter is a per-client swap.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the caller may retry (0 when allowed). */
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
}

export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  check(key: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.max) {
      const oldest = recent[0]!;
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}
