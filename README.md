# Wallet Radar

Continuous wallet monitoring for Solana — and a **gate before you copy**. Point-in-time
wallet intelligence answers "what does this wallet look like right now?"; Wallet Radar
answers **"what changed, and does it matter?"** — and, before you copy or pay an
unverified wallet, **"is it safe to trust it right now?"** Copy-trading tools find wallets
to copy; none of them safety-gate the wallet first. Radar does — deterministically, with a
per-rule explanation you can audit and a stamp on how fresh the data is.

Wallet Radar is in **early-access** (v0.1.x). It was prototyped at the Solana
hackathon (Colosseum, fall 2026) and is now available as a live HTTP / MCP /
x402 service. See [Status](#status), [Support](#support), and
[Security](SECURITY.md).

> **Security note:** The on-chain Transfer Hook and ZK Oracle modules are
> **experimental and unaudited**. They are not yet recommended for production
> use with significant funds. The core scan/trust/watch pipeline is stable.
> Thresholds are configurable per-deployment via `RADAR_THRESHOLD_SCALE` env var
> (see [Configuration](#configuration)).

## Live Demo

- **A2A trust gate:** [`https://radar.cbellory.xyz`](https://radar.cbellory.xyz) — `POST /a2a` (agent-to-agent), `GET /.well-known/agent.json` (A2A card)
- **x402 pay-per-call:** [`https://pay.cbellory.xyz`](https://pay.cbellory.xyz) — `POST /scan` (0.005 USDC), `POST /analyze` (0.001 USDC), `GET /selftest` (free)
- **Web dashboard:** [`https://radar.cbellory.xyz/dashboard`](https://radar.cbellory.xyz/dashboard) — on-chain ZK ledger viewer
- **Demo video:** [`docs/videos/wallet-radar-scope.mp4`](docs/videos/wallet-radar-scope.mp4)
- **GitHub Pages:** [`https://daniilmilintieiev-ux.github.io/wallet-radar/`](https://daniilmilintieiev-ux.github.io/wallet-radar/)

## Quick start

```bash
# 1. Install & build
npm install && npm run build

# 2. Verify with offline smoke test (no API keys required)
npm run radar -- selftest

# 3. Live scan a Solana wallet
export HELIUS_API_KEY=...
npm run radar -- scan <wallet>

# 4. Run tests
npm test
```

`npm run radar` is an alias for the CLI (`node dist/src/cli.js`).

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `HELIUS_API_KEY` | — | Required for live scans. Without it, `/selftest` and `/analyze` (offline) still work. |
| `RADAR_THRESHOLD_SCALE` | `1.0` | Multiplier on all detection thresholds. `<1.0` = stricter (harder to trigger), `>1.0` = more permissive. Example: `0.5` makes burst require 10 tx instead of 5. |
| `RADAR_WATCH` | `0` | Set to `1` to enable the HTTP monitoring endpoints (`/watch`, `/alerts`, `/poll`). |
| `RADAR_RATE_LIMIT_PER_MIN` | `120` | Per-IP request rate limit (exempt: `/health`, `/metrics`). |
| `RADAR_API_TOKEN` | — | Optional. When set, the mutating endpoints (`POST /watch`, `/unwatch`, `/poll`, `/defense/:wallet/clear`) require `Authorization: Bearer <token>` (or `x-api-token`). Read endpoints and read-only POSTs stay open. |
| `RADAR_CORS_ORIGINS` | — (open `*`) | Optional comma-separated CORS origin allowlist. When set, only listed origins (or `*`) receive an `Access-Control-Allow-Origin` header; unmatched origins get none. |
| `RADAR_ORACLE` | `0` | Set to `1` to write each scan as a ZK-compressed attestation to the on-chain scan ledger. |
| `RADAR_ORACLE_KEYPAIR` | — | Path to the oracle payer keypair file (JSON array of 64 bytes, the `solana-keygen` format). Preferred way to configure the payer — the secret stays out of the process environment. |
| `RADAR_ORACLE_PAYER` | — | Fallback: base58-encoded 64-byte secret key of the oracle payer, stored in the environment. Use `RADAR_ORACLE_KEYPAIR` in production (see `SECURITY.md`). |

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
             alerts    (Telegram, Webhook, or stdout console)
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
| `TOXIC_MINT` | Swap involves a token with unrenounced mint/freeze authority **or** extreme top-holder concentration (top-10 wallets control ≥ 60% of supply; `high` severity at ≥ 80% or with a freeze authority) |
| `OFF_HOURS` | A majority of recent txs land in UTC hours with no activity in the wallet's historical hour profile |
| `REGIME_SHIFT` | Sustained structural break from baseline in swap size, venue diversity, protocol mix, or cadence (not a single spike) |

### USD normalization

Raw token quantities are not comparable (1 SOL vs 50M BONK). Wallet Radar
normalizes swap sizes to USD with the Jupiter Price API (read-only, keyless):

- `USDC`/`USDT` legs are 1:1 with USD — no price feed needed.
- Any other leg is valued with its Jupiter USD price.
- The baseline tracks the **median swap size in USD over the most recent window**
  (bounded, old outliers fall out) across all mints, so `LARGE_SWAP` works for any
  token, not just the majors.
- The baseline computes **PnL-lite** (`pnl: { realizedUsd, winRate, roundTrips, windowDays }`) via FIFO over closed swap legs; unpriced or one-sided legs emit `null`. Prices are the **current** Jupiter spot, so realized matching is bounded to the last `windowDays` (30) days relative to the newest leg — a stale leg priced far from today's spot would otherwise distort PnL.
- If the price feed is unavailable (or a swap can't be priced), the rule falls
  back to major-only raw quantities — a scan never fails because of prices.

Every anomaly carries structured evidence (tx signatures, numbers) plus a
one-sentence human-readable description, so both agents and humans can verify it.

## MCP server

Wallet Radar ships as an MCP server (`src/mcp.ts`), so any agent (Claude Code,
Cursor, solana-agent-kit) can plug in one-shot risk checks with a single line of
config. Seven tools:

| Tool | Purpose |
| --- | --- |
| `radar_scan` | Live Helius fetch + baseline + rules → risk score, per-rule `reasons`, `summary`, and `freshness` (needs `HELIUS_API_KEY`) |
| `radar_trust` | Gate before you copy / pay: risk + liquidity → `safe`/`hold`/`unknown`, with verdict reasons, per-rule `reasons`, `summary`, and `freshness` (needs `HELIUS_API_KEY`) |
| `radar_batch` | Gate a whole copy-book at once: runs `radar_trust` over up to 20 wallets and returns a deterministic shortlist — `safe` ranked by risk then liquidity, plus `hold` and `unknown` buckets (needs `HELIUS_API_KEY`) |
| `radar_analyze` | Run the rules over a transactions fixture you already have (no network) |
| `radar_simulate` | Pre-trade what-if: "if wallet Y pays out X USDC, what happens to Y?" The wallet under analysis is the **payer** (the outgoing payment reduces its liquidity). Models liquidity impact, large-payment trigger, risk delta → actionable decision (needs `HELIUS_API_KEY`) |
| `radar_selftest` | Offline smoke test, no keys |
| `radar_benchmark` | Reproducible quality proof: runs a versioned labeled eval set through the full detection pipeline and reports precision/recall/accuracy per case. Deterministic, no network |

### Decision Engine

Wallet Radar doesn't just score risk — it tells you **what to do**. The Decision Engine transforms the trust gate output into actionable agent-facing verdicts:

| Action Verdict | Meaning | When |
| --- | --- | --- |
| `allow` | Payment safe to execute | Low risk, sufficient liquidity |
| `throttle` | Reduce payment size | Elevated risk or thin liquidity |
| `block` | Do not pay | High-severity anomaly detected |
| `manual_review` | Escalate to human | Unknown data or ambiguous signal |

Each decision includes:
- **confidence** (0–1) — how certain the system is
- **riskFactors** — normalized per-signal contributions (sum ≈ 1)
- **suggestedLimitUsd** — max safe payment size right now
- **cooldownMs** — how long to wait before re-checking
- **recommendation** — one-sentence action for the agent

### Simulation Mode (pre-trade what-if)

`POST /simulate` (or `radar_simulate` via MCP): the agent asks **before signing** — "if wallet Y pays out X USDC, what happens to Y?" The wallet under analysis is the **payer**: the proposed payment is modeled as an outgoing transfer, so it reduces the wallet's liquidity and is scored against its swap-size and liquidity profile. (A plain transfer is not a DEX swap, so the projected triggers use their own labels — `LARGE_PAYMENT` / `LIQUIDITY_DRAIN` — rather than detector anomaly types.)

```json
{
  "wallet": "7xKX...",
  "amountUsd": 250,
  "balances": { "sol": 0, "usdc": 600, "usdt": 0 }
}
```

Returns:
- Would the payment **exceed the wallet's liquidity**?
- Would it count as a **large payment** relative to the wallet's median swap size?
- Would it **drain the wallet's liquidity**?
- What is the **projected risk score delta**?
- **Actionable decision** + specific recommendation

This is the "pre-trade risk layer" — the agent asks before funds are in motion.

### Audit Trail (explainability)

Pass `includeAudit: true` (or `?audit=true` on HTTP) to get a machine-readable proof of the verdict: every step from raw signal to final decision, with per-signal weights and thresholds. Any auditor (human or agent) can replay the logic.

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

## MCP Service (AgenticTrade)

Wallet Radar is packaged as a standalone MCP service ready for listing on [AgenticTrade](https://github.com/JudyaiLab/agentictrade) ([agentictrade.io](https://agentictrade.io)), allowing autonomous AI agents to discover, invoke, and pay for wallet risk checks via Model Context Protocol.

### Running the standalone server

The server can be run directly via `bin/mcp-server` or `npm run mcp:server`:

```bash
# Start stdio MCP server for agent hosts
./bin/mcp-server
# or
npm run mcp:server

# Print version and exit 0
./bin/mcp-server --version

# Print JSON health status and exit 0
./bin/mcp-server --health
```

### Environment configuration

Configuration is loaded from the environment, `radar.env`, or `.env`:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `HELIUS_API_KEY` | Optional* | — | Helius API key (*required for live `radar_scan` and `radar_trust`) |
| `SOLANA_RPC_URL` | Optional | — | Custom Solana RPC endpoint |
| `RADAR_MAX_RISK` | Optional | `30` | Behavioral risk score threshold (0–100) |
| `RADAR_MIN_LIQUIDITY_USD` | Optional | `50` | Minimum wallet liquidity threshold in USD |
| `RADAR_WINDOW_DAYS` | Optional | `7` | Risk evaluation window in days |
| `RADAR_SEED_PAGES` | Optional | `3` | History pages fetched when seeding a wallet baseline (1–20) |
| `RADAR_QUIET_POLLS` | Optional | `3` | Consecutive zero-tx polls before stretching poll interval |
| `RADAR_MAX_POLL_MS` | Optional | `3600000` | Maximum stretched poll interval in ms (60m) |
| `WEBHOOK_URL` | Optional | — | Webhook endpoint for real-time compact JSON anomaly alerts |
| `RADAR_LLM_KEY` | Optional | — | API key for LLM-generated anomaly digests |
| `RADAR_LLM_BASE` | Optional | `https://api.openai.com/v1` | LLM service base URL (alias: `RADAR_LLM_URL`) |
| `RADAR_LLM_MODEL` | Optional | `gpt-4o-mini` | LLM model identifier |
| `RADAR_LLM_PATH` | Optional | — | LLM API endpoint path (e.g. `/api/generate` for Ollama) |
| `RADAR_LLM_TIMEOUT_MS` | Optional | `5000` | Timeout for LLM digest calls in milliseconds |
| `RADAR_LLM_OPTIONS` | Optional | — | JSON string of inference parameters |

### Service manifest

The service manifest is located at [`agentictrade/manifest.json`](agentictrade/manifest.json). It declares service metadata (`wallet-radar` v0.1.0), stdio transport, tools (`radar_scan`, `radar_analyze`, `radar_selftest`), configuration keys, and per-use pricing.

### Listing on AgenticTrade

1. **Per-use USDC pricing**:
   - `radar_scan`: `0.005 USDC` per call (full Helius history + Jupiter USD pricing + anomaly rules)
   - `radar_analyze`: `0.001 USDC` per call (offline analysis over client-provided transaction fixtures)
   - `radar_selftest`: `0.000 USDC` (free offline smoke test / health check)
2. **Platform incentives**: 0% platform commission fee during the first month via the Provider Growth Program (subsequent tiers capped at 5–10%).
3. **Payouts**: Usage is metered by the marketplace and settled automatically to the provider's designated USDC wallet.

## x402 pay-per-call (HTTP)

Wallet Radar exposes a standalone HTTP service (`bin/x402-server` or `npm run x402:server`) implementing the [x402](https://x402.org) payment-required standard on Solana for autonomous agent micropayments.

- **Endpoints & Pricing**: `GET /selftest` (0 USDC, free), `POST /scan` (0.005 USDC), `POST /analyze` (0.001 USDC).
- **Environment**: `RADAR_X402_RECIPIENT` (operator receiving wallet), `RADAR_X402_PORT` (default `4020`), `SOLANA_RPC_URL` (optional custom RPC; defaults to Helius or Solana mainnet).
- **Handshake (402)**: Requests without proof receive `HTTP 402 Payment Required` containing amount, recipient, and USDC mint (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`).
- **Proof Format**: Provide tx signature and payer via HTTP headers: `X-Payment-Signature: <tx_sig>` and `X-Payment-Payer: <payer_address>` (or `Authorization: x402 <sig>:<payer>`, or `X-Payment: {"signature":"...","payer":"..."}`).
- **Settlement & Anti-Replay**: On-chain verification confirms the USDC transfer to the recipient with amount >= price. Settled signatures are recorded in SQLite (`settled_payments`) to prevent replay attacks across calls.

## On-Chain ZK Scan Ledger (The Oracle)

Wallet Radar turns real-time anomaly assessments into an immutable, verifiable on-chain oracle (`src/oracle`) powered by **Light Protocol ZK compression**:

- **~400x Cost Reduction**: Regular Solana PDAs require ~0.002039 SOL in rent deposit per account. By storing state in ZK-compressed state trees, Wallet Radar commits audit attestations for **~0.000005 SOL** (rent-free state), enabling affordable, continuous on-chain logging.
- **Compact Binary Encoding (`RS01`)**: Scan records pack fixed 48-byte headers (`magic: RS01`, `wallet: 32B`, `risk_score: u8`, `verdict_code: u8`, `timestamp: u64LE`, `payload_len: u16LE`) with JSON evidence payloads for zero-copy deserialization in on-chain programs and off-chain indexers.
- **Tamper-Evident Receipts**: State mutations append to on-chain merkle trees verified against Solana state roots.
- **Autonomous Gating**: Smart contracts and AI agents query on-chain scan attestations before executing transactions, copy-trades, or token transfers.

```typescript
import { commitScan, readScanLedger } from "wallet-radar/oracle";

// 1. Commit an audit attestation to Solana state compression
const { signature, slot, compressedAddress } = await commitScan({
  wallet: "TargetSolanaWallet1111111111111111111111111",
  riskScore: 85,
  verdict: "HIGH RISK",
  topRules: ["DORMANT_ACTIVE", "LARGE_SWAP"],
  txSignatures: ["txSig1..."],
});

// 2. Read historical attestations on-chain
const records = await readScanLedger("TargetSolanaWallet1111111111111111111111111", { limit: 10 });
console.log(`Latest on-chain score: ${records[0].riskScore} (${records[0].verdict}) at slot ${records[0].slot}`);
```

## Agent SDK (JS/TS)

Autonomous agents, trading bots, and dApps can interact directly with Wallet Radar via the official client SDK (`src/sdk`):

```typescript
import { createRadarClient } from "./dist/src/sdk/index.js";
import { Keypair } from "@solana/web3.js";

const client = createRadarClient({
  baseUrl: "http://127.0.0.1:4020", // or hosted API
  rpc: "https://api.mainnet-beta.solana.com",
  x402Payer: Keypair.fromSecretKey(...), // auto-pays 402 challenges
  recipient: "RecipientUSDCWallet...",
});

// One-tap wallet scan with automated x402 payment & on-chain ZK ledger reading
const { riskScore, verdict, evidence, onchainLedgerSig } = await client.scan("<target_wallet>");
console.log(`Risk: ${riskScore} (${verdict}), Attestation Sig: ${onchainLedgerSig}`);

// Read historical on-chain ZK scan attestations from Light Protocol
const attestations = await client.readOnchainLedger("<target_wallet>", 5);
```

See [`src/sdk/README.md`](src/sdk/README.md) for full SDK API documentation, payment signer callbacks, and offline fixtures.

## Solana Actions & Blinks

Wallet Radar exposes official **Solana Actions & Blinks** (`src/blink`), turning wallet audits into interactive one-tap UI cards on Twitter/X, Discord, Phantom, Solflare, and Dialect:

- **Actions Discovery**: `GET /actions.json` defines URL routing rules.
- **Action Metadata**: `GET /api/actions/radar-scan[?wallet=<addr>]` returns standard `ActionGetResponse` with CORS headers.
- **One-Tap Execution**: `POST /api/actions/radar-scan` builds and returns a signable transaction containing an audit memo instruction (`RadarScan:<target>:x402:0.005`) and 0.005 USDC micropayment transfer.
- **Dialect Blinks Link**:
  ```
  https://dial.to/?action=solana-action:https://pay.cbellory.xyz/api/actions/radar-scan
  ```
- **Phantom & Solflare Deep Links**:
  ```
  https://phantom.app/ul/browse/https%3A%2F%2Fpay.cbellory.xyz%2Fapi%2Factions%2Fradar-scan?ref=wallet-radar
  https://solflare.com/ul/v1/browse/https%3A%2F%2Fpay.cbellory.xyz%2Fapi%2Factions%2Fradar-scan
  ```

See [`src/blink/README.md`](src/blink/README.md) for full specification, registration manifest, and programmatic usage.

## Web Dashboard & ZK Ledger Viewer

Wallet Radar provides a minimal, deterministic web dashboard (`src/dashboard.ts`) reading on-chain ZK scan ledger attestations (`readScanLedger`) and displaying per-wallet risk history alongside the latest oracle verdict:

- **Browser Web Dashboard**: `GET /dashboard?wallet=<addr>` (served by both `http-server` and `x402-server`). Self-contained monospace terminal UI with hero score card, compressed PDA, on-chain signature explorer link, and historical attestation timeline.
- **JSON Ledger API**: `GET /api/ledger?wallet=<addr>[&limit=N]` returns structured on-chain attestation history.
- **CLI Ledger Inspection & HTML Export**:
  ```bash
  # View on-chain ZK scan attestations as a monospace terminal table
  node dist/src/cli.js ledger <wallet>

  # Output machine-readable JSON history
  node dist/src/cli.js ledger <wallet> --json

  # Export deterministic standalone HTML dashboard
  node dist/src/cli.js ledger <wallet> --export wallet-ledger.html
  node dist/src/cli.js dashboard --export overview.html
  ```

## Independently Verifiable Trust Proofs (`/trust-proof`)

Anyone—human or autonomous agent—can independently verify a wallet's risk assessment without trusting our server via `GET /trust-proof?wallet=<addr>`:

- **Differentiator**: *"We don't just assert trust — we prove it on-chain, and we're paid USDC for it."*
- **On-Chain ZK Attestation**: Includes the Solana transaction signature, ledger slot, and compressed account PDA from the Light Protocol ZK scan ledger.
- **Current Assessment**: Exact risk score (0–100), verdict badge (`SAFE` / `SUSPICIOUS` / `HIGH RISK`), and firing anomaly detector rules (`REGIME_SHIFT`, `TOXIC_MINT`, `LARGE_SWAP`, etc.).
- **x402 Commercial Receipt**: If the scan was earned via x402 pay-per-call, includes payer address, amount in USDC ($0.005), and settlement signature — proving commercial audit authenticity.
- **Unknown Wallets**: Returns graceful empty/null fields when an address has no prior scans or attestations.

```bash
# Query verifiable trust proof bundle
curl "http://localhost:7690/trust-proof?wallet=<wallet_address>"
```

Example response:
```json
{
  "wallet": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "verified": true,
  "attestation": {
    "signature": "5Knm...3ZtW",
    "slot": 312845920,
    "compressedAddress": "comp_a1b2c3d4...",
    "timestamp": 1726700000
  },
  "riskScore": 88,
  "verdict": "HIGH RISK",
  "topRules": ["REGIME_SHIFT", "TOXIC_MINT"],
  "payment": {
    "payer": "4uQeVj5tqViQh7yWWGStvfEG1Zmhx6uasJtWCJziofM",
    "amountUsdc": 0.005,
    "txSignature": "3Fpq...7VwX",
    "signature": "3Fpq...7VwX",
    "settledAt": 1726700000
  },
  "generatedAt": 1726700000
}
```

## Token-22 Transfer Hook (Scan-on-Transfer)

Wallet Radar delivers autonomous on-chain risk gating via an SPL Token-22 transfer hook program (`programs/radar-transfer-hook` and `src/hook`).

When an SPL Token-22 mint enables the `TransferHook` extension pointing to `radar-transfer-hook`, every `transfer_checked` automatically CPIs into the hook to verify the counterparty on-chain:

- **Scan-on-Transfer Enforcement**: Resolves the destination wallet's Radar Scan Ledger record (`RS01` binary attestation).
- **Threshold Gating**: Reverts the transaction if the destination's risk score exceeds `maxRiskScore` (default: 80 / 100) or carries a `HIGH RISK` verdict.
- **Freshness Policy**: Configurable maximum attestation age in seconds (`maxAttestationAgeSec`).
- **Policy for Unverified Wallets**: Configurable `allowUnverified: bool`.
- **Instruction Builders & Client**:
  ```typescript
  import {
    createRiskGatedTransferCheckedInstruction,
    evaluateTransferRisk,
  } from "wallet-radar/hook";

  // Simulate/evaluate transfer risk off-chain before submitting
  const evalResult = evaluateTransferRisk(destinationRecord, { maxRiskScore: 75 });
  if (!evalResult.allowed) {
    throw new Error(`Transfer blocked: ${evalResult.reason}`);
  }

  // Construct Token-22 TransferChecked instruction with hook extra accounts
  const ix = createRiskGatedTransferCheckedInstruction({
    source: senderAta,
    mint: tokenMint,
    destination: recipientAta,
    owner: senderWallet.publicKey,
    amount: 1_000_000n,
    decimals: 6,
    destinationWallet: recipientWallet.publicKey,
  });
  ```

See [`programs/radar-transfer-hook/README.md`](programs/radar-transfer-hook/README.md) and [`src/hook/README.md`](src/hook/README.md) for complete specifications and deployment instructions.

## One-shot checks (stateless)

```bash
node dist/src/cli.js scan <wallet>            # live fetch + baseline + rules + risk score (JSON)
node dist/src/cli.js analyze <wallet> tx.json # rules over a saved Enhanced-tx file (offline, no keys)
node dist/src/cli.js selftest                 # offline smoke test, no keys
node dist/src/cli.js prices <mint>...         # Jupiter Price API lookup
```

`scan` is the fastest way to try Radar on any wallet: one Helius fetch,
deterministic baseline, risk score, digest — no watchlist, no state.

### Trust check (the gate before you copy)

`trust` answers the question every copy-trader and agent asks before copying or
paying an unverified wallet: **"is it safe to trust this wallet right now?"**
Copy-trading bots (BonkBot, Maestro, Trojan, Axiom, Photon, BullX) surface wallets
to copy but don't safety-gate them first — Radar is that gate. It combines the
behavioral risk score (9 rules over the recent window) with payment capacity
(SOL + USDC/USDT liquidity in USD) into one deterministic verdict:

```bash
node dist/src/cli.js trust <wallet>                        # defaults: max-risk 30, min-liquidity $50, window 7d
node dist/src/cli.js trust <wallet> --max-risk 50 --min-liquidity 100 --json
```

Verdicts: `safe` (both thresholds met), `hold` (data available, threshold
missed), `unknown` (no data to decide — conservative). The JSON carries
machine-readable verdict reasons **plus a per-rule `reasons[]` breakdown and a
one-line `summary`**, so any agent or human can see exactly which rules fired and
why. A `freshness` block states the last activity, the analysis window, and whether
the read is stale — a gate is only as good as the data behind it. No LLM in the
verdict path. Full design: [`docs/trust-spec.md`](docs/trust-spec.md).

### Batch trust gate (gate the whole book)

A copy-trading agent doesn't gate one wallet — it gates the *book* of wallets it
was told to copy. `radar_batch` / `POST /batch` runs the trust check over a whole
set of wallets at once and returns a deterministic shortlist: which are `safe`
(ranked by risk, then liquidity), which are `hold`, and which are `unknown`. A
per-wallet failure never aborts the batch — it is reported as `unknown`.

```bash
# gate the stored watchlist (CLI)
node dist/src/cli.js trust --watchlist --json
```

```bash
# gate any set of up to 20 wallets over HTTP (independent of the watchlist)
curl -s http://localhost:7690/batch -H 'Content-Type: application/json' \
  -d '{"wallets": ["<w1>", "<w2>", "<w3>"], "maxRisk": 30, "minLiquidityUsd": 50}'
```

The response is `{ generatedAt, total, counts: {safe, hold, unknown}, shortlist: [...], borderline: [...], unknown: [...] }`.
MCP tool: `radar_batch`.

## Watchlist (continuous monitoring)

The CLI keeps a watchlist in SQLite (default `~/.wallet-radar/radar.db`,
override with `RADAR_DB`):

```bash
node dist/src/cli.js add <wallet>      # add a wallet
node dist/src/cli.js watch             # poll every 5 min; alerts via Telegram, Webhook, or console
node dist/src/cli.js watch --once      # single iteration (cron-friendly)
node dist/src/cli.js report <wallet>   # baseline (incl. pnl: realizedUsd, winRate, roundTrips) + recent anomalies + risk score
node dist/src/cli.js history <wallet> [--export [out.html]] # baseline + anomalies terminal summary or self-contained HTML export (--export - for stdout)
node dist/src/cli.js alerts [limit]    # recent anomalies across the watchlist
node dist/src/cli.js remove <wallet>   # drop a wallet
```

### Monitoring over HTTP (agent surface)

The same watchlist is exposed over HTTP so an agent can set up monitoring without the CLI. Start the HTTP server with monitoring enabled and it opens the same SQLite store and runs the continuous watch loop in-process, firing `WEBHOOK_URL` / Telegram alerts on every new anomaly:

```bash
RADAR_WATCH=1 WEBHOOK_URL=https://your-agent/hook \
  node dist/src/http-server.js     # or pass --watch; poll interval via RADAR_POLL_MS
```

| Endpoint | Purpose |
|---|---|
| `POST /watch` `{wallet}` | Add a wallet to the watchlist |
| `GET /watch` | List watched wallets (seed status + unalerted-anomaly count) |
| `POST /unwatch` `{wallet}` | Remove a wallet |
| `GET /alerts?limit=N` | Recent recorded anomalies (most recent first) |
| `POST /poll` | Immediately re-check the whole watchlist and fire webhooks/Telegram on any new anomaly — "re-check my copied wallet now" |

```bash
curl -s http://localhost:7690/watch -H 'Content-Type: application/json' \
  -d '{"wallet":"8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j"}'
curl -s http://localhost:7690/poll -X POST -H 'Content-Type: application/json' -d '{}'   # re-check now
curl -s http://localhost:7690/alerts
```

`POST /poll` runs one synchronous iteration over the watchlist (seed → detect → alert), so an agent gets an immediate risk report plus any webhooks without waiting for the next scheduled poll. Without `RADAR_WATCH=1` the HTTP server is stateless and these routes return `503` (the CLI above still works standalone).

### Webhook alerts

Set `WEBHOOK_URL` to deliver compact structured alert payloads to any webhook endpoint (agent hooks, Slack/Discord bridges, or ingestion services). On every detected anomaly batch, Radar POSTs JSON:

```json
{
  "wallet": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "risk": 65,
  "anomalies": [
    {
      "type": "DORMANT_ACTIVE",
      "wallet": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      "severity": "high",
      "timestamp": 1773000000,
      "evidence": { "daysSilent": 82 },
      "text": "Wallet reactivated after ~82 days of inactivity."
    }
  ]
}
```

Delivery is best-effort: failures (network errors, timeouts, non-2xx statuses) are logged to stderr and swallowed so alerting never disrupts or breaks the continuous watch loop. If both `WEBHOOK_URL` and Telegram credentials (`TG_BOT_TOKEN`, `TG_CHAT_ID`) are set, alerts broadcast to both sinks in parallel.

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
- `--alert` — deliver through the configured sink (Telegram, Webhook, or console).
- `--json` — machine-readable result on stdout.

First-seed semantics: when a wallet is added to the watchlist, its history is
seeded via paged history (`fetchWalletHistory`, default 3 pages / up to 300 txs,
configurable with `RADAR_SEED_PAGES` 1..20) and priced immediately with Jupiter
USD prices. This ensures `medianSwapAmountUsd` is populated from day one so
`LARGE_SWAP` USD evaluation is active immediately. Seeding is completely silent
(no alerts on old historical activity), and all fetched signatures are marked seen
so subsequent watch polls only process fresh, unseen transactions.

### Adaptive polling & credit economics

Polling idle wallets every 5 minutes wastes RPC credits. Radar implements per-wallet adaptive pacing to minimize Helius usage while preserving fast detection on active wallets:

- **Credit economics**: Each poll consumes 1 Helius Enhanced Transactions request per polled wallet. On the free tier (~100k credits/month), watching 10 wallets every 5 minutes would consume ~86,400 requests/month (~86% of quota).
- **Adaptive pacing**: When a wallet yields zero fresh transactions for $N$ consecutive polls (default 3, env `RADAR_QUIET_POLLS`), Radar progressively stretches its polling interval up to a cap (default 60 minutes, env `RADAR_MAX_POLL_MS`):
  - Quiet wallets stretch up to 60 minutes (12× longer than the 5-minute base interval), reducing idle traffic by up to 12×.
  - As soon as a fresh transaction appears, the wallet's polling interval instantly resets to the base interval (5 minutes).
  - Quiet streak and `nextPollAt` schedules are persisted in SQLite (`wallet_pacing`), surviving service restarts.
  - In `watchOnce` reports, skipped quiet wallets are marked with `{ skipped: true, quiet: true, nextPollAt: ... }` without querying Helius.

### Optional LLM digest

Alerts get a one-sentence natural-language summary when an LLM is configured —
any OpenAI-compatible `/chat/completions` endpoint (OpenAI, OpenRouter, Groq,
local Ollama...). Without a key, or on any failure/timeout, the deterministic
template digest is used — alerting never blocks on the LLM:

- `RADAR_LLM_KEY` — enables the LLM digest (API key)
- `RADAR_LLM_BASE` — endpoint base, default `https://api.openai.com/v1`
- `RADAR_LLM_MODEL` — model, default `gpt-4o-mini`
- `RADAR_LLM_TIMEOUT_MS` — request timeout in ms, default `15000`
- `RADAR_LLM_OPTIONS` — extra JSON request fields, e.g. Ollama `{"num_thread": 8}`
- `RADAR_LLM_PATH` — path appended to the base, default `chat/completions`
  (Ollama native endpoint: `http://127.0.0.1:11434/api` + `chat`)

**Hardened & unattended-safe**: Unreachable endpoints, request timeouts, malformed
JSON, or provider error payloads automatically degrade to the deterministic rule
template without throwing into the continuous watch loop.

## Current scope & known limitations

- **Cold start**: Baseline is seeded from recent history on the first watch (paged up to 300 txs + priced). Historical anomalies inside this initial seed window are intentionally not alerted; a brand-new wallet with zero transaction history starts with an empty baseline.
- **Baseline drift / Sybil**: Reference swap-size medians now track a bounded recent window, so old outliers fall out and the profile follows current behavior — but sustained micro-swap activity still lowers the reference and dilutes `LARGE_SWAP` sensitivity. Known venues and programs are append-only, meaning malicious pre-warming suppresses `NEW_VENUE` and `NEW_PROTOCOL`. Planned mitigations: sample floor before trusting medians and robust statistics.
- **Helius credit consumption**: Continuous watching consumes 1 Enhanced Transactions request per polled wallet (free tier: ~100k credits/month). Exponential 429/5xx backoff and adaptive quiet-wallet pacing (stretching intervals up to 60m) mitigate credit exhaustion.
- **Price feed dependency**: If Jupiter Price API is unreachable or tokens cannot be priced in USD, `LARGE_SWAP` falls back to major-only sizing (evaluating raw quantities on SOL, USDC, and USDT only).

## Colosseum Hackathon (Fall 2026): Before / After Honesty Note

In the spirit of complete transparency for hackathon judges and the Solana
community, here is an exact breakdown of the project's timeline relative to the
hackathon window, which opened **2026-09-14 15:00 UTC** and closed 2026-10-13.
`git log` on `main` is the authoritative record of what landed when.

### What Existed Before the Window (the `v0.0.0` foundation)
The working product that preceded the hackathon (commits `20a965f` … `3e0e0ad`,
frozen as the `v0.0.0-pre-hackathon` baseline):
- **Deterministic Anomaly Rules Engine** — the 8 behavioral rules
  (`DORMANT_ACTIVE`, `ACTIVITY_BURST`, `NEW_VENUE`, `LARGE_SWAP`, `CONCENTRATION`,
  `NEW_PROTOCOL`, `TOXIC_MINT`, `REGIME_SHIFT`).
- **Baseline Profiler** — Helius Enhanced Transactions + Jupiter USD
  normalization; per-wallet behavioral baseline in **SQLite**.
- **Trust gate & explainability** — the `trust` verdict (`safe`/`hold`/`unknown`)
  with per-rule `reasons`, summary, and data `freshness`; the
  **gate-before-you-copy** wedge; the **batch** trust-gate (`POST /batch`);
  **TOXIC_MINT** top-holder concentration.
- **x402 pay-per-call** Solana settlement + **HTTP service** + **continuous
  monitoring** (watchlist, adaptive polling, Telegram/Webhook alerts) +
  **AgenticTrade** packaging + **A2A** agent surface + **stdio MCP server** + CLI.

### The pre-window "Leap", committed at the boundary (`f2bc219`)
A large feature leap was completed **immediately before** the window and landed
as a **single snapshot commit** —
[`f2bc219`](https://github.com/daniilmilintieiev-ux/wallet-radar/commit/f2bc219)
(`"feat(leap): …"`, **2026-09-14 11:05 UTC**, 35 files, +9,438 / −262) — at the
window boundary rather than as a stream of small commits. It bundles:
- **ZK Scan Ledger / The Oracle** (`src/oracle`) — Light Protocol
  ZK-compressed attestations (~0.000005 SOL, ~400× cheaper than a PDA), `RS01`
  binary format.
- **Autonomous Agent SDK** (`src/sdk`) — `createRadarClient`, automated x402
  payment, on-chain attestation reads.
- **Solana Actions & Blinks** (`src/blink`), **Web Dashboard & ZK Ledger Viewer**
  (`src/dashboard.ts`), **SPL Token-22 Transfer Hook**
  (`programs/radar-transfer-hook`, `src/hook`), and the **End-to-End Test Suite**
  (`test/e2e.test.ts`).

This is the "commit bomb": one big consolidation of **prior** work, **not** 35
separate in-window changes.

### What Was Built IN-WINDOW (2026-09-14 15:00 UTC → 10-13) — 18 incremental commits
The genuine in-window development is a real stream of focused commits that follow
`f2bc219` in `main`:

| Commit | Date (UTC) | In-window work |
| --- | --- | --- |
| `64e1a8a` | 9/14 15:00 | Hackathon kickoff (live-demo links, CHANGELOG leap entries) |
| `16b35f3` · `ccfc534` · `aebe35d` | 9/15 | **Decision Engine** (actionable verdicts), **pre-trade Simulation Mode**, enhanced explainability (MCP `radar_simulate`, audit trail) |
| `0d8a4dd` | 9/15 | **Anti-evasion** rules (`REGIME_SHIFT`, `WARMING`) + reproducible **benchmark/eval** endpoint |
| `6b92523` · `c980a35` · `ae1dd8c` | 9/16 | Security-critique quick wins; TLS domains (`radar.`/`pay.cbellory.xyz`); link fixes |
| `232b01e` | 9/16 | **Autonomous canary agent** (self-paying 24/7) + load test + systemd unit |
| `3e3150b` | 9/16 | Benchmark eval set 6→21 (100% accuracy / precision / recall) |
| `990bb36` | 9/16 | **Hardening**: baseline-poisoning defense, counterparty clustering, account-authority check |
| `b200406` | 9/16 | Trust **baseline redesign** + x402/watch/pnl/oracle/store hardening |
| `72ea65f` | 9/16 | **Pillar 1 — Self-Funding Loop**: P&L engine, `/economics`, Helius cost tracking |
| `d7cc3cc` | 9/16 | **Pillar 2 — Multi-Agent Consensus**: agent panel, weighted aggregation, optional LLM voter |
| `8f0226e` | 9/16 | x402server promoted to a systemd unit (survives ssh-close + reboot) |
| `16ed9a4` | 9/17 | **Pillar 3 — Active Defense**: autonomous per-wallet stance (armed→alerting→gated→blocked), enforcement, audit trail |
| `6a379b5` · `e46cc4d` | 9/17 | **Reliable-green CI**: `/scan` honors injected deps + `--test-force-exit`; deterministic canary |
| `0eba3d8` · `32eb601` | 9/17 | Windows test-suite hardening (libuv double-close) + this before/after honesty note |
| `93d32f6` · `c66eb55` · `e8b1f83` | 9/18 | **Batch 6**: security hardening (x402/HTTP/RL/timeouts), `REGIME_SHIFT` 8th rule, test expansion + config fail-fast |
| `165b2a9` → `e2b2486` | 9/18 | Cross-batch **counterparty relationship memory** (3 branches merged: regime/harden/tests + counterparty) |
| `78602b4` | 9/18 | **v7 CONSOLE dashboard** wired to live defense + scan ledger (487/487 tests) |
| `fb10026` | 9/18 | **On-chain ZK oracle end-to-end**: real Light `compress()` attestations, live read/write verified (488/488) |
| `3c2b4c3` · `364b221` · `5d2b870` · `9150d0e` | 9/18 | **Honest audit** (30 features classified, 5 gaps) + Blink-domain fix + canonical ATA ID fix + test-count correction |
| `803556e` | 9/18 | **GAP 2 closed**: `radar-watch.service` systemd unit (all 4 services reboot-proof) |
| `886579b` · `2ad4066` | 9/18 | **GAP 1 prep**: Token-22 transfer hook SBF build + devnet deploy script + revert-on-flagged test |
| `7707e7d` | 9/18 | **WOW**: `GET /trust-proof` — independently verifiable on-chain attestation bundle |
| `56d3caa` | 9/19 | **GAP 1 closed**: Transfer Hook **deployed end-to-end on devnet** (program `ASXvQY…`, Token-22 mint `9usnYu…`, config-init sig `FMKe3U…`, flagged REVERT / unflagged ALLOW proof) |

**In short:** a pre-window `v0.0.0` foundation → one pre-window leap snapshot
(`f2bc219`) at the boundary → **40 real incremental in-window commits** (decision
engine, simulation, anti-evasion + benchmark, hardening, trust redesign, canary,
the three pillars: self-funding economics / multi-agent consensus / active
defense, on-chain ZK oracle end-to-end, honest audit + gap closure, and the
Token-22 Transfer Hook deployed + proven on devnet).

## Status

**Early-access (v0.1.x)** — the core is production-usable and live: collector
(Helius), per-wallet behavioral baseline (incl. USD median), deterministic
analyzer (9 rules, USD-normalized, unit-tested), `trust` gate-before-you-copy verdict
(risk + liquidity → `safe`/`hold`/`unknown`, with per-rule reasons, summary, and data
freshness), MCP server
(stdio), HTTP service, x402 pay-per-call, Telegram / Webhook / console alerts,
deterministic replay, and self-contained HTML reports. Continuous monitoring
watches a wallet list and alerts on fresh anomalies.

### Roadmap

- Continuous per-wallet trust-score trend (time-series) in reports.
- Robustness mitigations for baseline drift / Sybil (sample floor, robust
  statistics, recency decay) — see Current scope.
- Self-hosted deployment guide and hosted-API terms/SLA for paying customers.

## Support

- **Report issues** via [GitHub Issues](https://github.com/daniilmilintieiev-ux/wallet-radar/issues)
  (non-security) or privately via [SECURITY.md](SECURITY.md) (security).
- **Early-access response target:** we aim to acknowledge within 1 business day
  and follow up with a plan or a fix. For hosted-API customers, support is
  provided per engagement; a formal uptime SLA is on the roadmap.
- **Live service:** `GET /health` reports the version and configuration status.

## Security

See [SECURITY.md](SECURITY.md) for supported versions, the private
vulnerability-disclosure process, how we handle data, oracle key-material
storage, and x402 payment replay protection.

## Privacy

Wallet Radar is read-only and custody-free: it reads public on-chain data via
Helius, never holds a private key, and never signs or moves your funds. x402
payment verification is read-only (it reads the submitted transaction and the
recipient USDC balance). The full data-handling model is in
[SECURITY.md](SECURITY.md).

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — release history and unreleased changes.
- [SECURITY.md](SECURITY.md) — security policy, disclosure, data handling.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute.
- [docs/trust-spec.md](docs/trust-spec.md) — trust-check design.

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

- Node 22.13+ (uses the built-in `node:sqlite`; the core CLI/watch pipeline has no npm deps — the optional oracle, x402 SDK, MCP, and Solana Actions features pull in the Solana/MCP libraries listed in `package.json`)
- `HELIUS_API_KEY` env var (Enhanced Transactions API, read-only)
- Jupiter Price API (keyless by default, `lite-api.jup.ag`). Optional:
  - `JUPITER_API_KEY` — uses the higher-limit `api.jup.ag` endpoint
  - `JUPITER_PRICE_BASE` — overrides the price endpoint URL entirely
- Alert sinks (optional, defaults to stdout console):
  - Telegram alerts: `TG_BOT_TOKEN` + `TG_CHAT_ID`
  - Webhook alerts: `WEBHOOK_URL` (POST compact JSON `{wallet, risk, anomalies}`)
- LLM digest (optional, falls back to deterministic template):
  - `RADAR_LLM_KEY` (plus optional `RADAR_LLM_BASE`, `RADAR_LLM_MODEL`, `RADAR_LLM_TIMEOUT_MS`, `RADAR_LLM_OPTIONS`, `RADAR_LLM_PATH`)
- Watch tuning (optional):
  - `RADAR_SEED_PAGES` — cold-start seed depth (default 3, range 1..20)
  - `RADAR_QUIET_POLLS` — consecutive zero-tx polls before stretching interval (default 3)
  - `RADAR_MAX_POLL_MS` — maximum stretched interval cap in ms (default 3,600,000 = 60m)


## License

MIT
