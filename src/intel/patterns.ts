import { createHash } from "node:crypto";
import type { ResearchDataset } from "../fomo/types.ts";
import {
  analyzeAllTraders,
  normalizeWindow,
  rankTraders,
  type AnalysisWindow,
  type RankedTrader,
  type RealizedOutcome,
  type TraderRankingOptions,
} from "./traders.ts";

export const RETROSPECTIVE_LABEL = "retrospective-noncausal" as const;

export type PatternGrid = {
  lookbackDays: number[];
  minClosed: number[];
  minWinRate: number[];
  minProfitFactor: number[];
  maxDrawdownPct: number[];
  topTraders: number[];
  positionUsd: number[];
  slippageBps: number[];
  delaySeconds: number[];
};

export type PatternGridInput = Partial<{ [Key in keyof PatternGrid]: readonly number[] }>;

export type CopyPattern = {
  id: string;
  lookbackDays: number;
  minClosed: number;
  minWinRate: number;
  minProfitFactor: number;
  maxDrawdownPct: number;
  topTraders: number;
  positionUsd: number;
  slippageBps: number;
  delaySeconds: number;
};

export type ExecutionAssumptions = {
  /** Total explicit fee charged across entry and exit. */
  roundTripFeeBps?: number;
  /** Adverse return penalty per second of observation/execution delay. */
  delayHaircutBpsPerSecond?: number;
};

export type PatternSimulation = {
  tradeCount: number;
  grossPnlUsd: number;
  executionCostUsd: number;
  delayHaircutUsd: number;
  netPnlUsd: number;
  returnPct: number;
  maxDrawdownPct: number;
};

export type ScreenedPattern = PatternSimulation & {
  pattern: CopyPattern;
  label: typeof RETROSPECTIVE_LABEL;
  selectedTraderIds: string[];
};

export type PatternScreenOptions = ExecutionAssumptions & {
  window: AnalysisWindow;
  grid?: PatternGridInput | string;
  maxGridCells?: number;
  ranking?: TraderRankingOptions;
};

export type PatternScreenResult = {
  label: typeof RETROSPECTIVE_LABEL;
  patternsTested: number;
  window: { since: number; until: number };
  results: ScreenedPattern[];
};

export type WalkForwardFold = {
  index: number;
  cutoff: number;
  testUntil: number;
};

export type PatternFoldResult = PatternSimulation & {
  foldIndex: number;
  cutoff: number;
  testUntil: number;
  selectedTraderIds: string[];
};

export type ValidatedPattern = {
  pattern: CopyPattern;
  netPnlUsd: number;
  returnPct: number;
  maxDrawdownPct: number;
  positiveFoldRatio: number;
  worstFoldReturnPct: number;
  foldCount: number;
  tradeCount: number;
  folds: PatternFoldResult[];
};

export type PatternValidationOptions = ExecutionAssumptions & {
  window: AnalysisWindow;
  grid?: PatternGridInput | string;
  maxGridCells?: number;
  foldCount?: number;
  testDays?: number;
  folds?: readonly Omit<WalkForwardFold, "index">[];
  ranking?: TraderRankingOptions;
  /** Defaults to true. False is exploratory and may include historically backfilled data. */
  causal?: boolean;
  maxObservationLagSeconds?: number;
};

export type PatternValidationResult = {
  label: "walk-forward-causal" | "walk-forward-retrospective";
  patternsTested: number;
  folds: WalkForwardFold[];
  window: { since: number; until: number };
  results: ValidatedPattern[];
};

const DAY_MS = 86_400_000;
const DEFAULT_MAX_GRID_CELLS = 100_000;
const EPSILON = 1e-12;

// Nine axes with three values each produce 19,683 deterministic configurations.
export const DEFAULT_PATTERN_GRID: Readonly<PatternGrid> = Object.freeze({
  lookbackDays: [30, 60, 90],
  minClosed: [3, 6, 12],
  minWinRate: [0.5, 0.55, 0.6],
  minProfitFactor: [1, 1.25, 1.5],
  maxDrawdownPct: [25, 40, 60],
  topTraders: [3, 5, 10],
  positionUsd: [100, 250, 500],
  slippageBps: [25, 75, 150],
  delaySeconds: [15, 60, 180],
});

