import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openFomoSession } from "../fomo/browser.ts";
import { FomoClient } from "../fomo/client.ts";
import { FomoStore } from "../fomo/store.ts";
import { pacedTransport } from "../fomo/rate-limit.ts";
import type {
  FomoClanWindow,
  FomoSyncSummary,
  FomoUser,
  RawFomoPage,
  StoredFomoUser,
} from "../fomo/types.ts";
import {
  addScoutCandidate,
  recommendScoutTraders,
  selectScoutCandidates,
  selectScoutPolicy,
  type ScoutCandidate,
  type ScoutPolicy,
  type ScoutRecommendation,
  type ScoutRecommendationState,
} from "../intel/scout.ts";
import { screenPatterns, validatePatterns, type PatternGridInput } from "../intel/patterns.ts";
import { rankTraders } from "../intel/traders.ts";
import { banner, dim, gold, green, red, table } from "../ui/index.ts";

const DAY_MS = 86_400_000;

type ScoutSyncResult = {
  candidate: ScoutCandidate;
  summary: FomoSyncSummary | null;
  error: string | null;
};

type ScoutReport = {
  generatedAt: string;
  mode: "cached" | "discover-and-refresh";
  window: { since: string; until: string };
  universe: {
    discovered: number;
    selected: number;
    analyzed: number;
    sources: Record<string, number>;
    discoveryErrors: string[];
    syncCompleted: number;
    syncFailed: number;
    syncTruncated: number;
    syncSkipped: number;
  };
  states: Record<ScoutRecommendationState, number>;
  policy: ScoutPolicy | null;
  interestingStats: Array<{ label: string; trader: string; value: string }>;
  recommendations: ReturnType<typeof recommendationJson>[];
  syncFailures: Array<{ userHandle: string; error: string }>;
  limitations: string[];
};

