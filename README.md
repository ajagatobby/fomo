# Fomo

Fomo is a read-only command-line tool for fetching and researching current data from [Fomo](https://fomo.family).

Only refreshable session credentials in macOS Keychain persist between invocations. Profiles, leaderboards, swaps, research datasets, and reports are held in memory and discarded when each command exits. Fomo does not place trades or mutate your account.

On startup, the CLI removes the legacy `~/.fomo` database and browser profile created by older versions.

## Requirements

- macOS
- A Fomo account
- Google Chrome
- Node.js 23 or newer
- npm

## Install

```bash
npm install
npm link
fomo --help
```

You can run the local CLI without linking it:

```bash
npm run fomo -- --help
```

## Login

```bash
fomo login
```

Login opens an ephemeral Chrome context. Sign in normally and wait for `Authenticated session captured.` The browser context and profile data are removed when the command exits; refreshable credentials are saved in macOS Keychain under service `com.fomo.cli`. The CLI never asks for or stores your password.

Confirm the active identity with a fresh request:

```bash
fomo account
```

Run `fomo login` again if credentials expire or are rejected.

## Commands

### Account And Activity

```bash
fomo account [--json]
fomo alerts [--limit 25] [--last-id <id>] [--json]
fomo watch <@handle> --webhook <https-url> [--interval 15s] [--json]
```

`watch` uses the Fomo `trading_activity` WebSocket topic with polling recovery. The signed-in account must already follow the target. Set `FOMO_WEBHOOK_URL` for a default destination and `FOMO_WEBHOOK_SECRET` for HMAC-SHA256 request signatures.

### Profiles And Leaderboards

```bash
fomo profile <@handle> --json
fomo user profile <@handle> --json
fomo leaderboard [--window 24h|7d|30d|all|<duration>] [--top 20] [--json]
fomo leaderboards [options]
fomo wallets [--window 24h] [--top 50] [--json]
fomo emails [--window 24h] [--top 100] [--json]
fomo clans [--window 24h|7d|30d] [--top 20] [--json]
fomo clan <id|name> [--window 24h|7d|30d] [--top 20] [--json]
```

`wallets` reads addresses exposed by current Fomo rankings; it is not a blockchain wallet scan. `emails` returns only addresses explicitly published in public profile bios.

### Analyze

```bash
fomo analyze <@handle> [--days 90] [--max-pages 20] [--json]
fomo analyze <visible-wallet> [options]
```

Every analysis fetches the profile and swap history from Fomo into a new in-memory `ResearchDataset`. Wallet lookup checks only profiles visible in the current `24h`, `7d`, `30d`, and `all` leaderboards. Fomo does not expose a global wallet-owner lookup.

The report reconstructs retrospective realized outcomes from the returned swap history. JSON output includes page count and truncation metadata. Fresh backfilled history does not establish when records were available to an observer and is not live execution-timing evidence.

### Scout

```bash
fomo scout --max-traders 25 --max-pages 5
fomo scout --max-traders 200 --max-pages 10 --json
```

Scout discovers the currently visible trader and clan universe, fetches each selected trader's history, evaluates it in memory, and discards the dataset on exit. It may screen retrospective pattern assumptions, but its output is exploratory historical research rather than evidence that a trade could have been copied at a particular time.

Large runs make many read-only requests. Increase `--max-traders`, `--max-pages`, concurrency, and request rate gradually.

## Output

Reporting commands support `--json` where shown:

```bash
fomo leaderboard --window 24h --json | jq '.leaderboard[0:5]'
fomo analyze @alice --json > alice-analysis.json
NO_COLOR=1 fomo leaderboard --window 7d
```

Redirected JSON files are user-created output and are not managed or retained by the application.

## Help

```bash
fomo --help
fomo help analyze
fomo help scout
fomo help watch
```

## Troubleshooting

If Chrome does not open, confirm Google Chrome is installed in `/Applications`. If authentication is missing or expired, run `fomo login`. If a wallet cannot be resolved, use its owner's Fomo handle or confirm that the wallet is visible in a current leaderboard.

## Development

```bash
npm install
npm test
npm run typecheck
```

Do not commit credentials or research output. Respect Fomo's terms, profile privacy controls, and API limits. Historical performance does not guarantee future results and is not financial advice.
