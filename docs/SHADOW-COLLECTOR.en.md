Translation of the Russian original docs/SHADOW-COLLECTOR.md. The Russian text is authoritative and was fixed before data collection began (see git history). In case of any difference, the original prevails.

# Shadow Prospective Collector Design

Status: **design only, not implemented, not running**. Refers to the protocol in [docs/TESTER-SPEC.md](TESTER-SPEC.md) (section 6). Nothing in this document implies that the collector is already operating anywhere.

---

## 1. Trade source (revised in stage 7B based on live comparison results)

Similar, but not identical to the frame from `TESTER-SPEC.md` section 1: tokens younger than 14 days, venues Jupiter/Raydium/PumpSwap — **but without the filter "buyer has >= 20 prior transactions"** (see `TESTER-SPEC.md` section 6 — removed in v2.1 specifically for the prospective frame: there is no technical reason to keep it here, and substantively it cuts out the population where `WARMING`/`DORMANT_ACTIVE` are most relevant).

### Source of NEW POOLS: comparison by live requests (2026-09-29)

The initial version of this document proposed `logsSubscribe` to venue programs as the sole source. Per stage 7B assignment, the choice was revised: **first check GeckoTerminal `new_pools`, if unsuitable — `logsSubscribe`.**

**GeckoTerminal `GET https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=N`** — verified by a live request:
- Responds 200 without an API key; field `data[].attributes.pool_created_at` is the genuine pool creation timestamp (ISO 8601), no need to compute/observe anything independently.
- **Indexing latency, measured:** request at `2026-09-29T10:05:44.914Z` returned pools with `pool_created_at` from `10:04:20Z` to `10:04:57Z` — **latency ~50–85 seconds**, well within the required 15 minutes (task 1 `POOL_MAX_AGE_MINUTES`).
- Field `relationships.dex.data.id` gives the venue directly (`pump-fun`, `pumpswap`, `raydium`, as well as irrelevant `stonkfun` etc. — filtered out by regex `^(raydium|pump-?fun|pumpswap)`).
- Pagination: 20 entries/page, pages ordered newest-first — one can stop as soon as a page provides no entries within the freshness threshold.
- **Rate limit:** no `x-rate-limit-*` headers in the response (`cache-control: max-age=30, s-maxage=60` is the sole hint of caching). Official GeckoTerminal support documentation confirms **30 requests/minute** for the public API — figure from documentation, not from response headers.
- **Conclusion: suitable, selected as primary source.** The `logsSubscribe` alternative was not needed — fallback plan preserved below in case GeckoTerminal becomes unavailable or changes format.

Detection flow (implemented in `scripts/shadow/collect.mjs`, `fetchFreshPools`):
1. `GET new_pools?page=N` (iterating pages while fresh entries appear, up to 5 pages).
2. Filter by `dexId` (venue) and `pool_created_at` no older than `POOL_MAX_AGE_MINUTES=15` **at collection time**.
3. Candidate mint — `relationships.base_token.data.id` (format `solana_<mint>`).
4. Separately, for each candidate — check TOKEN age (not pool age) via DexScreener `/tokens/{mint}`: minimum `pairCreatedAt` across all pairs no older than `TOKEN_MAX_AGE_DAYS=14` (`checkTokenAge`) — a fresh pool of an already established token does not enter the frame, counted in `TOKEN_TOO_OLD`.
5. Trade `t` — **not** `pool_created_at`, but `blockTime` of the actual buy transaction (section 2 below, `resolveBuyer`).

