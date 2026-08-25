import { banner, bold, cyan, dim, gold, green } from "./ui/index.ts";

type HelpDetail = {
  summary: string;
  usage: string;
  options?: Array<[string, string]>;
  examples: string[];
  notes?: string[];
  environment?: Array<[string, string]>;
};

const COMMAND_GROUPS: Array<[string, Array<[string, string]>]> = [
  ["Monitor", [
    ["scout", "Discover and evaluate visible Fomo traders"],
    ["signals", "Research timely reliable-trader token flow"],
    ["alerts", "Read the signed-in account activity feed"],
    ["watch <@handle>", "Stream one followed profile to a webhook"],
    ["account", "Show the signed-in Fomo identity"],
  ]],
  ["Explore", [
    ["profile <@handle>", "Export a sanitized public profile"],
    ["leaderboard", "Show official or custom-window trader rankings"],
    ["wallets", "List wallets linked to ranked profiles"],
    ["emails", "Find addresses published in profile bios"],
    ["clans", "Show the official Fomo clan leaderboard"],
    ["clan <id | name>", "Inspect a clan, members, and top tokens"],
  ]],
  ["Research", [
    ["analyze <target>", "Sync and analyze a username or linked wallet"],
    ["sync <@handles...>", "Collect Fomo research data"],
    ["rank", "Rank locally stored traders"],
    ["show <@handle>", "Explain one stored trader"],
    ["patterns", "Screen the strategy grid"],
    ["validate", "Run walk-forward validation"],
  ]],
  ["System", [
    ["login", "Authenticate with Fomo"],
    ["status", "Inspect the local Fomo database"],
    ["help [command]", "Show overview or command help"],
  ]],
];

const COMMON_JSON: Array<[string, string]> = [["--json", "Print machine-readable output"]];
const DETAILS: Record<string, HelpDetail> = {
  login: detail("Authenticate with Fomo and save credentials in macOS Keychain.", "fomo login", [], ["fomo login"]),
  account: detail("Show the signed-in Fomo profile and login identity.", "fomo account [--json]", COMMON_JSON, ["fomo account --json"]),
  alerts: detail("Read personalized Fomo trading activity.", "fomo alerts [options]", [
    ["--limit <n>", "Fetch 1-100 alerts"], ["--last-id <id>", "Continue after an alert"], ...COMMON_JSON,
  ], ["fomo alerts --limit 25"]),
  watch: {
    summary: "Watch a followed profile through Fomo realtime activity with polling recovery.",
    usage: "fomo watch <@handle> --webhook <url> [options]",
    options: [["--webhook <url>", "HTTPS destination"], ["--interval <5s..60m>", "Recovery interval"], ...COMMON_JSON],
    environment: [["FOMO_WEBHOOK_URL", "Default destination"], ["FOMO_WEBHOOK_SECRET", "HMAC-SHA256 secret"]],
    examples: ["fomo watch @alice --webhook https://example.com/fomo"],
    notes: ["Realtime uses the trading_activity WebSocket topic.", "Signed requests include X-Fomo-Signature."],
  },
  scout: detail("Discover, refresh, and evaluate visible Fomo traders.", "fomo scout [options]", [
    ["--max-traders <n>", "Discovery cap"], ["--max-pages <n>", "History page cap"],
    ["--cached", "Use local data only"], ["--resume", "Skip completed traders"], ...COMMON_JSON,
  ], ["fomo scout --max-traders 200 --max-pages 10"]),
  signals: detail("Research current reliable-trader token flow with market safety gates.", "fomo signals [options]", [
    ["--window <duration>", "Current-flow window"], ["--min-traders <n>", "Independent buyers required"],
    ["--chain <name>", "solana, ethereum, base, or bsc"], ...COMMON_JSON,
  ], ["fomo signals --window 15m"]),
  profile: detail("Export a sanitized public Fomo profile.", "fomo profile <@handle> --json", COMMON_JSON, ["fomo profile @alice --json"]),
  leaderboard: detail("Rank Fomo traders over an official or custom window.", "fomo leaderboard [options]", [
    ["--window <period>", "24h, 7d, 30d, all, or a duration"], ["--top <n>", "Rows to show"], ...COMMON_JSON,
  ], ["fomo leaderboard --window 24h --top 25"]),
  wallets: detail("List wallets linked to ranked Fomo profiles.", "fomo wallets [options]", [
    ["--window <period>", "Leaderboard window"], ["--top <n>", "Profiles to inspect"], ...COMMON_JSON,
  ], ["fomo wallets --window 7d --top 50"]),
  emails: detail("Find email addresses explicitly published in profile bios.", "fomo emails [options]", [
    ["--window <period>", "Leaderboard window"], ["--top <n>", "Profiles to inspect"], ...COMMON_JSON,
  ], ["fomo emails --window 24h --top 100"]),
  clans: detail("Show Fomo's official clan leaderboard.", "fomo clans [options]", [
    ["--window <period>", "24h, 7d, or 30d"], ["--top <n>", "Rows to show"], ...COMMON_JSON,
  ], ["fomo clans --window 30d"]),
  clan: detail("Inspect one Fomo clan.", "fomo clan <id | name> [options]", [
    ["--window <period>", "24h, 7d, or 30d"], ["--top <n>", "Members and tokens to show"], ...COMMON_JSON,
  ], ["fomo clan \"Wizards\" --window 7d"]),
  analyze: detail("Sync and analyze a Fomo username or linked wallet.", "fomo analyze <target> [options]", [
    ["--days <n>", "Research lookback"], ["--max-pages <n>", "History page cap"], ["--cached", "Use local data only"], ...COMMON_JSON,
  ], ["fomo analyze @alice --days 90"]),
  sync: detail("Collect Fomo profiles, swaps, balances, and trades.", "fomo sync <@handles...> [options]", [
    ["--file <path>", "Read additional handles"], ["--max-pages <n>", "History page cap"], ...COMMON_JSON,
  ], ["fomo sync @alice @bob --max-pages 10"]),
  rank: detail("Rank locally stored Fomo traders.", "fomo rank [options]", [["--days <n>", "Research lookback"], ["--top <n>", "Rows to show"], ...COMMON_JSON], ["fomo rank --days 90"]),
  show: detail("Explain one locally measured Fomo trader.", "fomo show <@handle> [options]", [["--days <n>", "Research lookback"], ...COMMON_JSON], ["fomo show @alice"]),
  patterns: detail("Screen strategy patterns over stored Fomo observations.", "fomo patterns [options]", [["--config <path>", "Pattern grid"], ["--top <n>", "Rows to show"], ...COMMON_JSON], ["fomo patterns --days 90"]),
  validate: detail("Run observed-time walk-forward validation.", "fomo validate [options]", [["--folds <n>", "Validation folds"], ["--test-days <n>", "Days per fold"], ...COMMON_JSON], ["fomo validate --folds 4 --test-days 14"]),
  status: detail("Show local Fomo database counts and sync status.", "fomo status [--json]", COMMON_JSON, ["fomo status"]),
};

