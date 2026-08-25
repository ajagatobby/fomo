import assert from "node:assert/strict";
import test from "node:test";
import { canonicalTokenKey, fetchTokenMarkets } from "../src/fomo/markets.ts";
import { evaluateTokenSignals, type SignalTrader, type TokenSignalOptions } from "../src/intel/signals.ts";
import type { NormalizedTradeEvent } from "../src/intel/traders.ts";

const now = Date.parse("2026-08-17T12:00:00.000Z");
const token = "0x1111111111111111111111111111111111111111";
const tokenKey = `8453:${token}`;
const traders: SignalTrader[] = [
  { userId: "a", handle: "alpha", clanId: "clan-a", reliability: 0.8, score: 1.2 },
  { userId: "b", handle: "beta", clanId: "clan-b", reliability: 0.7, score: 1.1 },
];
const options: TokenSignalOptions = {
  since: now - 15 * 60_000,
  until: now,
  maxObservationLagSeconds: 300,
  minTraders: 2,
  minBuyUsd: 100,
  minNetBuyUsd: 500,
  maxSellRatio: 0.35,
  minUsdCoverage: 0.8,
  minLiquidityUsd: 50_000,
  minPairAgeHours: 24,
};
const markets = new Map([[tokenKey, {
  tokenKey,
  networkId: "8453",
  tokenAddress: token,
  symbol: "MEME",
  name: "Meme",
  priceUsd: 0.01,
  liquidityUsd: 100_000,
  marketCapUsd: 1_000_000,
  fdvUsd: 1_000_000,
  pairCreatedAt: now - 48 * 3_600_000,
  pairUrl: "https://dexscreener.com/base/pair",
}]]);

test("two timely independent reliable buyers produce a blocked research signal", () => {
  const signals = evaluateTokenSignals([
    event("buy-a", "a", "buy", 300, 120),
    event("buy-b", "b", "buy", 350, 60),
  ], traders, markets, [], options);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].researchSignal, true);
  assert.equal(signals[0].actionableBuyNow, false);
  assert.equal(signals[0].buyers.length, 2);
  assert.equal(signals[0].netBuyUsd, 650);
  assert.ok(signals[0].blockedBy.includes("sellabilityUnknown"));
});

test("correlated buyers, sell pressure, and late observations are rejected", () => {
  const sameClan = traders.map((trader) => ({ ...trader, clanId: "same" }));
  const correlated = evaluateTokenSignals([
    event("buy-a", "a", "buy", 500, 30),
    event("buy-b", "b", "buy", 500, 30),
  ], sameClan, markets, [], options)[0];
  assert.equal(correlated.researchSignal, false);
  assert.match(correlated.rejectionReasons.join(" "), /independent buyer groups/);

  const selling = evaluateTokenSignals([
    event("buy-a", "a", "buy", 500, 30),
    event("buy-b", "b", "buy", 500, 30),
    event("sell-a", "a", "sell", 500, 30),
  ], traders, markets, [], options)[0];
  assert.equal(selling.researchSignal, false);
  assert.match(selling.rejectionReasons.join(" "), /sell\/buy ratio/);

  const late = evaluateTokenSignals([event("late", "a", "buy", 1_000, 600)], traders, markets, [], options);
  assert.deepEqual(late, []);
});

test("market enrichment preserves case-sensitive Solana addresses", async () => {
  const mint = "AbCdEfGhijkLMNopQRstuVwxyz123456789ABCDE";
  let requestedUrl = "";
  const result = await fetchTokenMarkets([{ networkId: "1399811149", tokenAddress: mint }], async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      async json() {
        return [{
          baseToken: { address: mint, symbol: "SOLMEME", name: "Sol Meme" },
          priceUsd: "0.02",
          liquidity: { usd: 75_000 },
          marketCap: 500_000,
          fdv: 600_000,
          pairCreatedAt: now - 2 * 86_400_000,
          url: "https://dexscreener.com/solana/pair",
        }];
      },
    };
  });
  assert.match(requestedUrl, new RegExp(mint));
  assert.equal(result.get(canonicalTokenKey("solana", mint)!)?.symbol, "SOLMEME");
});

function event(
  id: string,
  userId: string,
  side: "buy" | "sell",
  cashUsd: number,
  observedDelaySeconds: number,
): NormalizedTradeEvent {
  const eventTime = now - 2 * 60_000;
  return {
    id,
    userId,
    userHandle: userId,
    eventTime,
    observedTime: eventTime + observedDelaySeconds * 1_000,
    side,
    networkId: "8453",
    tokenAddress: token,
    tokenKey,
    tokenAmount: 100,
    cashUsd,
    copyDelaySeconds: observedDelaySeconds,
    swap: {
      id,
      userId,
      userHandle: userId,
      createdAt: new Date(eventTime).toISOString(),
      observedAt: new Date(eventTime + observedDelaySeconds * 1_000).toISOString(),
      inNetworkId: "8453",
      outNetworkId: "8453",
      inTokenAddress: side === "buy" ? "USDC" : token,
      outTokenAddress: side === "buy" ? token : "USDC",
      inTradeId: null,
      outTradeId: null,
      inHumanAmount: "100",
      outHumanAmount: "100",
      humanUsdAmountIn: String(cashUsd),
      humanUsdAmountOut: String(cashUsd),
    },
  };
}
