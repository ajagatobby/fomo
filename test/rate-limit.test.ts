import assert from "node:assert/strict";
import test from "node:test";
import { pacedTransport } from "../src/fomo/rate-limit.ts";

test("paced transport coordinates exponential HTTP 429 retries", async () => {
  let now = 0;
  let attempts = 0;
  const sleeps: number[] = [];
  const transport = pacedTransport({
    async request<T>(): Promise<T> {
      attempts++;
      if (attempts <= 2) throw new Error("Fomo API request failed (HTTP 429)");
      return { ok: true } as T;
    },
  }, {
    requestsPerSecond: 4,
    maxRateLimitRetries: 2,
    now: () => now,
    random: () => 0,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });
  assert.deepEqual(await transport.request("/test"), { ok: true });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [10_000, 20_000]);
});

test("paced transport serializes concurrent request starts", async () => {
  let now = 0;
  const starts: number[] = [];
  const transport = pacedTransport({
    async request<T>(): Promise<T> {
      starts.push(now);
      return {} as T;
    },
  }, {
    requestsPerSecond: 4,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  });
  await Promise.all([transport.request("/a"), transport.request("/b"), transport.request("/c")]);
  assert.deepEqual(starts, [0, 250, 500]);
});
