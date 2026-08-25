import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runScout } from "./scout.ts";
import { runSignals } from "./signals.ts";
import { loginFomo, openFomoSession } from "../fomo/browser.ts";
import { FomoClient, publicEmails, publicProfileResponse } from "../fomo/client.ts";
import { FomoStore } from "../fomo/store.ts";
import { postWebhook, webhookDisplayUrl, type FomoWatchWebhookPayload } from "../fomo/webhook.ts";
import { fomoHelp } from "../help.ts";
import type {
  FomoAlert,
  FomoClanDetail,
  FomoClanWindow,
  FomoLeaderboardEntry,
  FomoLeaderboardWindow,
  FomoUser,
  RawFomoPage,
  ResearchDataset,
  StoredFomoUser,
} from "../fomo/types.ts";
import { rankTraders, type RankedTrader } from "../intel/traders.ts";
import {
  screenPatterns,
  validatePatterns,
  type PatternGridInput,
  type ScreenedPattern,
  type ValidatedPattern,
} from "../intel/patterns.ts";
import { banner, bold, cyan, dim, gold, green, red, shortAddr, table } from "../ui/index.ts";

const DAY_MS = 86_400_000;

type TraderLeaderboardWindow = {
  label: string;
  official: FomoLeaderboardWindow | null;
  durationMs: number | null;
};

type LoadedTraderLeaderboard = {
  entries: FomoLeaderboardEntry[];
  source: "fomo-official" | "fomo-snapshots";
  candidateCount: number;
  measuredCount: number;
};

export async function runFomo(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === "-h" || command === "--help") {
    console.log(fomoHelp());
    return;
  }
  if (command === "help") {
    console.log(fomoHelp(args[0]));
    return;
  }
  if (args.includes("-h") || args.includes("--help")) {
    const nestedTopic = command === "user" && args[0]?.toLowerCase() === "profile"
      ? "profile"
      : command === "analyze" && ["wallets", "leaderboard", "leaderboards", "clans", "clan"].includes(args[0]?.toLowerCase())
        ? args[0]
        : command;
    console.log(fomoHelp(nestedTopic));
    return;
  }
  switch (command) {
    case "login":
      await loginCommand();
      return;
    case "account":
      await accountCommand(args);
      return;
    case "alerts":
      await alertsCommand(args);
      return;
    case "watch":
      await watchCommand(args);
      return;
    case "scout":
      await runScout(args);
      return;
    case "signals":
      await runSignals(args);
      return;
    case "sync":
      await syncCommand(args);
      return;
    case "analyze":
      await analyzeFomoCommand(args);
      return;
    case "profile":
      await profileCommand(args);
      return;
    case "user":
      if (args[0]?.toLowerCase() !== "profile") {
        throw new Error("Usage: fomo user profile <@handle> --json");
      }
      await profileCommand(args.slice(1));
      return;
    case "wallets":
      await walletsCommand(args);
      return;
    case "emails":
      await emailsCommand(args);
      return;
    case "leaderboard":
    case "leaderboards":
      await leaderboardCommand(args);
      return;
    case "clans":
      await clansCommand(args);
      return;
    case "clan":
      await clanCommand(args);
      return;
    case "rank":
      rankCommand(args);
      return;
    case "show":
      showCommand(args);
      return;
    case "patterns":
      patternsCommand(args);
      return;
    case "validate":
      validateCommand(args);
      return;
    case "status":
    case "db":
      statusCommand(args);
      return;
    case undefined:
      console.log(fomoHelp());
      return;
    default:
      throw new Error(`Unknown fomo command: ${command}`);
  }
}

async function analyzeFomoCommand(args: string[]): Promise<void> {
  const subject = args[0]?.toLowerCase();
  switch (subject) {
    case "wallets":
      await walletsCommand(args.slice(1));
      return;
    case "leaderboard":
    case "leaderboards":
      await leaderboardCommand(args.slice(1));
      return;
    case "clans":
      await clansCommand(args.slice(1));
      return;
    case "clan":
      await clanCommand(args.slice(1));
      return;
  }
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      days: { type: "string" }, since: { type: "string" }, until: { type: "string" },
      "max-pages": { type: "string", default: "20" },
      cached: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const target = parsed.positionals[0]?.trim();
  if (!target) throw new Error("Provide a Fomo username or linked wallet: fomo analyze <target>");
  const maxPages = positiveInteger(parsed.values["max-pages"], "--max-pages");
  const store = new FomoStore();
  let session: Awaited<ReturnType<typeof openFomoSession>> | null = null;

  try {
    let stored = findStoredUser(store.dataset().users, target);
    if (!parsed.values.cached) {
      session = await openFomoSession();
      const client = new FomoClient(session);
      let handle: string;
      if (isWallet(target)) {
        stored ??= await resolveLeaderboardWallet(client, store, target);
        if (!stored) {
          throw new Error(
            "Fomo does not expose a global wallet-owner lookup. This wallet is not in the local dataset or current Fomo leaderboards; analyze its Fomo username first.",
          );
        }
        handle = stored.userHandle;
      } else {
        handle = target.replace(/^@/, "");
      }
      if (!parsed.values.json) {
        console.log(banner(`Fomo analysis · @${handle}`));
        process.stdout.write(`  ${dim("Syncing Fomo profile and trades...")}`);
      }
      const result = await syncAndStore(client, store, handle, maxPages);
      stored = result.user;
      if (!parsed.values.json) {
        const truncation = result.truncated ? `  ${gold("history truncated at --max-pages")}` : "";
        process.stdout.write(`\r  ${green("OK")} ${result.swapCount} Fomo swaps collected${truncation}\n\n`);
      }
    }
    if (!stored) throw new Error(`No stored Fomo user or linked wallet matches ${target}`);
    const dataset = store.dataset([stored.userHandle]);
    requireDataset(dataset);
    const window = researchWindow(parsed.values, dataset, 90);
    const ranked = unrestrictedTrader(dataset, window);
    if (!ranked) throw new Error(`No Fomo activity available for @${stored.userHandle}`);
    if (parsed.values.json) console.log(JSON.stringify(ranked, jsonNumber, 2));
    else renderTrader(ranked);
  } finally {
    await session?.close();
    store.close();
  }
}

