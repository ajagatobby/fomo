import { createHmac } from "node:crypto";
import type { FomoSwap, FomoUser } from "./types.ts";

type FomoWebhookProfile = Pick<
  FomoUser,
  "id" | "userHandle" | "displayName" | "address" | "evmAddress"
>;

export type FomoSwapWebhookPayload = {
  version: 1;
  event: "fomo.swap";
  occurredAt: string;
  deliveredAt: string;
  profile: FomoWebhookProfile;
  swap: FomoSwap;
};

export type FomoTradingActivityWebhookPayload = {
  version: 1;
  event: "fomo.trading_activity";
  occurredAt: string;
  deliveredAt: string;
  profile: FomoWebhookProfile;
  activity: Record<string, unknown>;
};

export type FomoWatchWebhookPayload = FomoSwapWebhookPayload | FomoTradingActivityWebhookPayload;

export type PostWebhookOptions = {
  secret?: string;
  fetcher?: typeof fetch;
  attempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  now?: () => number;
};

export async function postWebhook(
  webhookUrl: string,
  payload: FomoWatchWebhookPayload,
  options: PostWebhookOptions = {},
): Promise<void> {
  const url = validateWebhookUrl(webhookUrl);
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor((options.now?.() ?? Date.now()) / 1_000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "fomo-watch/1",
    "x-fomo-delivery": webhookDeliveryId(payload),
    "x-fomo-event": payload.event,
    "x-fomo-timestamp": timestamp,
  };
  if (options.secret) {
    headers["x-fomo-signature"] = webhookSignature(body, options.secret, timestamp);
  }
  const fetcher = options.fetcher ?? fetch;
  const attempts = options.attempts ?? 3;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (response.ok) return;
      lastError = new Error(`Webhook returned HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt + 1 < attempts) {
      await sleep((options.retryDelayMs ?? 500) * 2 ** attempt);
    }
  }
  throw lastError ?? new Error("Webhook delivery failed");
}

function webhookDeliveryId(payload: FomoWatchWebhookPayload): string {
  if (payload.event === "fomo.swap") return payload.swap.id;
  const id = payload.activity.id;
  if (typeof id !== "string" || !id) throw new Error("Realtime activity omitted its delivery ID");
  return id;
}

export function webhookSignature(body: string, secret: string, timestamp: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function webhookDisplayUrl(webhookUrl: string): string {
  const url = validateWebhookUrl(webhookUrl);
  return `${url.origin}${url.pathname}`;
}

function validateWebhookUrl(webhookUrl: string): URL {
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new Error("--webhook must be a valid URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("--webhook must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (url.username || url.password) throw new Error("--webhook must not contain URL credentials");
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
