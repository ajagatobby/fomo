import { parseArgs } from "node:util";
import { openFomoSession } from "../fomo/browser.ts";
import { FomoClient } from "../fomo/client.ts";
import { profileUrl } from "../fomo/networks.ts";
import type { FomoLeaderboardWindow, FomoSwap, FomoUser } from "../fomo/types.ts";
import {
  buyEvents,
  clusterBuys,
  harvestTokenSymbols,
  type ConvergenceCluster,
} from "../intel/convergence.ts";
import { banner, bold, cyan, dim, gold, green, table } from "../ui/index.ts";

const POOL_WINDOWS: FomoLeaderboardWindow[] = ["24h", "7d", "30d", "all"];
const MAX_LOOKBACK_MS = 24 * 3_600_000;
const MIN_LOOKBACK_MS = 30_000;
/** Buyers per cluster queried for token metadata when a symbol is unknown. */
const SYMBOL_LOOKUP_BUYERS = 2;
/** Rows shown when nothing clears --min-traders. */
const NEAR_MISS_ROWS = 5;
/** Warn once the scan itself consumes this share of the requested window. */
const STALE_WARNING_RATIO = 0.2;

type PoolMember = { user: FomoUser; sources: string[] };

export async function runHot(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      window: { type: "string", default: "5m" },
      "min-traders": { type: "string", default: "3" },
      top: { type: "string", default: "15" },
      pool: { type: "string", default: "100" },
      swaps: { type: "string", default: "50" },
      clans: { type: "boolean", default: false },
      "max-clans": { type: "string", default: "20" },
      json: { type: "boolean", default: false },
    },
  });
  const lookbackMs = lookback(values.window);
  const minTraders = positiveInteger(values["min-traders"], "--min-traders");
  const top = positiveInteger(values.top, "--top");
  const poolPerWindow = boundedInteger(values.pool, "--pool", 100);
  const swapLimit = boundedInteger(values.swaps, "--swaps", 100);
  const maxClans = positiveInteger(values["max-clans"], "--max-clans");
  const json = Boolean(values.json);

  const session = await openFomoSession();
  try {
    const client = new FomoClient(session);
    if (!json) console.log(banner(`Fomo convergence · last ${values.window}`));

    const pool = await buildPool(client, poolPerWindow, values.clans ? maxClans : 0, json);
    if (!pool.size) throw new Error("Fomo returned no ranked traders to scan");

    const users = [...pool.values()].map((member) => member.user);
    if (!json) process.stdout.write(`  ${dim(`Fetching recent swaps for ${users.length} traders...`)}`);
    const fetchStartedAt = Date.now();
    const swapsByUser = await client.recentSwapsMany(users, swapLimit);
    const fetchedAt = Date.now();
    const fetchSeconds = (fetchedAt - fetchStartedAt) / 1_000;
    const withHistory = [...swapsByUser.values()].filter((swaps) => swaps.length > 0).length;
    if (!json) {
      process.stdout.write(
        `\r  ${green("OK")} ${users.length} traders scanned in ${fetchSeconds.toFixed(1)}s`
        + ` · ${withHistory} with recent history\n\n`,
      );
    }

    const allSwaps: FomoSwap[] = [...swapsByUser.values()].flat();
    const sourcesByUser = new Map<string, string[]>(
      [...pool.entries()].map(([id, member]) => [id, member.sources]),
    );
    const buys = buyEvents(allSwaps);
    const until = fetchedAt;
    const since = until - lookbackMs;
    const symbols = new Map<string, string>();
    const cluster = (floor: number) => clusterBuys(buys, { since, until, minTraders: floor }, symbols, sourcesByUser);

    // Fomo's swap feed carries addresses only, so resolve symbols for whatever
    // this run will actually print - the matches, or the near misses shown in
    // their place when nothing clears --min-traders.
    let clusters = cluster(minTraders).slice(0, top);
    let nearMisses = clusters.length ? [] : cluster(1).slice(0, NEAR_MISS_ROWS);
    await resolveSymbols(client, pool, clusters.length ? clusters : nearMisses, symbols);
    clusters = cluster(minTraders).slice(0, top);
    nearMisses = clusters.length ? [] : cluster(1).slice(0, NEAR_MISS_ROWS);

    const report = {
      scannedAt: new Date(until).toISOString(),
      window: values.window,
      since: new Date(since).toISOString(),
      minTraders,
      pool: {
        traders: users.length,
        withRecentHistory: withHistory,
        includedClans: Boolean(values.clans),
        fetchSeconds: Number(fetchSeconds.toFixed(1)),
      },
      buyEventsInWindow: buys.filter((buy) => buy.eventTime >= since && buy.eventTime <= until).length,
      clusters,
    };
    // Traders are read sequentially, so the earliest reads are already this
    // many seconds old by the time the window is measured.
    const staleRatio = (fetchedAt - fetchStartedAt) / lookbackMs;

    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    render(report, clusters, nearMisses, staleRatio);
  } finally {
    await session.close();
  }
}

