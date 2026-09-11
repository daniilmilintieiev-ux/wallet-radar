# Changelog

All notable changes to Wallet Radar are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
