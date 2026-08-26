import type { FomoSwap, ResearchDataset, ResearchUser } from "../fomo/types.ts";

export type TimeInput = number | string | Date;

export type AnalysisWindow = {
  since: TimeInput;
  until: TimeInput;
};

export type CashKind = "wrapped-native" | "stable" | "noncash";
export type TradeSide = "buy" | "sell" | "other";

export type NormalizedTradeEvent = {
  id: string;
  userId: string;
  userHandle: string;
  eventTime: number;
  side: TradeSide;
  networkId: string | null;
  tokenAddress: string | null;
  tokenKey: string | null;
  tokenAmount: number | null;
  cashUsd: number | null;
  swap: FomoSwap;
};

export type RealizedOutcome = {
  swapId: string;
  userId: string;
  userHandle: string;
  eventTime: number;
  networkId: string;
  tokenAddress: string;
  tokenKey: string;
  soldAmount: number;
  coveredAmount: number;
  coverageRatio: number;
  basisUsd: number;
  proceedsUsd: number;
  pnlUsd: number;
  returnPct: number;
  holdSecondsEstimate: number | null;
  /** Earliest acquisition still represented by the average-cost pool. */
  basisOpenedAt: number;
};

export type TraderMetrics = {
  userId: string;
  handle: string;
  displayName: string;
  clanId: string | null;
  clanName: string | null;
  since: number;
  until: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  otherCount: number;
  closedOutcomeCount: number;
  realizedPnlUsd: number;
  realizedBasisUsd: number;
  realizedRoic: number;
  bayesianWinRate: number;
  profitFactor: number;
  profitFactorForRanking: number;
  expectancyUsd: number;
  activeDays: number;
  positiveDayRatio: number;
  capitalAtRiskUsd: number;
  maxDrawdownPct: number;
  dailySharpe: number;
  dailySortino: number;
  concentrationHhi: number;
  basisCoverage: number;
  medianTicketUsd: number | null;
  medianHoldSeconds: number | null;
};

export type TraderAnalysis = {
  user: ResearchUser;
  metrics: TraderMetrics;
  events: NormalizedTradeEvent[];
  outcomes: RealizedOutcome[];
};

export type TraderMetricOptions = {
  bayesianPriorWins?: number;
  bayesianPriorLosses?: number;
  profitFactorCap?: number;
};

export type TraderRankingOptions = TraderMetricOptions & {
  minTrades?: number;
  minClosed?: number;
  minBasisCoverage?: number;
  minActiveDays?: number;
  reliabilityClosedScale?: number;
};

export type RankingComponent = {
  value: number;
  robustZ: number;
  weight: number;
  contribution: number;
};

export type RankedTrader = {
  rank: number | null;
  eligible: boolean;
  eligibilityReasons: string[];
  reliability: number;
  score: number;
  components: {
    efficiency: RankingComponent;
    outcomes: RankingComponent;
    consistency: RankingComponent;
    riskControl: RankingComponent;
  };
  analysis: TraderAnalysis;
};

const SOLANA_NETWORKS = new Set(["1399811149", "sol", "solana", "mainnet-beta"]);
const ETHEREUM_NETWORKS = new Set(["1", "eth", "ethereum", "mainnet"]);
const BASE_NETWORKS = new Set(["8453", "base", "base-mainnet"]);
const BSC_NETWORKS = new Set(["56", "bsc", "bnb", "bnb-chain", "binance-smart-chain"]);
const MONAD_NETWORKS = new Set(["143", "monad"]);
const ROBINHOOD_NETWORKS = new Set(["4663", "robinhood", "robinhood-chain"]);

const CASH_ADDRESSES: Readonly<Record<string, Readonly<Record<string, Exclude<CashKind, "noncash">>>>> = {
  solana: {
    So11111111111111111111111111111111111111112: "wrapped-native",
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "stable",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "stable",
  },
  ethereum: {
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "wrapped-native",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "stable",
    "0xdac17f958d2ee523a2206206994597c13d831ec7": "stable",
    "0x6b175474e89094c44da98b954eedeac495271d0f": "stable",
  },
  base: {
    "0x4200000000000000000000000000000000000006": "wrapped-native",
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "stable",
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": "stable",
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": "stable",
  },
  bsc: {
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "wrapped-native",
    "0x55d398326f99059ff775485246999027b3197955": "stable",
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "stable",
    "0xe9e7cea3dedca5984780bafc599bd69add087d56": "stable",
    "0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3": "stable",
  },
  monad: {
    "0x754704bc059f8c67012fed69bc8a327a5aafb603": "stable",
  },
  robinhood: {
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "stable",
  },
};

