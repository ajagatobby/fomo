import type {
  FomoAlert,
  FomoAlertsPage,
  FomoApiEnvelope,
  FomoClanDetail,
  FomoClanLeaderboardEntry,
  FomoClanWindow,
  FomoClosedTradesPage,
  FomoLeaderboardEntry,
  FomoLeaderboardWindow,
  FomoPageResult,
  FomoPaginatedResult,
  FomoPnlSnapshot,
  FomoRecentSwaps,
  FomoSwap,
  FomoSwapsPage,
  FomoUser,
  RawFomoPage,
} from "./types.ts";

export type FomoJsonTransport = {
  request<T = unknown>(path: string): Promise<T>;
  requestMany?<T = unknown>(paths: string[], concurrency?: number): Promise<Array<T | null>>;
};

export type ClosedTradesOptions = {
  maxPages?: number;
  tokenAddress?: string;
  orderBy?: "closedAt" | "realizedPnlUsd";
};

export type TradingAlertsOptions = {
  limit?: number;
  lastId?: string;
  threshold?: number;
  minEquity?: number;
  minMarketCap?: number;
  maxMarketCap?: number;
};

/** Read-only client for the profile research endpoints used by the Fomo web app. */
export class FomoClient {
  readonly #transport: FomoJsonTransport;

  constructor(transport: FomoJsonTransport) {
    this.#transport = transport;
  }

  async currentUser(): Promise<FomoPageResult<FomoUser>> {
    const endpoint = "/v2/users/current";
    const fetchedAt = new Date().toISOString();
    const response = await this.#transport.request(endpoint);
    const user = parseUser(envelopeObject(response, endpoint), endpoint);
    return { data: user, raw: rawPage(endpoint, 1, null, fetchedAt, response) };
  }

  async resolveUser(handle: string): Promise<FomoPageResult<FomoUser>> {
    const cleanHandle = normalizeHandle(handle);
    const endpoint = `/v2/users/userHandle/${encodeURIComponent(cleanHandle)}`;
    const fetchedAt = new Date().toISOString();
    const response = await this.#transport.request(endpoint);
    const payload = envelopeObject(response, endpoint);
    const user = parseUser(payload, endpoint);
    return { data: user, raw: rawPage(endpoint, 1, null, fetchedAt, response) };
  }

