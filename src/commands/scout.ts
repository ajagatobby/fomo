import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openFomoSession } from "../fomo/browser.ts";
import { FomoClient } from "../fomo/client.ts";
import { pacedTransport } from "../fomo/rate-limit.ts";
import type { FomoClanWindow, FomoUser, ResearchDataset, ResearchUser } from "../fomo/types.ts";
import {
  addScoutCandidate,
  recommendScoutTraders,
  selectScoutCandidates,
  selectScoutPolicy,
  type ScoutCandidate,
  type ScoutRecommendation,
  type ScoutRecommendationState,
} from "../intel/scout.ts";
import { screenPatterns, type PatternGridInput } from "../intel/patterns.ts";
import { rankTraders } from "../intel/traders.ts";
import { banner, dim, gold, green, red, table } from "../ui/index.ts";

const DAY_MS = 86_400_000;

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
  const maxPatterns = positiveInteger(values["max-patterns"], "--max-patterns");
  const feeBps = nonNegativeNumber(values["fee-bps"], "--fee-bps");

  const session = await openFomoSession();
  try {
    const client = new FomoClient(pacedTransport(session, { requestsPerSecond }));
    const candidates = new Map<string, ScoutCandidate>();
    const discoveryErrors: string[] = [];
    if (!values.json) console.log(banner("live Fomo trader discovery"));
    await discoverUniverse(client, candidates, discoveryErrors, Boolean(values.json), concurrency);
    const selected = selectScoutCandidates(candidates.values(), maxTraders);
    if (!selected.length) throw new Error("Fomo discovery returned no traders");
    if (!values.json) console.log(dim(
      `\n  Fetching fresh history for ${selected.length}/${candidates.size} traders at ${requestsPerSecond}/s with concurrency ${concurrency}.\n`,
    ));

    let finished = 0;
    const fetched = await mapConcurrent(selected, concurrency, async (candidate) => {
      try {
        const profile = (await client.resolveUser(candidate.user.userHandle)).data;
        const swaps = await client.allSwaps(profile, maxPages);
        finished++;
        if (!values.json) progress("FETCH", finished, selected.length, profile.userHandle);
        return { candidate, profile, swaps: swaps.items, truncated: swaps.truncated, error: null };
      } catch (error) {
        finished++;
        const message = error instanceof Error ? error.message : String(error);
        if (!values.json) progress("FAIL", finished, selected.length, candidate.user.userHandle, message);
        return { candidate, profile: null, swaps: [], truncated: false, error: message };
      }
    });
    if (!values.json) console.log("\n");

    const successful = fetched.filter((item): item is typeof item & { profile: FomoUser } => item.profile !== null);
    const dataset: ResearchDataset = {
      users: successful.map((item) => researchUser(item.profile)),
      swaps: successful.flatMap((item) => item.swaps),
    };
    if (!dataset.swaps.length) throw new Error("Fresh Fomo fetch returned no swap history for selected traders");
    const until = Date.now();
    const window = { since: until - days * DAY_MS, until };
    const rankingOptions = { minClosed, minBasisCoverage: coverage };
    const rankings = rankTraders(dataset, window, rankingOptions);
    const incompleteIds = new Set(fetched.filter((item) => item.error || item.truncated).map((item) => item.candidate.user.id));
    const recommendations = sortRecommendations(recommendScoutTraders(rankings, incompleteIds, minReliability));
    const completeDataset = {
      users: dataset.users.filter((user) => !incompleteIds.has(user.id)),
      swaps: dataset.swaps.filter((swap) => !incompleteIds.has(swap.userId)),
    };
    const screened = screenPatterns(completeDataset, {
      window,
      grid: readGrid(values.config),
      maxGridCells: maxPatterns,
      roundTripFeeBps: feeBps,
      ranking: rankingOptions,
    });
    const policy = selectScoutPolicy(screened.results);
    const report = {
      generatedAt: new Date().toISOString(),
      mode: "fresh-retrospective" as const,
      window: { since: new Date(window.since).toISOString(), until: new Date(window.until).toISOString() },
      universe: {
        discovered: candidates.size,
        selected: selected.length,
        analyzed: rankings.length,
        discoveryErrors,
        fetchCompleted: successful.length,
        fetchFailed: fetched.filter((item) => item.error).length,
        fetchTruncated: fetched.filter((item) => item.truncated).length,
      },
      states: stateCounts(recommendations),
      policy,
      recommendations: recommendations.map(recommendationJson),
      fetchFailures: fetched.flatMap((item) => item.error ? [{ userHandle: item.candidate.user.userHandle, error: item.error }] : []),
      limitations: [
        "Fomo exposes at most 100 entries per official trader board and no global pagination here.",
        "Freshly fetched history is retrospective and is discarded when this command exits.",
        "Realized swap reconstruction excludes open-position mark-to-market and unclassified token routes.",
      ],
    };
    if (values.json) console.log(JSON.stringify(report, jsonNumber, 2));
    else renderReport(report, recommendations.slice(0, top));
  } finally {
    await session.close();
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
      for (const entry of board.data) addScoutCandidate(candidates, entry.user, "leaderboard", { window, officialRank: entry.rank });
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
      for (const member of detail.data.members) addScoutCandidate(candidates, member.user, "clan", { clanRank: clan.rank });
    } catch (error) {
      discoveryFailure(errors, true, `clan ${clan.id}`, error);
    }
  });
  if (!quiet) console.log(`  ${green("OK")} unique visible universe: ${candidates.size}`);
}