const HELP_ALIASES: Record<string, string> = { db: "status", leaderboards: "leaderboard", user: "profile" };

export function mainHelp(): string {
  return overviewHelp();
}

export function fomoHelp(topic?: string): string {
  if (!topic) return overviewHelp();
  const normalized = HELP_ALIASES[topic.toLowerCase()] ?? topic.toLowerCase();
  const value = DETAILS[normalized];
  if (!value) throw new Error(`Unknown help topic: ${topic}. Run fomo help for available commands.`);
  return detailHelp(normalized, value);
}

function overviewHelp(): string {
  const output = [
    banner("Fomo trader intelligence"),
    `  ${dim("Read-only intelligence built exclusively around Fomo data.")}`,
    heading("Usage"), `  ${cyan("fomo <command> [options]")}`, `  ${cyan("fomo help <command>")}`,
  ];
  for (const [group, commands] of COMMAND_GROUPS) output.push(heading(group), ...rows(commands));
  output.push(
    heading("Quick start"), example("fomo login"), example("fomo scout --max-traders 200"),
    example("fomo signals --window 15m"), example("fomo analyze @alice --days 90"),
    heading("Environment"), ...rows([["FOMO_WEBHOOK_URL", "Default watch webhook"], ["FOMO_WEBHOOK_SECRET", "Webhook signing secret"], ["NO_COLOR", "Disable ANSI styling"]]),
    `\n  ${green("Read-only by design.")} ${dim("No trades or Fomo account mutations.")}`,
    `  ${dim("Run fomo help <command> for focused help.")}\n`,
  );
  return output.join("\n");
}

function detailHelp(name: string, value: HelpDetail): string {
  const output = [banner(`help · ${name}`), `  ${value.summary}`, heading("Usage"), `  ${cyan(value.usage)}`];
  if (value.options?.length) output.push(heading("Options"), ...rows(value.options));
  if (value.environment?.length) output.push(heading("Environment"), ...rows(value.environment));
  output.push(heading("Examples"), ...value.examples.map(example));
  if (value.notes?.length) output.push(heading("Notes"), ...value.notes.map((note) => `  ${dim("-")} ${note}`));
  return output.join("\n");
}

function detail(summary: string, usage: string, options: Array<[string, string]>, examples: string[]): HelpDetail {
  return { summary, usage, options, examples };
}

function heading(label: string): string {
  return `\n${gold(bold(label.toUpperCase()))}`;
}

function rows(items: Array<[string, string]>): string[] {
  return items.map(([name, description]) => `  ${cyan(name.padEnd(30))}${description}`);
}

function example(command: string): string {
  return `  ${dim("$")} ${command}`;
}
