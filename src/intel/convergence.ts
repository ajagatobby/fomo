/**
 * Convergence detection: which tokens are several ranked Fomo traders buying
 * inside the same short window.
 *
 * Everything here is pure. Callers supply already-fetched swaps and the module
 * reports clusters; nothing in this file performs I/O or reads the clock.
 */

import { networkName, tokenKey, tokenUrl } from "../fomo/networks.ts";
import type { FomoSwap } from "../fomo/types.ts";
import { normalizeSwap } from "./traders.ts";

export type ConvergenceBuy = {
  userId: string;
  handle: string;
  eventTime: number;
  tokenKey: string;
  networkId: string;
  tokenAddress: string;
  usd: number | null;
};

export type ConvergenceTrader = {
  userId: string;
  handle: string;
  usd: number;
  buys: number;
  firstBuyAt: number;
  lastBuyAt: number;
  /** Leaderboard placements that put this trader in the scanned pool. */
  sources: string[];
};

export type ConvergenceCluster = {
  tokenKey: string;
  networkId: string;
  networkName: string;
  tokenAddress: string;
  symbol: string | null;
  url: string | null;
  distinctTraders: number;
  buyCount: number;
  totalUsd: number;
  /** Buys with no reported USD value, excluded from totalUsd. */
  unpricedBuys: number;
  firstBuyAt: number;
  lastBuyAt: number;
  traders: ConvergenceTrader[];
};

export type ClusterOptions = {
  since: number;
  until: number;
  minTraders?: number;
};

/**
 * Reduces raw swaps to buy events. A buy is a swap out of cash (stablecoin or
 * wrapped native) into a token, which is how Fomo represents entering a
 * position, including cross-chain entries.
 */
export function buyEvents(swaps: readonly FomoSwap[]): ConvergenceBuy[] {
  const buys: ConvergenceBuy[] = [];
  for (const swap of swaps) {
    const event = normalizeSwap(swap);
    if (!event || event.side !== "buy") continue;
    if (!event.networkId || !event.tokenAddress) continue;
    buys.push({
      userId: event.userId,
      handle: event.userHandle,
      eventTime: event.eventTime,
      tokenKey: tokenKey(event.networkId, event.tokenAddress),
      networkId: event.networkId,
      tokenAddress: event.tokenAddress,
      usd: event.cashUsd,
    });
  }
  return buys.sort((a, b) => a.eventTime - b.eventTime || a.tokenKey.localeCompare(b.tokenKey));
}

/**
 * Groups buys inside [since, until] by token and ranks the result by how many
 * distinct traders bought, then by capital committed.
 */
export function clusterBuys(
  buys: readonly ConvergenceBuy[],
  options: ClusterOptions,
  symbols: ReadonlyMap<string, string> = new Map(),
  sourcesByUser: ReadonlyMap<string, readonly string[]> = new Map(),
): ConvergenceCluster[] {
  const { since, until } = options;
  if (!Number.isFinite(since) || !Number.isFinite(until)) {
    throw new RangeError("Convergence window bounds must be finite");
  }
  if (since > until) throw new RangeError("Convergence window since must not be after until");
  const minTraders = options.minTraders ?? 1;
  if (!Number.isInteger(minTraders) || minTraders < 1) {
    throw new RangeError("Convergence minTraders must be a positive integer");
  }

  const byToken = new Map<string, ConvergenceBuy[]>();
  for (const buy of buys) {
    if (buy.eventTime < since || buy.eventTime > until) continue;
    const list = byToken.get(buy.tokenKey);
    if (list) list.push(buy);
    else byToken.set(buy.tokenKey, [buy]);
  }

  const clusters: ConvergenceCluster[] = [];
  for (const [key, list] of byToken) {
    const traders = new Map<string, ConvergenceTrader>();
    let unpricedBuys = 0;
    for (const buy of list) {
      if (buy.usd === null) unpricedBuys++;
      const existing = traders.get(buy.userId);
      if (existing) {
        existing.usd += buy.usd ?? 0;
        existing.buys += 1;
        existing.firstBuyAt = Math.min(existing.firstBuyAt, buy.eventTime);
        existing.lastBuyAt = Math.max(existing.lastBuyAt, buy.eventTime);
        continue;
      }
      traders.set(buy.userId, {
        userId: buy.userId,
        handle: buy.handle,
        usd: buy.usd ?? 0,
        buys: 1,
        firstBuyAt: buy.eventTime,
        lastBuyAt: buy.eventTime,
        sources: [...(sourcesByUser.get(buy.userId) ?? [])],
      });
    }
    if (traders.size < minTraders) continue;
    const first = list[0];
    clusters.push({
      tokenKey: key,
      networkId: first.networkId,
      networkName: networkName(first.networkId),
      tokenAddress: first.tokenAddress,
      symbol: symbols.get(key) ?? null,
      url: tokenUrl(first.networkId, first.tokenAddress),
      distinctTraders: traders.size,
      buyCount: list.length,
      totalUsd: [...traders.values()].reduce((sum, trader) => sum + trader.usd, 0),
      unpricedBuys,
      firstBuyAt: Math.min(...list.map((buy) => buy.eventTime)),
      lastBuyAt: Math.max(...list.map((buy) => buy.eventTime)),
      traders: [...traders.values()].sort((a, b) =>
        b.usd - a.usd || b.buys - a.buys || a.handle.localeCompare(b.handle)
      ),
    });
  }

  return clusters.sort((a, b) =>
    b.distinctTraders - a.distinctTraders
    || b.totalUsd - a.totalUsd
    || b.lastBuyAt - a.lastBuyAt
    || a.tokenKey.localeCompare(b.tokenKey)
  );
}

/**
 * Collects token symbols from arbitrary Fomo payloads that embed token
 * metadata (balances, trades, clan tokens). Fomo's swap feed carries addresses
 * only, so symbols have to be recovered from a metadata-bearing endpoint.
 */
export function harvestTokenSymbols(
  payload: unknown,
  into: Map<string, string> = new Map(),
): Map<string, string> {
  walk(payload, into, new Set());
  return into;
}

function walk(node: unknown, into: Map<string, string>, seen: Set<object>): void {
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, into, seen);
    return;
  }
  const record = node as Record<string, unknown>;
  const metadata = record.tokenMetadata as Record<string, unknown> | undefined;
  if (metadata && typeof metadata.symbol === "string" && typeof record.tokenAddress === "string") {
    set(into, metadata.networkId ?? record.networkId, record.tokenAddress, metadata.symbol);
  }
  const token = record.token as Record<string, unknown> | undefined;
  if (token && typeof token.symbol === "string" && typeof token.address === "string") {
    set(into, token.networkId, token.address, token.symbol);
  }
  if (typeof record.symbol === "string" && typeof record.tokenAddress === "string" && record.networkId != null) {
    set(into, record.networkId, record.tokenAddress, record.symbol);
  }
  for (const value of Object.values(record)) walk(value, into, seen);
}

function set(into: Map<string, string>, networkId: unknown, address: string, symbol: string): void {
  const clean = symbol.trim();
  if (!clean || networkId == null) return;
  into.set(tokenKey(String(networkId), address), clean);
}