export const DEFAULT_GRID = DEFAULT_PATTERN_GRID;

const GRID_KEYS = [
  "lookbackDays",
  "minClosed",
  "minWinRate",
  "minProfitFactor",
  "maxDrawdownPct",
  "topTraders",
  "positionUsd",
  "slippageBps",
  "delaySeconds",
] as const;

function finiteAxis(name: keyof PatternGrid, values: readonly number[]): number[] {
  if (!Array.isArray(values) || values.length === 0) throw new RangeError(`Grid axis ${name} must not be empty`);
  const normalized = [...new Set(values.map(Number))].sort((a, b) => a - b);
  if (normalized.some((value) => !Number.isFinite(value))) throw new RangeError(`Grid axis ${name} must be finite`);
  if (normalized.some((value) => value < 0)) throw new RangeError(`Grid axis ${name} must be non-negative`);
  if ((name === "lookbackDays" || name === "topTraders" || name === "positionUsd")
    && normalized.some((value) => value <= 0)) {
    throw new RangeError(`Grid axis ${name} must be positive`);
  }
  if ((name === "lookbackDays" || name === "minClosed" || name === "topTraders" || name === "delaySeconds")
    && normalized.some((value) => !Number.isInteger(value))) {
    throw new RangeError(`Grid axis ${name} must contain integers`);
  }
  if (name === "minWinRate" && normalized.some((value) => value > 1)) {
    throw new RangeError("Grid minWinRate values must be between zero and one");
  }
  if (name === "maxDrawdownPct" && normalized.some((value) => value > 100)) {
    throw new RangeError("Grid maxDrawdownPct values must be between zero and 100");
  }
  return normalized;
}

export function parsePatternGrid(input: PatternGridInput | string = {}): PatternGrid {
  let parsed: PatternGridInput;
  if (typeof input === "string") {
    const value: unknown = JSON.parse(input);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Pattern grid JSON must contain an object");
    }
    parsed = value as PatternGridInput;
  } else {
    parsed = input;
  }
  return Object.fromEntries(GRID_KEYS.map((key) => [
    key,
    finiteAxis(key, parsed[key] ?? DEFAULT_PATTERN_GRID[key]),
  ])) as PatternGrid;
}

function patternFields(pattern: Omit<CopyPattern, "id">): Omit<CopyPattern, "id"> {
  return {
    lookbackDays: pattern.lookbackDays,
    minClosed: pattern.minClosed,
    minWinRate: pattern.minWinRate,
    minProfitFactor: pattern.minProfitFactor,
    maxDrawdownPct: pattern.maxDrawdownPct,
    topTraders: pattern.topTraders,
    positionUsd: pattern.positionUsd,
    slippageBps: pattern.slippageBps,
    delaySeconds: pattern.delaySeconds,
  };
}

export function canonicalPatternId(pattern: Omit<CopyPattern, "id"> | CopyPattern): string {
  return createHash("sha256").update(JSON.stringify(patternFields(pattern))).digest("hex");
}

export function generatePatternGrid(
  input: PatternGridInput | string = {},
  maxGridCells = DEFAULT_MAX_GRID_CELLS,
): CopyPattern[] {
  if (!Number.isInteger(maxGridCells) || maxGridCells <= 0) throw new RangeError("maxGridCells must be a positive integer");
  const grid = parsePatternGrid(input);
  const cells = GRID_KEYS.reduce((count, key) => {
    if (count > Math.floor(maxGridCells / grid[key].length)) {
      throw new RangeError(`Pattern grid exceeds maxGridCells=${maxGridCells}`);
    }
    return count * grid[key].length;
  }, 1);
  if (cells > maxGridCells) throw new RangeError(`Pattern grid has ${cells} cells; maximum is ${maxGridCells}`);

  const patterns: CopyPattern[] = [];
  for (const lookbackDays of grid.lookbackDays)
    for (const minClosed of grid.minClosed)
      for (const minWinRate of grid.minWinRate)
        for (const minProfitFactor of grid.minProfitFactor)
          for (const maxDrawdownPct of grid.maxDrawdownPct)
            for (const topTraders of grid.topTraders)
              for (const positionUsd of grid.positionUsd)
                for (const slippageBps of grid.slippageBps)
                  for (const delaySeconds of grid.delaySeconds) {
                    const fields = patternFields({
                      lookbackDays,
                      minClosed,
                      minWinRate,
                      minProfitFactor,
                      maxDrawdownPct,
                      topTraders,
                      positionUsd,
                      slippageBps,
                      delaySeconds,
                    });
                    patterns.push({ id: canonicalPatternId(fields), ...fields });
                  }
  return patterns;
}