async function profileCommand(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: "boolean", default: false } },
  });
  const handle = parsed.positionals[0]?.trim();
  if (!handle) throw new Error("Provide a Fomo username: fomo profile <@handle> --json");
  const session = await openFomoSession();
  try {
    const result = await new FomoClient(session).resolveUser(handle);
    if (result.data.private === true) {
      throw new Error(`@${result.data.userHandle} has a private profile; export is unavailable`);
    }
    console.log(JSON.stringify({
      metadata: {
        source: "fomo-public-profile",
        endpoint: result.raw.endpoint,
        fetchedAt: result.raw.fetchedAt,
      },
      response: publicProfileResponse(result.raw.response),
    }, null, 2));
  } finally {
    await session.close();
  }
}

async function accountCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean", default: false } },
  });
  const session = await openFomoSession();
  const store = new FomoStore();
  try {
    const [profile, login] = await Promise.all([
      new FomoClient(session).currentUser(),
      session.loginIdentity(),
    ]);
    const account = store.saveCurrentAccount({
      user: profile.data,
      login,
      fetchedAt: profile.raw.fetchedAt,
    });
    if (values.json) {
      console.log(JSON.stringify(account, null, 2));
      return;
    }
    console.log(banner("Signed-in Fomo account"));
    console.log(table(
      [{ header: "Item" }, { header: "Value" }],
      [
        ["Handle", `@${account.userHandle}`],
        ["Display name", account.displayName ?? "-"],
        ["Login email", account.email],
        ["Login method", account.loginMethod],
        ["Fetched", account.fetchedAt],
      ],
    ));
    console.log();
  } finally {
    store.close();
    await session.close();
  }
}

async function alertsCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      limit: { type: "string", default: "50" },
      "last-id": { type: "string" },
      "min-size": { type: "string" },
      "min-equity": { type: "string" },
      "min-market-cap": { type: "string" },
      "max-market-cap": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const limit = positiveInteger(values.limit, "--limit");
  if (limit > 100) throw new Error("--limit must be between 1 and 100");
  const minMarketCap = optionalNonNegativeNumber(values["min-market-cap"], "--min-market-cap");
  const maxMarketCap = optionalNonNegativeNumber(values["max-market-cap"], "--max-market-cap");
  if (minMarketCap !== undefined && maxMarketCap !== undefined && minMarketCap > maxMarketCap) {
    throw new Error("--min-market-cap cannot exceed --max-market-cap");
  }
  const session = await openFomoSession();
  try {
    const result = await new FomoClient(session).tradingAlerts({
      limit,
      lastId: values["last-id"],
      threshold: optionalNonNegativeNumber(values["min-size"], "--min-size"),
      minEquity: optionalNonNegativeNumber(values["min-equity"], "--min-equity"),
      minMarketCap,
      maxMarketCap,
    });
    const nextId = result.data.hasNextPage ? result.data.items.at(-1)?.id ?? null : null;
    if (values.json) {
      console.log(JSON.stringify({
        metadata: {
          source: "fomo-trading-activity",
          endpoint: result.raw.endpoint,
          fetchedAt: result.raw.fetchedAt,
          hasNextPage: result.data.hasNextPage,
          nextId,
        },
        alerts: result.data.items,
      }, jsonNumber, 2));
      return;
    }
    console.log(banner("Fomo activity alerts"));
    if (result.data.items.length === 0) {
      console.log(dim("  No alerts matched the requested filters.\n"));
      return;
    }
    console.log(table(
      [
        { header: "Time" }, { header: "Event" }, { header: "Token" },
        { header: "Size", align: "right" }, { header: "Network" },
      ],
      result.data.items.map((alert) => [
        alert.createdAt.replace("T", " ").slice(0, 19),
        alert.type.replaceAll("_", " "),
        alertTicker(alert),
        alertUsdValue(alert),
        alert.networkId ?? "-",
      ]),
    ));
    if (nextId) console.log(dim(`\n  More alerts available: --last-id ${nextId}`));
    console.log();
  } finally {
    await session.close();
  }
}