async function buildPool(
  client: FomoClient,
  poolPerWindow: number,
  maxClans: number,
  json: boolean,
): Promise<Map<string, PoolMember>> {
  const pool = new Map<string, PoolMember>();
  const add = (user: FomoUser, source: string) => {
    if (!user?.id) return;
    const existing = pool.get(user.id);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    pool.set(user.id, { user, sources: [source] });
  };

  const boards = await Promise.all(POOL_WINDOWS.map(async (window) => {
    try {
      return { window, entries: (await client.leaderboard(window, poolPerWindow)).data };
    } catch {
      return { window, entries: [] };
    }
  }));
  for (const { window, entries } of boards) {
    for (const entry of entries) add(entry.user, `${window}#${entry.rank}`);
  }
  const leaderboardCount = pool.size;

  if (maxClans > 0) {
    try {
      const clans = (await client.clanLeaderboard("24h")).data.slice(0, maxClans);
      const details = await Promise.all(clans.map(async (clan) => {
        try { return (await client.clan(clan.id, "24h")).data; } catch { return null; }
      }));
      for (const detail of details) {
        if (!detail) continue;
        for (const member of detail.members) add(member.user, `clan:${detail.name}`);
      }
    } catch {
      if (!json) console.log(gold("  Warning: clan discovery failed; scanning leaderboard traders only."));
    }
  }
  if (!json) {
    const extra = pool.size - leaderboardCount;
    console.log(dim(
      `  Pool: ${pool.size} ranked traders (${leaderboardCount} from leaderboards`
      + `${extra > 0 ? `, ${extra} from clans` : ""}).`,
    ));
  }
  return pool;
}

async function resolveSymbols(
  client: FomoClient,
  pool: Map<string, PoolMember>,
  clusters: readonly ConvergenceCluster[],
  symbols: Map<string, string>,
): Promise<void> {
  const unresolved = clusters.filter((cluster) => !cluster.symbol);
  if (!unresolved.length) return;
  const lookupIds = new Set<string>();
  for (const cluster of unresolved) {
    for (const trader of cluster.traders.slice(0, SYMBOL_LOOKUP_BUYERS)) lookupIds.add(trader.userId);
  }
  const users = [...lookupIds]
    .map((id) => pool.get(id)?.user)
    .filter((user): user is FomoUser => user !== undefined);
  if (!users.length) return;
  try {
    for (const payload of await client.balancesMany(users)) harvestTokenSymbols(payload, symbols);
  } catch {
    // Symbols are cosmetic; addresses and links still identify the token.
  }
}

type HotReport = {
  window: string;
  minTraders: number;
  buyEventsInWindow: number;
  pool: { traders: number };
};