function executionValues(options: ExecutionAssumptions): { feeBps: number; delayBpsPerSecond: number } {
  const feeBps = options.roundTripFeeBps ?? 20;
  const delayBpsPerSecond = options.delayHaircutBpsPerSecond ?? 0.05;
  if (!Number.isFinite(feeBps) || feeBps < 0) throw new RangeError("roundTripFeeBps must be non-negative");
  if (!Number.isFinite(delayBpsPerSecond) || delayBpsPerSecond < 0) {
    throw new RangeError("delayHaircutBpsPerSecond must be non-negative");
  }
  return { feeBps, delayBpsPerSecond };
}

type SimulatedTrade = {
  eventTime: number;
  grossPnlUsd: number;
  executionCostUsd: number;
  delayHaircutUsd: number;
  netPnlUsd: number;
};

function simulatedTrades(
  outcomes: readonly RealizedOutcome[],
  pattern: CopyPattern,
  options: ExecutionAssumptions,
): SimulatedTrade[] {
  const { feeBps, delayBpsPerSecond } = executionValues(options);
  // Slippage is specified per side; feeBps is already round-trip.
  const executionRate = (feeBps + 2 * pattern.slippageBps) / 10_000;
  const delayRate = pattern.delaySeconds * delayBpsPerSecond / 10_000;
  return outcomes.map((outcome) => {
    const grossPnlUsd = pattern.positionUsd * outcome.returnPct;
    const executionCostUsd = pattern.positionUsd * executionRate;
    // Delay is an explicit adverse subtraction, including when the leader lost.
    const delayHaircutUsd = pattern.positionUsd * delayRate;
    return {
      eventTime: outcome.eventTime,
      grossPnlUsd,
      executionCostUsd,
      delayHaircutUsd,
      netPnlUsd: grossPnlUsd - executionCostUsd - delayHaircutUsd,
    };
  }).sort((a, b) => a.eventTime - b.eventTime);
}

function summarizeTrades(trades: readonly SimulatedTrade[], positionUsd: number): PatternSimulation {
  const grossPnlUsd = trades.reduce((sum, trade) => sum + trade.grossPnlUsd, 0);
  const executionCostUsd = trades.reduce((sum, trade) => sum + trade.executionCostUsd, 0);
  const delayHaircutUsd = trades.reduce((sum, trade) => sum + trade.delayHaircutUsd, 0);
  const netPnlUsd = grossPnlUsd - executionCostUsd - delayHaircutUsd;
  let equity = positionUsd;
  let peak = equity;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.netPnlUsd;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > EPSILON ? (peak - equity) / peak : 1);
  }
  return {
    tradeCount: trades.length,
    grossPnlUsd,
    executionCostUsd,
    delayHaircutUsd,
    netPnlUsd,
    // Return uses total fixed ticket capital deployed, not a compounding portfolio.
    returnPct: trades.length > 0 ? netPnlUsd / (positionUsd * trades.length) : 0,
    maxDrawdownPct: Math.min(1, maxDrawdown) * 100,
  };
}

export function simulateRetrospectiveCopies(
  outcomes: readonly RealizedOutcome[],
  pattern: CopyPattern,
  options: ExecutionAssumptions = {},
): PatternSimulation {
  return summarizeTrades(simulatedTrades(outcomes, pattern, options), pattern.positionUsd);
}

function broadRankingOptions(options: TraderRankingOptions | undefined): TraderRankingOptions {
  return {
    ...options,
    minTrades: 0,
    minClosed: 0,
    minActiveDays: 0,
    minBasisCoverage: options?.minBasisCoverage ?? 0.7,
  };
}

