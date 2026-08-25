#!/usr/bin/env node

import { runFomo } from "./commands/fomo.ts";
import { mainHelp } from "./help.ts";

const FOMO_COMMANDS = new Set([
  "account",
  "alerts",
  "watch",
  "scout",
  "signals",
  "analyze",
  "profile",
  "user",
  "wallets",
  "emails",
  "leaderboard",
  "leaderboards",
  "clans",
  "clan",
  "sync",
  "rank",
  "show",
  "patterns",
  "validate",
  "status",
  "db",
  "login",
]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "-h" || command === "--help") {
    console.log(mainHelp());
    return;
  }
  if (command === "help") {
    await runFomo(["help", ...argv.slice(1)]);
    return;
  }
  if (FOMO_COMMANDS.has(command)) {
    await runFomo(argv);
    return;
  }
  throw new Error(`Unknown command: ${command}. Run fomo --help.`);
}

main().then(
  async () => {
    await flushOutput();
    process.exit(0);
  },
  async (error: unknown) => {
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    await flushOutput();
    process.exit(1);
  },
);

async function flushOutput(): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write("", "utf8", () => resolve())),
    new Promise<void>((resolve) => process.stderr.write("", "utf8", () => resolve())),
  ]);
}