export async function runScout(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "max-traders": { type: "string", default: "500" },
      "max-pages": { type: "string", default: "20" },
      concurrency: { type: "string", default: "2" },
      "requests-per-second": { type: "string", default: "4" },
      days: { type: "string", default: "180" },
      top: { type: "string", default: "25" },
      "min-closed": { type: "string", default: "5" },
      coverage: { type: "string", default: "0.7" },
      "min-reliability": { type: "string", default: "0.25" },
      config: { type: "string" },
      "max-patterns": { type: "string", default: "100000" },
      "fee-bps": { type: "string", default: "20" },
      folds: { type: "string", default: "4" },
      "test-days": { type: "string", default: "14" },
      "max-lag": { type: "string", default: "300" },
      cached: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const maxTraders = positiveInteger(values["max-traders"], "--max-traders");
  const maxPages = positiveInteger(values["max-pages"], "--max-pages");
  const concurrency = positiveInteger(values.concurrency, "--concurrency");
  if (concurrency > 8) throw new Error("--concurrency must be between 1 and 8");
  const requestsPerSecond = positiveNumber(values["requests-per-second"], "--requests-per-second");
  if (requestsPerSecond > 20) throw new Error("--requests-per-second must not exceed 20");
  const days = positiveNumber(values.days, "--days");
  const top = positiveInteger(values.top, "--top");
  const minClosed = positiveInteger(values["min-closed"], "--min-closed");
  const coverage = ratio(values.coverage, "--coverage");
  const minReliability = ratio(values["min-reliability"], "--min-reliability");
  const foldCount = positiveInteger(values.folds, "--folds");
  const testDays = positiveInteger(values["test-days"], "--test-days");
  const maxLag = nonNegativeNumber(values["max-lag"], "--max-lag");
  const maxPatterns = positiveInteger(values["max-patterns"], "--max-patterns");
  const feeBps = nonNegativeNumber(values["fee-bps"], "--fee-bps");
  if (days < foldCount * testDays) {
    throw new Error("--days must cover at least --folds multiplied by --test-days");
  }

  const store = new FomoStore();
  let session: Awaited<ReturnType<typeof openFomoSession>> | null = null;
  try {
    const candidates = new Map<string, ScoutCandidate>();
    for (const user of store.dataset().users) addScoutCandidate(candidates, storedAsFomoUser(user), "local");
    const discoveryErrors: string[] = [];
    let selected: ScoutCandidate[];
    let syncResults: ScoutSyncResult[] = [];

    if (values.cached) {
      selected = selectScoutCandidates(candidates.values(), maxTraders);
    } else {
      session = await openFomoSession();
      const client = new FomoClient(pacedTransport(session, { requestsPerSecond }));
      if (!values.json) console.log(banner("autonomous Fomo trader discovery"));
      await discoverUniverse(client, candidates, discoveryErrors, Boolean(values.json), concurrency);
      selected = selectScoutCandidates(candidates.values(), maxTraders);
      const completedIds = values.resume ? store.completedUserIds() : new Set<string>();
      const refreshCandidates = selected.filter((candidate) => !completedIds.has(candidate.user.id));
      if (!values.json) console.log(dim(
        `\n  Selected ${selected.length}/${candidates.size} traders; refreshing ${refreshCandidates.length}`
        + ` at ${requestsPerSecond}/s with concurrency ${concurrency}`
        + `${values.resume ? `; resuming past ${selected.length - refreshCandidates.length} complete` : ""}.\n`,
      ));
      let finished = 0;
      syncResults = await mapConcurrent(refreshCandidates, concurrency, async (candidate) => {
        try {
          const summary = await syncCandidate(client, store, candidate, maxPages);
          finished++;
          if (!values.json) progress("SYNC", finished, refreshCandidates.length, candidate.user.userHandle);
          return { candidate, summary, error: null };
        } catch (error) {
          finished++;
          const message = error instanceof Error ? error.message : String(error);
          if (!values.json) progress("FAIL", finished, refreshCandidates.length, candidate.user.userHandle, message);
          return { candidate, summary: null, error: message };
        }
      });
      if (!values.json) console.log("\n");
    }

    if (selected.length === 0) {
      throw new Error(values.cached
        ? "No locally stored traders. Run fomo scout without --cached first."
        : "Fomo discovery returned no traders.");
    }
    const dataset = store.dataset(selected.map((candidate) => candidate.user.userHandle));
    if (dataset.swaps.length === 0) throw new Error("No swap history is available for the selected traders");
    const until = Date.now();
    const window = { since: until - days * DAY_MS, until };
    const rankingOptions = { minClosed, minBasisCoverage: coverage };
    const rankings = rankTraders(dataset, window, rankingOptions);
    const incompleteIds = store.incompleteUserIds();
    for (const result of syncResults) {
      if (result.error || result.summary?.truncated) incompleteIds.add(result.candidate.user.id);
    }
    const recommendations = sortRecommendations(recommendScoutTraders(rankings, incompleteIds, minReliability));
    const policyDataset = {
      users: dataset.users.filter((user) => !incompleteIds.has(user.id)),
      swaps: dataset.swaps.filter((swap) => !incompleteIds.has(swap.userId)),
    };
    const patternOptions = {
      window,
      grid: readGrid(values.config),
      maxGridCells: maxPatterns,
      roundTripFeeBps: feeBps,
      ranking: rankingOptions,
    };
    const screened = screenPatterns(policyDataset, patternOptions);
    const validated = validatePatterns(policyDataset, {
      ...patternOptions,
      foldCount,
      testDays,
      maxObservationLagSeconds: maxLag,
    });
    const policy = selectScoutPolicy(screened.results, validated.results);
    const report: ScoutReport = {
      generatedAt: new Date().toISOString(),
      mode: values.cached ? "cached" : "discover-and-refresh",
      window: { since: new Date(window.since).toISOString(), until: new Date(window.until).toISOString() },
      universe: {
        discovered: candidates.size,
        selected: selected.length,
        analyzed: rankings.length,
        sources: sourceCounts(selected),
        discoveryErrors,
        syncCompleted: syncResults.filter((result) => result.summary).length,
        syncFailed: syncResults.filter((result) => result.error).length,
        syncTruncated: syncResults.filter((result) => result.summary?.truncated).length,
        syncSkipped: !values.cached && values.resume ? selected.length - syncResults.length : 0,
      },
      states: stateCounts(recommendations),
      policy,
      interestingStats: interestingStats(recommendations),
      recommendations: recommendations.map(recommendationJson),
      syncFailures: syncResults.flatMap((result) => result.error
        ? [{ userHandle: result.candidate.user.userHandle, error: result.error }]
        : []),
      limitations: limitations(policy?.evidence),
    };
    if (values.json) console.log(JSON.stringify(report, jsonNumber, 2));
    else renderReport(report, recommendations.slice(0, top));
  } finally {
    await session?.close();
    store.close();
  }
}

