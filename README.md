# Wallet Radar

Continuous wallet monitoring for Solana. Point-in-time wallet intelligence answers
"what does this wallet look like right now?". Wallet Radar answers **"what changed,
and does it matter?"** — for a watchlist of wallets, continuously.

Built for the Solana hackathon (fall 2026, Colosseum).

## Quick start

```bash
npm install && npm run build
export HELIUS_API_KEY=...
node dist/src/cli.js scan <wallet>   # one-shot: fetch + baseline + rules + risk score
```

`npm run radar` is an alias for the CLI (`npm run radar -- scan <wallet>`).

## How it works

```
watchlist ──> collector (Helius Enhanced Transactions, read-only)
                │
                ▼
             baseline  (per-wallet behavioral profile: venues, programs,
                │       median swap size, activity pattern — SQLite)
                ▼
             analyzer  (deterministic anomaly rules, no LLM)
                │
                ▼
             digest    (one LLM call per anomaly batch, template fallback)
                │
                ▼
             alerts    (CLI, Telegram; webhook next)
```

### Anomaly rules (v1)

| Rule | Meaning |
| --- | --- |
| `DORMANT_ACTIVE` | Wallet reactivated after N days of silence |
| `ACTIVITY_BURST` | K+ transactions inside a short window vs. the wallet's normal rate |
| `NEW_VENUE` | First swap on a DEX/protocol not seen in the wallet's history |
| `LARGE_SWAP` | Swap size > N× the wallet's own median swap size — compared **in USD** (see below) when prices are available, otherwise major-only raw quantities |
| `CONCENTRATION` | Repeated swaps into the same token in a short window |
| `NEW_PROTOCOL` | First interaction with an unseen program |

### USD normalization

Raw token quantities are not comparable (1 SOL vs 50M BONK). Wallet Radar
normalizes swap sizes to USD with the Jupiter Price API (read-only, keyless):

- `USDC`/`USDT` legs are 1:1 with USD — no price feed needed.
- Any other leg is valued with its Jupiter USD price.
- The baseline tracks a running **median swap size in USD** across all mints,
  so `LARGE_SWAP` works for any token, not just the majors.
