import { parseArgs } from "node:util";
import { openFomoSession } from "../fomo/browser.ts";
import { FomoClient } from "../fomo/client.ts";
import { fetchTokenMarkets, canonicalNetworkId } from "../fomo/markets.ts";
import { pacedTransport } from "../fomo/rate-limit.ts";
import { FomoStore } from "../fomo/store.ts";
import type { FomoAlert, FomoUser, StoredFomoUser } from "../fomo/types.ts";
import { evaluateTokenSignals, selectSignalTraders, type TokenSignal } from "../intel/signals.ts";
import { normalizeSwaps, rankTraders } from "../intel/traders.ts";
import { banner, dim, gold, green, red, shortAddr, table } from "../ui/index.ts";

const DAY_MS = 86_400_000;

export async function runSignals(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      window: { type: "string", default: "15m" },
      "ranking-days": { type: "string", default: "90" },
      "max-traders": { type: "string", default: "25" },
      "min-traders": { type: "string", default: "2" },
      "min-reliability": { type: "string", default: "0.5" },
      "max-lag": { type: "string", default: "300" },
      "min-buy-usd": { type: "string", default: "100" },
      "min-net-buy-usd": { type: "string", default: "500" },
      "max-sell-ratio": { type: "string", default: "0.35" },
      "min-usd-coverage": { type: "string", default: "0.8" },
      "min-liquidity": { type: "string", default: "50000" },
      "min-age": { type: "string", default: "24" },
      chain: { type: "string" },
      top: { type: "string", default: "20" },
      concurrency: { type: "string", default: "4" },
      "requests-per-second": { type: "string", default: "4" },
      json: { type: "boolean", default: false },
    },
  });
  const windowMs = duration(values.window, "--window");
  if (windowMs > DAY_MS) throw new Error("--window must not exceed 24h");
  const rankingDays = positiveNumber(values["ranking-days"], "--ranking-days");
  const maxTraders = positiveInteger(values["max-traders"], "--max-traders");
  const minTraders = positiveInteger(values["min-traders"], "--min-traders");
  const minReliability = ratio(values["min-reliability"], "--min-reliability");
  const maxLag = nonNegativeNumber(values["max-lag"], "--max-lag");
  const minBuyUsd = nonNegativeNumber(values["min-buy-usd"], "--min-buy-usd");
  const minNetBuyUsd = nonNegativeNumber(values["min-net-buy-usd"], "--min-net-buy-usd");
  const maxSellRatio = ratio(values["max-sell-ratio"], "--max-sell-ratio");
  const minUsdCoverage = ratio(values["min-usd-coverage"], "--min-usd-coverage");
  const minLiquidityUsd = nonNegativeNumber(values["min-liquidity"], "--min-liquidity");
  const minPairAgeHours = nonNegativeNumber(values["min-age"], "--min-age");
  const top = positiveInteger(values.top, "--top");
  const concurrency = positiveInteger(values.concurrency, "--concurrency");
  if (concurrency > 8) throw new Error("--concurrency must be between 1 and 8");
  const requestsPerSecond = positiveNumber(values["requests-per-second"], "--requests-per-second");
  if (requestsPerSecond > 20) throw new Error("--requests-per-second must not exceed 20");
  const chain = values.chain ? canonicalNetworkId(values.chain) : null;
  if (values.chain && !chain) throw new Error("--chain must be solana, ethereum, base, or bsc");

  const startedAt = Date.now();
  const signalSince = startedAt - windowMs;
  const store = new FomoStore();
  let session: Awaited<ReturnType<typeof openFomoSession>> | null = null;
  try {
    const dataset = store.dataset();
    const selectionDataset = {
      users: dataset.users.filter((user) => Date.parse(user.firstObservedAt) <= signalSince),
      swaps: dataset.swaps.filter((swap) => Date.parse(swap.observedAt) <= signalSince),
    };
    const rankings = rankTraders(selectionDataset, {
      since: signalSince - rankingDays * DAY_MS,
      until: signalSince,
    });
    const traders = selectSignalTraders(rankings, store.incompleteUserIds(), minReliability, maxTraders);
    const userById = new Map(dataset.users.map((user) => [user.id, user]));
    const pollErrors: Array<{ handle: string; error: string }> = [];
    const alerts: FomoAlert[] = [];
    let alertError: string | null = null;
    let swaps = [] as Awaited<ReturnType<FomoClient["recentSwaps"]>>["data"]["items"];

    if (traders.length > 0) {
      session = await openFomoSession();
      const client = new FomoClient(pacedTransport(session, { requestsPerSecond }));
      const pages = await mapConcurrent(traders, concurrency, async (trader) => {
        const user = userById.get(trader.userId);
        if (!user) return [];
        try {
          return (await client.recentSwaps(storedAsFomoUser(user), 100)).data.items;
        } catch (error) {
          pollErrors.push({ handle: trader.handle, error: error instanceof Error ? error.message : String(error) });
          return [];
        }
      });
      swaps = pages.flat();
      try {
        alerts.push(...(await client.tradingAlerts({ limit: 100 })).data.items);
      } catch (error) {
        alertError = error instanceof Error ? error.message : String(error);
      }
    }

    const asOf = Date.now();
    let events = normalizeSwaps(swaps);
    if (chain) events = events.filter((event) => event.networkId && canonicalNetworkId(event.networkId) === chain);
    events = events.filter((event) =>
      event.eventTime >= signalSince
      && event.eventTime <= asOf
      && event.observedTime !== null
      && event.observedTime >= event.eventTime
      && event.observedTime <= asOf
      && event.observedTime - event.eventTime <= maxLag * 1_000
    );
    let markets = new Map();
    let marketError: string | null = null;
    try {
      markets = await fetchTokenMarkets(events.flatMap((event) =>
        event.networkId && event.tokenAddress ? [{ networkId: event.networkId, tokenAddress: event.tokenAddress }] : []
      ));
    } catch (error) {
      marketError = error instanceof Error ? error.message : String(error);
    }
    const signals = evaluateTokenSignals(events, traders, markets, alerts, {
      since: signalSince,
      until: asOf,
      maxObservationLagSeconds: maxLag,
      minTraders,
      minBuyUsd,
      minNetBuyUsd,
      maxSellRatio,
      minUsdCoverage,
      minLiquidityUsd,
      minPairAgeHours,
    });
    const report = {
      asOf: new Date(asOf).toISOString(),
      scope: "observed-reliable-fomo-trader-flow",
      completeUniverse: false,
      actionableBuyNowCount: 0,
      researchSignalCount: signals.filter((signal) => signal.researchSignal).length,
      selectionCutoff: new Date(signalSince).toISOString(),
      rankingDays,
      traders: { eligible: traders.length, polled: traders.length - pollErrors.length, failed: pollErrors.length },
      alerts: { fetched: alerts.length, error: alertError },
      marketError,
      signals,
      pollErrors,
      limitations: [
        "Signals cover selected locally measured Fomo traders, not the entire market.",
        "Contract sellability, taxes, authorities, holder concentration, and liquidity lock remain unknown.",
        "Token flow alone does not prove that a contract is a memecoin.",
        "Research signals are observational evidence and never an instruction or guarantee to buy.",
      ],
    };
    if (values.json) console.log(JSON.stringify(report, jsonNumber, 2));
    else renderSignals(signals.slice(0, top), report);
  } finally {
    await session?.close();
    store.close();
  }
}

