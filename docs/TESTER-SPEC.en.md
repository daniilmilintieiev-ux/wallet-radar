Translation of the Russian original docs/TESTER-SPEC.md. The Russian text is authoritative and was fixed before data collection began (see git history). In case of any difference, the original prevails.

# Wallet Radar Independent Tester Specification

**v2.2.** Status: **specification, implementation not started**. This document describes the protocol for independent evaluation of detection quality. It contains no code and does not imply that full-scale data collection is already underway (pilot collection of limited volume is a separate stage, see `ground-truth/outcomes/pilot/`, and neither substitutes nor completes this specification).

The rules from [CLAUDE.md](../CLAUDE.md) apply in full to the implementation of this specification: `src/` is not modified without an explicit task, labels are taken only from external sources, scripts and raw responses reside in `scripts/audit/` and `ground-truth/outcomes/`, no "fitting" of rules/thresholds/sampling after viewing results. `radar.env` is not read; if an RPC key is needed, it is supplied via the `HELIUS_API_KEY` environment variable without printing its value.

---

## 0. Unit of Test

**The unit of test is a trade, not a wallet**: `(wallet, mint, t)`, where `t` is the buy time (unix seconds, moment of on-chain buy transaction confirmation). A wallet may enter the dataset multiple times, once for each tracked buy.

Labeling is performed by a **script**, deterministically, based on the on-chain outcome occurring by `t + N` days (`N = 3`, **v2.2: unified horizon for criteria (a) and (b)** — see section 2; fixed prior to the first labeling run, not changed after viewing results — rule 4 CLAUDE.md). **Humans and AI agents (including Claude) do not write or edit individual labels manually** — only the labeling script itself does, version-controlled and reproducible.

---

## 1. Trade Sampling

**Sampling frame in one sentence:** buys of tokens younger than 14 days (from mint creation to buy time) on Jupiter/Raydium/PumpSwap, by a buyer wallet with a history of at least 20 transactions at buy time.

Formally, trade `(wallet, mint, t)` enters the frame if all conditions are satisfied:
1. `t - mintCreatedAt <= 14 * 86400` (token age at buy time).
2. Trade executed through one of the venues `{Jupiter, Raydium, PumpSwap}` (by the `source` field / invoked program IDs in the transaction — the same venue determination method already used in `src/analyzer.ts` for `NEW_VENUE`).
3. `wallet` at time `t` had `>= 20` prior transactions (`getSignaturesForAddress(wallet)` with `before=t`-equivalent cutoff or `gte-time`/`lt-time` window via `fetchWalletHistory`).

**Selection method:** trades are selected sequentially in order of on-chain appearance (not by random sampling from a large pool — at pilot scale, random sampling from an uncollected full set of trades is impossible: there is no way to enumerate "all trades on Jupiter/Raydium/PumpSwap in 14 days" other than traversing them in order). Traversal order: by blocks/slots ascending from a fixed starting point. When the frame becomes enumerable (see `docs/SHADOW-COLLECTOR.md`, prospective collection), it fixes **seed = `20261006`** (pilot collection start date in this specification, format YYYYMMDD, same principle as in `scripts/audit/trust-path-sensitivity.mjs`) — used where random selection of a SUBSET of already collected trades is needed (e.g. if collected trades exceed target N and a subsample without collection-time bias must be drawn).

**Test results apply only to this frame** and do not generalize to: tokens older than 14 days, venues outside Jupiter/Raydium/PumpSwap (Meteora, OpenBook, direct CPI swaps via other programs), wallets with history shorter than 20 transactions (including new/empty wallets — precisely the population where `WARMING`/`DORMANT_ACTIVE` are most relevant, and which is entirely excluded by the frame). This frame was chosen as a pilot for technical feasibility (fresh tokens on popular venues are easier to identify and their full history can be retrieved in a reasonable number of RPC calls), not because it is representative of all traffic seen by the radar.

### Two Strata (v2.1)

Within the frame, two non-overlapping strata are distinguished; metrics for them **are calculated and published separately, never summed** (into a single point estimate):

