# Fomo

Fomo is a read-only command-line tool for researching traders on [Fomo](https://fomo.family).

It can help you:

- View Fomo trader and clan leaderboards.
- Inspect public profiles and linked wallets.
- Save trader activity to a local database.
- Compare traders using risk-aware measurements.
- Research recent token flow from reliable traders.
- Test strategy ideas against observed historical data.
- Watch a followed trader and send new activity to a webhook.

Fomo does not place trades, follow users, join clans, change account settings, or modify alerts. Research output is not financial advice and does not guarantee future results.

## Requirements

Before you start, make sure you have:

- A macOS computer.
- A Fomo account.
- Google Chrome installed in the normal Applications folder.
- Node.js 23 or newer.
- npm, which is included with Node.js.

Check your Node.js and npm versions:

```bash
node --version
npm --version
```

The Node.js version should start with `v23` or a larger number.

## Install

Clone the repository and enter its directory:

```bash
git clone https://github.com/ajagatobby/fomo.git
cd fomo
```

Install the dependencies:

```bash
npm install
```

Create the global `fomo` command:

```bash
npm link
```

Confirm that it works:

```bash
fomo --help
```

If you do not want to use `npm link`, run commands from the repository with this form:

```bash
npm run fomo -- --help
npm run fomo -- leaderboard --window 24h
```

## First Login

Run:

```bash
fomo login
```

A dedicated Chrome window will open.

1. Sign in to Fomo normally.
2. Wait for the terminal to print `Authenticated session captured.`
3. Close the Chrome window after the command finishes.

Fomo stores refreshable session credentials in macOS Keychain. It never asks for or stores your Fomo password.

Confirm the signed-in account:

```bash
fomo account
```

If a later command says your session is missing, expired, or rejected, run `fomo login` again.

## Five-Minute Start

After logging in, try these commands in order.

View the current trader leaderboard:

```bash
fomo leaderboard --window 24h --top 10
```

Inspect a trader by replacing `alice` with a real Fomo handle:

```bash
fomo profile @alice --json
```

Collect and analyze that trader's activity:

```bash
fomo analyze @alice --days 90
```

Check what is now stored locally:

```bash
fomo status
```

Ask for help at any time:

```bash
fomo --help
fomo help analyze
fomo help leaderboard
```

## Important Ideas

### Handles

A handle is a Fomo username. Both forms below work:

```bash
fomo analyze @alice
fomo analyze alice
```

Using `@` makes it clearer that the value is a username.

### Time Windows

Many commands accept `--window` or `--days`.

Common leaderboard windows are:

```text
24h
7d
30d
all
```

Some trader commands also accept custom durations such as `48h` or `14d`.

Example:

```bash
fomo leaderboard --window 7d --top 25
fomo analyze @alice --days 180
```

### Page Limits

Commands that collect history may accept `--max-pages`. A larger value can collect more history, but it also takes longer and makes more Fomo requests.

Start small:

```bash
fomo analyze @alice --max-pages 10
```

Increase the limit only when you need more history:

```bash
fomo analyze @alice --max-pages 50
```

### Cached Mode

`--cached` uses only data already stored on your computer. It does not refresh data from Fomo.

```bash
fomo analyze @alice --cached
fomo scout --cached
```

Cached mode is useful for fast repeated research and offline inspection.

### JSON Output

Most reporting commands support `--json`.

```bash
fomo account --json
fomo leaderboard --window 24h --json
fomo analyze @alice --json
```

Save output to a file:

```bash
fomo analyze @alice --json > alice-analysis.json
```

Filter output with `jq`:

```bash
fomo status --json | jq
fomo leaderboard --json | jq '.leaderboard[0:5]'
```

## Command Guide

### `fomo login`

Opens Chrome and captures a refreshable Fomo session.

```bash
fomo login
```

Run this first and repeat it whenever authentication expires.

### `fomo account`

Shows the signed-in Fomo profile and login identity.

```bash
fomo account
fomo account --json
```

### `fomo alerts`

Reads the signed-in account's personalized activity feed.

```bash
fomo alerts
fomo alerts --limit 25
fomo alerts --last-id <alert-id> --json
```

Use `--last-id` to continue from a previous page of alerts.

### `fomo leaderboard`

Shows ranked Fomo traders for a time window.

```bash
fomo leaderboard
fomo leaderboard --window 24h --top 25
fomo leaderboard --window 7d --top 100
fomo leaderboard --window all --json
```

### `fomo profile`

Exports a sanitized public profile.

```bash
fomo profile @alice --json
```

Private profiles are not exported. Secret-like account fields are removed from the response.

### `fomo wallets`

Lists wallets linked to profiles in a Fomo ranking.

```bash
fomo wallets --window 24h --top 25
fomo wallets --window 7d --top 50 --json
```

This reads addresses exposed by Fomo. It does not perform a full blockchain wallet scan.

### `fomo emails`

Finds email addresses that traders explicitly published in public profile bios.

```bash
fomo emails --window 24h --top 100
fomo emails --window 7d --top 100 --json
```

It does not access private account email addresses.

### `fomo clans`

Shows Fomo's clan leaderboard.

```bash
fomo clans
fomo clans --window 7d --top 25
fomo clans --window 30d --json
```

Clan windows are `24h`, `7d`, or `30d`.

### `fomo clan`

Shows one clan, its members, and its top tokens.

```bash
fomo clan "Wizards"
fomo clan "Wizards" --window 7d --top 20
fomo clan <clan-id> --json
```

Use the clan ID when multiple clans have similar names.

### `fomo sync`

Collects profiles, swaps, balances, and trades into the local database.

```bash
fomo sync @alice
fomo sync @alice @bob @carol --max-pages 20
fomo sync --file handles.txt
fomo sync @alice --json
```

A plain-text handle file can look like this:

```text
@alice
@bob
@carol
```

Syncing regularly gives later research commands more local data.

### `fomo analyze`

Refreshes and analyzes one Fomo username or a known linked wallet.

```bash
fomo analyze @alice
fomo analyze @alice --days 90
fomo analyze @alice --max-pages 30
fomo analyze @alice --cached --json
```

The report includes measurements such as realized performance, coverage, win rate, profit factor, drawdown, holding period, and sample reliability.

A linked wallet can be analyzed after its owner has been discovered through a leaderboard, clan, profile, or earlier sync:

```bash
fomo analyze 0x1111111111111111111111111111111111111111
```

Fomo does not provide a global wallet-owner search, so an unknown wallet may not resolve. In that case, analyze the owner's username first.

### `fomo rank`

Ranks traders already stored in the local database.

```bash
fomo rank
fomo rank --days 90 --top 25
fomo rank --days 180 --json
```

Run `sync`, `analyze`, or `scout` first so there is enough local activity to compare.

### `fomo show`

Explains the locally measured results for one stored trader.

```bash
fomo show @alice
fomo show @alice --days 90 --json
```

Unlike a normal analysis refresh, this command uses stored research data.

### `fomo scout`

Discovers visible Fomo traders, refreshes their history, and evaluates the research universe.

Start with a small run:

```bash
fomo scout --max-traders 25 --max-pages 5
```

Run a larger collection later:

```bash
fomo scout --max-traders 200 --max-pages 10
```

Resume an interrupted collection:

```bash
fomo scout --resume --max-traders 200 --max-pages 10
```

Analyze only the local dataset:

```bash
fomo scout --cached
fomo scout --cached --json > scout-report.json
```

Large scout runs can take a long time and make many read-only requests. Increase limits gradually.

### `fomo signals`

Researches recent token flow from historically reliable traders.

```bash
fomo signals
fomo signals --window 15m
fomo signals --window 10m --chain base
fomo signals --min-traders 3 --json
```

Supported chain names are `solana`, `ethereum`, `base`, and `bsc`.

A research signal is not a buy instruction. Contract safety, sellability, taxes, authorities, holder concentration, liquidity locks, and other risks may still be unknown.

### `fomo patterns`

Screens strategy assumptions against locally stored observations.

```bash
fomo patterns --days 90
fomo patterns --config examples/pattern-grid.json
fomo patterns --json > patterns.json
```

Pattern screening is exploratory. A strong historical pattern may not work in future markets.

### `fomo validate`

Runs walk-forward validation over stored observations.

```bash
fomo validate
fomo validate --folds 4 --test-days 14
fomo validate --config examples/pattern-grid.json --json
```

Validation needs observations collected over time. A new database may not contain enough causal history yet.

### `fomo watch`

Watches one followed Fomo profile and sends new activity to a webhook.

```bash
fomo watch @alice --webhook https://example.com/webhooks/fomo
```

Set the destination once with an environment variable:

```bash
export FOMO_WEBHOOK_URL="https://example.com/webhooks/fomo"
fomo watch @alice
```

Sign webhook requests with a shared secret:

```bash
export FOMO_WEBHOOK_SECRET="replace-with-a-long-random-secret"
fomo watch @alice --webhook https://example.com/webhooks/fomo
```

Signed requests include these headers:

```text
X-Fomo-Event
X-Fomo-Delivery
X-Fomo-Timestamp
X-Fomo-Signature
```

The signature is an HMAC-SHA256 value calculated over:

```text
<timestamp>.<raw-request-body>
```

Your webhook should verify the signature, reject old timestamps, and use `X-Fomo-Delivery` to ignore duplicate events.

The signed-in Fomo account must already follow the watched profile and have its trader alerts enabled.

### `fomo status`

Shows the local database location, record counts, and latest sync state.

```bash
fomo status
fomo status --json
```

## Suggested Workflows

### Research One Trader

```bash
fomo login
fomo analyze @alice --days 90 --max-pages 20
fomo show @alice
```

### Compare Several Traders

```bash
fomo sync @alice @bob @carol --max-pages 20
fomo rank --days 90 --top 10
```

### Build a Larger Research Dataset

```bash
fomo scout --max-traders 100 --max-pages 10
fomo status
fomo rank --days 180 --top 25
fomo patterns --days 180
fomo validate --folds 4 --test-days 14
```

### Inspect Live Fomo Activity

```bash
fomo alerts --limit 25
fomo leaderboard --window 24h --top 25
fomo signals --window 15m
```

## Local Data And Credentials

Fomo stores local files in:

```text
~/.fomo/
```

The main locations are:

| Location | Purpose |
| --- | --- |
| `~/.fomo/fomo.sqlite` | Profiles, swaps, normalized account identity, sync history, and research data |
| `~/.fomo/browser-profile` | Dedicated Chrome profile used for interactive Fomo login |
| macOS Keychain service `com.fomo.cli` | Refreshable Fomo and Privy session credentials |

Treat these locations as private account data. Do not upload them or commit them to Git.

## Troubleshooting

### `fomo: command not found`

Run this from the repository:

```bash
npm install
npm link
```

Then open a new terminal and try:

```bash
fomo --help
```

You can always use the local form instead:

```bash
npm run fomo -- --help
```

### Login Opens No Chrome Window

Confirm that Google Chrome is installed in `/Applications`. Chrome is required only for `fomo login`.

### Session Missing Or Expired

Authenticate again:

```bash
fomo login
fomo account
```

### A Username Is Not Found

Use the exact Fomo handle rather than the display name:

```bash
fomo profile @exactHandle --json
```

### A Wallet Is Not Found

First collect likely owners from Fomo:

```bash
fomo leaderboard --window 24h --top 100
fomo leaderboard --window 7d --top 100
fomo leaderboard --window 30d --top 100
```

Then retry the wallet. If it still cannot be resolved, use the owner's Fomo username.

### There Is Not Enough Local Data

Collect more history:

```bash
fomo sync @alice @bob @carol --max-pages 20
fomo scout --max-traders 50 --max-pages 10
fomo status
```

### Output Has Color Codes

Disable terminal colors for scripts or files:

```bash
NO_COLOR=1 fomo leaderboard --window 24h
```

### See All Options For A Command

```bash
fomo help <command>
```

For example:

```bash
fomo help scout
fomo help signals
fomo help watch
```

## Development

Install dependencies:

```bash
npm install
```

Run the CLI directly:

```bash
npm run fomo -- --help
```

Run all tests:

```bash
npm test
```

Run TypeScript checks:

```bash
npm run typecheck
```

Both checks should pass before committing code.

## Safety Notes

- The CLI is read-only, but it still handles authenticated account data.
- Never share your macOS Keychain entries or `~/.fomo/browser-profile` directory.
- Never commit `.env`, database files, browser profiles, or JSON output containing personal data.
- Start large collection commands with small limits.
- Respect Fomo's terms, privacy controls, and API limits.
- Treat every ranking, signal, pattern, and validation result as research rather than a trade instruction.
