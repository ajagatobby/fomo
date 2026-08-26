/** The stable profile fields used by the authenticated Fomo data layer. */
export type FomoUser = {
  id: string;
  userHandle: string;
  displayName: string | null;
  clan: { id: string; name: string } | null;
  address?: string | null;
  evmAddress?: string | null;
  profilePictureLink?: string | null;
  description?: string | null;
  twitter?: string | null;
  private?: boolean;
};

export type FomoLoginMethod = "apple" | "google" | "email";

/** The minimal login identity selected from Privy's current-user response. */
export type FomoLoginIdentity = {
  privyUserId: string;
  email: string;
  method: FomoLoginMethod;
};

export type FomoAccount = {
  user: FomoUser;
  login: FomoLoginIdentity;
  fetchedAt: string;
};

export type FomoLeaderboardWindow = "24h" | "7d" | "30d" | "all";

export type FomoLeaderboardEntry = {
  rank: number;
  user: FomoUser;
  pnl: number;
  numTrades: number;
  totalVolume: number;
  totalHoldings: number;
};

export type FomoPnlSnapshot = {
  timestamp: number;
  equity: number;
  pnl: number;
};

export type FomoAlert = {
  id: string;
  type: string;
  createdAt: string;
  userId: string | null;
  tradeId: string | null;
  swapId: string | null;
  transferId: string | null;
  tokenAddress: string | null;
  networkId: string | null;
  body: Record<string, unknown>;
  likes: number;
  views: number;
  pinned: boolean;
};

export type FomoAlertsPage = {
  items: FomoAlert[];
  hasNextPage: boolean;
};

export type FomoClanWindow = Exclude<FomoLeaderboardWindow, "all">;

export type FomoClanLeaderboardEntry = {
  id: string;
  rank: number;
  name: string;
  description: string | null;
  memberCount: number;
  pnl: number;
};

export type FomoClanMember = {
  user: FomoUser;
  pnl: number;
  role: string | null;
};

export type FomoClanToken = {
  tokenAddress: string;
  networkId: string;
  symbol: string;
  pnl: number;
};

export type FomoClanDetail = FomoClanLeaderboardEntry & {
  tradeCount: number;
  members: FomoClanMember[];
  topTokens: FomoClanToken[];
};

/** A normalized Fomo swap. Decimal quantities remain strings to avoid precision loss. */
export type FomoSwap = {
  id: string;
  userId: string;
  userHandle: string;
  createdAt: string;
  inNetworkId: string;
  outNetworkId: string;
  inTokenAddress: string;
  outTokenAddress: string;
  inTradeId: string | null;
  outTradeId: string | null;
  inHumanAmount: string;
  outHumanAmount: string;
  humanUsdAmountIn: string | null;
  humanUsdAmountOut: string | null;
};

export type ResearchUser = {
  id: string;
  userHandle: string;
  /** Convenience alias for research/analytics consumers. */
  handle: string;
  displayName: string | null;
  clanId: string | null;
  clanName: string | null;
  address: string | null;
  evmAddress: string | null;
};

export type ResearchDataset = {
  users: ResearchUser[];
  swaps: FomoSwap[];
};

export type FomoApiEnvelope<T> = {
  success: boolean;
  statusCode: number;
  message?: string;
  errorCode?: string;
  responseObject?: T;
};

export type FomoSwapsPage = {
  swaps: Record<string, unknown>[];
  hasNextPage: boolean;
};

export type FomoRecentSwaps = {
  items: FomoSwap[];
  hasNextPage: boolean;
};

export type FomoClosedTradesPage = {
  closedTrades: Record<string, unknown>[];
  hasNextPage?: boolean;
  closedCount?: number;
};

/** Endpoint response metadata available only for the current invocation. */
export type RawFomoPage = {
  endpoint: string;
  pageNumber: number;
  cursor: string | null;
  fetchedAt: string;
  response: unknown;
};

export type FomoPageResult<T> = {
  data: T;
  raw: RawFomoPage;
};

export type FomoPaginatedResult<T> = {
  items: T[];
  pages: RawFomoPage[];
  truncated: boolean;
};
