import assert from "node:assert/strict";
import test from "node:test";
import { networkName, tokenKey, tokenUrl } from "../src/fomo/networks.ts";
import type { FomoSwap } from "../src/fomo/types.ts";
import { buyEvents, clusterBuys, harvestTokenSymbols } from "../src/intel/convergence.ts";

const SOLANA = "1399811149";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ROBINHOOD_USDC = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const MEME = "FZqdw6oSDCbHtKYxmhnfbi97SnyVy8jaYpdCoMrrjKa2";
const start = Date.parse("2026-08-26T01:00:00Z");

function swap(overrides: Partial<FomoSwap> & { id: string }): FomoSwap {
  return {
    userId: "u1", userHandle: "alpha",
    createdAt: new Date(start).toISOString(),
    inNetworkId: SOLANA, outNetworkId: SOLANA,
    inTokenAddress: SOLANA_USDC, outTokenAddress: MEME,
    inTradeId: null, outTradeId: null,
    inHumanAmount: "100", outHumanAmount: "1000",
    humanUsdAmountIn: "100", humanUsdAmountOut: "100",
    ...overrides,
  };
}

function buy(userId: string, handle: string, minute: number, usd: number, token = MEME): FomoSwap {
  return swap({
    id: `${userId}-${minute}-${token}`, userId, userHandle: handle,
    createdAt: new Date(start + minute * 60_000).toISOString(),
    outTokenAddress: token, humanUsdAmountIn: String(usd),
  });
}

test("buyEvents keeps cash-to-token swaps and drops the reverse", () => {
  const events = buyEvents([
    buy("u1", "alpha", 0, 100),
    swap({ id: "sell", inTokenAddress: MEME, outTokenAddress: SOLANA_USDC }),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].tokenAddress, MEME);
  assert.equal(events[0].usd, 100);
});

test("buyEvents recognizes cross-chain entries", () => {
  const events = buyEvents([swap({
    id: "cross", inNetworkId: SOLANA, inTokenAddress: SOLANA_USDC,
    outNetworkId: "4663", outTokenAddress: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18",
  })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].networkId, "4663");
});

test("buyEvents recognizes same-chain entries on Robinhood and Monad", () => {
  const events = buyEvents([
    swap({
      id: "rh", inNetworkId: "4663", inTokenAddress: ROBINHOOD_USDC,
      outNetworkId: "4663", outTokenAddress: "0xaaaa000000000000000000000000000000000001",
    }),
    swap({
      id: "monad", inNetworkId: "143", inTokenAddress: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
      outNetworkId: "143", outTokenAddress: "0xbbbb000000000000000000000000000000000002",
    }),
  ]);
  assert.deepEqual(new Set(events.map((event) => event.networkId)), new Set(["4663", "143"]));
});

test("clusterBuys counts distinct traders, not buy events", () => {
  const events = buyEvents([
    buy("u1", "alpha", 1, 100), buy("u1", "alpha", 2, 400), buy("u2", "beta", 3, 250),
  ]);
  const [cluster] = clusterBuys(events, { since: start, until: start + 10 * 60_000 });
  assert.equal(cluster.distinctTraders, 2);
  assert.equal(cluster.buyCount, 3);
  assert.equal(cluster.totalUsd, 750);
  assert.equal(cluster.traders[0].handle, "alpha");
  assert.equal(cluster.traders[0].buys, 2);
});

test("clusterBuys excludes buys outside the window", () => {
  const events = buyEvents([buy("u1", "alpha", 0, 100), buy("u2", "beta", 90, 100)]);
  const clusters = clusterBuys(events, { since: start + 60 * 60_000, until: start + 120 * 60_000 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].distinctTraders, 1);
  assert.equal(clusters[0].traders[0].handle, "beta");
});

