export type TokenMarket = {
  tokenKey: string;
  networkId: string;
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  pairCreatedAt: number | null;
  pairUrl: string | null;
};

export type MarketToken = { networkId: string; tokenAddress: string };
export type MarketFetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function fetchTokenMarkets(
  tokens: readonly MarketToken[],
  fetcher: MarketFetcher = fetch,
): Promise<Map<string, TokenMarket>> {
  const byChain = new Map<string, MarketToken[]>();
  for (const token of deduplicate(tokens)) {
    const chain = dexChain(token.networkId);
    if (!chain) continue;
    const group = byChain.get(chain);
    if (group) group.push(token);
    else byChain.set(chain, [token]);
  }
  const markets = new Map<string, TokenMarket>();
  for (const [chain, chainTokens] of byChain) {
    for (let offset = 0; offset < chainTokens.length; offset += 30) {
      const chunk = chainTokens.slice(offset, offset + 30);
      const url = `https://api.dexscreener.com/tokens/v1/${chain}/${chunk.map((token) => token.tokenAddress).join(",")}`;
      const response = await fetcher(url);
      if (!response.ok) throw new Error(`DexScreener market request failed (HTTP ${response.status})`);
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error("DexScreener returned an invalid market response");
      for (const value of payload) {
        const pair = parsePair(value, chainTokens);
        if (!pair) continue;
        const existing = markets.get(pair.tokenKey);
        if (!existing || (pair.liquidityUsd ?? 0) > (existing.liquidityUsd ?? 0)) markets.set(pair.tokenKey, pair);
      }
    }
  }
  return markets;
}

export function canonicalNetworkId(networkId: string): string | null {
  const value = networkId.trim().toLowerCase();
  if (["1399811149", "solana", "sol", "mainnet-beta"].includes(value)) return "1399811149";
  if (["1", "ethereum", "eth", "mainnet"].includes(value)) return "1";
  if (["8453", "base", "base-mainnet"].includes(value)) return "8453";
  if (["56", "bsc", "bnb", "bnb-chain", "binance-smart-chain"].includes(value)) return "56";
  return null;
}

export function canonicalTokenKey(networkId: string, tokenAddress: string): string | null {
  const canonicalNetwork = canonicalNetworkId(networkId);
  if (!canonicalNetwork || !tokenAddress.trim()) return null;
  const address = canonicalNetwork === "1399811149" ? tokenAddress.trim() : tokenAddress.trim().toLowerCase();
  return `${canonicalNetwork}:${address}`;
}

function parsePair(value: unknown, requested: readonly MarketToken[]): TokenMarket | null {
  if (!record(value) || !record(value.baseToken)) return null;
  const baseAddress = text(value.baseToken.address);
  if (!baseAddress) return null;
  const requestedToken = requested.find((token) =>
    canonicalTokenKey(token.networkId, token.tokenAddress) === canonicalTokenKey(token.networkId, baseAddress)
  );
  if (!requestedToken) return null;
  const tokenKey = canonicalTokenKey(requestedToken.networkId, requestedToken.tokenAddress);
  if (!tokenKey) return null;
  return {
    tokenKey,
    networkId: canonicalNetworkId(requestedToken.networkId)!,
    tokenAddress: requestedToken.tokenAddress,
    symbol: text(value.baseToken.symbol),
    name: text(value.baseToken.name),
    priceUsd: finite(value.priceUsd),
    liquidityUsd: record(value.liquidity) ? finite(value.liquidity.usd) : null,
    marketCapUsd: finite(value.marketCap),
    fdvUsd: finite(value.fdv),
    pairCreatedAt: finite(value.pairCreatedAt),
    pairUrl: text(value.url),
  };
}

function deduplicate(tokens: readonly MarketToken[]): MarketToken[] {
  const result = new Map<string, MarketToken>();
  for (const token of tokens) {
    const key = canonicalTokenKey(token.networkId, token.tokenAddress);
    if (key) result.set(key, token);
  }
  return [...result.values()];
}

function dexChain(networkId: string): string | null {
  switch (canonicalNetworkId(networkId)) {
    case "1399811149": return "solana";
    case "1": return "ethereum";
    case "8453": return "base";
    case "56": return "bsc";
    default: return null;
  }
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