function render(
  report: HotReport,
  clusters: readonly ConvergenceCluster[],
  nearMisses: readonly ConvergenceCluster[],
  staleRatio: number,
): void {
  if (staleRatio > STALE_WARNING_RATIO) {
    console.log(gold(
      `  Warning: the scan took ${(staleRatio * 100).toFixed(0)}% of the ${report.window} window,`
      + " so the earliest traders read are measurably stale.",
    ));
    console.log(dim("  Narrow the pool or widen --window for a tighter reading.\n"));
  }
  if (!clusters.length) {
    console.log(gold(
      `  No token had ${report.minTraders}+ ranked traders buying in the last ${report.window}.`,
    ));
    console.log(dim(
      `  ${report.buyEventsInWindow} buy events from ${report.pool.traders} traders in the window.`,
    ));
    if (nearMisses.length) {
      console.log(`\n${bold("Closest activity")}`);
      console.log(clusterTable(nearMisses));
    }
    console.log(dim("\n  Widen with --window 30m, lower --min-traders, or add --clans.\n"));
    disclaimer();
    return;
  }

  console.log(clusterTable(clusters));
  const lead = clusters[0];
  console.log(`\n${bold("Buyers")} ${dim(`· ${lead.symbol ?? lead.tokenAddress}`)}`);
  console.log(table(
    [
      { header: "Trader" }, { header: "Committed", align: "right" },
      { header: "Buys", align: "right" }, { header: "Last buy" }, { header: "Rank" },
    ],
    lead.traders.map((trader) => [
      `@${trader.handle}`, usd(trader.usd), String(trader.buys),
      clock(trader.lastBuyAt), trader.sources[0] ?? "-",
    ]),
  ));
  if (lead.url) console.log(`\n  ${bold("Token")}    ${cyan(lead.url)}`);
  console.log(`  ${bold("Buyer")}    ${cyan(profileUrl(lead.traders[0].handle))}`);
  disclaimer();
}

function clusterTable(clusters: readonly ConvergenceCluster[]): string {
  return table(
    [
      { header: "Traders", align: "right" }, { header: "Token", max: 18 }, { header: "Network" },
      { header: "Committed", align: "right" }, { header: "Buys", align: "right" },
      { header: "First" }, { header: "Last" }, { header: "Address", max: 46 },
    ],
    clusters.map((cluster) => [
      String(cluster.distinctTraders),
      cluster.symbol ?? dim("unknown"),
      cluster.networkName,
      usd(cluster.totalUsd),
      String(cluster.buyCount),
      clock(cluster.firstBuyAt),
      clock(cluster.lastBuyAt),
      cluster.tokenAddress,
    ]),
  );
}

function disclaimer(): void {
  console.log(dim("\n  Live Fomo swap data only; off-platform accumulation is not visible."));
  console.log(dim("  Crowding is not an entry signal and is not financial advice.\n"));
}

function clock(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 19) + "Z";
}

function usd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(value);
}

/** Parses a short lookback such as 90s, 5m, or 2h. */
function lookback(value: string | undefined): number {
  const normalized = (value ?? "5m").trim().toLowerCase();
  const match = /^(\d+)(s|m|h)$/.exec(normalized);
  if (!match) throw new Error("--window must be a duration such as 90s, 5m, 30m, or 2h");
  const unitMs = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const durationMs = Number(match[1]) * unitMs;
  if (!Number.isSafeInteger(durationMs) || durationMs < MIN_LOOKBACK_MS || durationMs > MAX_LOOKBACK_MS) {
    throw new Error("--window must be between 30s and 24h");
  }
  return durationMs;
}

function positiveInteger(value: string | undefined, flag: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${flag} must be a positive integer`);
  return number;
}

function boundedInteger(value: string | undefined, flag: string, max: number): number {
  const number = positiveInteger(value, flag);
  if (number > max) throw new Error(`${flag} must be between 1 and ${max}`);
  return number;
}
