/**
 * Fomo network identifiers shared by the research and reporting layers.
 *
 * Chain ids, slugs, and stable-asset addresses mirror the values the Fomo web
 * app compiles into its own chain module, so links and cash detection stay in
 * step with what the product shows.
 */

const APP_ORIGIN = "https://fomo.family";

export const SOLANA_NETWORK_ID = "1399811149";

/** Canonical numeric network id to the slug used in Fomo web app routes. */
const NETWORK_SLUGS: Readonly<Record<string, string>> = {
  [SOLANA_NETWORK_ID]: "solana",
  "1": "ethereum",
  "56": "bnb",
  "143": "monad",
  "1337": "hyperliquid",
  "4663": "robinhood",
  "8453": "base",
};

const NETWORK_NAMES: Readonly<Record<string, string>> = {
  [SOLANA_NETWORK_ID]: "Solana",
  "1": "Ethereum",
  "56": "BNB Chain",
  "143": "Monad",
  "1337": "Hyperliquid",
  "4663": "Robinhood",
  "8453": "Base",
};

export function networkSlug(networkId: string | number | null | undefined): string | null {
  return NETWORK_SLUGS[String(networkId ?? "").trim()] ?? null;
}

export function networkName(networkId: string | number | null | undefined): string {
  const key = String(networkId ?? "").trim();
  return NETWORK_NAMES[key] ?? key;
}

export function isSolanaNetwork(networkId: string | number | null | undefined): boolean {
  return networkSlug(networkId) === "solana";
}

/**
 * Builds the Fomo token page URL. Returns null for networks Fomo does not
 * route, so callers never print a link that resolves to nothing.
 */
export function tokenUrl(
  networkId: string | number | null | undefined,
  tokenAddress: string | null | undefined,
): string | null {
  const slug = networkSlug(networkId);
  const address = String(tokenAddress ?? "").trim();
  if (!slug || !address) return null;
  return `${APP_ORIGIN}/tokens/${slug}/${encodeURIComponent(address)}`;
}

export function profileUrl(handle: string): string {
  return `${APP_ORIGIN}/profile/${encodeURIComponent(handle.replace(/^@/, ""))}`;
}

/**
 * Normalizes a token address for identity comparison. Solana base58 addresses
 * are case-sensitive; EVM hex addresses are not.
 */
export function normalizeTokenAddress(
  networkId: string | number | null | undefined,
  address: string,
): string {
  return isSolanaNetwork(networkId) ? address.trim() : address.trim().toLowerCase();
}

/** Stable key identifying one token on one network. */
export function tokenKey(
  networkId: string | number | null | undefined,
  address: string,
): string {
  return `${String(networkId ?? "").trim()}:${normalizeTokenAddress(networkId, address)}`;
}
