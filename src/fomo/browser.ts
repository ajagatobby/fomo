import { chromium } from "playwright-core";
import type { BrowserContext, Page, Response } from "playwright-core";
import {
  openDirectFomoSession,
  saveFomoCredentials,
  type FomoDirectSession,
  type FomoDirectSessionOptions,
} from "./auth.ts";

const APP_ORIGIN = "https://fomo.family";
const API_ORIGIN = "https://prod-api.fomo.family";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;

type AuthHeaders = {
  authorization: string;
  "content-type": "application/json";
  "x-supported-chains": string;
};

/**
 * Opens an ephemeral Chrome context for interactive login and copies the
 * resulting credentials to macOS Keychain.
 */
export async function loginFomo(): Promise<void> {
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const context = await browser.newContext();
  try {
    const authenticated = waitForHeaders(context, LOGIN_TIMEOUT_MS, true);
    const page = context.pages()[0] ?? (await context.newPage());
    const [, headers] = await Promise.all([
      page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" }),
      authenticated,
    ]);
    const storage = await readPrivyStorage(page);
    await saveFomoCredentials({
      version: 1,
      appToken: headers.authorization.replace(/^Bearer\s+/i, ""),
      privyAccessToken: storage.privyAccessToken,
      refreshToken: storage.refreshToken,
      caId: storage.caId,
      supportedChains: headers["x-supported-chains"],
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function openFomoSession(
  handle = "",
  options?: FomoDirectSessionOptions,
): Promise<FomoDirectSession> {
  return openDirectFomoSession(options);
}

function waitForHeaders(
  context: BrowserContext,
  timeoutMs: number,
  requireSupportedChains: boolean,
): Promise<AuthHeaders> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (headers?: AuthHeaders, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.off("response", inspect);
      if (headers) resolve(headers);
      else reject(error ?? new Error("Unable to capture Fomo authentication headers"));
    };
    const inspect = (response: Response): void => {
      void (async () => {
        if (response.status() < 200 || response.status() >= 300) return;
        const request = response.request();
        if (new URL(request.url()).origin !== API_ORIGIN) return;
        const headers = await request.allHeaders();
        const authorization = headers.authorization;
        const supportedChains = headers["x-supported-chains"];
        if (!authorization || (requireSupportedChains && !supportedChains)) return;
        finish({
          authorization,
          "content-type": "application/json",
          "x-supported-chains": supportedChains ?? "",
        });
      })().catch(() => undefined);
    };
    const timer = setTimeout(() => {
      finish(
        undefined,
        new Error("Timed out waiting for an authenticated Fomo request; run loginFomo() first"),
      );
    }, timeoutMs);
    context.on("response", inspect);
  });
}

async function readPrivyStorage(page: Page): Promise<{
  privyAccessToken: string;
  refreshToken: string;
  caId: string;
}> {
  const values = await page.evaluate(() => {
    const read = (key: string): unknown => {
      const value = localStorage.getItem(key);
      if (!value) return null;
      try { return JSON.parse(value); } catch { return value; }
    };
    return {
      privyAccessToken: read("privy:pat"),
      refreshToken: read("privy:refresh_token"),
      caId: read("privy:caid"),
    };
  });
  if (
    typeof values.privyAccessToken !== "string" || !values.privyAccessToken
    || typeof values.refreshToken !== "string" || !values.refreshToken
    || typeof values.caId !== "string" || !values.caId
  ) {
    throw new Error("Fomo login completed without a refreshable Privy session");
  }
  return values as { privyAccessToken: string; refreshToken: string; caId: string };
}
