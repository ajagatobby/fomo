import type { FomoJsonTransport } from "./client.ts";

export type PacedTransportOptions = {
  requestsPerSecond?: number;
  maxRateLimitRetries?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

/** Pace all request starts through one queue and coordinate retries after HTTP 429 responses. */
export function pacedTransport(
  transport: FomoJsonTransport,
  options: PacedTransportOptions = {},
): FomoJsonTransport {
  const requestsPerSecond = options.requestsPerSecond ?? 4;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? 4;
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
    throw new RangeError("requestsPerSecond must be positive");
  }
  if (!Number.isInteger(maxRateLimitRetries) || maxRateLimitRetries < 0) {
    throw new RangeError("maxRateLimitRetries must be a non-negative integer");
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  const interval = 1_000 / requestsPerSecond;
  let queue = Promise.resolve();
  let nextRequestAt = 0;
  let cooldownUntil = 0;

  async function start<T>(request: () => Promise<T>): Promise<T> {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const target = Math.max(nextRequestAt, cooldownUntil);
      const wait = Math.max(0, target - now());
      if (wait > 0) await sleep(wait);
      nextRequestAt = Math.max(target, now()) + interval;
      return request();
    } finally {
      release();
    }
  }

  return {
    async request<T>(path: string): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await start(() => transport.request<T>(path));
        } catch (error) {
          if (!isRateLimit(error) || attempt >= maxRateLimitRetries) throw error;
          const backoff = Math.min(60_000, 10_000 * 2 ** attempt) + Math.floor(random() * 1_000);
          cooldownUntil = Math.max(cooldownUntil, now() + backoff);
        }
      }
    },
  };
}

function isRateLimit(error: unknown): boolean {
  return /(?:HTTP\s*)?429|rate[ -]?limit|too many requests/i.test(error instanceof Error ? error.message : String(error));
}
