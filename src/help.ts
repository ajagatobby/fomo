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
    ["hot", "Find tokens several ranked traders are buying right now"],
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
    ["analyze <target>", "Fetch and analyze a username or visible leaderboard wallet"],
    ["scout", "Discover and evaluate visible Fomo traders"],
  ]],
  ["System", [
    ["login", "Authenticate with Fomo"],
    ["help [command]", "Show overview or command help"],
  ]],
];

const COMMON_JSON: Array<[string, string]> = [["--json", "Print machine-readable output"]];
const DETAILS: Record<string, HelpDetail> = {
  login: detail("Authenticate in an ephemeral browser and save credentials in macOS Keychain.", "fomo login", [], ["fomo login"]),
  account: detail("Fetch the signed-in Fomo profile and login identity.", "fomo account [--json]", COMMON_JSON, ["fomo account --json"]),
  alerts: detail("Fetch personalized Fomo trading activity.", "fomo alerts [options]", [
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
  hot: {
    summary: "Scan ranked Fomo traders for tokens several of them are buying inside one short window.",
    usage: "fomo hot [options]",
    options: [
      ["--window <30s..24h>", "Lookback, such as 5m or 30m"],
      ["--min-traders <n>", "Distinct buyers required to report a token"],
      ["--top <n>", "Rows to show"],
      ["--pool <1-100>", "Traders per leaderboard window"],
      ["--swaps <1-100>", "Recent swaps read per trader"],
      ["--clans", "Widen the pool with top clan members"],
      ["--max-clans <n>", "Clans inspected when --clans is set"],
      ...COMMON_JSON,
    ],
    examples: [
      "fomo hot",
      "fomo hot --window 30m --min-traders 4",
      "fomo hot --window 15m --clans --json",
    ],
    notes: [
      "Buys are swaps out of a stablecoin or wrapped native asset into a token.",
      "Only Fomo-reported swaps are visible; off-platform accumulation is not.",
      "Crowding describes what already happened and is not an entry signal.",
    ],
  },
  scout: detail("Discover, fetch, and retrospectively evaluate visible Fomo traders in memory.", "fomo scout [options]", [
    ["--max-traders <n>", "Discovery cap"], ["--max-pages <n>", "History page cap"],
    ["--days <n>", "Research lookback"], ...COMMON_JSON,
  ], ["fomo scout --max-traders 200 --max-pages 10"]),
  profile: detail("Fetch a sanitized public Fomo profile.", "fomo profile <@handle> --json", COMMON_JSON, ["fomo profile @alice --json"]),
  leaderboard: detail("Fetch Fomo trader rankings for an official or custom window.", "fomo leaderboard [options]", [
    ["--window <period>", "24h, 7d, 30d, all, or a duration"], ["--top <n>", "Rows to show"], ...COMMON_JSON,
  ], ["fomo leaderboard --window 24h --top 25"]),
  wallets: detail("Fetch wallets linked to ranked Fomo profiles.", "fomo wallets [options]", [
    ["--window <period>", "Leaderboard window"], ["--top <n>", "Profiles to inspect"], ...COMMON_JSON,
  ], ["fomo wallets --window 7d --top 50"]),
  emails: detail("Fetch email addresses explicitly published in profile bios.", "fomo emails [options]", [
    ["--window <period>", "Leaderboard window"], ["--top <n>", "Profiles to inspect"], ...COMMON_JSON,
  ], ["fomo emails --window 24h --top 100"]),
  clans: detail("Fetch Fomo's official clan leaderboard.", "fomo clans [options]", [
    ["--window <period>", "24h, 7d, or 30d"], ["--top <n>", "Rows to show"], ...COMMON_JSON,
  ], ["fomo clans --window 30d"]),
  clan: detail("Fetch one Fomo clan.", "fomo clan <id | name> [options]", [
    ["--window <period>", "24h, 7d, or 30d"], ["--top <n>", "Members and tokens to show"], ...COMMON_JSON,
  ], ["fomo clan \"Wizards\" --window 7d"]),
  analyze: detail("Fetch fresh Fomo history and analyze it in memory.", "fomo analyze <target> [options]", [
    ["--days <n>", "Research lookback"], ["--max-pages <n>", "History page cap"], ...COMMON_JSON,
  ], ["fomo analyze @alice --days 90"]),
};

const HELP_ALIASES: Record<string, string> = { leaderboards: "leaderboard", user: "profile" };

export function mainHelp(): string { return overviewHelp(); }

export function fomoHelp(topic?: string): string {
  if (!topic) return overviewHelp();
  const normalized = HELP_ALIASES[topic.toLowerCase()] ?? topic.toLowerCase();
  const value = DETAILS[normalized];
  if (!value) throw new Error(`Unknown help topic: ${topic}. Run fomo help for available commands.`);
  return detailHelp(normalized, value);
}

function overviewHelp(): string {
  const output = [
    banner("Fomo live trader intelligence"),
    `  ${dim("Read-only Fomo data fetched fresh for each invocation.")}`,
    heading("Usage"), `  ${cyan("fomo <command> [options]")}`, `  ${cyan("fomo help <command>")}`,
  ];
  for (const [group, commands] of COMMAND_GROUPS) output.push(heading(group), ...rows(commands));
  output.push(
    heading("Quick start"), example("fomo login"), example("fomo leaderboard --window 24h"),
    example("fomo analyze @alice --days 90"), example("fomo scout --max-traders 25"),
    heading("Environment"), ...rows([["FOMO_WEBHOOK_URL", "Default watch webhook"], ["FOMO_WEBHOOK_SECRET", "Webhook signing secret"], ["NO_COLOR", "Disable ANSI styling"]]),
    `\n  ${green("Read-only by design.")} ${dim("Only Keychain credentials persist; research data is discarded on exit.")}`,
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

function heading(label: string): string { return `\n${gold(bold(label.toUpperCase()))}`; }
function rows(items: Array<[string, string]>): string[] { return items.map(([name, description]) => `  ${cyan(name.padEnd(30))}${description}`); }
function example(command: string): string { return `  ${dim("$")} ${command}`; }
