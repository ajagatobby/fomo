import assert from "node:assert/strict";
import test from "node:test";
import {
  FomoDirectSession,
  type FomoApiResponse,
  type FomoCredentials,
  type FomoWebSocket,
} from "../src/fomo/auth.ts";
import {
  FomoClient,
  publicEmails,
  publicProfileResponse,
  type FomoJsonTransport,
} from "../src/fomo/client.ts";
import { postWebhook, webhookSignature, type FomoWatchWebhookPayload } from "../src/fomo/webhook.ts";
import type { FomoSwap, FomoUser } from "../src/fomo/types.ts";

const user: FomoUser = {
  id: "user-1",
  userHandle: "alpha",
  displayName: "Alpha",
  clan: { id: "clan-1", name: "Wizards" },
};

function unsignedJwt(exp: number, audience: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp, aud: audience, iss: "privy.io" })}.signature`;
}

function rawSwap(id: string) {
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    inNetworkId: 8453,
    outNetworkId: 8453,
    inTokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    outTokenAddress: "0xtoken",
    inTradeId: `in-${id}`,
    outTradeId: `out-${id}`,
    inHumanAmount: "10",
    outHumanAmount: "100",
    humanUsdAmountIn: "10",
    humanUsdAmountOut: "9.9",
  };
}

test("Fomo client resolves users and paginates swaps", async () => {
  const paths: string[] = [];
  const transport: FomoJsonTransport = {
    async request<T>(requestPath: string): Promise<T> {
      paths.push(requestPath);
      if (requestPath.includes("userHandle")) {
        return { success: true, statusCode: 200, responseObject: {
          id: user.id, userHandle: user.userHandle, displayName: user.displayName, clan: user.clan,
        } } as T;
      }
      const second = requestPath.includes("lastSwapIdV2");
      return {
        success: true,
        statusCode: 200,
        responseObject: { swaps: [rawSwap(second ? "swap-2" : "swap-1")], hasNextPage: !second },
      } as T;
    },
  };
  const client = new FomoClient(transport);
  const resolved = await client.resolveUser("@alpha");
  const swaps = await client.allSwaps(resolved.data, 3);
  assert.equal(swaps.items.length, 2);
  assert.equal(swaps.truncated, false);
  assert.match(paths[2], /lastSwapIdV2=swap-1/);
  assert.equal(swaps.items[0].inNetworkId, "8453");
});

test("Fomo client fetches a bounded recent-swap page for watching", async () => {
  let requestedPath = "";
  const client = new FomoClient({
    async request<T>(requestPath: string): Promise<T> {
      requestedPath = requestPath;
      return {
        success: true,
        statusCode: 200,
        responseObject: { swaps: [rawSwap("swap-watch")], hasNextPage: true },
      } as T;
    },
  });
  const result = await client.recentSwaps(user, 25);
  assert.equal(requestedPath, "/v2/users/user-1/swaps?limit=25");
  assert.equal(result.data.items[0].id, "swap-watch");
  assert.equal(result.data.hasNextPage, true);
});

test("Fomo client resolves the authenticated current user", async () => {
  let requestedPath = "";
  const client = new FomoClient({
    async request<T>(requestPath: string): Promise<T> {
      requestedPath = requestPath;
      return { success: true, statusCode: 200, responseObject: user } as T;
    },
  });
  const result = await client.currentUser();
  assert.equal(requestedPath, "/v2/users/current");
  assert.equal(result.data.userHandle, "alpha");
});

test("Fomo client fetches and filters the authenticated activity alert feed", async () => {
  let requestedPath = "";
  const client = new FomoClient({
    async request<T>(requestPath: string): Promise<T> {
      requestedPath = requestPath;
      return { success: true, statusCode: 200, responseObject: {
        items: [{
          id: "alert-1",
          type: "multi_user_buy",
          createdAt: "2026-08-16T22:02:32.830Z",
          tokenAddress: "0xtoken",
          networkId: 8453,
          body: { ticker: "TEST", totalVolume: 1234.5 },
          likes: 2,
          views: 10,
          pinned: false,
        }],
        hasNextPage: true,
      } } as T;
    },
  });
  const result = await client.tradingAlerts({
    limit: 25,
    lastId: "alert-0",
    threshold: 100,
    minEquity: 500,
    minMarketCap: 1_000,
    maxMarketCap: 1_000_000,
  });
  assert.equal(
    requestedPath,
    "/feed/tradingActivity?limit=25&lastId=alert-0&threshold=100&minEquity=500&minMarketCap=1000&maxMarketCap=1000000",
  );
  assert.equal(result.data.items[0].networkId, "8453");
  assert.equal(result.data.items[0].body.ticker, "TEST");
  assert.equal(result.data.hasNextPage, true);
});

test("Fomo client validates alert feed filters", async () => {
  const client = new FomoClient({ async request<T>(): Promise<T> { throw new Error("unexpected request"); } });
  await assert.rejects(
    client.tradingAlerts({ minMarketCap: 10, maxMarketCap: 5 }),
    /minMarketCap cannot exceed maxMarketCap/,
  );
  await assert.rejects(client.tradingAlerts({ threshold: -1 }), /non-negative number/);
});

test("Fomo client resolves public profile details in a partial batch", async () => {
  const response = { success: true, statusCode: 200, responseObject: {
    id: "user-1", userHandle: "alpha", description: "Contact Alpha@Example.com",
    twitter: "https://x.com/alpha", private: false,
  } };
  const client = new FomoClient({
    async request<T>(): Promise<T> { return response as T; },
    async requestMany<T>(): Promise<Array<T | null>> { return [response as T, null]; },
  });
  const profiles = await client.resolveUsers(["alpha", "missing"]);
  assert.equal(profiles[0]?.twitter, "https://x.com/alpha");
  assert.equal(profiles[0]?.private, false);
  assert.equal(profiles[1], null);
});

test("public email extraction only reads explicit addresses from profile text", () => {
  assert.deepEqual(
    publicEmails("DM me or email Alpha@Example.com and alpha@example.com."),
    ["alpha@example.com"],
  );
  assert.deepEqual(publicEmails("alpha [at] example dot com"), []);
  assert.deepEqual(publicEmails(null), []);
});

test("public profile export removes account-secret fields recursively", () => {
  assert.deepEqual(publicProfileResponse({
    success: true,
    responseObject: {
      userHandle: "alpha",
      description: "public bio",
      email: "private@example.com",
      nested: { refresh_token: "secret", twitter: "alpha" },
    },
  }), {
    success: true,
    responseObject: {
      userHandle: "alpha",
      description: "public bio",
      nested: { twitter: "alpha" },
    },
  });
});

test("Fomo client marks swap history truncated at the page cap", async () => {
  const client = new FomoClient({
    async request<T>(): Promise<T> {
      return {
        success: true,
        statusCode: 200,
        responseObject: { swaps: [rawSwap("swap-1")], hasNextPage: true },
      } as T;
    },
  });
  const result = await client.allSwaps(user, 1);
  assert.equal(result.truncated, true);
});

test("Fomo client deduplicates overlapping swap pages", async () => {
  let page = 0;
  const client = new FomoClient({
    async request<T>(): Promise<T> {
      page++;
      return {
        success: true,
        statusCode: 200,
        responseObject: {
          swaps: page === 1 ? [rawSwap("swap-1")] : [rawSwap("swap-1"), rawSwap("swap-2")],
          hasNextPage: page === 1,
        },
      } as T;
    },
  });

  const result = await client.allSwaps(user, 3);

  assert.deepEqual(result.items.map((swap) => swap.id), ["swap-1", "swap-2"]);
});

test("Fomo client parses official trader and clan leaderboards", async () => {
  const transport: FomoJsonTransport = {
    async request<T>(requestPath: string): Promise<T> {
      let responseObject: unknown;
      if (requestPath.startsWith("/v2/leaderboard/7d")) {
        responseObject = { leaderboard: [{
          id: "user-1", userHandle: "alpha", displayName: "Alpha",
          address: "11111111111111111111111111111111",
          evmAddress: "0x1111111111111111111111111111111111111111",
          pnl7d: 1250.5, numTrades: 12, totalVolume: 5000, totalHoldings: 400,
          clan: { id: "clan-1", name: "Wizards" },
        }] };
      } else if (requestPath === "/v2/clans/leaderboard?window=7d") {
        responseObject = { leaderboard: [{
          id: "clan-1", rank: 2, name: "Wizards", memberCount: 3, pnl: 800,
        }] };
      } else if (requestPath === "/v2/clans/clan-1?window=7d") {
        responseObject = {
          id: "clan-1", rank: 2, name: "Wizards", memberCount: 3, pnl: 800, tradeCount: 20,
          members: [{ user: { id: "user-1", userHandle: "alpha" }, pnl: 700, role: "owner" }],
          topTokens: [{ tokenAddress: "0xtoken", networkId: 8453, symbol: "MAGIC", pnl: 600 }],
        };
      } else {
        throw new Error(`Unexpected request: ${requestPath}`);
      }
      return { success: true, statusCode: 200, responseObject } as T;
    },
  };
  const client = new FomoClient(transport);
  const leaderboard = await client.leaderboard("7d", 10);
  assert.equal(leaderboard.data[0].pnl, 1250.5);
  assert.equal(leaderboard.data[0].user.clan?.name, "Wizards");
  const clans = await client.clanLeaderboard("7d");
  assert.equal(clans.data[0].rank, 2);
  const clan = await client.clan("clan-1", "7d");
  assert.equal(clan.data.members[0].user.clan?.id, "clan-1");
  assert.equal(clan.data.topTokens[0].networkId, "8453");
});

test("Fomo client parses cumulative PnL snapshots for custom windows", async () => {
  const client = new FomoClient({
    async request<T>(requestPath: string): Promise<T> {
      assert.match(requestPath, /^\/v2\/userTokens\/aggregatedSnapshot\?/);
      return { success: true, statusCode: 200, responseObject: [
        { snapshotId: 200, equity: 1200, pnl: 300 },
        { snapshotId: 100, equity: 1000, pnl: 100 },
      ] } as T;
    },
  });
  const result = await client.pnlHistory("user-1", new Date(Date.now() - 2 * 86_400_000));
  assert.deepEqual(result.data.map((snapshot) => snapshot.timestamp), [100, 200]);
  assert.equal(result.data.at(-1)!.pnl - result.data[0].pnl, 200);
});

test("Fomo client keeps partial custom-window histories when a batch item fails", async () => {
  const envelope = {
    success: true,
    statusCode: 200,
    responseObject: [{ snapshotId: 100, equity: 1000, pnl: 100 }],
  };
  const client = new FomoClient({
    async request<T>(): Promise<T> { return envelope as T; },
    async requestMany<T>(): Promise<Array<T | null>> { return [envelope as T, null]; },
  });
  const histories = await client.pnlHistories(
    ["user-1", "user-2"],
    new Date(Date.now() - 2 * 86_400_000),
  );
  assert.equal(histories.size, 1);
  assert.equal(histories.has("user-1"), true);
  assert.equal(histories.has("user-2"), false);
});

test("Fomo session refreshes an expired app token before API requests", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const oldToken = unsignedJwt(now / 1_000 - 1, "fomo");
  const newToken = unsignedJwt(now / 1_000 + 3_600, "fomo");
  const credentials: FomoCredentials = {
    version: 1,
    appToken: oldToken,
    privyAccessToken: "old-privy-token",
    refreshToken: "old-refresh-token",
    caId: "client-auth-id",
    supportedChains: "1,56,8453,1399811149",
  };
  const saved: FomoCredentials[] = [];
  let authorization = "";
  const apiRequester = async (
    _url: string,
    headers: Record<string, string>,
  ): Promise<FomoApiResponse> => {
    authorization = headers.authorization;
    return {
      httpStatus: 200,
      body: { success: true, statusCode: 200, responseObject: { ok: true } },
      retryAfter: null,
    };
  };
  const session = new FomoDirectSession(credentials, {
    now: () => now,
    fetcher: async () => new Response(JSON.stringify({
      token: newToken,
      privy_access_token: "new-privy-token",
      refresh_token: "new-refresh-token",
    }), { status: 200, headers: { "content-type": "application/json" } }),
    apiRequester,
    saveCredentials: async (value) => { saved.push(value); },
  });

  try {
    const response = await session.request<{ responseObject: { ok: boolean } }>("/test");
    assert.equal(response.responseObject.ok, true);
    assert.equal(authorization, `Bearer ${newToken}`);
    assert.equal(saved[0]?.appToken, newToken);
    assert.equal(saved[0]?.refreshToken, "new-refresh-token");
  } finally {
    await session.close();
  }
});

test("Fomo session selects the login email without returning Privy identity tokens", async () => {
  const credentials: FomoCredentials = {
    version: 1,
    appToken: unsignedJwt(Date.now() / 1_000 + 3_600, "fomo"),
    privyAccessToken: "privy-token",
    refreshToken: "refresh-token",
    caId: "client-auth-id",
    supportedChains: "1,56,8453,1399811149",
  };
  let requestedUrl = "";
  const session = new FomoDirectSession(credentials, {
    fetcher: async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        user: {
          id: "privy-user-1",
          linked_accounts: [{ type: "apple_oauth", email: "relay@example.com" }],
        },
        identity_token: { token: "must-not-escape" },
      }), { status: 200 });
    },
    saveCredentials: async () => undefined,
  });
  try {
    assert.deepEqual(await session.loginIdentity(), {
      privyUserId: "privy-user-1",
      email: "relay@example.com",
      method: "apple",
    });
    assert.equal(requestedUrl, "https://auth.privy.io/api/v1/users/me");
  } finally {
    await session.close();
  }
});

test("Fomo session authenticates and subscribes to realtime trading activity", async () => {
  class FakeWebSocket implements FomoWebSocket {
    readonly sent: string[] = [];
    readonly listeners = new Map<string, Set<(event: any) => void>>();

    send(data: string): void { this.sent.push(data); }
    close(): void { this.emit("close", {}); }
    addEventListener(type: string, listener: (event: any) => void): void {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: (event: any) => void): void {
      this.listeners.get(type)?.delete(listener);
    }
    emit(type: string, event: any): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }
  const socket = new FakeWebSocket();
  const credentials: FomoCredentials = {
    version: 1,
    appToken: unsignedJwt(Date.now() / 1_000 + 3_600, "fomo"),
    privyAccessToken: "privy-token",
    refreshToken: "refresh-token",
    caId: "client-auth-id",
    supportedChains: "1,56,8453,1399811149",
  };
  const session = new FomoDirectSession(credentials, {
    webSocketFactory: () => socket,
    saveCredentials: async () => undefined,
  });
  const controller = new AbortController();
  const activities: Record<string, unknown>[] = [];
  const states: string[] = [];
  const stream = session.streamTradingActivity(
    "user-1",
    (activity) => { activities.push(activity); },
    controller.signal,
    (state) => { states.push(state); },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  socket.emit("open", {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(socket.sent[0]).type, "challengeResponse");
  socket.emit("message", { data: JSON.stringify({ type: "challengeAccepted" }) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), {
    type: "subscribe",
    topicType: "trading_activity",
    topicId: "user-1",
  });
  socket.emit("message", { data: JSON.stringify({
    type: "subscribed", topicType: "trading_activity", topicId: "user-1",
  }) });
  socket.emit("message", { data: JSON.stringify({
    type: "data", topicType: "trading_activity", topicId: "user-1",
    payload: { id: "activity-1", type: "swap_buy" },
  }) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await stream;
  await session.close();
  assert.equal(states.includes("connected"), true);
  assert.equal(activities[0].id, "activity-1");
});

test("Fomo watcher signs and retries webhook deliveries", async () => {
  const swap: FomoSwap = {
    id: "swap-1",
    userId: "user-1",
    userHandle: "alpha",
    createdAt: "2026-01-01T00:00:00.000Z",
    inNetworkId: "8453",
    outNetworkId: "8453",
    inTokenAddress: "0xusdc",
    outTokenAddress: "0xtoken",
    inTradeId: "trade-in",
    outTradeId: "trade-out",
    inHumanAmount: "10",
    outHumanAmount: "100",
    humanUsdAmountIn: "10",
    humanUsdAmountOut: "9.9",
  };
  const payload: FomoWatchWebhookPayload = {
    version: 1,
    event: "fomo.swap",
    occurredAt: swap.createdAt,
    deliveredAt: "2026-01-01T00:00:01.000Z",
    profile: { id: user.id, userHandle: user.userHandle, displayName: user.displayName },
    swap,
  };
  let attempts = 0;
  let requestHeaders: Headers | null = null;
  const fetcher = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    attempts++;
    requestHeaders = new Headers(init?.headers);
    return new Response(null, { status: attempts === 1 ? 500 : 204 });
  }) as typeof fetch;
  await postWebhook("https://hooks.example.test/fomo?token=hidden", payload, {
    secret: "test-secret",
    fetcher,
    retryDelayMs: 0,
    now: () => 1_700_000_000_000,
  });
  assert.equal(attempts, 2);
  assert.equal(requestHeaders!.get("x-fomo-delivery"), "swap-1");
  assert.equal(
    requestHeaders!.get("x-fomo-signature"),
    webhookSignature(JSON.stringify(payload), "test-secret", "1700000000"),
  );
  await assert.rejects(
    postWebhook("http://hooks.example.test/fomo", payload, { fetcher }),
    /must use HTTPS/,
  );
});

test("Fomo session preserves refresh credentials when Privy only rotates the app token", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const newToken = unsignedJwt(now / 1_000 + 3_600, "fomo");
  const credentials: FomoCredentials = {
    version: 1,
    appToken: unsignedJwt(now / 1_000 - 1, "fomo"),
    privyAccessToken: "existing-privy-token",
    refreshToken: "existing-refresh-token",
    caId: "client-auth-id",
    supportedChains: "1,56,8453,1399811149",
  };
  const saved: FomoCredentials[] = [];
  const session = new FomoDirectSession(credentials, {
    now: () => now,
    fetcher: async () => new Response(JSON.stringify({ token: newToken }), { status: 200 }),
    apiRequester: async () => ({
      httpStatus: 200,
      body: { success: true, statusCode: 200, responseObject: {} },
      retryAfter: null,
    }),
    saveCredentials: async (value) => { saved.push(value); },
  });

  try {
    await session.request("/test");
    assert.equal(saved[0]?.privyAccessToken, "existing-privy-token");
    assert.equal(saved[0]?.refreshToken, "existing-refresh-token");
  } finally {
    await session.close();
  }
});

test("Fomo session serializes concurrent token refreshes", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const credentials: FomoCredentials = {
    version: 1,
    appToken: unsignedJwt(now / 1_000 - 1, "fomo"),
    privyAccessToken: "privy-token",
    refreshToken: "refresh-token",
    caId: "client-auth-id",
    supportedChains: "1,56,8453,1399811149",
  };
  let refreshes = 0;
  const session = new FomoDirectSession(credentials, {
    now: () => now,
    fetcher: async () => {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ token: unsignedJwt(now / 1_000 + 3_600, "fomo") }), { status: 200 });
    },
    apiRequester: async () => ({
      httpStatus: 200,
      body: { success: true, statusCode: 200, responseObject: {} },
      retryAfter: null,
    }),
    saveCredentials: async () => undefined,
  });
  try {
    await Promise.all([session.request("/one"), session.request("/two"), session.request("/three")]);
    assert.equal(refreshes, 1);
  } finally {
    await session.close();
  }
});

test("Fomo session refreshes after a non-JSON 401 response", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const credentials: FomoCredentials = {
    version: 1,
    appToken: unsignedJwt(now / 1_000 + 3_600, "fomo"),
    privyAccessToken: "privy-token",
    refreshToken: "refresh-token",
    caId: "client-auth-id",
    supportedChains: "1,56,8453,1399811149",
  };
  let requests = 0;
  let refreshes = 0;
  const session = new FomoDirectSession(credentials, {
    now: () => now,
    fetcher: async () => {
      refreshes++;
      return new Response(JSON.stringify({ token: unsignedJwt(now / 1_000 + 7_200, "fomo") }), { status: 200 });
    },
    apiRequester: async () => {
      requests++;
      return requests === 1
        ? { httpStatus: 401, body: null, retryAfter: null }
        : { httpStatus: 200, body: { success: true, statusCode: 200 }, retryAfter: null };
    },
    saveCredentials: async () => undefined,
  });
  try {
    await session.request("/test");
    assert.equal(refreshes, 1);
    assert.equal(requests, 2);
  } finally {
    await session.close();
  }
});