  async resolveUsers(handles: string[]): Promise<Array<FomoUser | null>> {
    const endpoints = handles.map((handle) =>
      `/v2/users/userHandle/${encodeURIComponent(normalizeHandle(handle))}`
    );
    const responses = this.#transport.requestMany
      ? await this.#transport.requestMany(endpoints, 24)
      : await Promise.all(endpoints.map(async (endpoint) => {
          try { return await this.#transport.request(endpoint); } catch { return null; }
        }));
    return responses.map((response, index) => {
      if (response === null) return null;
      try {
        return parseUser(envelopeObject(response, endpoints[index]), endpoints[index]);
      } catch {
        return null;
      }
    });
  }

  async searchUsers(searchTerm: string): Promise<FomoPageResult<FomoUser[]>> {
    const clean = searchTerm.trim();
    if (!clean) throw new Error("A Fomo user search term is required");
    const endpoint = `/v2/users/fuzzy-search?searchTerm=${encodeURIComponent(clean)}`;
    const result = await this.#single(endpoint);
    if (!isRecord(result.data) || !Array.isArray(result.data.users)) {
      throw new Error(`Fomo ${endpoint} returned an invalid user search`);
    }
    return {
      data: result.data.users.map((user, index) => parseUser(user, `${endpoint} user ${index}`)),
      raw: result.raw,
    };
  }

  async leaderboard(
    window: FomoLeaderboardWindow = "24h",
    limit = 50,
  ): Promise<FomoPageResult<FomoLeaderboardEntry[]>> {
    validateLimit(limit);
    const endpoint = window === "all"
      ? `/v2/leaderboard?limit=${limit}`
      : `/v2/leaderboard/${window}?limit=${limit}`;
    const result = await this.#single(endpoint);
    if (!isRecord(result.data) || !Array.isArray(result.data.leaderboard)) {
      throw new Error(`Fomo ${endpoint} returned an invalid leaderboard`);
    }
    return {
      data: result.data.leaderboard.map((entry, index) =>
        parseLeaderboardEntry(entry, window, index + 1, `${endpoint} entry ${index}`)
      ),
      raw: result.raw,
    };
  }

  async pnlHistory(userId: string, since: Date): Promise<FomoPageResult<FomoPnlSnapshot[]>> {
    const cleanId = userId.trim();
    if (!cleanId) throw new Error("A Fomo user ID is required");
    const endpoint = pnlHistoryEndpoint(cleanId, since);
    const result = await this.#single(endpoint);
    if (!Array.isArray(result.data)) throw new Error(`Fomo ${endpoint} returned invalid PnL history`);
    const snapshots = result.data.map((snapshot, index) => parsePnlSnapshot(snapshot, `${endpoint}[${index}]`));
    snapshots.sort((a, b) => a.timestamp - b.timestamp);
    return { data: snapshots, raw: result.raw };
  }

  async pnlHistories(userIds: string[], since: Date): Promise<Map<string, FomoPnlSnapshot[]>> {
    const endpoints = userIds.map((userId) => pnlHistoryEndpoint(userId, since));
    const responses = this.#transport.requestMany
      ? await this.#transport.requestMany(endpoints, 24)
      : await Promise.all(endpoints.map(async (endpoint) => {
          try { return await this.#transport.request(endpoint); } catch { return null; }
        }));
    const histories = new Map<string, FomoPnlSnapshot[]>();
    responses.forEach((response, index) => {
      const endpoint = endpoints[index];
      if (response === null) return;
      const payload = envelopeObject(response, endpoint);
      if (!Array.isArray(payload)) throw new Error(`Fomo ${endpoint} returned invalid PnL history`);
      const snapshots = payload.map((snapshot, snapshotIndex) =>
        parsePnlSnapshot(snapshot, `${endpoint}[${snapshotIndex}]`)
      );
      snapshots.sort((a, b) => a.timestamp - b.timestamp);
      histories.set(userIds[index], snapshots);
    });
    return histories;
  }

  async tradingAlerts(options: TradingAlertsOptions = {}): Promise<FomoPageResult<FomoAlertsPage>> {
    const limit = options.limit ?? 50;
    validateFeedLimit(limit);
    const params = new URLSearchParams({ limit: String(limit) });
    if (options.lastId?.trim()) params.set("lastId", options.lastId.trim());
    appendNonNegativeNumber(params, "threshold", options.threshold);
    appendNonNegativeNumber(params, "minEquity", options.minEquity);
    appendNonNegativeNumber(params, "minMarketCap", options.minMarketCap);
    appendNonNegativeNumber(params, "maxMarketCap", options.maxMarketCap);
    if (
      options.minMarketCap !== undefined
      && options.maxMarketCap !== undefined
      && options.minMarketCap > options.maxMarketCap
    ) {
      throw new Error("Fomo alert minMarketCap cannot exceed maxMarketCap");
    }
    const endpoint = `/feed/tradingActivity?${params}`;
    const result = await this.#single(endpoint);
    return { data: parseAlertsPage(result.data, endpoint), raw: result.raw };
  }

  async clanLeaderboard(window: FomoClanWindow = "24h"): Promise<FomoPageResult<FomoClanLeaderboardEntry[]>> {
    const endpoint = `/v2/clans/leaderboard?window=${window}`;
    const result = await this.#single(endpoint);
    if (!isRecord(result.data) || !Array.isArray(result.data.leaderboard)) {
      throw new Error(`Fomo ${endpoint} returned an invalid clan leaderboard`);
    }
    return {
      data: result.data.leaderboard.map((entry, index) =>
        parseClanLeaderboardEntry(entry, index + 1, `${endpoint} entry ${index}`)
      ),
      raw: result.raw,
    };
  }

  async clan(clanId: string, window: FomoClanWindow = "24h"): Promise<FomoPageResult<FomoClanDetail>> {
    const cleanId = clanId.trim();
    if (!cleanId) throw new Error("A Fomo clan ID is required");
    const endpoint = `/v2/clans/${encodeURIComponent(cleanId)}?window=${window}`;
    const result = await this.#single(endpoint);
    return { data: parseClanDetail(result.data, endpoint), raw: result.raw };
  }

  async allSwaps(user: FomoUser, maxPages = 100): Promise<FomoPaginatedResult<FomoSwap>> {
    validateMaxPages(maxPages);
    const items: FomoSwap[] = [];
    const seenIds = new Set<string>();
    const pages: RawFomoPage[] = [];
    let cursor: string | undefined;
    let truncated = false;

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
      const params = new URLSearchParams();
      if (cursor) params.set("lastSwapIdV2", cursor);
      const endpoint = `/v2/users/${encodeURIComponent(user.id)}/swaps${params.size ? `?${params}` : ""}`;
      const fetchedAt = new Date().toISOString();
      const response = await this.#transport.request(endpoint);
      const payload = parseSwapsPage(envelopeObject(response, endpoint), endpoint);
      const swaps = payload.swaps.map((swap, index) =>
        parseSwap(swap, user, `${endpoint} swap ${index}`),
      );
      for (const swap of swaps) {
        if (seenIds.has(swap.id)) continue;
        seenIds.add(swap.id);
        items.push(swap);
      }
      pages.push(rawPage(endpoint, pageNumber, cursor ?? null, fetchedAt, response));

      if (!payload.hasNextPage) break;
      if (pageNumber === maxPages) {
        truncated = true;
        break;
      }
      cursor = swaps.at(-1)?.id;
      if (!cursor) throw new Error(`Fomo swaps page ${pageNumber} hasNextPage without a cursor`);
    }

    return { items, pages, truncated };
  }

  async recentSwaps(user: FomoUser, limit = 100): Promise<FomoPageResult<FomoRecentSwaps>> {
    validateFeedLimit(limit);
    const endpoint = `/v2/users/${encodeURIComponent(user.id)}/swaps?limit=${limit}`;
    const fetchedAt = new Date().toISOString();
    const response = await this.#transport.request(endpoint);
    const payload = parseSwapsPage(envelopeObject(response, endpoint), endpoint);
    return {
      data: {
        items: payload.swaps.map((swap, index) =>
          parseSwap(swap, user, `${endpoint} swap ${index}`),
        ),
        hasNextPage: payload.hasNextPage,
      },
      raw: rawPage(endpoint, 1, null, fetchedAt, response),
    };
  }

  async balances(user: FomoUser): Promise<FomoPageResult<unknown>> {
    return this.#single(`/v2/users/${encodeURIComponent(user.id)}/balances`);
  }

  async spotlight(user: FomoUser): Promise<FomoPageResult<unknown>> {
    return this.#single(`/v2/users/${encodeURIComponent(user.id)}/spotlight`);
  }

  async closedTrades(
    user: FomoUser,
    options: ClosedTradesOptions = {},
  ): Promise<FomoPaginatedResult<Record<string, unknown>>> {
    const maxPages = options.maxPages ?? 100;
    validateMaxPages(maxPages);
    const items: Record<string, unknown>[] = [];
    const pages: RawFomoPage[] = [];
    let cursor: string | undefined;
    let truncated = false;

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
      const params = new URLSearchParams({
        userId: user.id,
        orderBy: options.orderBy ?? "closedAt",
      });
      if (options.tokenAddress) params.set("tokenAddress", options.tokenAddress);
      if (cursor) params.set("lastTradeId", cursor);
      const endpoint = `/trades?${params}`;
      const fetchedAt = new Date().toISOString();
      const response = await this.#transport.request(endpoint);
      const payload = parseClosedTradesPage(envelopeObject(response, endpoint), endpoint);
      items.push(...payload.closedTrades);
      pages.push(rawPage(endpoint, pageNumber, cursor ?? null, fetchedAt, response));

      if (payload.hasNextPage === false || payload.closedTrades.length === 0) break;
      if (pageNumber === maxPages) {
        truncated = true;
        break;
      }
      cursor = closedTradeId(payload.closedTrades.at(-1));
      if (!cursor) {
        if (payload.hasNextPage) {
          throw new Error(`Fomo closed trades page ${pageNumber} hasNextPage without a cursor`);
        }
        break;
      }
    }

    return { items, pages, truncated };
  }

