import { spawn } from "node:child_process";
import { Impit } from "impit";
import type { FomoLoginIdentity, FomoLoginMethod } from "./types.ts";

const API_ORIGIN = "https://prod-api.fomo.family";
const AUTH_ORIGIN = "https://auth.privy.io";
const APP_ORIGIN = "https://fomo.family";
const PRIVY_APP_ID = "cm6h485o300n3zj9yl6vpedq7";
const PRIVY_CLIENT_ID = "client-WY5gFSayQjxnQhG4rP6SnwPAyPZWZpNRhJ6b9rzMnYwqH";
const PRIVY_CLIENT = "react-auth:3.34.0";
const KEYCHAIN_SERVICE = "com.fomo.cli";
const KEYCHAIN_ACCOUNT = "session";
const REFRESH_AHEAD_MS = 60_000;

export type FomoCredentials = {
  version: 1;
  appToken: string;
  privyAccessToken: string;
  refreshToken: string;
  caId: string;
  supportedChains: string;
};

export type FomoDirectSessionOptions = {
  requestTimeoutMs?: number;
  fetcher?: typeof fetch;
  apiRequester?: FomoApiRequester;
  saveCredentials?: (credentials: FomoCredentials) => Promise<void>;
  now?: () => number;
  webSocketFactory?: FomoWebSocketFactory;
};

export type FomoWebSocket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
};

export type FomoWebSocketFactory = (url: string) => FomoWebSocket;
export type FomoRealtimeState = "connecting" | "connected" | "reconnecting";

export type FomoApiResponse = {
  httpStatus: number;
  body: unknown;
  retryAfter: string | null;
};

export type FomoApiRequester = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<FomoApiResponse>;

/** Read-only Fomo API transport backed by refreshable credentials in macOS Keychain. */
export class FomoDirectSession {
  #credentials: FomoCredentials;
  readonly #requestTimeoutMs: number;
  readonly #fetcher: typeof fetch;
  readonly #apiRequester: FomoApiRequester | null;
  readonly #saveCredentials: (credentials: FomoCredentials) => Promise<void>;
  readonly #now: () => number;
  readonly #webSocketFactory: FomoWebSocketFactory;
  #client: Impit | null = null;
  #refreshPromise: Promise<void> | null = null;
  #closed = false;

  constructor(credentials: FomoCredentials, options: FomoDirectSessionOptions = {}) {
    this.#credentials = validateCredentials(credentials);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#fetcher = options.fetcher ?? fetch;
    this.#apiRequester = options.apiRequester ?? null;
    this.#saveCredentials = options.saveCredentials ?? saveFomoCredentials;
    this.#now = options.now ?? Date.now;
    this.#webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  async request<T = unknown>(apiPath: string): Promise<T> {
    if (this.#closed) throw new Error("Fomo session is closed");
    const url = apiUrl(apiPath);
    await this.#refresh(false);
    let refreshedAfterRejection = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.#requestApi(url);
      const body = response.body;
      const status = numericStatus(isRecord(body) ? body.statusCode : undefined, response.httpStatus);

      if (status === 401 || status === 403) {
        if (refreshedAfterRejection) {
          throw new Error(
            `Fomo authentication was rejected (HTTP ${status}); run fomo login again`,
          );
        }
        await this.#refresh(true);
        refreshedAfterRejection = true;
        continue;
      }

      if (status === 429 || status >= 500) {
        if (attempt === 2) {
          throw new Error(`Fomo API request failed after 3 attempts (HTTP ${status})`);
        }
        await sleep(retryDelay(response.retryAfter, attempt));
        continue;
      }

      if (!isRecord(body)) {
        throw new Error(`Fomo ${url.pathname} returned invalid JSON (HTTP ${response.httpStatus})`);
      }

      return body as T;
    }

    throw new Error("Fomo API request exhausted retries");
  }