async function watchCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      webhook: { type: "string" },
      interval: { type: "string", default: "15s" },
      json: { type: "boolean", default: false },
    },
  });
  const handle = positionals[0]?.trim();
  if (!handle) throw new Error("Provide a Fomo username: fomo watch <@handle> --webhook <url>");
  const webhookUrl = values.webhook?.trim() || process.env.FOMO_WEBHOOK_URL?.trim();
  if (!webhookUrl) throw new Error("Provide --webhook <url> or FOMO_WEBHOOK_URL");
  const intervalMs = watchInterval(values.interval);
  const displayUrl = webhookDisplayUrl(webhookUrl);
  const session = await openFomoSession();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const client = new FomoClient(session);
    const profile = (await client.resolveUser(handle)).data;
    const currentUser = (await client.currentUser()).data;
    const baseline = await client.recentSwaps(profile, 100);
    const seen = new Set(baseline.data.items.map((swap) => swap.id));
    const seenActivity = new Set<string>();
    if (!values.json) {
      console.log(banner(`Watching @${profile.userHandle}`));
      console.log(dim(`  Realtime via personalized Fomo alerts · recovery poll every ${formatWatchInterval(intervalMs)}`));
      console.log(dim(`  The target must be followed by @${currentUser.userHandle} for realtime events.`));
      console.log(dim(`  Webhook ${displayUrl}`));
      console.log(dim(`  Baseline: ${baseline.data.items.length} recent swaps · press Ctrl+C to stop\n`));
    }
    let deliveryQueue = Promise.resolve();
    const queueDelivery = (payload: FomoWatchWebhookPayload, line: string) => {
      deliveryQueue = deliveryQueue.then(async () => {
        if (values.json) console.log(JSON.stringify(payload));
        else console.log(line);
        try {
          await postWebhook(webhookUrl, payload, { secret: process.env.FOMO_WEBHOOK_SECRET });
        } catch (error) {
          const deliveryId = payload.event === "fomo.swap" ? payload.swap.id : String(payload.activity.id);
          console.error(red(`  Webhook failed for ${deliveryId}: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
      return deliveryQueue;
    };
    let realtimeState = "";
    const realtime = session.streamTradingActivity(
      currentUser.id,
      (activity) => {
        if (!activityMatchesProfile(activity, profile.id)) return;
        const activityId = typeof activity.id === "string" ? activity.id : null;
        if (!activityId || seenActivity.has(activityId)) return;
        seenActivity.add(activityId);
        const swapId = typeof activity.swapId === "string" ? activity.swapId : null;
        if (swapId) seen.add(swapId);
        const createdAt = typeof activity.createdAt === "string" ? activity.createdAt : new Date().toISOString();
        return queueDelivery({
          version: 1,
          event: "fomo.trading_activity",
          occurredAt: createdAt,
          deliveredAt: new Date().toISOString(),
          profile: watchProfile(profile),
          activity,
        }, realtimeActivityLine(profile, activity, createdAt));
      },
      controller.signal,
      (state) => {
        if (values.json || state === realtimeState) return;
        realtimeState = state;
        const label = state === "connected" ? green("connected") : gold(state);
        console.log(`  Realtime stream: ${label}`);
      },
    ).catch((error) => {
      if (!controller.signal.aborted) {
        console.error(red(`  Realtime stream failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    while (!controller.signal.aborted) {
      await waitForWatchPoll(intervalMs, controller.signal);
      if (controller.signal.aborted) break;
      let result: Awaited<ReturnType<FomoClient["recentSwaps"]>>;
      try {
        result = await client.recentSwaps(profile, 100);
      } catch (error) {
        console.error(red(`  Poll failed: ${error instanceof Error ? error.message : String(error)}`));
        continue;
      }
      const newSwaps = result.data.items.filter((swap) => !seen.has(swap.id)).reverse();
      for (const swap of newSwaps) {
        seen.add(swap.id);
        await queueDelivery({
          version: 1,
          event: "fomo.swap",
          occurredAt: swap.createdAt,
          deliveredAt: new Date().toISOString(),
          profile: watchProfile(profile),
          swap,
        }, watchSwapLine(profile, swap));
      }
      for (const swap of result.data.items) seen.add(swap.id);
      while (seen.size > 1_000) seen.delete(seen.values().next().value!);
      if (newSwaps.length === 100 && result.data.hasNextPage) {
        console.error(gold("  Warning: more than 100 new swaps may have occurred between polls."));
      }
    }
    controller.abort();
    await realtime;
    await deliveryQueue;
    if (!values.json) console.log(dim("\n  Watch stopped.\n"));
  } finally {
    controller.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await session.close();
  }
}

async function leaderboardCommand(args: string[]): Promise<void> {
  const { values } = parseLiveArgs(args, true);
  const window = traderLeaderboardWindow(values.window);
  const top = liveTop(values.top, 20);
  const session = await openFomoSession();
  const store = new FomoStore();
  try {
    const client = new FomoClient(session);
    if (!values.json && !window.official) {
      console.log(dim(`  Calculating ${window.label} PnL from live Fomo snapshots...`));
    }
    const result = await loadTraderLeaderboard(client, window, top);
    for (const entry of result.entries) store.saveUser(entry.user);
    const entries = result.entries.slice(0, top);
    if (values.json) {
      console.log(JSON.stringify({
        window: window.label,
        source: result.source,
        candidateCount: result.candidateCount,
        measuredCount: result.measuredCount,
        leaderboard: entries,
      }, null, 2));
      return;
    }
    console.log(banner(`Fomo leaderboard · ${window.label}`));
    console.log(renderOfficialLeaderboard(entries));
    const sourceNote = result.source === "fomo-official"
      ? "Official Fomo ranking."
      : `Calculated from Fomo PnL snapshots for ${result.measuredCount}/${result.candidateCount} live candidates.`;
    console.log(dim(`\n  ${sourceNote} Use fomo rank for the local risk-adjusted ranking.\n`));
  } finally {
    store.close();
    await session.close();
  }
}

async function walletsCommand(args: string[]): Promise<void> {
  const { values } = parseLiveArgs(args, true);
  const window = traderLeaderboardWindow(values.window);
  const top = liveTop(values.top, 50);
  const session = await openFomoSession();
  const store = new FomoStore();
  try {
    const client = new FomoClient(session);
    if (!values.json && !window.official) {
      console.log(dim(`  Calculating ${window.label} PnL from live Fomo snapshots...`));
    }
    const result = await loadTraderLeaderboard(client, window, top);
    for (const entry of result.entries) store.saveUser(entry.user);
    const entries = result.entries.filter((entry) => entry.user.address || entry.user.evmAddress).slice(0, top);
    if (values.json) {
      console.log(JSON.stringify({
        window: window.label,
        source: result.source,
        candidateCount: result.candidateCount,
        measuredCount: result.measuredCount,
        wallets: entries,
      }, null, 2));
      return;
    }
    console.log(banner(`Fomo-linked wallets · ${window.label}`));
    console.log(table(
      [
        { header: "#", align: "right" }, { header: "Trader" }, { header: "Solana" },
        { header: "EVM" }, { header: "PnL", align: "right" }, { header: "Clan" },
      ],
      entries.map((entry) => [
        String(entry.rank), `@${entry.user.userHandle}`,
        entry.user.address ? shortAddr(entry.user.address, 6) : "-",
        entry.user.evmAddress ? shortAddr(entry.user.evmAddress, 6) : "-",
        usd(entry.pnl), entry.user.clan?.name ?? "-",
      ]),
    ));
    console.log(dim("\n  Addresses are linked by Fomo profiles; this is not a full blockchain wallet scan.\n"));
  } finally {
    store.close();
    await session.close();
  }
}

async function emailsCommand(args: string[]): Promise<void> {
  const { values } = parseLiveArgs(args, true);
  const window = traderLeaderboardWindow(values.window);
  const top = liveTop(values.top, 100);
  const session = await openFomoSession();
  try {
    const client = new FomoClient(session);
    if (!values.json && !window.official) {
      console.log(dim(`  Calculating ${window.label} PnL from live Fomo snapshots...`));
    }
    const leaderboard = await loadTraderLeaderboard(client, window, top);
    const leaders = leaderboard.entries.slice(0, top);
    const publicEntries = leaders.filter((entry) => entry.user.private !== true);
    const published = publicEntries.flatMap((entry) =>
      publicEmails(entry.user.description).map((email) => ({ entry, email }))
    );
    const contactHandles = [...new Set(published.map(({ entry }) => entry.user.userHandle))];
    const profiles = await client.resolveUsers(contactHandles);
    const profileByHandle = new Map(
      profiles.filter((profile): profile is FomoUser => profile !== null)
        .map((profile) => [profile.userHandle.toLowerCase(), profile]),
    );
    const contacts = published.map(({ entry, email }) => {
      const profile = profileByHandle.get(entry.user.userHandle.toLowerCase()) ?? entry.user;
      return {
        rank: entry.rank,
        userHandle: profile.userHandle,
        displayName: profile.displayName,
        email,
        twitter: profile.twitter,
        bio: profile.description,
        source: "public-fomo-profile" as const,
      };
    });
    if (values.json) {
      console.log(JSON.stringify({
        window: window.label,
        leaderboardSource: leaderboard.source,
        profilesScanned: leaders.length,
        privateProfilesSkipped: leaders.length - publicEntries.length,
        contactProfilesFetched: profiles.filter(Boolean).length,
        contacts,
      }, null, 2));
      return;
    }
    console.log(banner(`Public trader emails · ${window.label}`));
    if (contacts.length) {
      console.log(table(
        [{ header: "#", align: "right" }, { header: "Trader" }, { header: "Email" }, { header: "Twitter" }],
        contacts.map((contact) => [
          String(contact.rank), `@${contact.userHandle}`, contact.email, contact.twitter ?? "-",
        ]),
      ));
    } else {
      console.log(dim("  No email addresses were published in the scanned trader bios."));
    }
    console.log(dim(
      `\n  Scanned ${leaders.length} profiles. Only emails explicitly published in non-private Fomo profile bios are included.\n`,
    ));
  } finally {
    await session.close();
  }
}

async function clansCommand(args: string[]): Promise<void> {
  const { values } = parseLiveArgs(args, false);
  const window = leaderboardWindow(values.window, false);
  const top = optionalInteger(values.top, 20, "--top");
  const session = await openFomoSession();
  try {
    const result = await new FomoClient(session).clanLeaderboard(window);
    const clans = result.data.slice(0, top);
    if (values.json) {
      console.log(JSON.stringify({ window, clans }, null, 2));
      return;
    }
    console.log(banner(`Fomo clan leaderboard · ${window}`));
    console.log(table(
      [
        { header: "#", align: "right" }, { header: "Clan" }, { header: "PnL", align: "right" },
        { header: "Members", align: "right" }, { header: "ID" },
      ],
      clans.map((clan) => [String(clan.rank), clan.name, usd(clan.pnl), String(clan.memberCount), clan.id]),
    ));
    console.log();
  } finally {
    await session.close();
  }
}

async function clanCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseLiveArgs(args, false);
  const target = positionals.join(" ").trim();
  if (!target) throw new Error("Provide a Fomo clan ID or name: fomo clan <id | name>");
  const window = leaderboardWindow(values.window, false);
  const top = optionalInteger(values.top, 20, "--top");
  const session = await openFomoSession();
  const store = new FomoStore();
  try {
    const client = new FomoClient(session);
    const board = await client.clanLeaderboard(window);
    const clanId = resolveClanId(board.data, target);
    const detail = (await client.clan(clanId, window)).data;
    for (const member of detail.members) store.saveUser(member.user);
    if (values.json) {
      console.log(JSON.stringify({ window, clan: detail }, null, 2));
      return;
    }
    renderClan(detail, window, top);
  } finally {
    store.close();
    await session.close();
  }
}

async function loginCommand(): Promise<void> {
  console.log(banner("Fomo browser login"));
  console.log(dim("  A dedicated Chrome profile will open. Sign in to Fomo normally."));
  console.log(dim("  Fomo CLI never reads or stores your password."));
  console.log(dim("  Refreshable session tokens are stored securely in macOS Keychain.\n"));
  await loginFomo();
  console.log(`\n  ${green("Authenticated session captured.")} You can now run ${bold("fomo sync")}.\n`);
}

async function syncCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      file: { type: "string" },
      "max-pages": { type: "string", default: "20" },
      json: { type: "boolean", default: false },
    },
  });
  const handles = uniqueHandles([
    ...positionals,
    ...(values.file ? handlesFromFile(values.file) : []),
  ]);
  if (handles.length === 0) throw new Error("Provide at least one @handle or --file <path>");
  const maxPages = positiveInteger(values["max-pages"], "--max-pages");
  const store = new FomoStore();
  const summaries: unknown[] = [];
  let session: Awaited<ReturnType<typeof openFomoSession>> | null = null;

  try {
    if (!values.json) {
      console.log(banner(`syncing ${handles.length} Fomo trader${handles.length === 1 ? "" : "s"}`));
      console.log(dim(`  Read-only API capture, up to ${maxPages} page(s) per endpoint.\n`));
    }
    session = await openFomoSession(handles[0]);
    const client = new FomoClient(session);

    for (const handle of handles) {
      const runId = store.beginSync(handle);
      const started = Date.now();
      try {
        if (!values.json) process.stdout.write(`  ${cyan("@" + handle)}  fetching...`);
        const result = await client.syncHandle(handle, { maxPages });
        store.saveUser(result.user, result.summary.completedAt ?? undefined);
        store.saveSwaps(result.swaps, runId);
        const rawPages = flattenRawPages(result.raw);
        for (const page of rawPages) store.saveRawPage(runId, page);
        const summary = store.completeSync(runId, {
          userId: result.user.id,
          swapCount: result.swaps.length,
          rawPageCount: rawPages.length,
        });
        const reportedSummary = { ...summary, truncated: result.summary.truncated };
        summaries.push(reportedSummary);
        if (!values.json) {
          const truncation = result.summary.truncated ? `  ${gold("truncated at page cap")}` : "";
          process.stdout.write(`\r  ${green("OK")} ${cyan("@" + handle)}  ${result.swaps.length} swaps  ${Date.now() - started}ms${truncation}\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summaries.push(store.completeSync(runId, { error: message }));
        if (!values.json) process.stdout.write(`\r  ${red("FAIL")} ${cyan("@" + handle)}  ${message}\n`);
      }
    }

    if (values.json) console.log(JSON.stringify(summaries, null, 2));
    else console.log(dim(`\n  Database: ${store.databasePath}\n`));
  } finally {
    await session?.close();
    store.close();
  }
}

function rankCommand(args: string[]): void {
  const parsed = parseResearchArgs(args);
  const store = new FomoStore();
  try {
    const dataset = store.dataset();
    requireDataset(dataset);
    const window = researchWindow(parsed.values, dataset, 90);
    const rankings = rankTraders(dataset, window, {
      minClosed: optionalInteger(parsed.values["min-closed"], 5, "--min-closed"),
      minBasisCoverage: optionalNumber(parsed.values.coverage, 0.7, "--coverage"),
    });
    const top = optionalInteger(parsed.values.top, 20, "--top");
    if (parsed.values.json) {
      console.log(JSON.stringify({ window, rankings: rankings.slice(0, top) }, jsonNumber, 2));
      return;
    }
    console.log(banner("Fomo trader ranking"));
    console.log(dim(`  ${new Date(window.since).toISOString()} to ${new Date(window.until).toISOString()}\n`));
    console.log(renderRankings(rankings.slice(0, top)));
    researchDisclaimer();
  } finally {
    store.close();
  }
}

function showCommand(args: string[]): void {
  const parsed = parseResearchArgs(args);
  const handle = parsed.positionals[0]?.replace(/^@/, "");
  if (!handle) throw new Error("Provide a trader: fomo show @handle");
  const store = new FomoStore();
  try {
    const dataset = store.dataset([handle]);
    requireDataset(dataset);
    const window = researchWindow(parsed.values, dataset, 90);
    const ranked = rankTraders(dataset, window, {
      minTrades: 0,
      minClosed: 0,
      minActiveDays: 0,
      minBasisCoverage: 0,
    })[0];
    if (!ranked) throw new Error(`No stored data for @${handle}`);
    if (parsed.values.json) {
      console.log(JSON.stringify(ranked, jsonNumber, 2));
      return;
    }
    renderTrader(ranked);
  } finally {
    store.close();
  }
}

async function syncAndStore(
  client: FomoClient,
  store: FomoStore,
  handle: string,
  maxPages: number,
): Promise<{ user: StoredFomoUser; swapCount: number; truncated: boolean }> {
  const runId = store.beginSync(handle);
  try {
    const result = await client.syncHandle(handle, { maxPages });
    const user = store.saveUser(result.user, result.summary.completedAt ?? undefined);
    store.saveSwaps(result.swaps, runId);
    const rawPages = flattenRawPages(result.raw);
    for (const page of rawPages) store.saveRawPage(runId, page);
    store.completeSync(runId, {
      userId: result.user.id,
      swapCount: result.swaps.length,
      rawPageCount: rawPages.length,
      truncated: result.summary.truncated,
    });
    return { user, swapCount: result.swaps.length, truncated: result.summary.truncated ?? false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.completeSync(runId, { error: message });
    throw error;
  }
}

function unrestrictedTrader(
  dataset: ResearchDataset,
  window: { since: number; until: number },
): RankedTrader | undefined {
  return rankTraders(dataset, window, {
    minTrades: 0,
    minClosed: 0,
    minActiveDays: 0,
    minBasisCoverage: 0,
  })[0];
}

function renderTrader(ranked: RankedTrader, disclaimer = true): void {
  const metric = ranked.analysis.metrics;
  console.log(banner(`@${metric.handle} Fomo intelligence`));
  console.log(table(
    [{ header: "Metric" }, { header: "Value", align: "right" }],
    [
      ["Clan", metric.clanName ?? "unaffiliated"],
      ["Trades / closed", `${metric.tradeCount} / ${metric.closedOutcomeCount}`],
      ["Realized PnL", usd(metric.realizedPnlUsd)],
      ["ROIC", percent(metric.realizedRoic)],
      ["Bayesian win rate", percent(metric.bayesianWinRate)],
      ["Profit factor", finite(metric.profitFactor, 2)],
      ["Max drawdown", `${metric.maxDrawdownPct.toFixed(1)}%`],
      ["Basis coverage", percent(metric.basisCoverage)],
      ["Copyable events", percent(metric.copyableRatio)],
      ["Median hold", duration(metric.medianHoldSeconds)],
      ["Reliability", percent(ranked.reliability)],
    ],
  ));
  if (disclaimer) researchDisclaimer();
  else console.log();
}

function renderOfficialLeaderboard(entries: FomoLeaderboardEntry[]): string {
  return table(
    [
      { header: "#", align: "right" }, { header: "Trader" }, { header: "PnL", align: "right" },
      { header: "Trades", align: "right" }, { header: "Volume", align: "right" },
      { header: "Holdings", align: "right" }, { header: "Clan" },
    ],
    entries.map((entry) => [
      String(entry.rank), `@${entry.user.userHandle}`, usd(entry.pnl), String(entry.numTrades),
      usd(entry.totalVolume), usd(entry.totalHoldings), entry.user.clan?.name ?? "-",
    ]),
  );
}

function renderClan(detail: FomoClanDetail, window: FomoClanWindow, top: number): void {
  console.log(banner(`${detail.name} · Fomo clan · ${window}`));
  console.log(table(
    [{ header: "Metric" }, { header: "Value", align: "right" }],
    [
      ["Official rank", detail.rank ? `#${detail.rank}` : "-"],
      ["PnL", usd(detail.pnl)],
      ["Members", String(detail.memberCount)],
      ["Trades", detail.tradeCount.toLocaleString()],
      ["Clan ID", detail.id],
    ],
  ));
  const members = [...detail.members].sort((a, b) => b.pnl - a.pnl).slice(0, top);
  if (members.length) {
    console.log(`\n${bold("Top members")}`);
    console.log(table(
      [
        { header: "#", align: "right" }, { header: "Trader" }, { header: "PnL", align: "right" },
        { header: "Role" }, { header: "Solana" }, { header: "EVM" },
      ],
      members.map((member, index) => [
        String(index + 1), `@${member.user.userHandle}`, usd(member.pnl), member.role ?? "member",
        member.user.address ? shortAddr(member.user.address, 6) : "-",
        member.user.evmAddress ? shortAddr(member.user.evmAddress, 6) : "-",
      ]),
    ));
  }
  if (detail.topTokens.length) {
    console.log(`\n${bold("Top tokens")}`);
    console.log(table(
      [
        { header: "Token" }, { header: "Network" }, { header: "PnL", align: "right" }, { header: "Address" },
      ],
      detail.topTokens.map((token) => [
        token.symbol, token.networkId, usd(token.pnl), shortAddr(token.tokenAddress, 6),
      ]),
    ));
  }
  researchDisclaimer();
}

function parseLiveArgs(args: string[], allowAll: boolean) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      window: { type: "string", default: "24h" },
      top: { type: "string", default: allowAll ? "20" : "20" },
      json: { type: "boolean", default: false },
    },
  });
}

