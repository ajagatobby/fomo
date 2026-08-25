import type { FomoAlert } from "../fomo/types.ts";
import { canonicalTokenKey, type TokenMarket } from "../fomo/markets.ts";
import type { NormalizedTradeEvent, RankedTrader } from "./traders.ts";

export type SignalTrader = {
  userId: string;
  handle: string;
  clanId: string | null;
  reliability: number;
  score: number;
};

export type TokenSignalOptions = {
  since: number;
  until: number;
  maxObservationLagSeconds: number;
  minTraders: number;
  minBuyUsd: number;
  minNetBuyUsd: number;
  maxSellRatio: number;
  minUsdCoverage: number;
  minLiquidityUsd: number;
  minPairAgeHours: number;
};

export type TokenSignal = {
  tokenKey: string;
  networkId: string;
  tokenAddress: string;
  symbol: string | null;
  researchSignal: boolean;
  actionableBuyNow: false;
  confidence: "unknown" | "low" | "medium" | "high";
  rejectionReasons: string[];
  blockedBy: string[];
  buyers: Array<{ userId: string; handle: string; clanId: string | null; buyUsd: number; reliability: number }>;
  independentBuyerGroups: number;
  grossBuyUsd: number;
  grossSellUsd: number;
  netBuyUsd: number;
  sellRatio: number;
  usdCoverage: number;
  latestBuyAt: string | null;
  maximumObservationLagSeconds: number;
  matchingAlerts: number;
  market: TokenMarket | null;
  safety: {
    sellability: "unknown";
    honeypot: "unknown";
    buyTax: "unknown";
    sellTax: "unknown";
    holderConcentration: "unknown";
    liquidityLock: "unknown";
    contractAuthorities: "unknown";
  };
};

type TokenAccumulator = {
  networkId: string;
  tokenAddress: string;
  events: NormalizedTradeEvent[];
};

const SAFETY_BLOCKERS = [
  "sellabilityUnknown",
  "honeypotUnknown",
  "taxesUnknown",
  "holderConcentrationUnknown",
  "liquidityLockUnknown",
  "contractAuthoritiesUnknown",
];

export function selectSignalTraders(
  rankings: readonly RankedTrader[],
  incompleteUserIds: ReadonlySet<string>,
  minimumReliability: number,
  limit: number,
): SignalTrader[] {
  if (!Number.isFinite(minimumReliability) || minimumReliability < 0 || minimumReliability > 1) {
    throw new RangeError("Signal minimum reliability must be between zero and one");
  }
  if (!Number.isInteger(limit) || limit <= 0) throw new RangeError("Signal trader limit must be positive");
  return rankings.filter((trader) => {
    const metrics = trader.analysis.metrics;
    return trader.eligible
      && !incompleteUserIds.has(metrics.userId)
      && trader.reliability >= minimumReliability
      && metrics.realizedRoic > 0
      && metrics.profitFactor >= 1.25
      && metrics.bayesianWinRate >= 0.55
      && metrics.maxDrawdownPct <= 40;
  }).slice(0, limit).map((trader) => ({
    userId: trader.analysis.metrics.userId,
    handle: trader.analysis.metrics.handle,
    clanId: trader.analysis.metrics.clanId,
    reliability: trader.reliability,
    score: trader.score,
  }));
}

