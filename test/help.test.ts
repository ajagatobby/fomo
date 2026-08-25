import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fomoHelp, mainHelp } from "../src/help.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function cli(...args: string[]): string {
  return execFileSync(process.execPath, ["src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

test("global help groups commands and points to focused help", () => {
  const output = mainHelp();
  assert.match(output, /MONITOR/);
  assert.match(output, /EXPLORE/);
  assert.match(output, /RESEARCH/);
  assert.match(output, /fomo help <command>/);
});

test("focused help includes options, examples, and operational notes", () => {
  const output = fomoHelp("watch");
  assert.match(output, /--webhook <url>/);
  assert.match(output, /FOMO_WEBHOOK_SECRET/);
  assert.match(output, /trading_activity WebSocket topic/);
  assert.match(output, /X-Fomo-Signature/);
});

test("help aliases resolve to their canonical command", () => {
  assert.match(fomoHelp("leaderboards"), /fomo leaderboard/);
  assert.match(fomoHelp("db"), /fomo status/);
  assert.match(fomoHelp("user"), /fomo profile/);
});

test("CLI routes direct and flag help without authentication", () => {
  assert.match(cli("help", "alerts"), /help · alerts/);
  assert.match(cli("user", "profile", "--help"), /help · profile/);
  assert.match(cli("leaderboards", "--help"), /help · leaderboard/);
  assert.match(cli("analyze", "clan", "--help"), /help · clan/);
  assert.match(cli("scout", "--help"), /help · scout/);
  assert.match(cli("signals", "--help"), /help · signals/);
});

test("unknown help topics report the available discovery command", () => {
  assert.throws(() => fomoHelp("missing"), /Run fomo help/);
});