function leaderboardWindow(value: string | undefined, allowAll: true): FomoLeaderboardWindow;
function leaderboardWindow(value: string | undefined, allowAll: false): FomoClanWindow;
function leaderboardWindow(value: string | undefined, allowAll: boolean): FomoLeaderboardWindow {
  const normalized = (value ?? "24h").toLowerCase();
  const accepted = allowAll ? ["24h", "7d", "30d", "all"] : ["24h", "7d", "30d"];
  if (!accepted.includes(normalized)) {
    throw new Error(`--window must be ${accepted.join(" | ")}`);
  }
  return normalized as FomoLeaderboardWindow;
}

function traderLeaderboardWindow(value: string | undefined): TraderLeaderboardWindow {
  const normalized = (value ?? "24h").trim().toLowerCase();
  if (normalized === "all") return { label: "all", official: "all", durationMs: null };
  const match = /^(\d+)(d|h)$/.exec(normalized);
  if (!match) throw new Error("--window must be all or a positive duration such as 1d, 2d, 48h, or 365d");
  const count = Number(match[1]);
  const unitMs = match[2] === "d" ? DAY_MS : 3_600_000;
  const durationMs = count * unitMs;
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(durationMs)) {
    throw new Error("--window duration is too large");
  }
  const official = durationMs === DAY_MS
    ? "24h"
    : durationMs === 7 * DAY_MS
      ? "7d"
      : durationMs === 30 * DAY_MS
        ? "30d"
        : null;
  return { label: normalized, official, durationMs };
}