function selectTraders(ranking: readonly RankedTrader[], pattern: CopyPattern): RankedTrader[] {
  const eligible = ranking.filter((trader) => {
    const metrics = trader.analysis.metrics;
    return trader.eligible
      && metrics.closedOutcomeCount >= pattern.minClosed
      && metrics.bayesianWinRate >= pattern.minWinRate
      && metrics.profitFactor >= pattern.minProfitFactor
      && metrics.maxDrawdownPct <= pattern.maxDrawdownPct;
  });
  const selected: RankedTrader[] = [];
  const seenClans = new Set<string>();
  for (const trader of eligible) {
    const clan = trader.analysis.metrics.clanId;
    if (clan && seenClans.has(clan)) continue;
    selected.push(trader);
    if (clan) seenClans.add(clan);
    if (selected.length === pattern.topTraders) return selected;
  }
  for (const trader of eligible) {
    if (selected.includes(trader)) continue;
    selected.push(trader);
    if (selected.length === pattern.topTraders) break;
  }
  return selected;
}

function selectionKey(pattern: CopyPattern): string {
  return [
    pattern.lookbackDays,
    pattern.minClosed,
    pattern.minWinRate,
    pattern.minProfitFactor,
    pattern.maxDrawdownPct,
    pattern.topTraders,
  ].join("|");
}

function economicKey(pattern: CopyPattern): string {
  return `${selectionKey(pattern)}|${pattern.slippageBps}|${pattern.delaySeconds}`;
}

function outcomesForTraders(traders: readonly RankedTrader[], since: number, until: number): RealizedOutcome[] {
  return traders.flatMap((trader) => trader.analysis.outcomes.filter((outcome) =>
    outcome.eventTime >= since && outcome.eventTime <= until
  ));
}

export function screenPatterns(dataset: ResearchDataset, options: PatternScreenOptions): PatternScreenResult {
  const window = normalizeWindow(options.window);
  const patterns = generatePatternGrid(options.grid ?? {}, options.maxGridCells ?? DEFAULT_MAX_GRID_CELLS);
  executionValues(options);
  const rankings = new Map<number, RankedTrader[]>();
  for (const lookbackDays of new Set(patterns.map((pattern) => pattern.lookbackDays))) {
    rankings.set(lookbackDays, rankTraders(dataset, {
      since: Math.max(window.since, window.until - lookbackDays * DAY_MS),
      until: window.until,
    }, broadRankingOptions(options.ranking)));
  }
  const selectionCache = new Map<string, { traders: RankedTrader[]; outcomes: RealizedOutcome[] }>();
  const simulationCache = new Map<string, PatternSimulation>();
  const results = patterns.map((pattern): ScreenedPattern => {
    const key = selectionKey(pattern);
    let selection = selectionCache.get(key);
    if (!selection) {
      const since = Math.max(window.since, window.until - pattern.lookbackDays * DAY_MS);
      const traders = selectTraders(rankings.get(pattern.lookbackDays) ?? [], pattern);
      selection = { traders, outcomes: outcomesForTraders(traders, since, window.until) };
      selectionCache.set(key, selection);
    }
    const simKey = economicKey(pattern);
    let unitSimulation = simulationCache.get(simKey);
    if (!unitSimulation) {
      const unitPattern = { ...pattern, positionUsd: 1 };
      unitSimulation = simulateRetrospectiveCopies(selection.outcomes, unitPattern, options);
      simulationCache.set(simKey, unitSimulation);
    }
    const simulation: PatternSimulation = {
      ...unitSimulation,
      grossPnlUsd: unitSimulation.grossPnlUsd * pattern.positionUsd,
      executionCostUsd: unitSimulation.executionCostUsd * pattern.positionUsd,
      delayHaircutUsd: unitSimulation.delayHaircutUsd * pattern.positionUsd,
      netPnlUsd: unitSimulation.netPnlUsd * pattern.positionUsd,
    };
    return {
      pattern,
      label: RETROSPECTIVE_LABEL,
      selectedTraderIds: selection.traders.map((trader) => trader.analysis.metrics.userId),
      ...simulation,
    };
  });
  return { label: RETROSPECTIVE_LABEL, patternsTested: patterns.length, window, results };
}