async function discoverUniverse(
  client: FomoClient,
  candidates: Map<string, ScoutCandidate>,
  errors: string[],
  quiet: boolean,
  concurrency: number,
): Promise<void> {
  for (const window of ["24h", "7d", "30d", "all"] as const) {
    try {
      const board = await client.leaderboard(window, 100);
      for (const entry of board.data) {
        addScoutCandidate(candidates, entry.user, "leaderboard", { window, officialRank: entry.rank });
      }
      if (!quiet) console.log(`  ${green("OK")} trader leaderboard ${window}: ${board.data.length}`);
    } catch (error) {
      discoveryFailure(errors, quiet, `trader leaderboard ${window}`, error);
    }
  }

  const clans = new Map<string, { id: string; rank: number; window: FomoClanWindow }>();
  for (const window of ["24h", "7d", "30d"] as const) {
    try {
      const board = await client.clanLeaderboard(window);
      for (const clan of board.data) {
        const existing = clans.get(clan.id);
        if (!existing || clan.rank < existing.rank) clans.set(clan.id, { id: clan.id, rank: clan.rank, window });
      }
      if (!quiet) console.log(`  ${green("OK")} clan leaderboard ${window}: ${board.data.length}`);
    } catch (error) {
      discoveryFailure(errors, quiet, `clan leaderboard ${window}`, error);
    }
  }
  await mapConcurrent([...clans.values()], Math.min(concurrency, 4), async (clan) => {
    try {
      const detail = await client.clan(clan.id, clan.window);
      for (const member of detail.data.members) {
        addScoutCandidate(candidates, member.user, "clan", { clanRank: clan.rank });
      }
    } catch (error) {
      discoveryFailure(errors, true, `clan ${clan.id}`, error);
    }
  });
  if (!quiet) console.log(`  ${green("OK")} unique visible universe: ${candidates.size}`);
}

async function syncCandidate(
  client: FomoClient,
  store: FomoStore,
  candidate: ScoutCandidate,
  maxPages: number,
): Promise<FomoSyncSummary> {
  const handle = candidate.user.userHandle;
  const runId = store.beginSync(handle);
  try {
    const result = await client.syncHandle(handle, { maxPages });
    store.saveUser(result.user, result.summary.completedAt ?? undefined);
    store.saveSwaps(result.swaps, runId);
    const pages = flattenRawPages(result.raw);
    for (const page of pages) store.saveRawPage(runId, page);
    return store.completeSync(runId, {
      userId: result.user.id,
      swapCount: result.swaps.length,
      rawPageCount: pages.length,
      truncated: result.summary.truncated,
    });
  } catch (error) {
    store.completeSync(runId, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function flattenRawPages(raw: {
  user: RawFomoPage;
  swaps: RawFomoPage[];
  balances: RawFomoPage;
  spotlight: RawFomoPage;
  closedTrades: RawFomoPage[];
}): RawFomoPage[] {
  return [raw.user, ...raw.swaps, raw.balances, raw.spotlight, ...raw.closedTrades];
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await worker(values[index], index);
    }
  }));
  return results;
}

function storedAsFomoUser(user: StoredFomoUser): FomoUser {
  return {
    id: user.id,
    userHandle: user.userHandle,
    displayName: user.displayName,
    clan: user.clanId && user.clanName ? { id: user.clanId, name: user.clanName } : null,
    address: user.address,
    evmAddress: user.evmAddress,
  };
}

function sortRecommendations(recommendations: ScoutRecommendation[]): ScoutRecommendation[] {
  const order: Record<ScoutRecommendationState, number> = {
    "research-candidate": 0,
    watch: 1,
    avoid: 2,
    "insufficient-data": 3,
  };
  return recommendations.sort((a, b) =>
    order[a.state] - order[b.state]
    || b.trader.score - a.trader.score
    || b.trader.reliability - a.trader.reliability
  );
}

function sourceCounts(candidates: readonly ScoutCandidate[]): Record<string, number> {
  return Object.fromEntries(["leaderboard", "clan", "local"].map((source) => [
    source,
    candidates.filter((candidate) => candidate.sources.some((value) => value === source)).length,
  ]));
}