async function loadTraderLeaderboard(
  client: FomoClient,
  window: TraderLeaderboardWindow,
  top: number,
): Promise<LoadedTraderLeaderboard> {
  if (window.official) {
    const result = await client.leaderboard(window.official, Math.min(100, top));
    return {
      entries: result.data,
      source: "fomo-official",
      candidateCount: result.data.length,
      measuredCount: result.data.length,
    };
  }
  if (window.durationMs === null) throw new Error("Custom Fomo window requires a finite duration");
  const sources: FomoLeaderboardWindow[] = window.durationMs <= 7 * DAY_MS
    ? ["24h", "7d"]
    : window.durationMs <= 30 * DAY_MS
      ? ["7d", "30d"]
      : ["30d", "all"];
  const boards = await Promise.all(sources.map((source) => client.leaderboard(source, 100)));
  const candidates = new Map<string, FomoLeaderboardEntry>();
  for (const board of boards) {
    for (const entry of board.data) candidates.set(entry.user.id, entry);
  }
  const since = new Date(Date.now() - window.durationMs);
  if (!Number.isFinite(since.getTime())) throw new Error("--window starts before the supported date range");
  const candidateEntries = [...candidates.values()];
  const histories = await client.pnlHistories(candidateEntries.map((entry) => entry.user.id), since);
  const entries = candidateEntries
    .map((entry) => {
      const history = histories.get(entry.user.id);
      return history && history.length >= 2
        ? { ...entry, pnl: history.at(-1)!.pnl - history[0].pnl }
        : null;
    })
    .filter((entry): entry is FomoLeaderboardEntry => entry !== null)
    .sort((a, b) => b.pnl - a.pnl)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  return {
    entries,
    source: "fomo-snapshots",
    candidateCount: candidates.size,
    measuredCount: entries.length,
  };
}

