import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

test("convergence help documents its window and trader floor", () => {
  const output = fomoHelp("hot");
  assert.match(output, /--window <30s\.\.24h>/);
  assert.match(output, /--min-traders <n>/);
  assert.match(output, /not an entry signal/);
});

test("help aliases resolve to their canonical command", () => {
  assert.match(fomoHelp("leaderboards"), /fomo leaderboard/);
  assert.match(fomoHelp("user"), /fomo profile/);
});

test("CLI routes direct and flag help without authentication", () => {
  assert.match(cli("help", "alerts"), /help · alerts/);
  assert.match(cli("user", "profile", "--help"), /help · profile/);
  assert.match(cli("leaderboards", "--help"), /help · leaderboard/);
  assert.match(cli("analyze", "clan", "--help"), /help · clan/);
  assert.match(cli("scout", "--help"), /help · scout/);
  assert.match(cli("hot", "--help"), /help · hot/);
  assert.match(cli("analyze", "--help"), /help · analyze/);
});

test("unknown help topics report the available discovery command", () => {
  assert.throws(() => fomoHelp("missing"), /Run fomo help/);
});

test("removed local-data commands are rejected", () => {
  for (const command of ["signals", "sync", "rank", "show", "patterns", "validate", "status", "db"]) {
    const result = spawnSync(process.execPath, ["src/cli.ts", command], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /Unknown command/, command);
  }
});