type Book = {
  totalQty: number;
  coveredQty: number;
  coveredCostUsd: number;
  acquiredAtWeightedMs: number;
  basisOpenedAt: number;
};

type LedgerResult = {
  outcomes: RealizedOutcome[];
  maxCapitalAtRiskUsd: number;
  sellProceedsUsd: number;
  coveredSellProceedsUsd: number;
};

const DAY_MS = 86_400_000;
const EPSILON = 1e-12;

function networkFamily(networkId: string | null | undefined): keyof typeof CASH_ADDRESSES | null {
  const value = String(networkId ?? "").trim().toLowerCase();
  if (SOLANA_NETWORKS.has(value)) return "solana";
  if (ETHEREUM_NETWORKS.has(value)) return "ethereum";
  if (BASE_NETWORKS.has(value)) return "base";
  if (BSC_NETWORKS.has(value)) return "bsc";
  if (MONAD_NETWORKS.has(value)) return "monad";
  if (ROBINHOOD_NETWORKS.has(value)) return "robinhood";
  return null;
}

function normalizedAddress(networkId: string | null | undefined, address: string): string {
  return networkFamily(networkId) === "solana" ? address.trim() : address.trim().toLowerCase();
}

export function classifyCashAsset(networkId: string | null | undefined, address: string | null | undefined): CashKind {
  if (!address) return "noncash";
  const family = networkFamily(networkId);
  if (!family) return "noncash";
  return CASH_ADDRESSES[family][normalizedAddress(networkId, address)] ?? "noncash";
}

export function toTimestamp(value: TimeInput): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("Timestamp must be finite");
    return Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
  }
  const numeric = Number(value);
  if (value.trim() !== "" && Number.isFinite(numeric)) return toTimestamp(numeric);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`Invalid timestamp: ${value}`);
  return parsed;
}

export function normalizeWindow(window: AnalysisWindow): { since: number; until: number } {
  const since = toTimestamp(window.since);
  const until = toTimestamp(window.until);
  if (since > until) throw new RangeError("Analysis window since must not be after until");
  return { since, until };
}

function optionalTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    return toTimestamp(value as TimeInput);
  } catch {
    return null;
  }
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function tokenKey(networkId: string, address: string): string {
  return `${networkId.toLowerCase()}:${normalizedAddress(networkId, address)}`;
}

export function normalizeSwap(swap: FomoSwap): NormalizedTradeEvent | null {
  const eventTime = optionalTimestamp(swap.createdAt);
  if (eventTime === null) return null;

  const inCash = classifyCashAsset(swap.inNetworkId, swap.inTokenAddress);
  const outCash = classifyCashAsset(swap.outNetworkId, swap.outTokenAddress);
  let side: TradeSide = "other";
  let networkId: string | null = null;
  let address: string | null = null;
  let amount: number | null = null;
  let cashUsd: number | null = null;

  if (inCash !== "noncash" && outCash === "noncash") {
    side = "buy";
    networkId = String(swap.outNetworkId);
    address = swap.outTokenAddress;
    amount = positiveNumber(swap.outHumanAmount);
    cashUsd = positiveNumber(swap.humanUsdAmountIn);
  } else if (inCash === "noncash" && outCash !== "noncash") {
    side = "sell";
    networkId = String(swap.inNetworkId);
    address = swap.inTokenAddress;
    amount = positiveNumber(swap.inHumanAmount);
    cashUsd = positiveNumber(swap.humanUsdAmountOut);
  }

  return {
    id: String(swap.id),
    userId: String(swap.userId),
    userHandle: String(swap.userHandle),
    eventTime,
    side,
    networkId,
    tokenAddress: address,
    tokenKey: networkId && address ? tokenKey(networkId, address) : null,
    tokenAmount: amount,
    cashUsd,
    swap,
  };
}