function buildFolds(options: PatternValidationOptions, since: number, until: number): WalkForwardFold[] {
  if (options.folds) {
    const folds = options.folds.map((fold, index) => ({
      index,
      cutoff: fold.cutoff,
      testUntil: fold.testUntil,
    })).sort((a, b) => a.cutoff - b.cutoff || a.testUntil - b.testUntil)
      .map((fold, index) => ({ ...fold, index }));
    for (const fold of folds) {
      if (!Number.isFinite(fold.cutoff) || !Number.isFinite(fold.testUntil)
        || fold.cutoff < since || fold.testUntil > until || fold.cutoff >= fold.testUntil) {
        throw new RangeError("Explicit folds must lie inside the validation window and have cutoff < testUntil");
      }
    }
    return folds;
  }

  const foldCount = options.foldCount ?? 4;
  const testDays = options.testDays ?? 14;
  if (!Number.isInteger(foldCount) || foldCount <= 0) throw new RangeError("foldCount must be a positive integer");
  if (!Number.isInteger(testDays) || testDays <= 0) throw new RangeError("testDays must be a positive integer");
  const testMs = testDays * DAY_MS;
  if (until - foldCount * testMs < since) throw new RangeError("Validation window is too short for the requested folds");
  return Array.from({ length: foldCount }, (_, index) => {
    const cutoff = until - (foldCount - index) * testMs;
    return { index, cutoff, testUntil: cutoff + testMs };
  });
}

type FoldContext = {
  fold: WalkForwardFold;
  rankingByLookback: Map<number, RankedTrader[]>;
  testOutcomesByUser: Map<string, RealizedOutcome[]>;
};

function validationContexts(
  dataset: ResearchDataset,
  patterns: readonly CopyPattern[],
  folds: readonly WalkForwardFold[],
  since: number,
  rankingOptions: TraderRankingOptions | undefined,
  causal: boolean,
  maxObservationLagSeconds: number,
): FoldContext[] {
  const lookbacks = new Set(patterns.map((pattern) => pattern.lookbackDays));
  return folds.map((fold) => {
    const trainingDataset = causal ? availableDataset(dataset, fold.cutoff) : dataset;
    const testDataset = causal ? availableDataset(dataset, fold.testUntil) : dataset;
    const rankingByLookback = new Map<number, RankedTrader[]>();
    for (const lookbackDays of lookbacks) {
      rankingByLookback.set(lookbackDays, rankTraders(trainingDataset, {
        since: Math.max(since, fold.cutoff - lookbackDays * DAY_MS),
        until: fold.cutoff,
      }, broadRankingOptions(rankingOptions)));
    }
    const analyses = analyzeAllTraders(testDataset, { since, until: fold.testUntil }, rankingOptions);
    const testOutcomesByUser = new Map<string, RealizedOutcome[]>();
    for (const analysis of analyses) {
      // Requiring the whole average-cost pool to open after cutoff rejects crossing positions.
      testOutcomesByUser.set(analysis.metrics.userId, analysis.outcomes.filter((outcome) =>
        outcome.eventTime > fold.cutoff
        && outcome.eventTime <= fold.testUntil
        && outcome.basisOpenedAt > fold.cutoff
        && (!causal || (
          outcome.basisObservedAt !== null
          && outcome.basisObservedAt <= outcome.eventTime
          && outcome.basisMaxObservationLagSeconds !== null
          && outcome.basisMaxObservationLagSeconds <= maxObservationLagSeconds
          && outcome.observedTime !== null
          && outcome.observedTime <= fold.testUntil
          && outcome.observedTime - outcome.eventTime <= maxObservationLagSeconds * 1_000
        ))
      ));
    }
    return { fold, rankingByLookback, testOutcomesByUser };
  });
}

function availableDataset(dataset: ResearchDataset, cutoff: number): ResearchDataset {
  const users = dataset.users.filter((user) => Date.parse(user.firstObservedAt) <= cutoff);
  const userIds = new Set(users.map((user) => user.id));
  const swaps = dataset.swaps.filter((swap) =>
    userIds.has(swap.userId) && Date.parse(swap.observedAt) <= cutoff
  );
  return { users, swaps };
}