- If the price feed is unavailable (or a swap can't be priced), the rule falls
  back to major-only raw quantities — a scan never fails because of prices.

Every anomaly carries structured evidence (tx signatures, numbers) plus a
one-sentence human-readable description, so both agents and humans can verify it.

## MCP server

Wallet Radar ships as an MCP server (`src/mcp.ts`), so any agent (Claude Code,
Cursor, solana-agent-kit) can plug in one-shot risk checks with a single line of
config. Three tools:

| Tool | Purpose |
| --- | --- |
| `radar_scan` | Live Helius fetch + baseline + rules → risk score (needs `HELIUS_API_KEY`) |
| `radar_trust` | Pre-flight check for agent payments: risk + liquidity → `safe`/`hold`/`unknown` (needs `HELIUS_API_KEY`) |
| `radar_analyze` | Run the rules over a transactions fixture you already have (no network) |
| `radar_selftest` | Offline smoke test, no keys |

```bash
npm run build
npm run mcp     # starts the stdio MCP server
```

Example client config (`.mcp.json` / Claude Code / Cursor):

```json
{
  "mcpServers": {
    "wallet-radar": {
      "command": "node",
      "args": ["<path-to-wallet-radar>/dist/src/mcp.js"],
      "env": { "HELIUS_API_KEY": "..." }
    }
  }
}
```

## One-shot checks (stateless)

```bash
node dist/src/cli.js scan <wallet>            # live fetch + baseline + rules + risk score (JSON)
node dist/src/cli.js analyze <wallet> tx.json # rules over a saved Enhanced-tx file (offline, no keys)
node dist/src/cli.js selftest                 # offline smoke test, no keys
node dist/src/cli.js prices <mint>...         # Jupiter Price API lookup
```

`scan` is the fastest way to try Radar on any wallet: one Helius fetch,
deterministic baseline, risk score, digest — no watchlist, no state.

### Trust check (pre-flight for agent payments)

`trust` answers the question an agent asks before paying a counterparty:
**"is it safe to deal with this wallet right now?"** It combines the
behavioral risk score (6 rules over the recent window) with payment capacity
(SOL + USDC/USDT liquidity in USD) into one deterministic verdict:

```bash
node dist/src/cli.js trust <wallet>                        # defaults: max-risk 30, min-liquidity $50, window 7d
node dist/src/cli.js trust <wallet> --max-risk 50 --min-liquidity 100 --json
node dist/src/cli.js trust --watchlist                     # check the whole watchlist -> ranked shortlist
node dist/src/cli.js trust --watchlist --json              # { shortlist, results } as JSON
```

Verdicts: `safe` (both thresholds met), `hold` (data available, threshold
missed), `unknown` (no data to decide — conservative). The JSON carries
machine-readable reasons with exact numbers, so any agent can recompute the
verdict from the same evidence. No LLM in the verdict path.

`--watchlist` runs the check over every watched wallet and returns a ranked
shortlist: `safe` wallets first (lowest risk, then highest liquidity), then
`hold`, then `unknown` — "which of these can I pay right now, and in what
order?". Deterministic and pure over the per-wallet results. Full design:
[`docs/trust-spec.md`](docs/trust-spec.md).

## Watchlist (continuous monitoring)

The CLI keeps a watchlist in SQLite (default `~/.wallet-radar/radar.db`,
override with `RADAR_DB`):

```bash
node dist/src/cli.js add <wallet>      # add a wallet
node dist/src/cli.js watch             # poll every 5 min; alerts via Telegram or console
node dist/src/cli.js watch --once      # single iteration (cron-friendly)
node dist/src/cli.js report <wallet>   # baseline + recent anomalies + risk score
node dist/src/cli.js alerts [limit]    # recent anomalies across the watchlist
node dist/src/cli.js remove <wallet>   # drop a wallet
```

### Replay (deterministic historical run)

Replay a past window of a real wallet through the live pipeline — build the
baseline from everything before `--since`, then run the rules over the activity
inside the window. Deterministic (the window is frozen in the past), no state,
no polling. Useful for demos and for auditing "what would Radar have flagged
back then?":

```bash
node dist/src/cli.js replay <wallet> --since 2026-03-11T07:36:15Z \
  --until 2026-08-31T08:00:00Z --alert
```

- `--since` (required) / `--until` — window bounds (ISO 8601 or unix seconds);
  history before `--since` feeds the baseline, activity inside the window is
  scored.
- `--pages N` — history depth (default 20 × 100 tx).
- `--no-prices` — skip Jupiter prices (major-only sizing).
- `--llm` — use the LLM digest for the report/alert (else deterministic template).
- `--alert` — deliver through the configured sink (Telegram or console).
- `--json` — machine-readable result on stdout.

First-seed semantics: when a wallet is added, its recent history is silently
folded into the baseline (no alerts for old activity). After that, only unseen
signatures are processed — signature dedupe keeps the loop correct even when
chain timestamps collide within one second.

### Optional LLM digest

Alerts get a one-sentence natural-language summary when an LLM is configured —
any OpenAI-compatible `/chat/completions` endpoint (OpenAI, OpenRouter, Groq,
local Ollama...). Without a key, or on any failure/timeout, the deterministic
template digest is used — alerting never blocks on the LLM:

- `RADAR_LLM_KEY` — enables the LLM digest (API key)
- `RADAR_LLM_BASE` — endpoint base, default `https://api.openai.com/v1`
- `RADAR_LLM_MODEL` — model, default `gpt-4o-mini`
- `RADAR_LLM_TIMEOUT_MS` — request timeout, default `15000`
- `RADAR_LLM_OPTIONS` — extra JSON request fields, e.g. Ollama `{"num_thread": 8}`
- `RADAR_LLM_PATH` — path appended to the base, default `chat/completions`
  (Ollama's native endpoint: `http://127.0.0.1:11434/api` + `chat`)

## Status

MVP complete: collector (Helius), baseline (incl. USD median), analyzer (6
rules, USD-normalized, unit-tested), template digest, optional LLM digest
(any OpenAI-compatible endpoint, template fallback), watch loop with SQLite
persistence (`node:sqlite`, zero deps), Telegram/console alerts, replay
(deterministic historical window), trust check (risk + liquidity →
safe/hold/unknown pre-flight verdict for agent payments), MCP server
(stdio). Webhook alerts and the continuous trust-score stretch remain.

## Develop

```bash
npm install
npm run build
npm test          # node:test, no framework
node dist/src/cli.js selftest
node dist/src/cli.js prices So11111111111111111111111111111111111111112  # Jupiter Price API
node dist/src/cli.js add <wallet> && node dist/src/cli.js watch --once   # continuous pipeline
```

## Requirements

- Node 22.13+ (uses the built-in `node:sqlite`, no deps)
- `HELIUS_API_KEY` env var (Enhanced Transactions API, read-only)
- Jupiter Price API (keyless by default, `lite-api.jup.ag`). Optional:
  - `JUPITER_API_KEY` — uses the higher-limit `api.jup.ag` endpoint
  - `JUPITER_PRICE_BASE` — overrides the price endpoint URL entirely
- Optional Telegram alerts: `TG_BOT_TOKEN` + `TG_CHAT_ID` (console fallback)

## License

MIT