  async #single(endpoint: string): Promise<FomoPageResult<unknown>> {
    const fetchedAt = new Date().toISOString();
    const response = await this.#transport.request(endpoint);
    const data = envelopeObject(response, endpoint);
    return { data, raw: rawPage(endpoint, 1, null, fetchedAt, response) };
  }
}

function envelopeObject(value: unknown, endpoint: string): unknown {
  if (!isRecord(value)) throw new Error(`Fomo ${endpoint} returned a non-object envelope`);
  const envelope = value as FomoApiEnvelope<unknown>;
  if (typeof envelope.success !== "boolean" || typeof envelope.statusCode !== "number") {
    throw new Error(`Fomo ${endpoint} returned an invalid envelope`);
  }
  if (!envelope.success || envelope.statusCode < 200 || envelope.statusCode >= 300) {
    const message = typeof envelope.message === "string" ? `: ${envelope.message}` : "";
    throw new Error(`Fomo ${endpoint} failed (${envelope.statusCode})${message}`);
  }
  if (!("responseObject" in envelope)) {
    throw new Error(`Fomo ${endpoint} omitted responseObject`);
  }
  return envelope.responseObject;
}

function parseUser(value: unknown, context: string): FomoUser {
  if (!isRecord(value)) throw new Error(`Fomo ${context} returned an invalid user`);
  const id = requiredString(value.id, `${context}.id`);
  const userHandle = requiredString(value.userHandle, `${context}.userHandle`);
  let clan: FomoUser["clan"] = null;
  if (value.clan != null) {
    if (!isRecord(value.clan)) throw new Error(`Fomo ${context}.clan is invalid`);
    const clanId = optionalString(value.clan.id) ?? optionalString(value.clan.clanId);
    const clanName = optionalString(value.clan.name) ?? optionalString(value.clan.displayName);
    if (clanId || clanName) clan = { id: clanId ?? clanName!, name: clanName ?? clanId! };
  }
  return {
    id,
    userHandle,
    displayName: optionalString(value.displayName),
    clan,
    address: optionalString(value.address),
    evmAddress: optionalString(value.evmAddress),
    profilePictureLink: optionalString(value.profilePictureLink),
    description: optionalString(value.description),
    twitter: optionalString(value.twitter),
    private: typeof value.private === "boolean" ? value.private : undefined,
  };
}

