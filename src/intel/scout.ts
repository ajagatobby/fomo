import type { FomoUser } from "../fomo/types.ts";
import type { CopyPattern, ScreenedPattern, ValidatedPattern } from "./patterns.ts";
import type { RankedTrader } from "./traders.ts";

export type ScoutSource = "leaderboard" | "clan" | "local";

export type ScoutCandidate = {
  user: FomoUser;
  sources: ScoutSource[];
  leaderboardWindows: string[];
  bestOfficialRank: number | null;
  bestClanRank: number | null;
};

export type ScoutRecommendationState = "research-candidate" | "watch" | "avoid" | "insufficient-data";

export type ScoutRecommendation = {
  state: ScoutRecommendationState;
  reasons: string[];
  trader: RankedTrader;
};

export type ScoutPolicy = {
  evidence: "walk-forward-causal" | "retrospective-noncausal";
  pattern: CopyPattern;
  tradeCount: number;
  returnPct: number;
  maxDrawdownPct: number;
  positiveFoldRatio: number | null;
  worstFoldReturnPct: number | null;
};

export function addScoutCandidate(
  candidates: Map<string, ScoutCandidate>,
  user: FomoUser,
  source: ScoutSource,
  metadata: { window?: string; officialRank?: number; clanRank?: number } = {},
): void {
  const existing = candidates.get(user.id);
  if (!existing) {
    candidates.set(user.id, {
      user,
      sources: [source],
      leaderboardWindows: metadata.window ? [metadata.window] : [],
      bestOfficialRank: metadata.officialRank ?? null,
      bestClanRank: metadata.clanRank ?? null,
    });
    return;
  }
  existing.user = richerUser(existing.user, user);
  if (!existing.sources.includes(source)) existing.sources.push(source);
  if (metadata.window && !existing.leaderboardWindows.includes(metadata.window)) {
    existing.leaderboardWindows.push(metadata.window);
  }
  existing.bestOfficialRank = minimum(existing.bestOfficialRank, metadata.officialRank);
  existing.bestClanRank = minimum(existing.bestClanRank, metadata.clanRank);
}

export function selectScoutCandidates(candidates: Iterable<ScoutCandidate>, limit: number): ScoutCandidate[] {
  if (!Number.isInteger(limit) || limit <= 0) throw new RangeError("Scout candidate limit must be positive");
  return [...candidates].sort((a, b) =>
    nullableRank(a.bestOfficialRank) - nullableRank(b.bestOfficialRank)
    || nullableRank(a.bestClanRank) - nullableRank(b.bestClanRank)
    || a.user.userHandle.localeCompare(b.user.userHandle, undefined, { sensitivity: "base" })
    || a.user.id.localeCompare(b.user.id)
  ).slice(0, limit);
}

export function recommendScoutTraders(
  traders: readonly RankedTrader[],
  incompleteUserIds: ReadonlySet<string>,
  minimumReliability = 0.25,
): ScoutRecommendation[] {
  if (!Number.isFinite(minimumReliability) || minimumReliability < 0 || minimumReliability > 1) {
    throw new RangeError("Scout minimum reliability must be between zero and one");
  }
  return traders.map((trader) => {
    const metrics = trader.analysis.metrics;
    if (incompleteUserIds.has(metrics.userId)) {
      return { state: "insufficient-data", reasons: ["history refresh failed or reached the page cap"], trader };
    }
    if (!trader.eligible) {
      return { state: "insufficient-data", reasons: trader.eligibilityReasons.map(readableReason), trader };
    }
    if (trader.reliability < minimumReliability) {
      return {
        state: "insufficient-data",
        reasons: [`reliability ${(trader.reliability * 100).toFixed(0)}% is below ${(minimumReliability * 100).toFixed(0)}%`],
        trader,
      };
    }
    const avoidReasons: string[] = [];
    if (metrics.realizedRoic <= 0) avoidReasons.push("non-positive realized ROIC");
    if (metrics.profitFactor < 1) avoidReasons.push("profit factor below 1.0");
    if (metrics.bayesianWinRate < 0.5) avoidReasons.push("Bayesian win rate below 50%");
    if (metrics.maxDrawdownPct > 60) avoidReasons.push("realized drawdown above 60%");
    if (avoidReasons.length) return { state: "avoid", reasons: avoidReasons, trader };

    const candidateReasons: string[] = [];
    if (metrics.realizedRoic > 0) candidateReasons.push("positive realized ROIC");
    if (metrics.profitFactor >= 1.25) candidateReasons.push("profit factor at least 1.25");
    if (metrics.bayesianWinRate >= 0.55) candidateReasons.push("Bayesian win rate at least 55%");
    if (metrics.maxDrawdownPct <= 40) candidateReasons.push("realized drawdown at most 40%");
    if (metrics.copyableRatio >= 0.5) candidateReasons.push("at least half of priced events observed promptly");
    if (candidateReasons.length === 5) return { state: "research-candidate", reasons: candidateReasons, trader };
    return { state: "watch", reasons: ["profitable sample, but not every copy-quality gate passed"], trader };
  });
}

export function selectScoutPolicy(
  retrospective: readonly ScreenedPattern[],
  validated: readonly ValidatedPattern[],
): ScoutPolicy | null {
  const causal = [...validated].filter((result) =>
    result.tradeCount >= 10 && result.returnPct > 0 && result.positiveFoldRatio >= 0.5
  ).sort((a, b) =>
    b.positiveFoldRatio - a.positiveFoldRatio
    || b.worstFoldReturnPct - a.worstFoldReturnPct
    || b.returnPct - a.returnPct
    || a.maxDrawdownPct - b.maxDrawdownPct
    || a.pattern.id.localeCompare(b.pattern.id)
  )[0];
  if (causal) {
    return {
      evidence: "walk-forward-causal",
      pattern: causal.pattern,
      tradeCount: causal.tradeCount,
      returnPct: causal.returnPct,
      maxDrawdownPct: causal.maxDrawdownPct,
      positiveFoldRatio: causal.positiveFoldRatio,
      worstFoldReturnPct: causal.worstFoldReturnPct,
    };
  }
  const exploratory = [...retrospective].filter((result) => result.tradeCount >= 10 && result.returnPct > 0)
    .sort((a, b) =>
      b.returnPct - a.returnPct
      || a.maxDrawdownPct - b.maxDrawdownPct
      || b.tradeCount - a.tradeCount
      || a.pattern.id.localeCompare(b.pattern.id)
    )[0];
  return exploratory ? {
    evidence: "retrospective-noncausal",
    pattern: exploratory.pattern,
    tradeCount: exploratory.tradeCount,
    returnPct: exploratory.returnPct,
    maxDrawdownPct: exploratory.maxDrawdownPct,
    positiveFoldRatio: null,
    worstFoldReturnPct: null,
  } : null;
}

function richerUser(current: FomoUser, candidate: FomoUser): FomoUser {
  return {
    ...current,
    ...candidate,
    displayName: candidate.displayName ?? current.displayName,
    clan: candidate.clan ?? current.clan,
    address: candidate.address ?? current.address,
    evmAddress: candidate.evmAddress ?? current.evmAddress,
  };
}

function minimum(current: number | null, candidate: number | undefined): number | null {
  return candidate === undefined ? current : current === null ? candidate : Math.min(current, candidate);
}

function nullableRank(value: number | null): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

function readableReason(reason: string): string {
  return reason.replace("tradeCount<", "classified trades below ")
    .replace("closedOutcomeCount<", "closed outcomes below ")
    .replace("basisCoverage<", "basis coverage below ")
    .replace("activeDays<", "active days below ");
}