**Fallback plan (not needed, but described in case of GeckoTerminal failure):** subscription to logs of the three venue programs via `logsSubscribe` (WebSocket, Solana RPC) — `Jupiter Aggregator v6` (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`), `Raydium AMM v4`/`CPMM`/`CLMM`, `pump.fun`/`PumpSwap` (program addresses are the same constants already present in `src/mint.ts:KNOWN_AMM_PROGRAMS`). Each log match -> `getTransaction` -> `extractSwap` (reused from `src/analyzer.ts`) -> candidate pool-creating transaction. Not implemented, as GeckoTerminal proved suitable.

**What switching to GeckoTerminal removes:** the former "degenerate edge case at start" (14 days of observation before the collector could confidently determine a mint's age) is completely removed: `pool_created_at`/`pairCreatedAt` provide real timestamps from day one of collector operation, no independent observation required.

---

## 2. What is preserved at time `t`

Immediately (within one block of detecting the trade), with a single record per trade:

| Field | Source | Note |
|---|---|---|
| `mint`, `pair`, `t`, `buyer`, `buyer_tx_signature` | `resolveBuyer` (section 3) | `t` = `blockTime` of the BUY transaction, not pool creation; `buyer` can be `NULL` if no candidate passed the System-owned/non-executable/non-PDA/non-creator-fee-payer check |
| `mintRiskAtT` (`mint_authority`, `freeze_authority`, `token_program`, `token_2022_extensions`) | `getAccountInfo(mint)` at detection time | `top10Pct` is intentionally NOT collected at all (neither passed nor `null`-stubbed in a separate field) — same reason as in `TESTER-SPEC.md` section 4: unrecoverable even prospectively, `getTokenLargestAccounts` is blocked on free RPC (commit `582b85f`) |
| `strat` | `determineStrat(mintRiskAtT)` | A/B, `TESTER-SPEC.md` v2.2 section 1 |
| `http_status`, `copy_amount_usd`, `mint_risk_fetched` | `POST /gate-copy` response | `http_status` — response code (non-200 = `RADAR_ERROR`, `radar_verdict` is then `NULL`, error in `radar_error`); `copy_amount_usd` — fixed constant `COPY_AMOUNT_USD`, recorded verbatim; `mint_risk_fetched` — `"true"`/`"NOT_DETERMINABLE"` (`TESTER-SPEC.md` v2.2, section 4) |
| `radar_verdict` / `radar_error` | `POST /gate-copy`, called immediately after buyer resolution, BEFORE the outcome is known | full response object on 200; on non-200 — `radar_verdict=NULL`, error body in `radar_error` |
| `radar_code_version` | `git rev-parse HEAD` of radar at call time | to distinguish future code changes from data changes |

The radar verdict is requested **immediately after** trade detection, but **before** any outcome labeling — this sequence guarantees that the radar physically cannot see the outcome (it does not yet exist: `t+N` is in the future).

---

## 3. Storage format

`ground-truth/outcomes/shadow/YYYY-MM-DD.jsonl` — one line per trade, one daily folder/file for the day of detection (not day of outcome — partitioned by `t`, so that "computing remaining outcomes" makes it easy to find required files by date range). Each line is a self-contained JSON object with all fields from section 2 plus `outcomeComputedAt: null` (populated by a separate process at `t+N`, see section 4) and `outcome: null` prior to that point.

Duplicate index `ground-truth/outcomes/shadow/index.jsonl` — one line `{wallet, mint, t, file}` per trade, for fast record lookup without rereading all daily files in their entirety (the requirement "do not read large JSON files in whole" applies to future collector operation as well, not just this session).

---

## 4. Outcome computation schedule

A separate process independent of the trade collector ("outcomes evaluator"), runs **once daily** (not continuously — outcome is determined once, exactly at `t+N`, re-evaluations are unneeded and prohibited by protocol, avoiding temptation to "re-evaluate later if outcome is undesirable"):

1. Finds all records with `t <= today - N days` and `outcome === null` (using the section 3 index, without reading all daily files).
2. For each — runs criteria (a)/(b)/(c)/`ISSUER_CONTROLLED` from `TESTER-SPEC.md` section 2 and (for (b)) liquidity migration check.
3. Records `outcome` and `outcomeComputedAt` = current timestamp (not `t+N` — honestly records when it was ACTUALLY computed, distinct from the moment to which it pertains).
4. Touches nothing in `radarVerdict` saved at the collection step — verdict and outcome reside physically in different fields of the same immutable (append-only) record.

---

## 5. Daily request volume estimate

Rough estimate, not a measurement (collector is not running):

- **Trade detection:** 1 `logsSubscribe` subscription per program x 3 venues — consumes no REST quota (WebSocket push), but each triggered match requires 1x `getTransaction` for decoding. Order of magnitude: per pilot data (section 6B `TESTER-SPEC.md`) — 3,291 candidate buys were found among 44,798 transactions of 1,001 cached wallets — meaning venue transactions of token holders are far from rare; for the stream of NEW tokens across 3 venues, a realistic estimate is **low thousands of transactions per day**, of which after the "token younger than 14 days" filter (filter "buyer >= 20 tx" is absent in prospective frame, section 1) an order of magnitude fewer will remain — **dozens to low hundreds of trades per day**, entering the sample frame.
- **For each trade entering the frame:**
  - 1x `getAccountInfo(mint)` (mintRisk at t).
  - 1x `POST /gate-copy` (internal call, not RPC, but loads the radar service itself).
  - 1x `getTransaction` (already accounted for at detection step, reused).
  - **Total ≈ 2 external RPC calls per trade** entering the frame (less than in the pilot retrospective frame — which also required `getSignaturesForAddress(wallet)` to verify >= 20 tx, absent here).
- **For each trade at outcome computation (unified horizon `t+N`, `N=3`, `TESTER-SPEC.md` v2.2):**
  - 1x `getTokenAccountsByOwner` (buyer token account state, criterion (a)).
  - 1x DexScreener `/pairs/solana/{pair}` request (`liquidity.usd`, criterion (b); 300 requests/min per DexScreener documentation, keyless) + 0-2x repeated DexScreener requests (`/tokens/{mint}`) if pair is not found directly (to confirm `PAIR_MISSING`) or drop >= 90% is detected and migration needs checking.
  - 0-1x RugCheck request (criterion (c), if implemented; under live `[t, t+N]` window — at most `x-rate-limit-limit: 15` at a time, commit `e910f2a`).
  - **Total ≈ 2-4 requests per trade** at outcome computation, under a single `t+N` horizon for both criteria (a) and (b).

**Overall rough estimate:** with dozens to low hundreds of trades in frame per day — **on the order of 150–1200 external RPC/API requests per day** across the entire pipeline (detection + labeling at `t+N_b`/`t+N`), excluding rejected candidates that fail the age filter at step 1 (which cost one `getAccountInfo`/`getSignaturesForAddress` each and are screened out earlier, before entering the main count). This is an order-of-magnitude estimate for planning (whether a paid RPC is required in prod), not a measured figure — the collector has not been run.

---

## 6. Not implemented and not running

This document is a design. Nothing in sections 1–5 has code in this repository at the time of writing. Implementation (if requested separately) is a new stage, with its own commits, starting with the simplest piece (e.g., section 2 only — trade recording at moment t without outcome computation), not the entire pipeline all at once.