function researchUser(user: FomoUser): ResearchUser {
  return {
    id: user.id,
    userHandle: user.userHandle,
    handle: user.userHandle,
    displayName: user.displayName,
    clanId: user.clan?.id ?? null,
    clanName: user.clan?.name ?? null,
    address: user.address ?? null,
    evmAddress: user.evmAddress ?? null,
  };
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await worker(values[index]);
    }
  }));
  return results;
}

function sortRecommendations(recommendations: ScoutRecommendation[]): ScoutRecommendation[] {
  const order: Record<ScoutRecommendationState, number> = { "research-candidate": 0, watch: 1, avoid: 2, "insufficient-data": 3 };
  return recommendations.sort((a, b) => order[a.state] - order[b.state] || b.trader.score - a.trader.score);
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

function renderReport(report: any, recommendations: readonly ScoutRecommendation[]): void {
  console.log(banner("fresh trader scout"));
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
  console.log(banner("retrospective trader stats"));
  console.log(table(
    [
      { header: "State" }, { header: "Trader" }, { header: "Score", align: "right" },
      { header: "ROIC", align: "right" }, { header: "Win", align: "right" },
      { header: "PF", align: "right" }, { header: "MDD", align: "right" },
      { header: "Closed", align: "right" }, { header: "Cover", align: "right" },
      { header: "Reliable", align: "right" },
    ],
    recommendations.map((item) => {
      const metrics = item.trader.analysis.metrics;
      return [
        stateLabel(item.state), `@${metrics.handle}`, item.trader.score.toFixed(2), pct(metrics.realizedRoic),
        pct(metrics.bayesianWinRate), Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : "inf",
        pct(metrics.maxDrawdownPct / 100), String(metrics.closedOutcomeCount), pct(metrics.basisCoverage),
        pct(item.trader.reliability),
      ];
    }),
  ));
  if (report.policy) {
    console.log(banner("retrospective pattern screen"));
    console.log(dim(`  Pattern ${report.policy.pattern.id.slice(0, 8)} screened ${report.policy.tradeCount} historical outcomes.`));
  }
  console.log(`\n  ${gold("RESEARCH ONLY")} Fresh backfilled history does not establish live availability or execution timing.`);
  console.log(dim("  All fetched research data remains in memory and is discarded on exit. This command never places trades.\n"));
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

function progress(label: "FETCH" | "FAIL", current: number, total: number, handle: string, error?: string): void {
  const status = label === "FAIL" ? red(label) : green(label);
  const line = `  ${status} ${current}/${total} @${handle}${error ? ` · ${error.replaceAll(/\s+/g, " ").slice(0, 90)}` : ""}`;
  process.stdout.write(label === "FAIL" ? `\r${line}\n` : `\r${line.padEnd(76)}`);
}

function readGrid(file: string | undefined): PatternGridInput {
  if (!file) return {};
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pattern config must contain a JSON object");
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