  async requestMany<T = unknown>(apiPaths: string[], concurrency = 24): Promise<Array<T | null>> {
    if (this.#closed) throw new Error("Fomo session is closed");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Fomo batch concurrency must be positive");
    const urls = apiPaths.map((path) => apiUrl(path));
    if (urls.length === 0) return [];
    if (this.#apiRequester) return Promise.all(apiPaths.map((path) => this.request<T>(path)));
    await this.#refresh(false);

    for (let round = 0; round < 2; round++) {
      const responses = await this.#requestApiBatch(urls, concurrency);
      if (responses.some((response) => response.httpStatus === 401 || response.httpStatus === 403)) {
        if (round === 1) throw new Error("Fomo batch authentication was rejected; run fomo login again");
        await this.#refresh(true);
        continue;
      }
      const output: Array<T | null> = new Array(responses.length).fill(null);
      for (let index = 0; index < responses.length; index++) {
        const response = responses[index];
        if (isRecord(response.body)) {
          const status = numericStatus(response.body.statusCode, response.httpStatus);
          if (status >= 200 && status < 300) {
            output[index] = response.body as T;
            continue;
          }
        }
        try { output[index] = await this.request<T>(apiPaths[index]); } catch { output[index] = null; }
      }
      return output;
    }
    throw new Error("Fomo batch request exhausted retries");
  }

  /** Resolve the login email Fomo displays from Privy's authenticated user. */
  async loginIdentity(): Promise<FomoLoginIdentity> {
    if (this.#closed) throw new Error("Fomo session is closed");
    await this.#refresh(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.#fetcher(`${AUTH_ORIGIN}/api/v1/users/me`, {
        method: "GET",
        headers: this.#privyHeaders(),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        await this.#refresh(true);
        continue;
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(`Fomo login identity request failed (HTTP ${response.status})`);
      }
      return parseLoginIdentity(body);
    }
    throw new Error("Fomo login identity request exhausted retries");
  }

  async streamTradingActivity(
    userId: string,
    onActivity: (activity: Record<string, unknown>) => void | Promise<void>,
    signal: AbortSignal,
    onState: (state: FomoRealtimeState) => void = () => undefined,
  ): Promise<void> {
    const cleanUserId = userId.trim();
    if (!cleanUserId) throw new Error("A Fomo user ID is required for realtime activity");
    let reconnectAttempt = 0;
    while (!signal.aborted && !this.#closed) {
      onState(reconnectAttempt === 0 ? "connecting" : "reconnecting");
      await this.#refresh(false);
      try {
        await this.#streamTradingActivityOnce(cleanUserId, onActivity, signal, onState);
        reconnectAttempt = 0;
      } catch (error) {
        if (signal.aborted || this.#closed) return;
        if (error instanceof FomoSubscriptionRejectedError) throw error;
        reconnectAttempt++;
      }
      if (!signal.aborted && !this.#closed) {
        await abortableSleep(Math.min(1_000 * 2 ** reconnectAttempt, 30_000), signal);
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#client = null;
  }

  #streamTradingActivityOnce(
    userId: string,
    onActivity: (activity: Record<string, unknown>) => void | Promise<void>,
    signal: AbortSignal,
    onState: (state: FomoRealtimeState) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.#webSocketFactory(`${API_ORIGIN.replace(/^http/, "ws")}/ws`);
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        socket.removeEventListener("open", open);
        socket.removeEventListener("message", message);
        socket.removeEventListener("close", close);
        socket.removeEventListener("error", errorEvent);
        if (error) reject(error);
        else resolve();
      };
      const sendChallenge = async () => {
        try {
          await this.#refresh(false);
          socket.send(JSON.stringify({ type: "challengeResponse", jwt: this.#credentials.appToken }));
        } catch (error) {
          socket.close();
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const abort = () => {
        socket.close();
        finish();
      };
      const open = () => { void sendChallenge(); };
      const message = (event: { data?: unknown }) => {
        void (async () => {
          let payload: unknown;
          try { payload = JSON.parse(String(event.data)); } catch { return; }
          if (!isRecord(payload)) return;
          switch (payload.type) {
            case "challenge":
              await sendChallenge();
              break;
            case "challengeAccepted":
              socket.send(JSON.stringify({
                type: "subscribe",
                topicType: "trading_activity",
                topicId: userId,
              }));
              break;
            case "subscribed":
              if (payload.topicType === "trading_activity" && payload.topicId === userId) onState("connected");
              break;
            case "data":
              if (
                payload.topicType === "trading_activity"
                && payload.topicId === userId
                && isRecord(payload.payload)
              ) await onActivity(payload.payload);
              break;
            case "error":
              if (payload.code === "SUBSCRIBE_REJECTED") {
                finish(new FomoSubscriptionRejectedError("Fomo rejected the realtime activity subscription"));
                socket.close();
              }
              break;
          }
        })().catch((error) => {
          finish(error instanceof Error ? error : new Error(String(error)));
          socket.close();
        });
      };
      const close = () => finish();
      const errorEvent = () => { socket.close(); };
      signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", open);
      socket.addEventListener("message", message);
      socket.addEventListener("close", close);
      socket.addEventListener("error", errorEvent);
      if (signal.aborted) abort();
    });
  }

  async #requestApi(url: URL): Promise<FomoApiResponse> {
    const headers = this.#apiHeaders();
    if (this.#apiRequester) {
      return this.#apiRequester(url.toString(), headers, this.#requestTimeoutMs);
    }

    const response = await this.#ensureClient().fetch(url, {
      method: "GET",
      headers,
      timeout: this.#requestTimeoutMs,
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* The caller reports invalid JSON. */ }
    return {
      httpStatus: response.status,
      body,
      retryAfter: response.headers.get("retry-after"),
    };
  }

  async #requestApiBatch(urls: URL[], concurrency: number): Promise<FomoApiResponse[]> {
    const results = new Array<FomoApiResponse>(urls.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
      while (next < urls.length) {
        const index = next++;
        try {
          results[index] = await this.#requestApi(urls[index]);
        } catch {
          results[index] = { httpStatus: 0, body: null, retryAfter: null };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  #apiHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.#credentials.appToken}`,
      "content-type": "application/json",
      origin: APP_ORIGIN,
      referer: `${APP_ORIGIN}/`,
      "x-supported-chains": this.#credentials.supportedChains,
    };
  }

  #privyHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.#credentials.privyAccessToken}`,
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "privy-app-id": PRIVY_APP_ID,
      "privy-ca-id": this.#credentials.caId,
      "privy-client": PRIVY_CLIENT,
      "privy-client-id": PRIVY_CLIENT_ID,
    };
  }

  #ensureClient(): Impit {
    this.#client ??= new Impit({
      browser: "chrome",
      timeout: this.#requestTimeoutMs,
      http3: false,
    });
    return this.#client;
  }

  async #refresh(force: boolean): Promise<void> {
    const expiration = jwtExpirationMs(this.#credentials.appToken);
    if (!force && expiration > this.#now() + REFRESH_AHEAD_MS) return;

    if (this.#refreshPromise) {
      await this.#refreshPromise;
      return;
    }
    const refresh = this.#performRefresh(force);
    this.#refreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.#refreshPromise === refresh) this.#refreshPromise = null;
    }
  }

  async #performRefresh(force: boolean): Promise<void> {
    const previousAppToken = this.#credentials.appToken;
    const response = await this.#fetcher(`${AUTH_ORIGIN}/api/v1/sessions`, {
      method: "POST",
      headers: this.#privyHeaders(),
      body: JSON.stringify({ refresh_token: this.#credentials.refreshToken }),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body)) {
      throw new Error("Fomo session refresh failed; run fomo login again");
    }

    const appToken = typeof body.token === "string" && body.token ? body.token : previousAppToken;
    const privyAccessToken = optionalString(body.privy_access_token) ?? this.#credentials.privyAccessToken;
    const refreshToken = optionalString(body.refresh_token) ?? this.#credentials.refreshToken;
    if (force && appToken === previousAppToken) {
      throw new Error("Fomo session could not be renewed; run fomo login again");
    }

    this.#credentials = validateCredentials({
      ...this.#credentials,
      appToken,
      privyAccessToken,
      refreshToken,
    });
    await this.#saveCredentials(this.#credentials);
  }
}