function stateCounts(recommendations: readonly ScoutRecommendation[]): Record<ScoutRecommendationState, number> {
  return {
    "research-candidate": recommendations.filter((item) => item.state === "research-candidate").length,
    watch: recommendations.filter((item) => item.state === "watch").length,
    avoid: recommendations.filter((item) => item.state === "avoid").length,
    "insufficient-data": recommendations.filter((item) => item.state === "insufficient-data").length,
  };
}

function recommendationJson(recommendation: ScoutRecommendation) {
  return {
    state: recommendation.state,
    reasons: recommendation.reasons,
    rank: recommendation.trader.rank,
    score: recommendation.trader.score,
    reliability: recommendation.trader.reliability,
    user: recommendation.trader.analysis.user,
    metrics: recommendation.trader.analysis.metrics,
  };
}

function interestingStats(recommendations: readonly ScoutRecommendation[]): ScoutReport["interestingStats"] {
  const eligible = recommendations.filter((item) => item.trader.eligible);
  if (!eligible.length) return [];
  const score = [...eligible].sort((a, b) => b.trader.score - a.trader.score)[0];
  const expectancy = [...eligible].sort((a, b) =>
    b.trader.analysis.metrics.expectancyUsd - a.trader.analysis.metrics.expectancyUsd
  )[0];
  const winRate = [...eligible].sort((a, b) =>
    b.trader.analysis.metrics.bayesianWinRate - a.trader.analysis.metrics.bayesianWinRate
  )[0];
  const copyable = [...eligible].sort((a, b) =>
    b.trader.analysis.metrics.copyableRatio - a.trader.analysis.metrics.copyableRatio
  )[0];
  return [
    { label: "Best risk-adjusted score", trader: `@${score.trader.analysis.metrics.handle}`, value: score.trader.score.toFixed(2) },
    { label: "Highest expectancy", trader: `@${expectancy.trader.analysis.metrics.handle}`, value: usd(expectancy.trader.analysis.metrics.expectancyUsd) },
    { label: "Highest Bayesian win rate", trader: `@${winRate.trader.analysis.metrics.handle}`, value: pct(winRate.trader.analysis.metrics.bayesianWinRate) },
    { label: "Most promptly observable", trader: `@${copyable.trader.analysis.metrics.handle}`, value: pct(copyable.trader.analysis.metrics.copyableRatio) },
  ];
}

function limitations(evidence?: ScoutPolicy["evidence"]): string[] {
  return [
    "Fomo exposes at most 100 entries per official trader board and no global pagination here.",
    "Clan/member responses may not represent every Fomo account.",
    "Realized swap reconstruction excludes open-position mark-to-market and unclassified token routes.",
    evidence === "walk-forward-causal"
      ? "Walk-forward evidence is observational research, not a guarantee of future execution or returns."
      : "The selected policy is retrospective only; collect timely observations before treating it as actionable.",
  ];
}

function renderReport(report: ScoutReport, recommendations: readonly ScoutRecommendation[]): void {
  console.log(banner("autonomous trader scout"));
  console.log(table(
    [{ header: "Universe" }, { header: "Count", align: "right" }],
    [
      ["Discovered", String(report.universe.discovered)],
      ["Selected", String(report.universe.selected)],
      ["Analyzed", String(report.universe.analyzed)],
      ["Research candidates", String(report.states["research-candidate"])],
      ["Watch", String(report.states.watch)],
      ["Avoid", String(report.states.avoid)],
      ["Insufficient data", String(report.states["insufficient-data"])],
    ],
  ));
  if (report.interestingStats.length) {
    console.log(banner("interesting standouts"));
    console.log(table(
      [{ header: "Stat" }, { header: "Trader" }, { header: "Value", align: "right" }],
      report.interestingStats.map((item) => [item.label, item.trader, item.value]),
    ));
  }
  console.log(banner("copy-quality trader stats"));
  console.log(table(
    [
      { header: "State" }, { header: "Trader" }, { header: "Score", align: "right" },
      { header: "ROIC", align: "right" }, { header: "Win", align: "right" },
      { header: "PF", align: "right" }, { header: "MDD", align: "right" },
      { header: "Closed", align: "right" }, { header: "Cover", align: "right" },
      { header: "Reliable", align: "right" }, { header: "Copyable", align: "right" },
    ],
    recommendations.map((item) => {
      const metrics = item.trader.analysis.metrics;
      return [
        stateLabel(item.state), `@${metrics.handle}`, item.trader.score.toFixed(2), pct(metrics.realizedRoic),
        pct(metrics.bayesianWinRate), Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : "inf",
        pct(metrics.maxDrawdownPct / 100), String(metrics.closedOutcomeCount), pct(metrics.basisCoverage),
        pct(item.trader.reliability), pct(metrics.copyableRatio),
      ];
    }),
  ));
  if (report.policy) renderPolicy(report.policy);
  console.log(banner("when not to copy"));
  console.log(`  ${red("STOP")} History is incomplete, truncated, stale, or below sample and coverage gates.`);
  console.log(`  ${red("STOP")} Win rate, profit factor, drawdown, or observation delay misses the policy.`);
  console.log(`  ${red("STOP")} Liquidity, impact, token tax, gas, or execution differs from assumptions.`);
  if (report.policy?.evidence !== "walk-forward-causal") {
    console.log(`  ${gold("RESEARCH ONLY")} No positive entry-and-exit causal policy has enough outcomes yet.`);
  }
  console.log(dim(`\n  Discovery errors: ${report.universe.discoveryErrors.length}. Full reasons: fomo scout --cached --json`));
  console.log(dim("  Broadest visible Fomo universe, not proof of every account. This command never places trades.\n"));
}

