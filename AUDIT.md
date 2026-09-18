# Wallet Radar — Honest Audit (what actually works vs. what is promised)

Date: 2026-09-18. Method: full `tsc` build + the entire unit/integration suite
(488 tests, 22 suites), a static wiring review of `src/http-server.ts`, and a
**live** probe of the deployed service on the Orange Pi (`radar-http.service`,
port 7690; `x402` server, port 4020) plus the public domains. This is the answer
to "how much of this is a promise or fake code?" — verified, not asserted.

## Verdict

The core product is **real, tested, and live**: 8-rule deterministic analyzer,
baseline (USD-normalized, PnL-lite), trust gate + decision engine, batch,
simulate, watchlist + adaptive polling, replay, benchmark, economics math,
consensus, active defense, counterparty memory, x402 pay-per-call handshake,
MCP server, A2A surface, on-chain **ZK** scan ledger (write + read), and the
dashboard. **488/488 tests pass; the live service returns real on-chain data.**

There are **5 gaps** where the README/Colosseum report claim more than is true
live today. None of them is "fake code" in the sense of a stub that throws
`not implemented` — the code is written and tested. The gaps are **deployment /
wiring / domain** gaps: a feature that exists in the repo but is not actually
running, or a link that points at a dead host.

## Evidence base (this audit)

- `npm run build` (tsc) — clean.
- `npm test` — **488 pass / 0 fail / 0 skip** (22 suites), ~7.7s.
- Live probe (2026-09-18, Orange Pi):
  - `POST /scan 5DTK7…3V1g` → real: `txCount 7`, `riskScore 15`, `LOW RISK`,
    anomaly `ACTIVITY_BURST`; committed a fresh on-chain attestation
    (`slot 448145607`) — the ZK oracle write path is live.
  - `GET /api/ledger?wallet=5DTK7…` → real on-chain attestations (latest
    `slot 448145607`, risk 15).
  - `POST /a2a 5DTK7…` → real trust gate: `verdict "hold"`, live balances
    (sol 0.0047, usdc 0.00015), `freshness.stale true`.
  - `GET /economics` → real: `revenue.totalUsdc 0, payments 0`,
    `cost.totalUsd 0.0025` (5 helius events), `net -0.0025`.
  - `GET /defense` → real (empty stance list — nothing has escalated; correct).
  - x402 `POST /scan` with **no** payment → **HTTP 402** with a full x402
    manifest (`amount 0.005`, recipient `F6wWPy4c…BNR`, USDC mint). The
    pay-per-call handshake is live.
  - `radar.cbellory.xyz/health` → **HTTP 200** (public service is up).
  - `wallet-radar.app/api/actions/radar-scan` → **HTTP 000** (dead).
  - `systemctl --user status canary-agent` → **`could not be found`**.

## Feature-by-feature classification

Legend: **LIVE** = verified returning real data on the deployed service.
**CODE** = written + unit/integration tested + wired, not separately re-verified
live in this pass (but the same code path as a LIVE sibling). **GAP** = the
README/report claims more than is true today (see the 5 gaps below).

| # | Feature (README claim) | Status | Evidence |
|---|---|---|---|
| 1 | Collector (Helius enhanced tx) | LIVE | `/scan` fetched 7 real txs |
| 2 | Baseline profiler (USD median, PnL-lite) | LIVE | `/scan` returns `pnl`, baseline used |
| 3 | Analyzer — 8 deterministic rules | LIVE | `ACTIVITY_BURST` fired; 8 rules unit-tested |
| 4 | Digest (LLM + deterministic template) | CODE | tested; template used live (no LLM key on pi) |
| 5 | Alerts (Telegram / Webhook / console) | CODE | sinks tested (best-effort, non-throwing) |
| 6 | Trust gate `safe`/`hold`/`unknown` | LIVE | `/a2a` returned `hold` with real balances |
| 7 | Decision engine (allow/throttle/block/manual_review) | CODE | `computeDecision` tested; in trust path |
| 8 | Batch trust gate (`/batch`) | CODE | tested + wired; per-wallet error isolation |
| 9 | Simulation mode (`/simulate`) | CODE | `simulatePayment` tested + wired |
| 10 | Watchlist monitoring (`/watch`,`/poll`,`/alerts`) | CODE | tested + wired (needs `RADAR_WATCH=1`) |
| 11 | Adaptive polling / credit economics | CODE | tested (stretch-to-60m, backoff) |
| 12 | Replay (deterministic historical) | CODE | `buildReplay`/`replayWallet` tested |
| 13 | Benchmark/eval endpoint | LIVE | `/benchmark` present; 21-case eval, 100% |
| 14 | Counterparty relationship memory | CODE | `fold`/`detect` tested; wired into analyzer |
| 15 | **Pillar 1 — Self-funding loop** (`/economics`) | GAP(4) | math tested + live, but **0 real settled USDC revenue** |
| 16 | **Pillar 2 — Multi-agent consensus** | CODE | `aggregateConsensus` tested; internal to trust |
| 17 | **Pillar 3 — Active defense** | LIVE | `/defense` live; `enforceVerdict` wired in scan |
| 18 | **Autonomous canary agent** ("self-paying 24/7 + systemd unit") | GAP(2) | code + tests exist, but **service not installed on pi** |
| 19 | **x402 pay-per-call** (HTTP 402 + on-chain USDC verify + settlement) | LIVE(handshake) / GAP(4) | 402 manifest live; **no real settled payment yet** |
| 20 | MCP server (6 tools) | CODE | stdio handshake + tools/list tested; `bin/mcp-server` |
| 21 | A2A agent surface (card + `/a2a`) | LIVE | card + `/a2a` live; T3N DID registration unverified |
| 22 | Agent SDK (`createRadarClient`, auto-pay, ledger read) | CODE | 12 SDK tests pass (real HTTP + payment + ledger) |
| 23 | **Solana Actions & Blinks** (Phantom/Solflare/Dialect deep links) | GAP(3) | code + tests work, but **`wallet-radar.app` domain is dead** |
| 24 | Web dashboard + ZK ledger viewer | LIVE | verified populated with real attestations |
| 25 | **On-chain ZK scan ledger (The Oracle)** | LIVE | write + read proven live (see above) |
| 26 | **SPL Token-22 Transfer Hook** (scan-on-transfer enforcement) | GAP(1) | program written; **not deployed**, no record bridge, no Token-22 mint |
| 27 | AgenticTrade manifest | CODE | manifest.json validated by test |
| 28 | Self-contained HTML reports | CODE | `renderHtmlReport` tested + CLI export |
| 29 | Audit trail (`includeAudit`) | CODE | tested; machine-readable proof path |
| 30 | CLI (scan/analyze/trust/ledger/dashboard/replay/…) | CODE | tested; `bin/*` + `npm run radar` |

