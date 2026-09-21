# Changelog

All notable changes to Wallet Radar are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

> **Git-history note (hackathon transparency):** the pre-window "leap" feature
> set (ZK oracle, Agent SDK, Solana Actions/Blinks, web dashboard, Token-22 hook,
> E2E suite) landed as a single snapshot commit
> [`f2bc219`](https://github.com/daniilmilintieiev-ux/wallet-radar/commit/f2bc219)
> (2026-09-14 11:05 UTC, 35 files, +9,438) at the window boundary, while the
> genuine in-window work (from 2026-09-14 15:00 UTC) is a series of 18
> incremental commits (decision engine, pre-trade simulation, anti-evasion +
> benchmark, hardening, trust baseline redesign, autonomous canary, and the three
> pillars: self-funding economics, multi-agent consensus, active defense). The
> full before/after breakdown is in the [README](README.md) — "Colosseum
> Hackathon (Fall 2026): Before / After Honesty Note".

### Added
- Per-IP rate limiting on the HTTP service (default `120` requests/minute,
  configurable via `RADAR_RATE_LIMIT_PER_MIN`; `429` + `Retry-After` when exceeded,
  `/health` and `OPTIONS` exempt).
- `RADAR_X402_RECIPIENT` configuration for the x402 pay-per-call service
  (the operator USDC receiving wallet).
- Production-readiness documentation: `SECURITY.md` (vulnerability disclosure +
  data handling), `CHANGELOG.md`, `CONTRIBUTING.md`.
- Explainability: a per-rule `reasons[]` breakdown and a one-line `summary` on
  `/scan`, `/analyze`, and `/selftest` (HTTP + MCP), and a per-rule anomaly
  breakdown + summary on the `trust` verdict — so any agent or human can see
  exactly which deterministic rules fired and why.
- A `freshness` block on `/scan` and `/trust`: last activity, analysis window,
  days-since-last-activity, and a `stale` flag — a gate now states how recent
  its data is, instead of being silent about it.
- Batch trust gate: `POST /batch` (HTTP) and the `radar_batch` MCP tool run the
  pre-flight trust check over up to 20 wallets at once and return a deterministic
  shortlist — `safe` ranked by risk then liquidity, plus `hold` and `unknown`
  buckets — so a copy-trading agent can gate its whole book in one call. A
  per-wallet failure is reported as `unknown` and never aborts the batch.
- Monitoring over HTTP (the agent surface for "keep gating while you copy"): the
  HTTP server can now run the watch loop in-process (`RADAR_WATCH=1` or
  `--watch`), sharing the same SQLite store and firing `WEBHOOK_URL` / Telegram
  alerts on every new anomaly. New routes: `POST /watch` (add), `GET /watch`
  (list), `POST /unwatch` (remove), `GET /alerts` (recent anomalies), and
   `POST /poll` (re-check the whole watchlist now and fire webhooks on any new
   anomaly). `watchLoop` now accepts an `AbortSignal` for clean in-process
   shutdown.
- `TOXIC_MINT` now also fires on **top-holder concentration**: when the top-10
  wallets control ≥ 60% of a token's supply (fetched via standard RPC
  `getTokenLargestAccounts` + supply/decimals from Helius DAS or RPC).
  Concentration ≥ 80% (or a present freeze authority) escalates the anomaly to
  `high` severity. `MintRiskInfo.top10Pct` is computed, persisted in the mint
  cache, and surfaced in the anomaly `reasons` and `evidence`.
- **On-Chain ZK Scan Ledger — The Oracle (`src/oracle`)**: ZK-compressed state
  accounts (Light Protocol) storing immutable scan attestations rent-free
  (~0.000005 SOL, ~400× cheaper than a PDA). Compact `RS01` binary
  serialization (48-byte zero-copy header + JSON evidence payload).
  `commitScan` / `readScanLedger` with Light RPC validity-proof fallback.