function renderPolicy(policy: ScoutPolicy): void {
  console.log(banner(policy.evidence === "walk-forward-causal"
    ? "when to copy · observed-time validated"
    : "when to copy · research hypothesis"));
  console.log(table(
    [{ header: "Condition" }, { header: "Value" }],
    [
      ["Minimum closed outcomes", String(policy.pattern.minClosed)],
      ["Minimum Bayesian win rate", pct(policy.pattern.minWinRate)],
      ["Minimum profit factor", policy.pattern.minProfitFactor.toFixed(2)],
      ["Maximum realized drawdown", pct(policy.pattern.maxDrawdownPct / 100)],
      ["Maximum leaders", String(policy.pattern.topTraders)],
      ["Observe and act within", `${policy.pattern.delaySeconds}s`],
      ["Assumed one-side slippage", `${policy.pattern.slippageBps} bps`],
      ["Evaluated outcomes", String(policy.tradeCount)],
      ["Simulated return per copy", pct(policy.returnPct)],
      ...(policy.positiveFoldRatio === null ? [] : [["Positive folds", pct(policy.positiveFoldRatio)]]),
    ],
  ));
}

function stateLabel(state: ScoutRecommendationState): string {
  if (state === "research-candidate") return green("CANDIDATE");
  if (state === "watch") return gold("WATCH");
  if (state === "avoid") return red("AVOID");
  return dim("INSUFFICIENT");
}

function discoveryFailure(errors: string[], quiet: boolean, source: string, error: unknown): void {
  const message = `${source}: ${error instanceof Error ? error.message : String(error)}`;
  errors.push(message);
  if (!quiet) console.log(`  ${red("FAIL")} ${message}`);
}

function progress(label: "SYNC" | "FAIL", current: number, total: number, handle: string, error?: string): void {
  const status = label === "FAIL" ? red(label) : green(label);
  const line = `  ${status} ${current}/${total} @${handle}${error ? ` · ${conciseError(error)}` : ""}`;
  process.stdout.write(label === "FAIL" ? `\r${line}\n` : `\r${line.padEnd(76)}`);
}

function conciseError(error: string): string {
  if (/(?:HTTP\s*)?429|rate[ -]?limit|too many requests/i.test(error)) return "Fomo rate limit (HTTP 429)";
  if (/404|not found/i.test(error)) return "profile no longer available";
  if (/401|403|authentication|login/i.test(error)) return "authentication rejected; run fomo login";
  return error.replaceAll(/\s+/g, " ").slice(0, 90);
}

function readGrid(file: string | undefined): PatternGridInput {
  if (!file) return {};
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pattern config must be a JSON object");
  return value as PatternGridInput;
}

function positiveInteger(value: string | undefined, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function positiveNumber(value: string | undefined, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be positive`);
  return number;
}

function nonNegativeNumber(value: string | undefined, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be non-negative`);
  return number;
}

function ratio(value: string | undefined, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${name} must be between zero and one`);
  return number;
}

function jsonNumber(_key: string, value: unknown): unknown {
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function usd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}