## The 5 gaps (promise > reality)

### GAP 1 — Transfer Hook is written but not deployed (the big one)
- `programs/radar-transfer-hook` is a complete Anchor program (`initialize`,
  `update_config`, `transfer_hook`), but `declare_id!("Hook111…")` is still the
  **placeholder** — it has **not** been deployed to any cluster, and there is no
  release SBF `.so` or deploy artifact.
- **There is no record-bridge instruction.** The hook reads a regular PDA
  `radar_record` (`RS01` binary) for the destination, but the ZK oracle writes
  **Light ZK-compressed** accounts (a different store/format). Nothing currently
  writes the hook's PDA, so even once deployed the hook has nothing to read.
- **No Token-22 mint** with the `TransferHook` extension exists, and the config
  is not initialized.
- The client-side `evaluateTransferRisk` (`src/hook/index.ts`) is a real, tested
  pure function, but it is **not wired into any live endpoint** (reference only).
- **Fix (new work, see PLAN):** add a `write_scan_record` bridge instruction,
  `anchor build` (SBF), deploy to **devnet**, create a Token-22 mint with the
  hook, wire `commitScan` to mirror the verdict into the PDA, and prove a real
  `transfer_checked` that the chain reverts. Until then the README should say
  "designed + implemented, **not yet deployed**."

### GAP 2 — Canary agent: code exists, service is not installed on the pi
- `scripts/canary-agent.ts` + `deploy/canary-agent.service` + `canary.test.ts`
  exist and pass, but `systemctl --user status canary-agent` → **could not be
  found**. So the "autonomous canary (self-paying 24/7) + systemd unit" claim is
  not currently true on the deployed box.
- **Fix (existing work, do now):** install + enable + start the canary unit on
  the pi and confirm it is running; it then exercises the real self-pay loop.

### GAP 3 — Blink deep links point at a dead domain
- README Blink links (Phantom/Solflare/Dialect) use `wallet-radar.app`, which
  returns **HTTP 000** (unreachable). The same action endpoints work on the live
  host `radar.cbellory.xyz`.
- **Fix (existing work, do now):** point the README/manifest Blink + Actions
  links at the live host, or restore the `wallet-radar.app` CNAME. Until then,
  "registered on Phantom/Solflare" is aspirational.

### GAP 4 — Self-funding loop has cost but no real settled revenue yet
- `/economics` is real and the P&L math is tested, but
  `revenue.totalUsdc = 0, payments = 0` — **no real on-chain USDC payment has
  actually settled** through x402 on the live service. The 402 handshake works;
  the "self-funding" is proven only up to the challenge, not a settled payment.
- **Fix (existing work, do now):** perform a **real** paid `/scan` that settles
  actual USDC (a signed `transferWithAuthorization` to the x402 recipient
  `F6wWPy4c…BNR`), verify it on-chain, and confirm `/economics` then shows
  `revenue > 0`. That converts the claim from "handshake works" to "the agent
  actually earned USDC."

### GAP 5 (minor) — Live `/scan` reported `pricesAvailable: false`
- The audited wallet's recent legs were not pricable (or Jupiter was not
  reachable), so `LARGE_SWAP` fell back to major-only sizing. This is the
  designed degradation, not a crash — but it should be confirmed that Jupiter
  pricing works on the pi for wallets that *do* have pricable swaps.
- **Fix (verify now):** run a `/scan` on a wallet with known DEX swap activity
  and confirm `pricesAvailable: true` + a USD-normalized `LARGE_SWAP`.

## What is safe to claim (post-fix target state)

- **Provable:** every Radar verdict is committed as an immutable, ZK-compressed,
  rent-free on-chain attestation owned by the scanned wallet; anyone can read
  the history. *(already live.)*
- **Self-funding:** the service earns real USDC per paid call via x402 and
  reports it in `/economics`. *(live once GAP 4 is closed with a real settlement.)*
- **Acting (advisory):** the radar escalates a defense stance and tightens the
  actionable verdict. *(live, decision-layer.)*
- **Enforced on-chain:** the chain reverts a Token-22 transfer to a flagged
  wallet. *(NOT yet live — GAP 1; target state via PLAN.)*

## Housekeeping found
- Stray scratch file at repo root: `_recover_nested.mjs` — remove.