export function normalizeSwaps(swaps: readonly FomoSwap[]): NormalizedTradeEvent[] {
  const events: NormalizedTradeEvent[] = [];
  for (const swap of swaps) {
    const event = normalizeSwap(swap);
    if (event) events.push(event);
  }
  return events.sort((a, b) => a.eventTime - b.eventTime || a.id.localeCompare(b.id));
}

function runLedger(events: readonly NormalizedTradeEvent[], since: number, until: number): LedgerResult {
  const books = new Map<string, Book>();
  const outcomes: RealizedOutcome[] = [];
  let maxCapitalAtRiskUsd = 0;
  let currentCapitalAtRiskUsd = 0;
  let sellProceedsUsd = 0;
  let coveredSellProceedsUsd = 0;

  for (const event of events) {
    if (event.eventTime > until) break;
    if (event.eventTime >= since) maxCapitalAtRiskUsd = Math.max(maxCapitalAtRiskUsd, currentCapitalAtRiskUsd);
    if (!event.tokenKey || !event.tokenAddress || !event.networkId || !event.tokenAmount) continue;
    let book = books.get(event.tokenKey);
    if (!book) {
      book = {
        totalQty: 0,
        coveredQty: 0,
        coveredCostUsd: 0,
        acquiredAtWeightedMs: 0,
        basisOpenedAt: event.eventTime,
      };
      books.set(event.tokenKey, book);
    }

    if (event.side === "buy") {
      book.totalQty += event.tokenAmount;
      if (event.cashUsd !== null) {
        const oldCoveredQty = book.coveredQty;
        book.coveredQty += event.tokenAmount;
        book.coveredCostUsd += event.cashUsd;
        book.acquiredAtWeightedMs = oldCoveredQty > EPSILON
          ? (book.acquiredAtWeightedMs * oldCoveredQty + event.eventTime * event.tokenAmount) / book.coveredQty
          : event.eventTime;
        if (oldCoveredQty <= EPSILON) {
          book.basisOpenedAt = event.eventTime;
        }
        currentCapitalAtRiskUsd += event.cashUsd;
        if (event.eventTime >= since) {
          maxCapitalAtRiskUsd = Math.max(maxCapitalAtRiskUsd, currentCapitalAtRiskUsd);
        }
      }
      continue;
    }

    if (event.side !== "sell") continue;
    const totalBefore = book.totalQty;
    const matchedQty = Math.min(event.tokenAmount, totalBefore);
    const coveredAmount = totalBefore > EPSILON
      ? Math.min(book.coveredQty, matchedQty * (book.coveredQty / totalBefore))
      : 0;
    const averageCost = book.coveredQty > EPSILON ? book.coveredCostUsd / book.coveredQty : 0;
    const basisUsd = coveredAmount * averageCost;
    const coverageRatio = coveredAmount / event.tokenAmount;
    const proceedsUsd = event.cashUsd === null ? 0 : event.cashUsd * coverageRatio;
    const holdSecondsEstimate = coveredAmount > EPSILON && book.acquiredAtWeightedMs > 0
      ? Math.max(0, (event.eventTime - book.acquiredAtWeightedMs) / 1_000)
      : null;
    const basisOpenedAt = book.basisOpenedAt;

    book.totalQty = Math.max(0, totalBefore - event.tokenAmount);
    book.coveredQty = Math.max(0, book.coveredQty - coveredAmount);
    book.coveredCostUsd = Math.max(0, book.coveredCostUsd - basisUsd);
    currentCapitalAtRiskUsd = Math.max(0, currentCapitalAtRiskUsd - basisUsd);
    if (book.coveredQty <= EPSILON) {
      book.coveredQty = 0;
      book.coveredCostUsd = 0;
      book.acquiredAtWeightedMs = 0;
    }

    if (event.eventTime < since || event.cashUsd === null) continue;
    sellProceedsUsd += event.cashUsd;
    coveredSellProceedsUsd += proceedsUsd;
    if (coveredAmount <= EPSILON || basisUsd <= EPSILON) continue;
    const pnlUsd = proceedsUsd - basisUsd;
    outcomes.push({
      swapId: event.id,
      userId: event.userId,
      userHandle: event.userHandle,
      eventTime: event.eventTime,
      networkId: event.networkId,
      tokenAddress: event.tokenAddress,
      tokenKey: event.tokenKey,
      soldAmount: event.tokenAmount,
      coveredAmount,
      coverageRatio,
      basisUsd,
      proceedsUsd,
      pnlUsd,
      returnPct: pnlUsd / basisUsd,
      holdSecondsEstimate,
      basisOpenedAt,
    });
  }

  return { outcomes, maxCapitalAtRiskUsd, sellProceedsUsd, coveredSellProceedsUsd };
}