function parseAlertsPage(value: unknown, context: string): FomoAlertsPage {
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.hasNextPage !== "boolean") {
    throw new Error(`Fomo ${context} returned an invalid alert feed`);
  }
  return {
    items: value.items.map((alert, index) => parseAlert(alert, `${context} item ${index}`)),
    hasNextPage: value.hasNextPage,
  };
}

function parseAlert(value: unknown, context: string): FomoAlert {
  if (!isRecord(value)) throw new Error(`Fomo ${context} returned an invalid alert`);
  const createdAt = requiredString(value.createdAt, `${context}.createdAt`);
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error(`Fomo ${context}.createdAt is invalid`);
  const body = value.body == null ? {} : value.body;
  if (!isRecord(body)) throw new Error(`Fomo ${context}.body is invalid`);
  return {
    id: requiredString(value.id, `${context}.id`),
    type: requiredString(value.type, `${context}.type`),
    createdAt,
    userId: optionalString(value.userId),
    tradeId: optionalString(value.tradeId),
    swapId: optionalString(value.swapId),
    transferId: optionalString(value.transferId),
    tokenAddress: optionalString(value.tokenAddress),
    networkId: optionalIdentifierString(value.networkId),
    body,
    likes: optionalNumber(value.likes) ?? 0,
    views: optionalNumber(value.views) ?? 0,
    pinned: value.pinned === true,
  };
}

export function publicEmails(description: string | null | undefined): string[] {
  if (!description) return [];
  const matches = description.match(
    /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi,
  ) ?? [];
  const unique = new Map<string, string>();
  for (const email of matches) unique.set(email.toLowerCase(), email);
  return [...unique.values()];
}

export function publicProfileResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicProfileResponse);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveAccountField(key)) continue;
    output[key] = publicProfileResponse(nested);
  }
  return output;
}

function isSensitiveAccountField(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return normalized === "email"
    || normalized === "emailaddress"
    || normalized === "phone"
    || normalized === "phonenumber"
    || normalized === "password"
    || normalized === "secret"
    || normalized === "authorization"
    || normalized === "accesstoken"
    || normalized === "refreshtoken"
    || normalized === "sessiontoken"
    || normalized === "otp";
}

