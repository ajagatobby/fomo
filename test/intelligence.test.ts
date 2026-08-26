import assert from "node:assert/strict";
import test from "node:test";
import type { FomoSwap, ResearchDataset, ResearchUser } from "../src/fomo/types.ts";
import { analyzeTrader, rankTraders } from "../src/intel/traders.ts";
import { generatePatternGrid, screenPatterns } from "../src/intel/patterns.ts";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "0x1111111111111111111111111111111111111111";
const start = Date.parse("2026-01-01T00:00:00Z");

const user: ResearchUser = {
  id: "user-1", userHandle: "alpha", handle: "alpha", displayName: "Alpha",
  clanId: "clan-1", clanName: "Wizards", address: null, evmAddress: null,
};

function swap(id: string, day: number, side: "buy" | "sell", tokenAmount: number, usd: number): FomoSwap {
  return {
    id, userId: user.id, userHandle: user.userHandle,
    createdAt: new Date(start + day * 86_400_000).toISOString(),
    inNetworkId: "8453", outNetworkId: "8453",
    inTokenAddress: side === "buy" ? USDC : TOKEN,
    outTokenAddress: side === "buy" ? TOKEN : USDC,
    inTradeId: null, outTradeId: null,
    inHumanAmount: String(side === "buy" ? usd : tokenAmount),
    outHumanAmount: String(side === "buy" ? tokenAmount : usd),
    humanUsdAmountIn: String(side === "buy" ? usd : usd - 1),
    humanUsdAmountOut: String(side === "sell" ? usd : usd - 1),
  };
}

const swaps = [
  swap("train-buy", 1, "buy", 100, 100),
  swap("train-sell", 2, "sell", 100, 140),
  swap("test-buy", 6, "buy", 100, 100),
  swap("test-sell", 7, "sell", 100, 130),
];
const dataset: ResearchDataset = { users: [user], swaps };

test("average-cost trader metrics produce covered realized outcomes", () => {
  const analysis = analyzeTrader(user, swaps, { since: start, until: start + 10 * 86_400_000 });
  assert.equal(analysis.metrics.closedOutcomeCount, 2);
  assert.equal(analysis.metrics.realizedPnlUsd, 70);
  assert.equal(analysis.metrics.basisCoverage, 1);
  const ranked = rankTraders(dataset, { since: start, until: start + 10 * 86_400_000 }, {
    minTrades: 0, minClosed: 0, minActiveDays: 0, minBasisCoverage: 0,
  });
  assert.equal(ranked[0].eligible, true);
});

test("Fomo numeric Solana cash legs classify cross-chain trades", () => {
  const buy = { ...swap("cross-buy", 1, "buy", 100, 100), inNetworkId: "1399811149", inTokenAddress: SOLANA_USDC };
  const sell = { ...swap("cross-sell", 2, "sell", 100, 140), outNetworkId: "1399811149", outTokenAddress: SOLANA_USDC };
  const analysis = analyzeTrader(user, [buy, sell], { since: start, until: start + 3 * 86_400_000 });
  assert.equal(analysis.metrics.buyCount, 1);
  assert.equal(analysis.metrics.sellCount, 1);
  assert.equal(analysis.metrics.realizedPnlUsd, 40);
});

test("default strategy grid contains thousands of deterministic patterns", () => {
  const first = generatePatternGrid();
  const second = generatePatternGrid();
  assert.equal(first.length, 19_683);
  assert.equal(first[0].id, second[0].id);
});

test("retrospective screening accepts a fresh in-memory dataset without observation fields", () => {
  const result = screenPatterns(dataset, {
    window: { since: start, until: start + 10 * 86_400_000 },
    grid: {
      lookbackDays: [30], minClosed: [1], minWinRate: [0.4], minProfitFactor: [1],
      maxDrawdownPct: [100], topTraders: [1], positionUsd: [100], slippageBps: [0], delaySeconds: [0],
    },
    roundTripFeeBps: 0,
  });
  assert.equal(result.label, "retrospective");
  assert.equal(result.results[0].tradeCount, 2);
  assert.ok(result.results[0].netPnlUsd > 0);
});