export function calculateRealizedOutcomes(
  swaps: readonly FomoSwap[],
  window: AnalysisWindow,
): RealizedOutcome[] {
  const { since, until } = normalizeWindow(window);
  return runLedger(normalizeSwaps(swaps), since, until).outcomes;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function standardDeviation(values: readonly number[], target = 0): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + (value - target) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function riskAdjustedDaily(dailyReturns: readonly number[]): { sharpe: number; sortino: number } {
  if (dailyReturns.length < 2) return { sharpe: 0, sortino: 0 };
  const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length;
  const volatility = standardDeviation(dailyReturns, mean);
  const downside = dailyReturns.filter((value) => value < 0);
  const downsideDeviation = standardDeviation(downside, 0);
  // Zero-return days are retained; sqrt(365) annualizes these descriptive ratios.
  return {
    sharpe: volatility > EPSILON ? (mean / volatility) * Math.sqrt(365) : 0,
    sortino: downsideDeviation > EPSILON ? (mean / downsideDeviation) * Math.sqrt(365) : 0,
  };
}

function drawdownPct(outcomes: readonly RealizedOutcome[], capitalAtRiskUsd: number): number {
  if (capitalAtRiskUsd <= EPSILON) return 0;
  let equity = capitalAtRiskUsd;
  let peak = equity;
  let maximum = 0;
  for (const outcome of outcomes) {
    equity += outcome.pnlUsd;
    peak = Math.max(peak, equity);
    maximum = Math.max(maximum, peak > EPSILON ? (peak - equity) / peak : 1);
  }
  // This curve deliberately excludes open-position appreciation and external deposits.
  return Math.min(1, maximum) * 100;
}

function userSwaps(dataset: ResearchDataset, userId: string): FomoSwap[] {
  return dataset.swaps.filter((swap: FomoSwap) => String(swap.userId) === userId);
}

export function analyzeTrader(
  user: ResearchUser,
  swaps: readonly FomoSwap[],
  window: AnalysisWindow,
  options: TraderMetricOptions = {},
): TraderAnalysis {
  const { since, until } = normalizeWindow(window);
  const priorWins = options.bayesianPriorWins ?? 1;
  const priorLosses = options.bayesianPriorLosses ?? 1;
  const profitFactorCap = options.profitFactorCap ?? 10;
  if (priorWins < 0 || priorLosses < 0 || priorWins + priorLosses <= 0) {
    throw new RangeError("Bayesian prior counts must be non-negative and non-zero in total");
  }
  if (profitFactorCap <= 0) throw new RangeError("Metric caps must be positive");

  const events = normalizeSwaps(swaps);
  const inWindow = events.filter((event) => event.eventTime >= since && event.eventTime <= until);
  const ledger = runLedger(events, since, until);
  const outcomes = ledger.outcomes;
  const wins = outcomes.filter((outcome) => outcome.pnlUsd > 0).length;
  const grossProfit = outcomes.reduce((sum, outcome) => sum + Math.max(0, outcome.pnlUsd), 0);
  const grossLoss = outcomes.reduce((sum, outcome) => sum + Math.max(0, -outcome.pnlUsd), 0);
  const realizedPnlUsd = grossProfit - grossLoss;
  const realizedBasisUsd = outcomes.reduce((sum, outcome) => sum + outcome.basisUsd, 0);
  const rawProfitFactor = grossLoss > EPSILON ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const dailyPnl = new Map<string, number>();
  for (const outcome of outcomes) {
    const day = utcDay(outcome.eventTime);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + outcome.pnlUsd);
  }
  const activeDaySet = new Set(inWindow.map((event) => utcDay(event.eventTime)));
  const positiveDays = [...activeDaySet].filter((day) => (dailyPnl.get(day) ?? 0) > 0).length;
  const capitalAtRiskUsd = ledger.maxCapitalAtRiskUsd;
  const dailyReturns: number[] = [];
  for (let day = Date.UTC(
    new Date(since).getUTCFullYear(),
    new Date(since).getUTCMonth(),
    new Date(since).getUTCDate(),
  ); day <= until; day += DAY_MS) {
    dailyReturns.push(capitalAtRiskUsd > EPSILON ? (dailyPnl.get(utcDay(day)) ?? 0) / capitalAtRiskUsd : 0);
  }
  const riskAdjusted = riskAdjustedDaily(dailyReturns);
  const basisByToken = new Map<string, number>();
  for (const outcome of outcomes) {
    basisByToken.set(outcome.tokenKey, (basisByToken.get(outcome.tokenKey) ?? 0) + outcome.basisUsd);
  }
  const concentrationHhi = realizedBasisUsd > EPSILON
    ? [...basisByToken.values()].reduce((sum, basis) => sum + (basis / realizedBasisUsd) ** 2, 0)
    : 0;
  const pricedEvents = inWindow.filter((event) => event.cashUsd !== null);

  return {
    user,
    events,
    outcomes,
    metrics: {
      userId: String(user.id),
      handle: String(user.handle),
      displayName: user.displayName ?? user.handle,
      clanId: user.clanId == null ? null : String(user.clanId),
      clanName: user.clanName == null ? null : String(user.clanName),
      since,
      until,
      tradeCount: inWindow.filter((event) => event.side !== "other").length,
      buyCount: inWindow.filter((event) => event.side === "buy").length,
      sellCount: inWindow.filter((event) => event.side === "sell").length,
      otherCount: inWindow.filter((event) => event.side === "other").length,
      closedOutcomeCount: outcomes.length,
      realizedPnlUsd,
      realizedBasisUsd,
      realizedRoic: realizedBasisUsd > EPSILON ? realizedPnlUsd / realizedBasisUsd : 0,
      bayesianWinRate: (wins + priorWins) / (outcomes.length + priorWins + priorLosses),
      profitFactor: rawProfitFactor,
      profitFactorForRanking: Math.min(profitFactorCap, rawProfitFactor),
      expectancyUsd: outcomes.length > 0 ? realizedPnlUsd / outcomes.length : 0,
      activeDays: activeDaySet.size,
      positiveDayRatio: activeDaySet.size > 0 ? positiveDays / activeDaySet.size : 0,
      capitalAtRiskUsd,
      maxDrawdownPct: drawdownPct(outcomes, capitalAtRiskUsd),
      dailySharpe: riskAdjusted.sharpe,
      dailySortino: riskAdjusted.sortino,
      concentrationHhi,
      basisCoverage: ledger.sellProceedsUsd > EPSILON
        ? ledger.coveredSellProceedsUsd / ledger.sellProceedsUsd
        : 0,
      medianTicketUsd: median(pricedEvents.map((event) => event.cashUsd as number)),
      medianHoldSeconds: median(outcomes.flatMap((outcome) =>
        outcome.holdSecondsEstimate === null ? [] : [outcome.holdSecondsEstimate]
      )),
    },
  };
}