function parseLeaderboardEntry(
  value: unknown,
  window: FomoLeaderboardWindow,
  rank: number,
  context: string,
): FomoLeaderboardEntry {
  if (!isRecord(value)) throw new Error(`Fomo ${context} is invalid`);
  const pnlField = window === "all" ? "totalPnL" : `pnl${window}`;
  return {
    rank,
    user: parseUser(value, context),
    pnl: optionalNumber(value[pnlField]) ?? 0,
    numTrades: optionalNumber(value.numTrades) ?? 0,
    totalVolume: optionalNumber(value.totalVolume) ?? 0,
    totalHoldings: optionalNumber(value.totalHoldings) ?? 0,
  };
}

function parseClanLeaderboardEntry(value: unknown, rank: number, context: string): FomoClanLeaderboardEntry {
  if (!isRecord(value)) throw new Error(`Fomo ${context} is invalid`);
  return {
    id: requiredString(value.id, `${context}.id`),
    rank: optionalNumber(value.rank) ?? rank,
    name: requiredString(value.name, `${context}.name`),
    description: optionalString(value.description),
    memberCount: optionalNumber(value.memberCount) ?? 0,
    pnl: optionalNumber(value.pnl) ?? 0,
  };
}

function parseClanDetail(value: unknown, context: string): FomoClanDetail {
  if (!isRecord(value)) throw new Error(`Fomo ${context} returned an invalid clan`);
  const clan = parseClanLeaderboardEntry(value, 0, context);
  const members = Array.isArray(value.members) ? value.members.map((member, index) => {
    if (!isRecord(member) || !isRecord(member.user)) {
      throw new Error(`Fomo ${context}.members[${index}] is invalid`);
    }
    const user = parseUser(member.user, `${context}.members[${index}].user`);
    user.clan = { id: clan.id, name: clan.name };
    return {
      user,
      pnl: optionalNumber(member.pnl) ?? 0,
      role: optionalString(member.role),
    };
  }) : [];
  const topTokens = Array.isArray(value.topTokens) ? value.topTokens.map((token, index) => {
    if (!isRecord(token)) throw new Error(`Fomo ${context}.topTokens[${index}] is invalid`);
    return {
      tokenAddress: requiredString(token.tokenAddress, `${context}.topTokens[${index}].tokenAddress`),
      networkId: identifierString(token.networkId, `${context}.topTokens[${index}].networkId`),
      symbol: optionalString(token.symbol) ?? "unknown",
      pnl: optionalNumber(token.pnl) ?? 0,
    };
  }) : [];
  return {
    ...clan,
    tradeCount: optionalNumber(value.tradeCount) ?? 0,
    members,
    topTokens,
  };
}

function parsePnlSnapshot(value: unknown, context: string): FomoPnlSnapshot {
  if (!isRecord(value)) throw new Error(`Fomo ${context} is invalid`);
  const rawTimestamp = optionalNumber(value.snapshotId);
  if (rawTimestamp === null || rawTimestamp <= 0) throw new Error(`Fomo ${context}.snapshotId is invalid`);
  return {
    timestamp: rawTimestamp > 1e11 ? Math.floor(rawTimestamp / 1_000) : Math.floor(rawTimestamp),
    equity: optionalNumber(value.equity) ?? 0,
    pnl: optionalNumber(value.pnl) ?? 0,
  };
}

function pnlHistoryEndpoint(userId: string, since: Date): string {
  const cleanId = userId.trim();
  if (!cleanId) throw new Error("A Fomo user ID is required");
  const ageMs = Date.now() - since.getTime();
  if (!Number.isFinite(ageMs) || ageMs <= 0) throw new Error("Fomo PnL history start must be in the past");
  const params = new URLSearchParams({ userId: cleanId, timestamp: since.toISOString() });
  if (ageMs > 7 * 86_400_000) params.set("interval", "4");
  return `/v2/userTokens/aggregatedSnapshot?${params}`;
}