test("clusterBuys applies the minimum trader floor", () => {
  const events = buyEvents([buy("u1", "alpha", 1, 100), buy("u2", "beta", 2, 100)]);
  const window = { since: start, until: start + 10 * 60_000 };
  assert.equal(clusterBuys(events, { ...window, minTraders: 2 }).length, 1);
  assert.equal(clusterBuys(events, { ...window, minTraders: 3 }).length, 0);
});

test("clusterBuys ranks by trader count first and capital second", () => {
  const other = "So11111111111111111111111111111111111111113";
  const events = buyEvents([
    buy("u1", "alpha", 1, 50), buy("u2", "beta", 2, 50),
    buy("u3", "gamma", 3, 90_000, other),
  ]);
  const clusters = clusterBuys(events, { since: start, until: start + 10 * 60_000 });
  assert.equal(clusters[0].distinctTraders, 2);
  assert.equal(clusters[1].totalUsd, 90_000);
});

test("clusterBuys reports unpriced buys without inflating committed capital", () => {
  const priced = buy("u1", "alpha", 1, 100);
  const unpriced = swap({
    id: "no-usd", userId: "u2", userHandle: "beta",
    createdAt: new Date(start + 120_000).toISOString(), humanUsdAmountIn: null,
  });
  const [cluster] = clusterBuys(buyEvents([priced, unpriced]), { since: start, until: start + 10 * 60_000 });
  assert.equal(cluster.totalUsd, 100);
  assert.equal(cluster.unpricedBuys, 1);
});

test("clusterBuys attaches leaderboard sources and a token link", () => {
  const events = buyEvents([buy("u1", "alpha", 1, 100)]);
  const [cluster] = clusterBuys(
    events, { since: start, until: start + 10 * 60_000 },
    new Map([[tokenKey(SOLANA, MEME), "Pistacio"]]),
    new Map([["u1", ["24h#3"]]]),
  );
  assert.equal(cluster.symbol, "Pistacio");
  assert.equal(cluster.url, `https://fomo.family/tokens/solana/${MEME}`);
  assert.deepEqual(cluster.traders[0].sources, ["24h#3"]);
});

test("clusterBuys rejects an inverted window", () => {
  assert.throws(() => clusterBuys([], { since: start + 1, until: start }), RangeError);
});

test("harvestTokenSymbols reads balance and trade payloads", () => {
  const symbols = harvestTokenSymbols({
    balances: [{
      balance: { tokenAddress: MEME },
      tokenFilterResult: { token: { address: MEME, networkId: 1399811149, symbol: "Pistacio" } },
    }],
    activeTrades: [{
      trade: { tokenAddress: BASE_USDC, networkId: 8453, tokenMetadata: { symbol: "USDC", networkId: 8453 } },
    }],
  });
  assert.equal(symbols.get(tokenKey(SOLANA, MEME)), "Pistacio");
  assert.equal(symbols.get(tokenKey("8453", BASE_USDC)), "USDC");
});

test("harvestTokenSymbols survives cyclic payloads", () => {
  const node: Record<string, unknown> = { token: { address: MEME, networkId: 1399811149, symbol: "Pistacio" } };
  node.self = node;
  assert.equal(harvestTokenSymbols(node).get(tokenKey(SOLANA, MEME)), "Pistacio");
});

test("token keys respect Solana case sensitivity and EVM case folding", () => {
  assert.notEqual(tokenKey(SOLANA, MEME), tokenKey(SOLANA, MEME.toLowerCase()));
  assert.equal(tokenKey("8453", BASE_USDC.toUpperCase()), tokenKey("8453", BASE_USDC));
});

test("tokenUrl only links networks Fomo routes", () => {
  assert.equal(tokenUrl("56", "0xabc"), "https://fomo.family/tokens/bnb/0xabc");
  assert.equal(tokenUrl("4663", "0xabc"), "https://fomo.family/tokens/robinhood/0xabc");
  assert.equal(tokenUrl("999999", "0xabc"), null);
  assert.equal(tokenUrl(SOLANA, ""), null);
  assert.equal(networkName("4663"), "Robinhood");
});