- **Stratum A — "regular new tokens":** trades from the frame above where the mint at time `t` has **no** active `freezeAuthority`/`mintAuthority` (both `null`, authorities already revoked by creator).
- **Stratum B — "new tokens with active authority":** the same trades, but the mint at time `t` has active `freezeAuthority` and/or `mintAuthority`.

Rationale for separate accounting: stratum B is precisely the population where `TOXIC_MINT` by construction can trigger via `hasFreeze`/`hasMint` (section 4); stratum A is the population where `TOXIC_MINT` cannot in principle trigger via authority (see limitation 12 in section 7 regarding pump.fun tokens without authority). Blending strata into a single FN/FP metric would mask whether the token rule functions where it is capable of functioning at all.

---

## 2. Outcome Definitions

Each trade `(wallet, mint, t)` is assigned one resulting class based on objective checks at `t+N`. Class `DANGEROUS` is assigned if (a) OR (b) OR (c) triggered, **and the token is not on the preregistered `ISSUER_CONTROLLED` list** (whose class is assigned in advance, by token rather than outcome — see below). Order of checking is from cheapest source to most expensive, but class assignment does not depend on order.

### (a) Frozen token account of the buyer

- **Data source:** `getAccountInfo(walletTokenAccount, {encoding: "jsonParsed"})` at time `t+N` — field `data.parsed.info.state`.
- **Criterion:** `state === "frozen"` on the buyer wallet's token account for the given `mint`, provided that at time `t` the state was NOT `"frozen"`.
- **Limitation:** the buyer's token account (ATA) must be known in advance — reconstructed from `tokenTransfers`/`postTokenBalances` of the buy transaction. If the buyer closed the ATA before `t+N` (`closeAccount`), `frozen` state cannot be reconstructed — such a trade is marked "unrecoverable" and excluded from the sample, not credited as `SAFE`.

### (b) Pair `liquidity.usd` drop >= 90% between `t` and `t+N`, EXCLUDING liquidity migrations (via DexScreener)

**v2.2: unified horizon.** (a) and (b) now share the same `N=3` (not separate `N_b` as in v2.1) — implementation (`scripts/shadow/outcomes.mjs`, `OUTCOME_HORIZON_DAYS`) evaluates both criteria in ONE pass over records older than `t+3` days, so separate horizons would only complicate code without substantive justification: (a) also requires a live query at `t+N` (token account state does not store history), meaning the limitation "honestly obtainable only prospectively" applies to BOTH criteria equally, not just (b). `N=3` was chosen for the prior reasons from v2.1: pairs of new/low-liquidity tokens disappear from DexScreener faster than a week; a shorter window reduces the share of `PAIR_MISSING`; sharp liquidity drains typically occur in the first days.

Criterion (b) is evaluated by polling the public DexScreener API: pair `liquidity.usd` at time `t` (value recorded by collector upon trade detection, section 4) and again at time `t+N`.