export function validatePatterns(dataset: ResearchDataset, options: PatternValidationOptions): PatternValidationResult {
  const window = normalizeWindow(options.window);
  const patterns = generatePatternGrid(options.grid ?? {}, options.maxGridCells ?? DEFAULT_MAX_GRID_CELLS);
  executionValues(options);
  const causal = options.causal ?? true;
  const maxObservationLagSeconds = options.maxObservationLagSeconds ?? 300;
  if (!Number.isFinite(maxObservationLagSeconds) || maxObservationLagSeconds < 0) {
    throw new RangeError("maxObservationLagSeconds must be non-negative");
  }
  const folds = buildFolds(options, window.since, window.until);
  const contexts = validationContexts(
    dataset,
    patterns,
    folds,
    window.since,
    options.ranking,
    causal,
    maxObservationLagSeconds,
  );
  const foldSelectionCache = new Map<string, { ids: string[]; outcomes: RealizedOutcome[] }>();
  const foldSimulationCache = new Map<string, PatternSimulation>();

  const results = patterns.map((pattern): ValidatedPattern => {
    const foldResults: PatternFoldResult[] = contexts.map((context) => {
      const selectionCacheKey = `${context.fold.index}|${selectionKey(pattern)}`;
      let selection = foldSelectionCache.get(selectionCacheKey);
      if (!selection) {
        const traders = selectTraders(context.rankingByLookback.get(pattern.lookbackDays) ?? [], pattern);
        const ids = traders.map((trader) => trader.analysis.metrics.userId);
        const outcomes = ids.flatMap((id) => context.testOutcomesByUser.get(id) ?? []);
        selection = { ids, outcomes };
        foldSelectionCache.set(selectionCacheKey, selection);
      }
      const simulationCacheKey = `${context.fold.index}|${economicKey(pattern)}`;
      let unitSimulation = foldSimulationCache.get(simulationCacheKey);
      if (!unitSimulation) {
        unitSimulation = simulateRetrospectiveCopies(selection.outcomes, { ...pattern, positionUsd: 1 }, options);
        foldSimulationCache.set(simulationCacheKey, unitSimulation);
      }
      return {
        foldIndex: context.fold.index,
        cutoff: context.fold.cutoff,
        testUntil: context.fold.testUntil,
        selectedTraderIds: selection.ids,
        ...unitSimulation,
        grossPnlUsd: unitSimulation.grossPnlUsd * pattern.positionUsd,
        executionCostUsd: unitSimulation.executionCostUsd * pattern.positionUsd,
        delayHaircutUsd: unitSimulation.delayHaircutUsd * pattern.positionUsd,
        netPnlUsd: unitSimulation.netPnlUsd * pattern.positionUsd,
      };
    });
    const netPnlUsd = foldResults.reduce((sum, fold) => sum + fold.netPnlUsd, 0);
    const tradeCount = foldResults.reduce((sum, fold) => sum + fold.tradeCount, 0);
    const positiveFolds = foldResults.filter((fold) => fold.netPnlUsd > 0).length;
    const aggregateTrades = contexts.flatMap((context, index) => {
      const selection = foldSelectionCache.get(`${context.fold.index}|${selectionKey(pattern)}`);
      return simulatedTrades(selection?.outcomes ?? [], pattern, options).map((trade) => ({ ...trade, foldIndex: index }));
    }).sort((a, b) => a.eventTime - b.eventTime || a.foldIndex - b.foldIndex);
    const aggregate = summarizeTrades(aggregateTrades, pattern.positionUsd);
    return {
      pattern,
      netPnlUsd,
      returnPct: tradeCount > 0 ? netPnlUsd / (pattern.positionUsd * tradeCount) : 0,
      maxDrawdownPct: aggregate.maxDrawdownPct,
      positiveFoldRatio: foldResults.length > 0 ? positiveFolds / foldResults.length : 0,
      worstFoldReturnPct: foldResults.length > 0 ? Math.min(...foldResults.map((fold) => fold.returnPct)) : 0,
      foldCount: foldResults.length,
      tradeCount,
      folds: foldResults,
    };
  });

  return {
    label: causal ? "walk-forward-causal" : "walk-forward-retrospective",
    patternsTested: patterns.length,
    folds,
    window,
    results,
  };
}