function parseSwap(
  value: unknown,
  user: FomoUser,
  context: string,
): FomoSwap {
  if (!isRecord(value)) throw new Error(`Fomo ${context} is not an object`);
  const createdAt = requiredString(value.createdAt, `${context}.createdAt`);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error(`Fomo ${context}.createdAt is not a valid timestamp`);
  }
  return {
    id: requiredString(value.id, `${context}.id`),
    userId: optionalString(value.userId) ?? user.id,
    userHandle: optionalString(value.userHandle) ?? user.userHandle,
    createdAt,
    inNetworkId: identifierString(value.inNetworkId, `${context}.inNetworkId`),
    outNetworkId: identifierString(value.outNetworkId, `${context}.outNetworkId`),
    inTokenAddress: requiredString(value.inTokenAddress, `${context}.inTokenAddress`),
    outTokenAddress: requiredString(value.outTokenAddress, `${context}.outTokenAddress`),
    inTradeId: optionalString(value.inTradeId),
    outTradeId: optionalString(value.outTradeId),
    inHumanAmount: decimalString(value.inHumanAmount, `${context}.inHumanAmount`),
    outHumanAmount: decimalString(value.outHumanAmount, `${context}.outHumanAmount`),
    humanUsdAmountIn: optionalDecimalString(value.humanUsdAmountIn, `${context}.humanUsdAmountIn`),
    humanUsdAmountOut: optionalDecimalString(
      value.humanUsdAmountOut,
      `${context}.humanUsdAmountOut`,
    ),
  };
}

function parseSwapsPage(value: unknown, context: string): FomoSwapsPage {
  if (!isRecord(value) || !Array.isArray(value.swaps) || typeof value.hasNextPage !== "boolean") {
    throw new Error(`Fomo ${context} returned an invalid swaps page`);
  }
  return { swaps: value.swaps, hasNextPage: value.hasNextPage };
}

function parseClosedTradesPage(value: unknown, context: string): FomoClosedTradesPage {
  if (!isRecord(value) || !Array.isArray(value.closedTrades)) {
    throw new Error(`Fomo ${context} returned an invalid closed trades page`);
  }
  if (value.hasNextPage != null && typeof value.hasNextPage !== "boolean") {
    throw new Error(`Fomo ${context}.hasNextPage is invalid`);
  }
  if (value.closedCount != null && typeof value.closedCount !== "number") {
    throw new Error(`Fomo ${context}.closedCount is invalid`);
  }
  for (const trade of value.closedTrades) {
    if (!isRecord(trade)) throw new Error(`Fomo ${context} contains an invalid closed trade`);
  }
  return {
    closedTrades: value.closedTrades as Record<string, unknown>[],
    hasNextPage: typeof value.hasNextPage === "boolean" ? value.hasNextPage : undefined,
    closedCount: typeof value.closedCount === "number" ? value.closedCount : undefined,
  };
}

function closedTradeId(value: Record<string, unknown> | undefined): string | undefined {
  if (!value || !isRecord(value.trade)) return undefined;
  return optionalString(value.trade.id) ?? undefined;
}

function rawPage(
  endpoint: string,
  pageNumber: number,
  cursor: string | null,
  fetchedAt: string,
  response: unknown,
): RawFomoPage {
  return { endpoint, pageNumber, cursor, fetchedAt, response };
}

function normalizeHandle(handle: string): string {
  const clean = handle.trim().replace(/^@/, "");
  if (!clean) throw new Error("A Fomo profile handle is required");
  return clean;
}

function validateMaxPages(maxPages: number): void {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error("maxPages must be a positive integer");
  }
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Fomo leaderboard limit must be an integer from 1 to 100");
  }
}

function validateFeedLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Fomo alert limit must be an integer from 1 to 100");
  }
}

function appendNonNegativeNumber(params: URLSearchParams, key: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) throw new Error(`Fomo alert ${key} must be a non-negative number`);
  params.set(key, String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Fomo ${context} must be a string`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function identifierString(value: unknown, context: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error(`Fomo ${context} must be a string or number`);
}

function optionalIdentifierString(value: unknown): string | null {
  if (value == null || value === "") return null;
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function decimalString(value: unknown, context: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error(`Fomo ${context} must be a decimal value`);
}

function optionalDecimalString(value: unknown, context: string): string | null {
  if (value == null || value === "") return null;
  return decimalString(value, context);
}