- **Autonomous Agent SDK (`src/sdk`)**: TypeScript/JavaScript client
  (`createRadarClient`) with automated x402 payment (signed Solana
   transactions) and on-chain ZK attestation reading. Self-contained base58
   encoder, ATA derivation, and SPL transfer instruction builders.
- **Solana Actions & Blinks v1 (`src/blink`)**: Official Solana Actions
  specification (`/actions.json` discovery, `ActionGetResponse` /
  `ActionPostResponse` endpoints), one-tap Blink URL generators and deep
  links for Dialect (`dial.to`), Phantom, and Solflare.
- **Web Dashboard & ZK Ledger Viewer (`src/dashboard.ts`)**: Self-contained
  monospace web dashboard (`GET /dashboard`) with hero verdict cards, slot
  tracking, on-chain signature links, and historical timeline. `GET /api/ledger`
  JSON API and CLI `radar ledger` / `radar dashboard --export` exporter.
- **SPL Token-22 Transfer Hook (`programs/radar-transfer-hook`, `src/hook`)**:
  Anchor program implementing `spl-transfer-hook-interface` for
  scan-on-transfer risk gating. Client instruction builders
  (`createRiskGatedTransferCheckedInstruction`) and deterministic risk
  evaluator (`evaluateTransferRisk`).
- **End-to-End Test Suite (`test/e2e.test.ts`)**: Full-circle verification
  (scan → x402 auto-pay → ZK oracle commit → SDK read → dashboard render →
  Token-22 hook gate), 25-concurrent load test with unique settlement
  signatures, and anti-replay verification.

### Changed
- README reframed from "hackathon MVP" to **early-access (v0.1.x)**, with
  Status, Support, Security, and Privacy sections and links to the new docs.
- Corrected the anomaly-rule count in user-facing text from 6 to 7 to match
  the documented rule set.
- README and landing site reframed around the **gate-before-you-copy** wedge:
  Radar is the deterministic pre-copy / pre-payment trust gate that copy-trading
  bots (BonkBot, Maestro, Trojan, Axiom, Photon, BullX) don't provide.
- Fixed the remaining stale "6 rules" → 7 in the MCP tool descriptions and the
  landing site, and added the missing `TOXIC_MINT` row to the site rules list.

## [0.1.0] - 2026-09-10

Initial public release (early-access).

### Added
- Continuous Solana wallet monitoring: collector (Helius Enhanced Transactions,
  read-only), per-wallet behavioral baseline (SQLite), deterministic anomaly
  analyzer.
- Seven deterministic anomaly rules (no LLM in the decision path):
  `DORMANT_ACTIVE`, `ACTIVITY_BURST`, `NEW_VENUE`, `LARGE_SWAP` (USD-normalized),
  `CONCENTRATION`, `NEW_PROTOCOL`, `TOXIC_MINT`.
- Jupiter Price API USD normalization with graceful fallback (a scan never
  fails because of prices).
- `trust` pre-flight verdict (`safe`/`hold`/`unknown`) combining behavioral
  risk with payment capacity (SOL + USDC/USDT liquidity in USD).
- MCP server (stdio) exposing `radar_scan`, `radar_trust`, `radar_analyze`,
  and `radar_selftest`.
- AgenticTrade service packaging (manifest + per-use USDC pricing).
- x402 pay-per-call HTTP service (`/scan` 0.005 USDC, `/analyze` 0.001 USDC,
  `/selftest` free) with on-chain USDC settlement verification and anti-replay.
- HTTP service (`/scan`, `/analyze`, `/trust`, `/selftest`, `/health`).
- Alert sinks: Telegram, Webhook (compact JSON), and console; optional LLM
  digest (any OpenAI-compatible endpoint) with deterministic template fallback.
- Adaptive quiet-wallet polling to minimize Helius credit consumption.
- Deterministic `replay` over a frozen historical window; self-contained HTML
  report export.