export function computeTraderMetrics(
  user: ResearchUser,
  swaps: readonly FomoSwap[],
  window: AnalysisWindow,
  options: TraderMetricOptions = {},
): TraderMetrics {
  return analyzeTrader(user, swaps, window, options).metrics;
}

export function analyzeAllTraders(
  dataset: ResearchDataset,
  window: AnalysisWindow,
  options: TraderMetricOptions = {},
): TraderAnalysis[] {
  const swapsByUser = new Map<string, FomoSwap[]>();
  for (const swap of dataset.swaps) {
    const id = String(swap.userId);
    const list = swapsByUser.get(id);
    if (list) list.push(swap);
    else swapsByUser.set(id, [swap]);
  }
  return dataset.users.map((user: ResearchUser) =>
    analyzeTrader(user, swapsByUser.get(String(user.id)) ?? [], window, options)
  );
}

function robustZScores(values: readonly number[]): number[] {
  const center = median(values) ?? 0;
  const absoluteDeviations = values.map((value) => Math.abs(value - center));
  const mad = median(absoluteDeviations) ?? 0;
  if (mad <= EPSILON) return values.map(() => 0);
  return values.map((value) => Math.max(-4, Math.min(4, 0.674_489_75 * (value - center) / mad)));
}

export function rankTraders(
  dataset: ResearchDataset,
  window: AnalysisWindow,
  options: TraderRankingOptions = {},
): RankedTrader[] {
  const minTrades = options.minTrades ?? 8;
  const minClosed = options.minClosed ?? 5;
  const minBasisCoverage = options.minBasisCoverage ?? 0.7;
  const minActiveDays = options.minActiveDays ?? 2;
  const reliabilityClosedScale = options.reliabilityClosedScale ?? 12;
  const analyses = analyzeAllTraders(dataset, window, options);
  const componentValues = analyses.map(({ metrics }) => ({
    efficiency: metrics.realizedRoic,
    outcomes: Math.log1p(metrics.profitFactorForRanking),
    consistency: (metrics.bayesianWinRate + metrics.positiveDayRatio) / 2,
    riskControl: 1 - metrics.maxDrawdownPct / 100 - metrics.concentrationHhi * 0.25,
  }));
  const keys = ["efficiency", "outcomes", "consistency", "riskControl"] as const;
  const weights: Record<(typeof keys)[number], number> = {
    efficiency: 0.3,
    outcomes: 0.2,
    consistency: 0.3,
    riskControl: 0.2,
  };
  const zByKey = Object.fromEntries(keys.map((key) => [
    key,
    robustZScores(componentValues.map((values) => values[key])),
  ])) as Record<(typeof keys)[number], number[]>;

  const ranked = analyses.map((analysis, index): RankedTrader => {
    const metrics = analysis.metrics;
    const eligibilityReasons: string[] = [];
    if (metrics.tradeCount < minTrades) eligibilityReasons.push(`tradeCount<${minTrades}`);
    if (metrics.closedOutcomeCount < minClosed) eligibilityReasons.push(`closedOutcomeCount<${minClosed}`);
    if (metrics.basisCoverage < minBasisCoverage) eligibilityReasons.push(`basisCoverage<${minBasisCoverage}`);
    if (metrics.activeDays < minActiveDays) eligibilityReasons.push(`activeDays<${minActiveDays}`);
    const sampleReliability = metrics.closedOutcomeCount / (metrics.closedOutcomeCount + reliabilityClosedScale);
    const reliability = Math.max(0, Math.min(1,
      sampleReliability * metrics.basisCoverage * Math.min(1, metrics.activeDays / Math.max(1, minActiveDays * 2)),
    ));
    const components = Object.fromEntries(keys.map((key) => {
      const robustZ = zByKey[key][index];
      return [key, {
        value: componentValues[index][key],
        robustZ,
        weight: weights[key],
        contribution: robustZ * weights[key] * reliability,
      } satisfies RankingComponent];
    })) as RankedTrader["components"];
    const score = keys.reduce((sum, key) => sum + components[key].contribution, 0);
    return {
      rank: null,
      eligible: eligibilityReasons.length === 0,
      eligibilityReasons,
      reliability,
      score,
      components,
      analysis,
    };
  });

  ranked.sort((a, b) =>
    Number(b.eligible) - Number(a.eligible)
    || b.score - a.score
    || b.reliability - a.reliability
    || a.analysis.metrics.userId.localeCompare(b.analysis.metrics.userId)
  );
  let rank = 0;
  for (const trader of ranked) {
    if (trader.eligible) trader.rank = ++rank;
  }
  return ranked;
}

export function getTraderMetrics(
  dataset: ResearchDataset,
  userId: string,
  window: AnalysisWindow,
  options: TraderMetricOptions = {},
): TraderMetrics | null {
  const user = dataset.users.find((candidate: ResearchUser) => String(candidate.id) === userId);
  return user ? analyzeTrader(user, userSwaps(dataset, userId), window, options).metrics : null;
}
