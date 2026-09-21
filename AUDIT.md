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

The original audit found **5 gaps** where the README/Colosseum report claimed
more than was true live. **3 are now closed this session** — GAP 3 (Blink
domain re-point), GAP 4 (real x402 USDC settlement, `selfSustaining: true`), and
GAP 5 (Jupiter pricing verified) — leaving **2**: GAP 1 (Transfer Hook not
deployed) and GAP 2 (canary/x402/watch are bare processes, not managed units).
None of them is "fake code" in the sense of a stub that throws
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
  - `GET /economics` → real. Pre-settlement: `revenue.totalUsdc 0, payments 0`,
    `net -0.0025`. After the GAP 4 payment: `revenue.totalUsdc 0.005`,
    `payments 1`, `net.usd 0.0015`, `selfSustaining: true`.
  - `GET /defense` → real (empty stance list — nothing has escalated; correct).
  - x402 `POST /scan` with **no** payment → **HTTP 402** with a full x402
    manifest (`amount 0.005`, recipient `F6wWPy4c…BNR`, USDC mint). The
    pay-per-call handshake is live.
  - `radar.cbellory.xyz/health` → **HTTP 200** (public service is up).
  - `wallet-radar.app/api/actions/radar-scan` → **HTTP 000** (dead).
  - `pay.cbellory.xyz/actions.json` → **HTTP 200**, `/api/actions/radar-scan` → **HTTP 200** (the x402 server serves the live Blink routes).
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
| 3 | Analyzer — 9 deterministic rules | LIVE | `ACTIVITY_BURST` fired; 9 rules unit-tested |
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
| 18 | **Autonomous canary agent** ("self-paying 24/7 + systemd unit") | GAP(2) | **process IS running** (log iter 1530, since 09-17) but as a bare process, not a managed systemd unit; its "self-pay" is a **dry-run**, not real USDC |
| 19 | **x402 pay-per-call** (HTTP 402 + on-chain USDC verify + settlement) | LIVE(handshake) / GAP(4) | 402 manifest live; **no real settled payment yet** |
| 20 | MCP server (6 tools) | CODE | stdio handshake + tools/list tested; `bin/mcp-server` |
| 21 | A2A agent surface (card + `/a2a`) | LIVE | card + `/a2a` live; T3N DID registration unverified |
| 22 | Agent SDK (`createRadarClient`, auto-pay, ledger read) | CODE | 12 SDK tests pass (real HTTP + payment + ledger) |
| 23 | **Solana Actions & Blinks** (Phantom/Solflare/Dialect deep links) | FIXED | Blink routes are **live on `pay.cbellory.xyz`** (`/actions.json` + `/api/actions/...` → HTTP 200); README/deep-links re-pointed from the dead `wallet-radar.app` |
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

### GAP 2 — canary / x402 / watch run as bare processes, not managed units (minor)
- Corrected after probing the box: the canary **is** running
  (`/tmp/canary.log` at iter 1530, started 09-17), as is the x402 server
  (`dist/src/x402server.js`) and the watch process (`dist/src/cli.js watch`).
  Only `radar-http.service` is a real systemd unit; the other three are bare
  processes. So the *features* work, but **auto-start / restart-on-crash /
  survive-reboot** for x402, canary, and watch is not guaranteed by a unit.
- Two nuances the README should state honestly: (a) the canary's "self-pay" is a
  **dry-run** (`X-Payment-Dry-Run: true` against the free `/selftest`) — it
  validates the x402 handshake, it does **not** move real USDC; (b)
  `deploy/canary-agent.service` exists but is not installed.
- **Fix (existing work):** install + enable proper systemd units for the x402
  server (and canary/watch) so all four services are managed, restart-on-failure,
  and start-on-boot (see PLAN / TASKS Batch 7).

### GAP 3 — Blink deep links pointed at a dead domain (FIXED this session)
- README/`src/blink` deep links (Phantom/Solflare/Dialect) used `wallet-radar.app`
  (HTTP 000, unreachable). The Blink/Actions routes are actually served by the
  **x402 server**, which is live on `pay.cbellory.xyz`: `/actions.json` → 200,
  `/api/actions/radar-scan` → 200 (verified).
- **Fix applied (existing work):** `getBlinkRegistrationManifest` default base is
  now `process.env.RADAR_BLINK_BASE_URL || "https://pay.cbellory.xyz"`; README,
  `src/blink/README.md`, `docs/oracle-spike.md`, and `src/sdk/README.md` deep
  links re-pointed to `pay.cbellory.xyz`. "One-tap in Phantom/Solflare" now
  points at a live host. (Optional follow-up: restore the `wallet-radar.app`
  CNAME if a branded domain is wanted.)

### GAP 4 — Self-funding loop: real settled revenue (VERIFIED this session)
- **CLOSED.** A real paid `/scan` settled actual USDC on **mainnet** via x402,
  and `/economics` now shows `revenue > 0`. Proof:
  - Payer (Wallet B `3fNN…5eYh`) paid **0.005 USDC** to the x402 recipient
    `F6wWPy4c…BNR` — tx `3ipJQte7…tNKg`, slot `448167017`, `meta.err = null`.
    Recipient USDC `0 → 0.005`; payer `2.700 → 2.695` (confirmed on-chain).
  - `POST /scan` with `X-Payment-Signature`/`X-Payment-Payer` → **HTTP 200**
    (full scan returned); the unauthenticated call → HTTP 402 as designed.
  - `GET /economics` → `revenue.totalUsdc 0.005`, `payments 1`,
    `byEndpoint["/scan"].amountUsdc 0.005`, `net.usd 0.0015`,
    **`selfSustaining: true`** (revenue 0.005 > tracked cost 0.0035).
- The settlement used a manual SystemProgram + Token create/init/`transferChecked`
  (equivalent to an ATA transfer); the SDK's ATA program-id bug that motivated
  this is fixed under *Housekeeping found*.

### GAP 5 (minor) — Jupiter pricing (VERIFIED this session)
- **CLOSED.** Jupiter pricing works on the pi: keyed `https://api.jup.ag/price/v3`
  (with `x-api-key`) and keyless `https://lite-api.jup.ag/price/v3` both return
  live prices (e.g. SOL ≈ 112, JUP ≈ 0.26). The earlier `pricesAvailable: false`
  was the audited wallet's legs being non-pricable (designed degradation), not a
  broken pricing path — `LARGE_SWAP` USD-normalization works when prices are available.

## What is safe to claim (post-fix target state)

- **Provable:** every Radar verdict is committed as an immutable, ZK-compressed,
  rent-free on-chain attestation owned by the scanned wallet; anyone can read
  the history. *(already live.)*
- **Self-funding:** the service earns real USDC per paid call via x402 and
  reports it in `/economics`. *(live — a real 0.005 USDC settled, `selfSustaining: true`.)*
- **Acting (advisory):** the radar escalates a defense stance and tightens the
  actionable verdict. *(live, decision-layer.)*
- **Enforced on-chain:** the chain reverts a Token-22 transfer to a flagged
  wallet. *(NOT yet live — GAP 1; target state via PLAN.)*

## Housekeeping found
- Stray scratch file at repo root: `_recover_nested.mjs` — remove.
- **SDK bug fixed:** `ASSOCIATED_TOKEN_PROGRAM_ID` was
  `ATokenGPvbdGVxr1b2hvZbsiqW5Pvf9z3579PJgND1R` — a **non-existent** mainnet
  program, which broke any ATA derivation / x402 ATA-payer path. Corrected to the
  canonical `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` (verified
  `executable: true` on mainnet; source `@solana/spl-token`). Build + 488/488 tests green.