- **Source:** primary request — `GET https://api.dexscreener.com/latest/dex/pairs/solana/{pair}` (by specific pair address recorded upon trade detection, rather than by mint — eliminates ambiguity of "mint has multiple pairs"); `GET .../tokens/{mint}` is used only as a secondary query — to confirm that the pair indeed disappeared (not just this specific request), and to locate a successor pool upon migration.
- **Verified by live request** (2026-09-29): endpoint responds 200 without a key. Response headers: `cache-control: public, max-age=30` (CDN cache 30s), `cf-cache-status`, `age` — **no `x-rate-limit-*` headers in response** (unlike RugCheck, where the limit is visible directly in header — here it cannot be checked that way). Official documentation (`docs.dexscreener.com/api/reference`) states **300 requests/minute** for keyless `token`/`pair` endpoints — this is a documented figure, not observed runtime behavior; NOT VERIFIED whether the limit is truly 300 and what happens upon exceeding it.
- **Criterion:** `(liquidity_t - liquidity_t+N) / liquidity_t >= 0.90`.
- **Any API/network error during query (b) leaves outcome `NULL`** (retry on next `outcomes.mjs` run), **never treated as drop/DANGEROUS** — see section 5, exclusion rule 8.
- **Risk of pair disappearing from results by `t+N`:** if a direct request by pair address does not find it AND a repeat check `GET /tokens/{mint}` also finds NO pair for the mint — the trade is marked with class **`PAIR_MISSING`** (not "unrecoverable", a separate named class), entering neither DANGEROUS nor SAFE directly — reported in reports with **two bounds** (lower: treat as non-dangerous; upper: treat as dangerous), see `docs/SHADOW-RUNBOOK.md` §5.4a.
- **Migration exclusion (mandatory before applying criterion, v2.2: successor strictly AFTER `t`):** a drop counts as `DANGEROUS` only if the mint has **no** active successor pool at time `t+N` that received the bulk of released liquidity. A successor pool is a pool for the same mint on another venue with `liquidity.usd >= $1000` AND `pairCreatedAt > t` (**strictly later than the buy time itself**, not merely "in window `[t, t+N]`" — a pool already existing BEFORE the buy is not a "successor", even with high liquidity: it is unconnected to liquidity disappearing FROM this trade's specific pair). If a successor with `pairCreatedAt > t` is found — outcome is "liquidity migration, not outcome", excluded from DANGEROUS/SAFE, separate counter.
  - **Verified on 3 real examples** (commit `11dfe7f`, `scripts/audit/verify-pumpfun-migration.mjs`): for 3 tokens that migrated from pump.fun bonding curve to PumpSwap (found via public DexScreener search `?q=pumpswap`), the source bonding-curve PDA was drained to ~rent-exempt minimum (1,285,240–1,417,320 lamports), while the independently discovered DexScreener successor pool held real liquidity ($27,482–$88,630) at the same time. Method confirmed, not "NOT VERIFIED".
- **Limitation:** the pair is identified by specific address recorded at trade detection (section 4) — not re-selected by mint at time `t+N`, so there is no ambiguity of "mint has multiple pairs" for criterion (b) ITSELF; ambiguity remains only when searching for a successor pool (there a mint may indeed have multiple pairs).
- **Consequence for retrospective collection (pilot, section 5):** because values "at time `t`" for criteria (a) AND (b) are honestly obtainable only via live request at moment `t`, retrospective labeling of already past trades will almost always yield "unrecoverable"/`PAIR_MISSING` (no way to query DexScreener or check ATA state in the past retroactively). Criteria (a) and (b) operate fully only in prospective mode (section 6, `docs/SHADOW-COLLECTOR.md`), where query at `t` is executed immediately upon trade detection.

### (c) Third-party label `rugged` (RugCheck), if available

**Verified by live request** (commit `e910f2a`, keyless, `GET https://api.rugcheck.xyz/v1/tokens/{mint}/report`):
- Operates without an API key for reading; response header `x-rate-limit-limit: 15` (window not specified in docs/headers — treat conservatively, no more than ~15 requests in sequence without pause).
- Response includes `rugged: boolean` and `detectedAt: <ISO timestamp>`, as well as `events: []` (empty array in both tested mints; semantics of populated `events` for a genuinely "rugged" token **NOT VERIFIED** — no test example with `rugged: true` was found).
- **Critical limitation confirmed by query:** `rugged`/`score`/`events` represent **current state computed at query time**; the API has no "as of date X" parameter or historical score log. Using this field for `t+N` labeling is valid only if the query was executed ACTUALLY at time `t+N` (prospectively, see `docs/SHADOW-COLLECTOR.md`) or if `detectedAt` itself falls in the interval `[t, t+N]`. Querying RugCheck today and attributing the result to past date `t+N` is the exact lookahead bias recognized as an error in `mint.ts` (see CLAUDE.md) — **this must not be done**.
- If `detectedAt` is outside `[t, t+N]` or endpoint is unavailable / rate limit exhausted — source (c) for this trade is marked **NOT VERIFIED**, counting toward neither `DANGEROUS` nor `SAFE`.

### Separate Class: `ISSUER_CONTROLLED` — Assigned IN ADVANCE, by Token, Not Outcome

**Change from v1:** in v1, `ISSUER_CONTROLLED` was assigned post-factum if outcome (a)/(b) fired for the trade. In v2, membership in `ISSUER_CONTROLLED` is a property of the **mint itself**, known and fixed **prior to** outcome checking, rather than a consequence of an outcome proving "bad". This eliminates a source of systematic bias: post-factum assignment makes classification dependent on the result it is meant to explain.

- **List of identified issuers is fixed by preregistration**, in a separate versioned file `ground-truth/issuer-controlled-mints.jsonl` (format: `{mint, issuer, sourceUrl, checkedAt}`), compiled PRIOR to outcome collection start for a specific test run. Starting set — from stage 4B of this work (commits `582b85f`, `b48693d`): xStocks/Backed (docs.xstocks.fi), Backpack Securities (support.backpack.exchange), PreStocks (prestocks.com), USD1/World Liberty Financial (docs.worldlibertyfinancial.com — exact address match confirmed), JupUSD/Jupiter (docs.jup.ag — exact match confirmed), CASH/Bridge-Phantom (help.phantom.com).
- A trade with `mint` present on this list at time `t` is classified as `ISSUER_CONTROLLED` **regardless of whether outcome (a)/(b) fired or not** — just as a regular trade receives `SAFE` if nothing fired.
- **How FP is calculated for `ISSUER_CONTROLLED` tokens:** by the same definition as regular FP (radar blocked / gave `manual_review`, but no actual dangerous outcome occurred by `t+N`) — calculated and published as a **separate line**, not summed into primary FP. Expectation: FP rate on `ISSUER_CONTROLLED` may be noticeably higher than primary (these tokens structurally have active freeze/pause with the issuer, intended to trigger `TOXIC_MINT` via `hasFreeze`) — this is expected and documented behavior, not grounds to exclude these trades from reporting.
- If outcome (a)/(b) did fire for an `ISSUER_CONTROLLED` token (issuer genuinely froze / drained liquidity) — this is recorded via a separate flag `issuerControlledOutcomeFired: true` in raw output, but **enters neither** primary `DANGEROUS` counter nor primary `SAFE` counter, only separate statistics for this class.

---

## 3. Reconstructing Mint State at Time `t`

**Problem confirmed in stages 3–4:** `mint.ts` cannot provide historical snapshots — `getAccountInfo`/`getTokenLargestAccounts` always return state AT QUERY TIME, not at slot/date `t`. Solana full-node RPC stores no historical account state without an archival indexer.

### Permissible Simplified Path (Adopted for Primary Test)

Include in the primary test **only those `mint`s having zero `SetAuthority` instructions in their entire transaction history** (for neither `mintAuthority` nor `freezeAuthority`) after mint creation. For such mints, current authority state equals state at any past moment `t`, including buy time — no reconstruction needed, zero lookahead bias by construction.

Remaining mints (where `SetAuthority` occurs at least once) **are excluded from the primary test** and accounted for in reports under a separate line "unrecoverable (authority changed)".

### Verified by Live Request (commit `e910f2a`)

`getSignaturesForAddress(mint, {limit: 1000})` on public `api.mainnet-beta.solana.com` **operates without a key**. For a test mint (442 signatures across entire lifetime), all returned in a single call.

**Limitations:**
- Maximum 1000 signatures per call — mints with longer history require pagination via `before` cursor.
- Verifying `SetAuthority` requires `getTransaction` **for every signature** — for a dataset with hundreds of trades, this may be impractical on free RPC without an explicit cap. **Cap for pilot (section 6B): first 1000 signatures from mint creation per mint**, with no further pagination — if `SetAuthority` is not found in these 1000, the mint is considered to have passed the filter for pilot purposes, with the explicit caveat that `SetAuthority` beyond the first 1000 signatures will not be detected by this method.

### Holder Concentration at Time `t`

**Reconstruction is impossible without a paid indexer** — `getTokenLargestAccounts` does not support historical snapshots and proved hard-blocked on free public RPC (commit `582b85f`, confirmed on 3 different free RPCs regardless of mint, including USDC). This feature **is disabled entirely in the test** (see section 4 regarding `mintRisk`).

---

## 4. Tested Paths and Data Received by Radar

### First (Primary) Path: `POST /gate-copy` with `mint` and `mintRisk`

According to stage 3A of this work, this is the sole HTTP route that actually fetches and passes `mintRisk` to `simulatePayment` (unlike the eponymous MCP tool `radar_gate_copy`, which does not — see `src/mcp.ts`, stage 3A finding). It is HTTP `/gate-copy` that is tested.

### Second Path: `radar_trust` (MCP) / `POST /trust` — without `mintRisk`

Confirmed in stage 3A: `trust.ts:329` invokes `detectAnomalies` without the `mintRisk` argument — structurally incapable of accounting for `TOXIC_MINT`. Results for this path are reported in a **separate table**, never averaged with the first path.

| | `/gate-copy` (mint + mintRisk) | `radar_trust` / `/trust` (without mintRisk) |
|---|---|---|
| TOXIC_MINT available | yes | structurally no |
| Expected FN rate | lower (per 5A data: mintRisk resolves up to 55/58 omissions in benchmark under same window) | higher |
| Primary test path | yes | no, informational |

### How `mintRisk` Received by Radar is Formed

`mintRisk` is constructed by the tester **manually**, not via `fetchSwapMintRisk`/`fetchMintMetadata` from `src/mint.ts` (that function always reaches out to the network for current state) — but from data already reconstructed at time `t` (section 3):

```
mintRisk[mint] = {
  mintAuthority: <address at t if mint passed section 3 filter, otherwise NOT VERIFIED>,
  freezeAuthority: <address at t if mint passed section 3 filter, otherwise NOT VERIFIED>,
  top10Pct: null,   // ALWAYS null -- unrecoverable at t (section 3), passing current value is prohibited
  isPumpFun: <by address suffix, requires no reconstruction>,
}
```

`top10Pct: null` is not data omission, but a deliberate decision: in `analyzer.ts`, the condition `concentrated = top10 != null && top10 >= 60` with `top10 === null` is always `false`, meaning `TOXIC_MINT` continues to function via `hasFreeze`/`hasMint`, but never triggers via concentration — exactly the constraint the test requires (section 3: concentration at `t` is unrecoverable, so its contribution to verdict must be literally excluded, not approximated with current value).

For mints failing the section 3 filter (`SetAuthority` present in history), `mintRisk[mint]` is not passed to the radar at all (trade excluded from sample at stage 3 — prior to invoking radar).

### Field `mintRiskFetched` (v2.2)

The `POST /gate-copy` response contains no explicit boolean field "mint metadata was successfully fetched" — determined indirectly by the presence of `TOXIC_MINT`/`CONCENTRATION` in `details.simulation.wouldTrigger` of the response:
- `wouldTrigger` contains `TOXIC_MINT` or `CONCENTRATION` -> `mintRiskFetched = true` (this is possible only if the mint metadata query actually succeeded and returned freeze/mint authority or concentration).
- Otherwise -> `mintRiskFetched = "NOT_DETERMINABLE"` (**not** `false`) — absence of rule trigger does not prove query failure: the mint may simply be "clean". Recording `false` would be an unproven claim.

Saved in every record (`shadow_trades.mint_risk_fetched`, see `docs/SHADOW-COLLECTOR.md`/`docs/SHADOW-RUNBOOK.md`).

### Radar as a Black Box — Pipeline Independence

1. Tester supplies radar only data available at time `t` (wallet history strictly prior to `t`, `mintRisk` as described above).
2. Outcome labels (section 2) are computed by a separate process with no access to radar verdict until after outcome is recorded. Order: (request to radar -> verdict recording) and (outcome computation at `t+N`) are independent pipelines, compared only at analysis stage, never during collection.
3. Test script does not use radar internal rules/thresholds as labeling input (prohibited by `ground-truth/PROTOCOL.md`, item 3.1).

---

## 5. Preregistration

Fixed **prior to first run** of data collection, published in `ground-truth/` alongside date and commit hash. Any deviation after viewing results = new numbered experiment (rule 4 CLAUDE.md).

- **Sampling frame:** section 1 (tokens younger than 14 days, Jupiter/Raydium/PumpSwap, buyer with >= 20 transactions). Result applies only to it.
- **N (outcome horizon):** 3 days, unified for (a) and (b) (v2.2, section 2).
- **Minimum sample size:** not less than **30 dangerous outcomes** (`DANGEROUS`, excluding `ISSUER_CONTROLLED`) to publish a quantitative metric. Under 30 — report result is **"insufficient data"**, not a number.
- **Holdout sample: REMOVED in v2.** Rationale (one paragraph): holdout guards against fitting thresholds/rules to test data — thus needed when a calibration step exists. In this protocol there is no calibration whatsoever: radar rules and thresholds are fixed in code PRIOR to test data collection and do not change mid-flight (rule 4 CLAUDE.md prohibits changing them after viewing results in any case — a stronger guarantee than holdout). At pilot and even target scale (dozens to low hundreds of dangerous outcomes), a 70/30 split leaves both halves too small for separate confidence intervals, offering nothing in exchange for risk. If/when the sample grows by an order of magnitude (thousands of trades, hundreds of dangerous outcomes) and any step appears that depends on intermediate run results (e.g. revisions to sampling protocol based on first run) — holdout must be reintroduced specifically for THAT step, as a separate numbered experiment, not retroactively into current run.
- **Exclusion rules** (exhaustive list, applied automatically by script):
  1. Trade outside sampling frame (section 1).
  2. Mint with `SetAuthority` in history (section 3) — "unrecoverable (authority changed)".
  3. Buyer token account closed before `t+N` — "unrecoverable (ATA closed)".
  4. Trade pool not unambiguously identified — only for check (b).
  5. Liquidity migration detected with successor created after `t` (section 2b) — "migration, not outcome".
  6. Address overlaps with `archive/exp1/large-wallets.json` (commit `ab316b2`) — excluded completely.
  7. Duplicate `(wallet, mint, t)` — first occurrence by collection time is taken.
  8. **(v2.2)** API/network error during outcome evaluation (a) or (b) — outcome remains `NULL`, retried on next run; **never counted as `DANGEROUS`**.
  9. **(v2.2)** Pair disappeared from DexScreener at `t+N` (after confirmation via `/tokens/{mint}`) — class `PAIR_MISSING`, separate from DANGEROUS/SAFE, reported with two bounds (`docs/SHADOW-RUNBOOK.md` §5.4a).
- **Metrics:**
  - Full confusion matrix (TP/FP/TN/FN), separately for each of the two paths (section 4) **and separately for each stratum A/B (section 1)** — 2x2 = 4 independent matrices minimum, never summed into a single aggregate number.
  - **FN rate** = `FN / (FN + TP)` across `DANGEROUS` trades, with **Wilson confidence interval**, computed for each stratum separately.
  - **FP rate** across regular (non-`DANGEROUS`, non-`ISSUER_CONTROLLED`) trades, with Wilson interval, computed for each stratum separately.
  - Same two metrics as a separate line for `ISSUER_CONTROLLED` (section 2), including `issuerControlledOutcomeFired` breakdown (`ISSUER_CONTROLLED` by construction falls almost entirely into stratum B — active issuer authority — but is computed as its own separate line, not merged into stratum B).
  - **(v2.2)** Stratum B trades where buyer failed to resolve (`buyer IS NULL`), and trades with `RADAR_ERROR` (HTTP status of `/gate-copy` != 200) **are reported as a separate line** and enter neither numerator nor denominator of FN/FP for any stratum — genuine radar verdict was never obtained for them; including them would either depress or blindly inflate FN/FP.
  - **(v2.2, stage 7D)** **Share of `NO_BUYER`** (`buyer IS NULL / total discovered pools in frame`, section 7 limitation 14) is published as a separate line **for each stratum separately** (not only stratum B) — indicator of how often the first resolved buyer is unreachable within `BUYER_CANDIDATE_SCAN_LIMIT = 20` transactions, independent of FN/FP.
  - Breakdown of FN by outcome source (a)/(b)/(c) and their intersections, separately by strata.
  - The 30 dangerous outcomes rule (above) applies **to each stratum separately**: if stratum A has under 30 `DANGEROUS`, for stratum A result is "insufficient data", even if stratum B has already reached 30 or more.

---

## 6. Shadow Prospective Test Mode

See separately [docs/SHADOW-COLLECTOR.md](SHADOW-COLLECTOR.md) — prospective collector design, removing part of the retrospective protocol's limitations (primarily: reconstruction of state at `t`, unneeded in prospective collection: data is recorded at moment `t`, not reconstructed later; and full criterion (b) via DexScreener, see section 2, available only in this mode).

**Difference in sampling frame from pilot (section 1) — v2.1:** for the shadow (prospective) frame, the filter "buyer >= 20 prior transactions" is **removed**. Rationale: in the pilot (retrospective) frame, this filter was primarily a cheap technical way to approximate "not wallet's first buy" via already cached data; prospective collector is unconstrained by cache and can honestly determine wallet age/history on the fly, so there is no technical reason to keep the filter — and substantively it cuts out precisely the population (thin/zero buyer history) where `WARMING`/`DORMANT_ACTIVE` are maximally relevant (see section 1, limitation 11 of old frame), recognized as an undesirable narrowing rather than intentional design. Prospective frame tracks **all** buys of tokens younger than 14 days on Jupiter/Raydium/PumpSwap regardless of buyer history. Metrics on prospective sample are not mixed with pilot retrospective figures (these are different frames, section 1 "Test results apply only to this frame" — each frame version is computed separately).

---

## 7. Limitations — What This Test Cannot Prove

1. **Does not measure overall radar "accuracy" as a single number.** The two tested paths (section 4) yield different verdicts on identical data (quantitatively: commits `e0cd996`, `2216315` — 55 of 58 benchmark verdicts depend on `mintRisk`, which `radar_trust` lacks in prod). The test explicitly indicates which path is tested.
2. **Does not cover top10Pct / holder concentration at time `t`** (section 3) — if an exploit manifests exclusively via concentration, the test will not observe it.
3. **Does not cover mints with `SetAuthority` history** — systematically excludes the exact case "authority appeared after buy", potentially most interesting from a risk perspective. Biases sample toward "simpler" cases. Prospective mode (section 6) does not share this limitation.
4. **Does not cover `mintAuthority` abuse without freeze** — secondary token issuance (supply inflation via `MintTo` after buy), which dilutes buyer share without freezing their account and without necessarily collapsing pool liquidity by 90% quickly. Neither (a), nor (b), nor typical RugCheck `rugged` flag reliably catch this scenario — outside current outcome definitions.
5. **Does not cover "inability to sell without formal freeze"** — honeypot mechanics via `transferHook` (hook program with custom logic selectively blocking outgoing transfers) or `permanentDelegate` (issuer can confiscate tokens from holder without freezing account) produce the effect "cannot sell" / "tokens disappeared" without token account `state` ever becoming `"frozen"`. Criterion (a) will not catch them; requires a separate, undescribed criterion (simulation of `sell` instruction against hook program) — outside scope of current specification.
6. **RugCheck is not a ground truth source**; scoring methodology is not publicly documented in verified sources. Match/mismatch with RugCheck is an auxiliary signal, not an arbiter.
7. **N=3 days (v2.2) is an arbitrary, pre-fixed threshold, shorter than original N=7.** A rug pull on day 4 will be counted as `SAFE` despite bad outcome — shortening the window (for technical feasibility of (a)/(b) prospectively, section 2) reduces chance of catching slower (non-instantaneous) drains that longer `N=7` might catch.
8. **Minimum 30 dangerous outcomes is minimum for publishing a number, not a guarantee of statistical power.** Wilson interval at n=30 remains wide.
9. **Not an adversarial test** — passive observation, does not verify bypass of detector by targeted attacker (see `ADVERSARIAL-TESTING.md`, which tests something different: x402/hook invariants).
10. **`ISSUER_CONTROLLED` depends on completeness of preregistered issuer list** (section 2) — a legitimate issuer missed from the list will be erroneously counted toward primary danger metrics until next list revision.
11. **(v2.2) Source of new pool discovery (GeckoTerminal `new_pools`) is not representative of all new pools on Solana.** GeckoTerminal indexes pools via its own pipeline with its own latency and venue coverage (observed ~1 minute latency and labels `pump-fun`/`pumpswap`/`raydium`/`stonkfun` at verification time, `docs/SHADOW-COLLECTOR.md`) — pools that GeckoTerminal for any reason fails to index at all (outage, specific DEX outside coverage, temporary unavailability) cannot enter the sample in principle, and this shortfall is neither measured nor corrected. Test result characterizes "new pools seen by GeckoTerminal", not "all new pools on Solana".
11. **Sampling frame (section 1) is not representative of all radar traffic.** Result does not transfer to tokens older than 14 days, wallets with thin history (except prospective frame, section 6, where this filter is lifted), or venues outside Jupiter/Raydium/PumpSwap.
12. **Does not cover developer/deployer selling directly along bonding curve.** Classic pump.fun rug — deployer holds large share on bonding curve itself (prior to AMM migration) and sells via `Sell` instruction of program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, crashing price for holders — is not a "freeze" (a), not necessarily a 90% drop in `liquidity.usd` under criterion (b) (bonding curve itself is not an AMM pair indexed by DexScreener prior to migration), and RugCheck (c) may fail to respond within `[t, t+N]`. Detecting such sales requires a separate criterion (monitoring `Sell` instructions from mint creator address on its own bonding curve) — not described in this version of specification.
14. **(v2.2, stage 7D) Buyer = first resolved buyer of new pool, not a sample of "real copy-traders".** `scripts/shadow/collect.mjs` (`resolveBuyer`) takes the first transaction after pool creation where token recipient is a System-owned non-PDA account distinct from the pool creation transaction fee payer. This definition **does not filter**:
    - snipers and trading bots (wallets specifically monitoring new pool creation and buying in first seconds — typical profile for "first buyer" on popular venues);
    - token creator wallets from a DIFFERENT address than pool creation transaction fee payer (only match against fee payer itself is checked — creator buying from pre-funded second wallet passes as regular buyer).

    Consequence: test result (shares of `DANGEROUS` across strata, section 4.2–4.3 `docs/PREREGISTRATION.md`) characterizes radar behavior on the population "first resolved buyer", systematically biased toward snipers/bots relative to real copy-traders (humans copying trades of other wallets with latency in seconds-minutes rather than milliseconds) — **result does not transfer** to the population of copied traders for whom the tool is primarily intended (README.md, copy-trading firewall). The share of trades where buyer failed to resolve at all (`NO_BUYER`, `buyer IS NULL`) within `BUYER_CANDIDATE_SCAN_LIMIT = 20` transactions is published as a **separate report line** (enters denominator of FN/FP for neither stratum, section 5 below) — serving in itself as an indicator of how often "first resolved" is unreachable within a reasonable count of checked transactions.
15. **pump.fun tokens without active authority do not test the token rule at all.** Most pump.fun tokens have `mintAuthority`/`freezeAuthority` revoked immediately upon creation (this is stratum A, section 1) — for them `mintRisk.freezeAuthority`/`mintAuthority` are both `null`, and `top10Pct` in this test is always `null` (section 4) — meaning `TOXIC_MINT` structurally **cannot trigger at all** on any of the three grounds (`hasFreeze`/`hasMint`/`concentrated`) for all of stratum A, regardless of how objectively risky the token is by other signals (e.g. high holder concentration or bonding curve mechanics). Radar in this test on stratum A can block a trade only via NON-token rules (`REGIME_SHIFT`, `LARGE_SWAP`, etc. on buyer wallet side) — token risk of stratum A is fundamentally not measured by the test.