function liveTop(value: string | undefined, fallback: number): number {
  const top = optionalInteger(value, fallback, "--top");
  if (top > 100) throw new Error("--top must be between 1 and 100 for live Fomo rankings");
  return top;
}

function optionalNonNegativeNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${flag} must be a non-negative number`);
  return number;
}

function alertTicker(alert: FomoAlert): string {
  const ticker = alert.body.ticker;
  if (typeof ticker === "string" && ticker) return ticker;
  return alert.tokenAddress ? shortAddr(alert.tokenAddress, 6) : "-";
}

function alertUsdValue(alert: FomoAlert): string {
  for (const key of ["totalVolume", "usdAmount", "usdValue"]) {
    const value = alert.body[key];
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(number)) return usd(number);
  }
  return "-";
}

function watchInterval(value: string | undefined): number {
  const match = /^(\d+)(s|m)$/.exec((value ?? "15s").trim().toLowerCase());
  if (!match) throw new Error("--interval must be a duration such as 15s or 1m");
  const milliseconds = Number(match[1]) * (match[2] === "m" ? 60_000 : 1_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 5_000 || milliseconds > 3_600_000) {
    throw new Error("--interval must be between 5s and 60m");
  }
  return milliseconds;
}

function formatWatchInterval(milliseconds: number): string {
  return milliseconds % 60_000 === 0 ? `${milliseconds / 60_000}m` : `${milliseconds / 1_000}s`;
}

function waitForWatchPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function watchSwapLine(profile: FomoUser, swap: import("../fomo/types.ts").FomoSwap): string {
  const route = `${swap.inHumanAmount} ${shortAddr(swap.inTokenAddress, 5)} -> ${swap.outHumanAmount} ${shortAddr(swap.outTokenAddress, 5)}`;
  return `${green("NEW")} ${swap.createdAt} @${profile.userHandle} · ${route}`;
}

function realtimeActivityLine(
  profile: FomoUser,
  activity: Record<string, unknown>,
  createdAt: string,
): string {
  const type = typeof activity.type === "string" ? activity.type.replaceAll("_", " ") : "trading activity";
  return `${green("LIVE")} ${createdAt} @${profile.userHandle} · ${type}`;
}

function watchProfile(profile: FomoUser) {
  return {
    id: profile.id,
    userHandle: profile.userHandle,
    displayName: profile.displayName,
    address: profile.address,
    evmAddress: profile.evmAddress,
  };
}

function activityMatchesProfile(activity: Record<string, unknown>, userId: string): boolean {
  if (activity.userId === userId) return true;
  const body = activity.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (record.userId === userId) return true;
  for (const key of ["user", "author", "trader"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested) && (nested as Record<string, unknown>).id === userId) {
      return true;
    }
  }
  for (const key of ["topTraders", "users", "traders"]) {
    const users = record[key];
    if (Array.isArray(users) && users.some((user) =>
      user && typeof user === "object" && !Array.isArray(user) && (user as Record<string, unknown>).id === userId
    )) return true;
  }
  return false;
}

function findStoredUser(users: StoredFomoUser[], target: string): StoredFomoUser | null {
  const clean = target.trim().replace(/^@/, "");
  const evm = clean.toLowerCase();
  return users.find((user) =>
    user.userHandle.toLowerCase() === clean.toLowerCase()
    || user.address === clean
    || user.evmAddress?.toLowerCase() === evm
  ) ?? null;
}

async function resolveLeaderboardWallet(
  client: FomoClient,
  store: FomoStore,
  wallet: string,
): Promise<StoredFomoUser | null> {
  for (const window of ["24h", "7d", "30d", "all"] as const) {
    const result = await client.leaderboard(window, 100);
    for (const entry of result.data) store.saveUser(entry.user);
    const match = result.data.find((entry) => walletMatches(entry.user, wallet));
    if (match) return store.saveUser(match.user);
  }
  return null;
}

function walletMatches(user: FomoUser, wallet: string): boolean {
  return user.address === wallet || user.evmAddress?.toLowerCase() === wallet.toLowerCase();
}

function isWallet(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function resolveClanId(clans: Array<{ id: string; name: string }>, target: string): string {
  const normalized = target.trim().toLowerCase();
  const exact = clans.find((clan) => clan.id === target || clan.name.toLowerCase() === normalized);
  if (exact) return exact.id;
  const partial = clans.filter((clan) => clan.name.toLowerCase().includes(normalized));
  if (partial.length === 1) return partial[0].id;
  if (partial.length > 1) {
    throw new Error(`Clan name is ambiguous: ${partial.slice(0, 5).map((clan) => clan.name).join(", ")}`);
  }
  return target;
}

function patternsCommand(args: string[]): void {
  const parsed = parsePatternArgs(args);
  const store = new FomoStore();
  try {
    const dataset = store.dataset();
    requireDataset(dataset);
    const window = researchWindow(parsed.values, dataset, 90);
    const result = screenPatterns(dataset, {
      window,
      grid: loadGrid(parsed.values.config),
      maxGridCells: optionalInteger(parsed.values["max-patterns"], 100_000, "--max-patterns"),
      roundTripFeeBps: optionalNumber(parsed.values["fee-bps"], 20, "--fee-bps"),
    });
    const top = optionalInteger(parsed.values.top, 20, "--top");
    const ranked = [...result.results]
      .filter((item) => item.tradeCount > 0)
      .sort((a, b) => b.returnPct - a.returnPct || b.netPnlUsd - a.netPnlUsd)
      .slice(0, top);
    if (parsed.values.json) {
      console.log(JSON.stringify({ ...result, results: ranked }, null, 2));
      return;
    }
    console.log(banner(`${result.patternsTested.toLocaleString()} retrospective patterns`));
    console.log(renderPatterns(ranked));
    console.log(dim("\n  Exploratory only: this screen uses historical leader outcomes and is not causal."));
    researchDisclaimer();
  } finally {
    store.close();
  }
}

function validateCommand(args: string[]): void {
  const parsed = parsePatternArgs(args, true);
  const store = new FomoStore();
  try {
    const dataset = store.dataset();
    requireDataset(dataset);
    const window = researchWindow(parsed.values, dataset, 180);
    const result = validatePatterns(dataset, {
      window,
      grid: loadGrid(parsed.values.config),
      maxGridCells: optionalInteger(parsed.values["max-patterns"], 100_000, "--max-patterns"),
      roundTripFeeBps: optionalNumber(parsed.values["fee-bps"], 20, "--fee-bps"),
      foldCount: optionalInteger(optionString(parsed.values.folds), 4, "--folds"),
      testDays: optionalInteger(optionString(parsed.values["test-days"]), 14, "--test-days"),
      causal: !parsed.values.retrospective,
      maxObservationLagSeconds: optionalNumber(optionString(parsed.values["max-lag"]), 300, "--max-lag"),
    });
    const top = optionalInteger(parsed.values.top, 20, "--top");
    const ranked = [...result.results]
      .filter((item) => item.tradeCount > 0)
      .sort((a, b) =>
        b.positiveFoldRatio - a.positiveFoldRatio
        || b.worstFoldReturnPct - a.worstFoldReturnPct
        || b.returnPct - a.returnPct
      )
      .slice(0, top);
    if (parsed.values.json) {
      console.log(JSON.stringify({ ...result, results: ranked }, null, 2));
      return;
    }
    console.log(banner(`${result.patternsTested.toLocaleString()} ${result.label} patterns`));
    console.log(renderValidation(ranked));
    if (ranked.length === 0 && !parsed.values.retrospective) {
      console.log(dim("\n  No causal outcomes yet. Historical backfills are excluded; sync periodically to build observations."));
    }
    researchDisclaimer();
  } finally {
    store.close();
  }
}

function statusCommand(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean", default: false } },
  });
  const store = new FomoStore();
  try {
    const status = store.status();
    if (values.json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(banner("Fomo research database"));
      console.log(table(
        [{ header: "Item" }, { header: "Value", align: "right" }],
        [
          ["Users", status.users.toLocaleString()],
          ["Swaps", status.swaps.toLocaleString()],
          ["Raw API pages", status.rawPages.toLocaleString()],
          ["Last sync", status.lastSync?.completedAt ?? "never"],
          ["Database", status.databasePath],
        ],
      ));
      console.log();
    }
  } finally {
    store.close();
  }
}

function parseResearchArgs(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      days: { type: "string" }, since: { type: "string" }, until: { type: "string" },
      top: { type: "string", default: "20" }, json: { type: "boolean", default: false },
      "min-closed": { type: "string" }, coverage: { type: "string" },
    },
  });
}

function parsePatternArgs(args: string[], validation = false) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      days: { type: "string" }, since: { type: "string" }, until: { type: "string" },
      top: { type: "string", default: "20" }, json: { type: "boolean", default: false },
      config: { type: "string" }, "max-patterns": { type: "string", default: "100000" },
      "fee-bps": { type: "string", default: "20" },
      ...(validation ? {
        folds: { type: "string" as const, default: "4" },
        "test-days": { type: "string" as const, default: "14" },
        "max-lag": { type: "string" as const, default: "300" },
        retrospective: { type: "boolean" as const, default: false },
      } : {}),
    },
  });
}

function researchWindow(
  values: { days?: string; since?: string; until?: string },
  dataset: ResearchDataset,
  defaultDays: number,
): { since: number; until: number } {
  const times = dataset.swaps.map((swap) => Date.parse(swap.createdAt)).filter(Number.isFinite);
  const dataMax = times.length ? Math.max(...times) : Date.now();
  const until = values.until ? parseDate(values.until, true) : Math.max(dataMax, Date.now());
  const since = values.since
    ? parseDate(values.since, false)
    : until - optionalNumber(values.days, defaultDays, "--days") * DAY_MS;
  if (since >= until) throw new Error("Research window must have --since before --until");
  return { since, until };
}

function flattenRawPages(raw: {
  user: RawFomoPage;
  swaps: RawFomoPage[];
  balances: RawFomoPage;
  spotlight: RawFomoPage;
  closedTrades: RawFomoPage[];
}): RawFomoPage[] {
  return [raw.user, ...raw.swaps, raw.balances, raw.spotlight, ...raw.closedTrades];
}

function handlesFromFile(file: string): string[] {
  const text = readFileSync(file, "utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { handles?: unknown }).handles)) {
      return (parsed as { handles: unknown[] }).handles.map(String);
    }
  } catch {
    // Fall through to newline/comma parsing.
  }
  return text.split(/[\n,]/).map((line) => line.replace(/#.*$/, "").trim()).filter(Boolean);
}

function uniqueHandles(handles: string[]): string[] {
  return [...new Set(handles.map((handle) => handle.trim().replace(/^@/, "")).filter(Boolean))];
}

function loadGrid(file?: string): PatternGridInput {
  if (!file) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pattern config must contain a JSON object");
  }
  return parsed as PatternGridInput;
}

function renderRankings(rankings: RankedTrader[]): string {
  return table(
    [
      { header: "#", align: "right" }, { header: "Trader" }, { header: "Score", align: "right" },
      { header: "PnL", align: "right" }, { header: "ROIC", align: "right" },
      { header: "Win", align: "right" }, { header: "MDD", align: "right" },
      { header: "Closed", align: "right" }, { header: "Coverage", align: "right" }, { header: "Clan" },
    ],
    rankings.map((item) => {
      const metric = item.analysis.metrics;
      return [
        item.rank ? String(item.rank) : "-", `@${metric.handle}`, item.score.toFixed(3),
        usd(metric.realizedPnlUsd), percent(metric.realizedRoic), percent(metric.bayesianWinRate),
        `${metric.maxDrawdownPct.toFixed(0)}%`, String(metric.closedOutcomeCount), percent(metric.basisCoverage),
        metric.clanName ?? "-",
      ];
    }),
  );
}

function renderPatterns(patterns: ScreenedPattern[]): string {
  return table(
    [
      { header: "ID" }, { header: "Return", align: "right" }, { header: "Net", align: "right" },
      { header: "MDD", align: "right" }, { header: "Trades", align: "right" },
      { header: "Leaders", align: "right" }, { header: "Lookback", align: "right" },
      { header: "Slip", align: "right" }, { header: "Delay", align: "right" },
    ],
    patterns.map((item) => [
      item.pattern.id.slice(0, 8), percent(item.returnPct), usd(item.netPnlUsd),
      `${item.maxDrawdownPct.toFixed(1)}%`, String(item.tradeCount), String(item.selectedTraderIds.length),
      `${item.pattern.lookbackDays}d`, `${item.pattern.slippageBps}bp`, `${item.pattern.delaySeconds}s`,
    ]),
  );
}

function renderValidation(patterns: ValidatedPattern[]): string {
  return table(
    [
      { header: "ID" }, { header: "Return", align: "right" }, { header: "Worst", align: "right" },
      { header: "+Folds", align: "right" }, { header: "MDD", align: "right" },
      { header: "Trades", align: "right" }, { header: "Net", align: "right" },
    ],
    patterns.map((item) => [
      item.pattern.id.slice(0, 8), percent(item.returnPct), percent(item.worstFoldReturnPct),
      percent(item.positiveFoldRatio), `${item.maxDrawdownPct.toFixed(1)}%`,
      String(item.tradeCount), usd(item.netPnlUsd),
    ]),
  );
}

function requireDataset(dataset: ResearchDataset): void {
  if (dataset.users.length === 0) throw new Error("No Fomo research data. Run fomo sync @handle first");
}

function optionalInteger(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  return positiveInteger(value, flag);
}

function optionString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function positiveInteger(value: string | undefined, flag: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${flag} must be a positive integer`);
  return number;
}

function optionalNumber(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${flag} must be a non-negative number`);
  return number;
}

function parseDate(value: string, endOfDay: boolean): number {
  const suffix = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : "";
  const timestamp = Date.parse(value + suffix);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid date: ${value}`);
  return timestamp;
}

function usd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function finite(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "inf";
}

function duration(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

function jsonNumber(_key: string, value: unknown): unknown {
  return typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
}

function researchDisclaimer(): void {
  console.log(dim("\n  Research candidates only. Results depend on data coverage and execution assumptions;"));
  console.log(dim("  historical performance does not guarantee future profitability.\n"));
}
