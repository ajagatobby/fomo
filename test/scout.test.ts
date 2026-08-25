import assert from "node:assert/strict";
import test from "node:test";
import type { FomoUser } from "../src/fomo/types.ts";
import {
  addScoutCandidate,
  recommendScoutTraders,
  selectScoutCandidates,
} from "../src/intel/scout.ts";
import { rankTraders } from "../src/intel/traders.ts";
import type { ResearchDataset } from "../src/fomo/types.ts";

const alpha: FomoUser = { id: "a", userHandle: "alpha", displayName: "Alpha", clan: null };
const beta: FomoUser = { id: "b", userHandle: "beta", displayName: "Beta", clan: null };

test("scout universe deduplicates sources and prioritizes official rank", () => {
  const candidates = new Map();
  addScoutCandidate(candidates, beta, "clan", { clanRank: 1 });
  addScoutCandidate(candidates, alpha, "leaderboard", { window: "24h", officialRank: 8 });
  addScoutCandidate(candidates, { ...alpha, clan: { id: "c", name: "Clan" } }, "clan", { clanRank: 2 });
  const selected = selectScoutCandidates(candidates.values(), 2);
  assert.deepEqual(selected.map((candidate) => candidate.user.id), ["a", "b"]);
  assert.deepEqual(selected[0].sources, ["leaderboard", "clan"]);
  assert.equal(selected[0].user.clan?.name, "Clan");
});

test("scout recommendations gate candidates on completeness", () => {
  const start = Date.parse("2026-01-01T00:00:00Z");
  const stored = {
    id: alpha.id,
    userHandle: alpha.userHandle,
    handle: alpha.userHandle,
    displayName: alpha.displayName,
    clanId: null,
    clanName: null,
    address: null,
    evmAddress: null,
    firstObservedAt: new Date(start).toISOString(),
    syncedAt: new Date(start).toISOString(),
  };
  const swaps = [
    swap("buy-1", 1, "buy", 100), swap("sell-1", 2, "sell", 150),
    swap("buy-2", 3, "buy", 100), swap("sell-2", 4, "sell", 140),
  ];
  const dataset: ResearchDataset = { users: [stored], swaps };
  const ranked = rankTraders(dataset, { since: start, until: start + 5 * 86_400_000 }, {
    minTrades: 0,
    minClosed: 1,
    minActiveDays: 0,
    minBasisCoverage: 0,
  });
  assert.equal(recommendScoutTraders(ranked, new Set(), 0.1)[0].state, "research-candidate");
  assert.equal(recommendScoutTraders(ranked, new Set([alpha.id]), 0.1)[0].state, "insufficient-data");

  function swap(id: string, day: number, side: "buy" | "sell", usd: number) {
    const createdAt = new Date(start + day * 86_400_000).toISOString();
    return {
      id,
      userId: alpha.id,
      userHandle: alpha.userHandle,
      createdAt,
      observedAt: new Date(Date.parse(createdAt) + 5_000).toISOString(),
      inNetworkId: "8453",
      outNetworkId: "8453",
      inTokenAddress: side === "buy" ? "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" : "0xtoken",
      outTokenAddress: side === "buy" ? "0xtoken" : "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      inTradeId: null,
      outTradeId: null,
      inHumanAmount: side === "buy" ? String(usd) : "100",
      outHumanAmount: side === "buy" ? "100" : String(usd),
      humanUsdAmountIn: String(side === "buy" ? usd : usd - 1),
      humanUsdAmountOut: String(side === "sell" ? usd : usd - 1),
    };
  }
});