export async function openDirectFomoSession(
  options: FomoDirectSessionOptions = {},
): Promise<FomoDirectSession> {
  const credentials = await loadFomoCredentials();
  if (!credentials) {
    throw new Error("No cached Fomo session; run fomo login first");
  }
  return new FomoDirectSession(credentials, options);
}

export async function loadFomoCredentials(): Promise<FomoCredentials | null> {
  requireMacOS();
  try {
    const output = await runSecurity([
      "find-generic-password",
      "-a", KEYCHAIN_ACCOUNT,
      "-s", KEYCHAIN_SERVICE,
      "-w",
    ]);
    return validateCredentials(JSON.parse(output));
  } catch (error) {
    if (error instanceof SecurityCommandError && error.exitCode === 44) return null;
    if (error instanceof SyntaxError) throw new Error("Cached Fomo session is invalid; run fomo login again");
    throw error;
  }
}

export async function saveFomoCredentials(credentials: FomoCredentials): Promise<void> {
  requireMacOS();
  const value = JSON.stringify(validateCredentials(credentials));
  await runSecurityInteractive(
    `add-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE} -U -w ${securityQuote(value)}`,
  );
  const saved = await runSecurity([
    "find-generic-password",
    "-a", KEYCHAIN_ACCOUNT,
    "-s", KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (saved !== value) throw new Error("macOS Keychain did not preserve the Fomo session");
}

export function jwtExpirationMs(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return 0;
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!isRecord(payload) || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return 0;
    return payload.exp * 1_000;
  } catch {
    return 0;
  }
}

function validateCredentials(value: unknown): FomoCredentials {
  if (!isRecord(value) || value.version !== 1) throw new Error("Invalid cached Fomo session");
  return {
    version: 1,
    appToken: requiredString(value.appToken, "Fomo app token"),
    privyAccessToken: requiredString(value.privyAccessToken, "Privy access token"),
    refreshToken: requiredString(value.refreshToken, "Privy refresh token"),
    caId: requiredString(value.caId, "Privy client authentication ID"),
    supportedChains: requiredString(value.supportedChains, "Fomo supported chains"),
  };
}

function parseLoginIdentity(value: unknown): FomoLoginIdentity {
  if (!isRecord(value) || !isRecord(value.user)) {
    throw new Error("Privy current-user response is invalid");
  }
  const privyUserId = requiredString(value.user.id, "Privy user ID");
  if (!Array.isArray(value.user.linked_accounts)) {
    throw new Error("Privy current-user response omitted linked accounts");
  }
  const loginTypes: Array<[string, FomoLoginMethod]> = [
    ["google_oauth", "google"],
    ["apple_oauth", "apple"],
    ["email", "email"],
  ];
  for (const [type, method] of loginTypes) {
    const account = value.user.linked_accounts.find(
      (candidate) => isRecord(candidate) && candidate.type === type,
    );
    if (!isRecord(account)) continue;
    const email = optionalString(account.email)
      ?? (type === "email" ? optionalString(account.address) : null);
    if (email) return { privyUserId, email, method };
  }
  throw new Error("Fomo account has no email login identity");
}

function apiUrl(apiPath: string): URL {
  if (!apiPath.startsWith("/")) throw new Error("Fomo API path must start with /");
  const url = new URL(apiPath, API_ORIGIN);
  if (url.origin !== API_ORIGIN) throw new Error("Fomo API path must remain on prod-api.fomo.family");
  return url;
}

function numericStatus(value: unknown, fallback: number): number {
  const status = Number(value);
  return Number.isFinite(status) && status > 0 ? status : fallback;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function retryDelay(value: string | null, attempt: number): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 500 * 2 ** attempt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function requireMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error("Secure Fomo session storage currently requires macOS Keychain");
  }
}

class SecurityCommandError extends Error {
  readonly exitCode: number | null;

  constructor(message: string, exitCode: number | null) {
    super(message);
    this.exitCode = exitCode;
  }
}

class FomoSubscriptionRejectedError extends Error {}

function runSecurity(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new SecurityCommandError(stderr.trim() || "macOS Keychain command failed", code));
    });
  });
}

function runSecurityInteractive(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new SecurityCommandError(stderr.trim() || "macOS Keychain command failed", code));
    });
    child.stdin.end(`${command}\n`);
  });
}

function securityQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