function renderSignals(
  signals: readonly TokenSignal[],
  report: { researchSignalCount: number; traders: { eligible: number; polled: number; failed: number }; marketError: string | null },
): void {
  console.log(banner("current token signals"));
  console.log(dim(`  Reliable traders: ${report.traders.eligible}; polled: ${report.traders.polled}; failed: ${report.traders.failed}.`));
  if (!signals.length) {
    console.log(`\n  ${gold("NO SIGNAL")} No timely classified token flow was observed in the selected trader set.\n`);
    return;
  }
  console.log(table(
    [
      { header: "State" }, { header: "Token" }, { header: "Chain" },
      { header: "Buyers", align: "right" }, { header: "Net buy", align: "right" },
      { header: "Sell", align: "right" }, { header: "Liquidity", align: "right" },
      { header: "Age", align: "right" }, { header: "Lag", align: "right" },
    ],
    signals.map((signal) => [
      signal.researchSignal ? green("RESEARCH") : dim("REJECT"),
      signal.symbol ?? shortAddr(signal.tokenAddress, 6),
      chainName(signal.networkId),
      String(signal.buyers.length),
      usd(signal.netBuyUsd),
      Number.isFinite(signal.sellRatio) ? pct(signal.sellRatio) : "-",
      signal.market?.liquidityUsd == null ? "unknown" : usd(signal.market.liquidityUsd),
      signal.market?.pairCreatedAt == null ? "unknown" : age(Date.now() - signal.market.pairCreatedAt),
      `${signal.maximumObservationLagSeconds.toFixed(0)}s`,
    ]),
  ));
  const strongest = signals.find((signal) => signal.researchSignal);
  if (strongest) {
    console.log(banner("strongest research signal"));
    console.log(`  ${green(strongest.symbol ?? strongest.tokenAddress)} · ${strongest.buyers.map((buyer) => `@${buyer.handle}`).join(", ")}`);
    console.log(`  Net reliable-trader flow ${usd(strongest.netBuyUsd)}; liquidity ${strongest.market?.liquidityUsd == null ? "unknown" : usd(strongest.market.liquidityUsd)}.`);
    console.log(`  ${red("BUY-NOW BLOCKED")} Contract safety and holder-risk checks are unavailable.`);
  } else {
    console.log(`\n  ${gold("NO ACTIONABLE RESEARCH SIGNAL")} Every observed token failed one or more evidence gates.`);
    console.log(dim(`  Leading rejection: ${signals[0].rejectionReasons.join("; ")}.`));
  }
  if (report.marketError) console.log(dim(`\n  Market enrichment failed: ${report.marketError}`));
  console.log(dim("\n  This command reports observed research evidence and never places or directs a trade.\n"));
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

function duration(value: string | undefined, name: string): number {
  const match = /^(\d+)(s|m|h)$/.exec((value ?? "").trim().toLowerCase());
  if (!match) throw new Error(`${name} must be a duration such as 5m, 15m, or 1h`);
  const factor = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1_000;
  const result = Number(match[1]) * factor;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be positive`);
  return result;
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

function chainName(networkId: string): string {
  if (networkId === "1399811149") return "Solana";
  if (networkId === "1") return "Ethereum";
  if (networkId === "8453") return "Base";
  if (networkId === "56") return "BSC";
  return networkId;
}

function age(milliseconds: number): string {
  const hours = Math.max(0, milliseconds) / 3_600_000;
  return hours >= 48 ? `${(hours / 24).toFixed(0)}d` : `${hours.toFixed(0)}h`;
}

function usd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function jsonNumber(_key: string, value: unknown): unknown {
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}