export function evaluateTokenSignals(
  events: readonly NormalizedTradeEvent[],
  traders: readonly SignalTrader[],
  markets: ReadonlyMap<string, TokenMarket>,
  alerts: readonly FomoAlert[],
  options: TokenSignalOptions,
): TokenSignal[] {
  validateOptions(options);
  const traderById = new Map(traders.map((trader) => [trader.userId, trader]));
  const tokens = new Map<string, TokenAccumulator>();
  for (const event of events) {
    if (!traderById.has(event.userId) || event.side === "other" || !event.tokenAddress || !event.networkId) continue;
    if (event.eventTime < options.since || event.eventTime > options.until) continue;
    if (event.observedTime === null || event.observedTime < event.eventTime || event.observedTime > options.until) continue;
    if (event.observedTime - event.eventTime > options.maxObservationLagSeconds * 1_000) continue;
    const key = canonicalTokenKey(event.networkId, event.tokenAddress);
    if (!key) continue;
    const existing = tokens.get(key);
    if (existing) existing.events.push(event);
    else tokens.set(key, { networkId: key.split(":", 1)[0], tokenAddress: event.tokenAddress, events: [event] });
  }

  return [...tokens.entries()].map(([tokenKey, token]) => {
    const flowEvents = token.events.filter((event) => event.cashUsd !== null);
    const qualifyingBuys = flowEvents.filter((event) => event.side === "buy" && (event.cashUsd ?? 0) >= options.minBuyUsd);
    const buysByTrader = new Map<string, number>();
    for (const event of qualifyingBuys) buysByTrader.set(event.userId, (buysByTrader.get(event.userId) ?? 0) + (event.cashUsd ?? 0));
    const buyers = [...buysByTrader].map(([userId, buyUsd]) => {
      const trader = traderById.get(userId)!;
      return { userId, handle: trader.handle, clanId: trader.clanId, buyUsd, reliability: trader.reliability };
    }).sort((a, b) => b.buyUsd - a.buyUsd || a.handle.localeCompare(b.handle));
    const independentGroups = new Set(buyers.map((buyer) => buyer.clanId ? `clan:${buyer.clanId}` : `user:${buyer.userId}`));
    const grossBuyUsd = qualifyingBuys.reduce((sum, event) => sum + (event.cashUsd ?? 0), 0);
    const grossSellUsd = flowEvents.filter((event) => event.side === "sell")
      .reduce((sum, event) => sum + (event.cashUsd ?? 0), 0);
    const netBuyUsd = grossBuyUsd - grossSellUsd;
    const sellRatio = grossBuyUsd > 0 ? grossSellUsd / grossBuyUsd : Infinity;
    const usdCoverage = token.events.length > 0 ? flowEvents.length / token.events.length : 0;
    const maximumObservationLagSeconds = token.events.reduce((maximum, event) =>
      Math.max(maximum, ((event.observedTime ?? event.eventTime) - event.eventTime) / 1_000), 0);
    const latestBuy = qualifyingBuys.reduce<NormalizedTradeEvent | null>((latest, event) =>
      !latest || event.eventTime > latest.eventTime ? event : latest, null);
    const matchingAlerts = alerts.filter((alert) =>
      alert.tokenAddress
      && canonicalTokenKey(alert.networkId ?? "", alert.tokenAddress) === tokenKey
      && Date.parse(alert.createdAt) >= options.since
      && Date.parse(alert.createdAt) <= options.until
    ).length;
    const market = markets.get(tokenKey) ?? null;
    const rejectionReasons: string[] = [];
    if (buyers.length < options.minTraders) rejectionReasons.push(`reliable buyers below ${options.minTraders}`);
    if (independentGroups.size < options.minTraders) rejectionReasons.push(`independent buyer groups below ${options.minTraders}`);
    if (netBuyUsd < options.minNetBuyUsd) rejectionReasons.push(`net reliable-trader buys below $${options.minNetBuyUsd}`);
    if (sellRatio > options.maxSellRatio) rejectionReasons.push(`sell/buy ratio above ${options.maxSellRatio}`);
    if (usdCoverage < options.minUsdCoverage) rejectionReasons.push(`USD flow coverage below ${options.minUsdCoverage}`);
    if (market?.liquidityUsd == null) rejectionReasons.push("liquidity unknown");
    else if (market.liquidityUsd < options.minLiquidityUsd) rejectionReasons.push(`liquidity below $${options.minLiquidityUsd}`);
    if (market?.pairCreatedAt == null) rejectionReasons.push("pair age unknown");
    else if (options.until - market.pairCreatedAt < options.minPairAgeHours * 3_600_000) {
      rejectionReasons.push(`pair younger than ${options.minPairAgeHours}h`);
    }
    const researchSignal = rejectionReasons.length === 0;
    const confidence = !researchSignal ? "low"
      : buyers.length >= 3 && matchingAlerts > 0 && usdCoverage === 1 ? "high" : "medium";
    return {
      tokenKey,
      networkId: token.networkId,
      tokenAddress: token.tokenAddress,
      symbol: market?.symbol ?? alertSymbol(alerts, tokenKey),
      researchSignal,
      actionableBuyNow: false,
      confidence,
      rejectionReasons,
      blockedBy: [...SAFETY_BLOCKERS],
      buyers,
      independentBuyerGroups: independentGroups.size,
      grossBuyUsd,
      grossSellUsd,
      netBuyUsd,
      sellRatio,
      usdCoverage,
      latestBuyAt: latestBuy ? new Date(latestBuy.eventTime).toISOString() : null,
      maximumObservationLagSeconds,
      matchingAlerts,
      market,
      safety: {
        sellability: "unknown",
        honeypot: "unknown",
        buyTax: "unknown",
        sellTax: "unknown",
        holderConcentration: "unknown",
        liquidityLock: "unknown",
        contractAuthorities: "unknown",
      },
    } satisfies TokenSignal;
  }).sort((a, b) =>
    Number(b.researchSignal) - Number(a.researchSignal)
    || b.buyers.length - a.buyers.length
    || b.netBuyUsd - a.netBuyUsd
    || a.tokenKey.localeCompare(b.tokenKey)
  );
}

function alertSymbol(alerts: readonly FomoAlert[], tokenKey: string): string | null {
  for (const alert of alerts) {
    if (!alert.tokenAddress || canonicalTokenKey(alert.networkId ?? "", alert.tokenAddress) !== tokenKey) continue;
    for (const key of ["ticker", "symbol"]) {
      const value = alert.body[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function validateOptions(options: TokenSignalOptions): void {
  if (!Number.isFinite(options.since) || !Number.isFinite(options.until) || options.since >= options.until) {
    throw new RangeError("Signal window must be finite and non-empty");
  }
  for (const [name, value] of Object.entries(options)) {
    if (name === "since" || name === "until") continue;
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`Signal option ${name} must be non-negative`);
  }
  if (!Number.isInteger(options.minTraders) || options.minTraders <= 0) {
    throw new RangeError("Signal minTraders must be a positive integer");
  }
  if (options.maxSellRatio > 1 || options.minUsdCoverage > 1) {
    throw new RangeError("Signal ratios must be between zero and one");
  }
}
