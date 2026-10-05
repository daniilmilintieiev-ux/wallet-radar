# Preregistration — Wallet Radar Shadow Prospective Run

> **Translation note:** Translation of the Russian original docs/PREREGISTRATION.md. The Russian text is authoritative and was fixed before data collection began (see git history). In case of any difference, the original prevails.
>
> **Sub-item Mapping Table (Cyrillic to Latin):**
> This document maps Cyrillic lettered subsections in the original text to Latin letters alphabetically:
> | Russian | Latin | Subsections occurring in text |
> |---|---|---|
> | а | a | 14a, 15a, 17a, 18a, 19a |
> | б | b | 14b, 15b, 17b, 18b, 19b (referenced as §15b, §17b) |
> | в | c | 14c, 15c, 17c, 18c, 19c (referenced as §15c, §17c; README.md section 17c) |
> | г | d | 14d, 15d, 17d, 18d, 19d |
> | д | e | 14e, 15e, 17e (referenced as §15e) |
> | е | f | 14f, 15f, 17f |
> | ж | g | 15g, 17g (referenced as §15g; transliterated as 15zh in KNOWN-ISSUES.md) |
> | з | h | 15h, 17h |
> | и | i | 15i |


**Status: preregistration, fixed BEFORE the first dry/live run of the shadow collector.** Pertains to [docs/TESTER-SPEC.md](TESTER-SPEC.md) **v2.2** and the prospective (shadow) collection frame described in TESTER-SPEC.md §6 and [docs/SHADOW-COLLECTOR.md](SHADOW-COLLECTOR.md) — not to the retrospective pilot of §1/§5 of that same document (which has its own, narrower frame with the "buyer >= 20 transactions" filter).

The rules from [CLAUDE.md](../CLAUDE.md) apply in full, specifically rule 4: **any deviation from the provisions of this document after viewing collection results = a new numbered experiment, rather than retroactively editing this file.**

**Code version is fixed by tag `shadow-v1`** (`git tag shadow-v1`, commit `7a1387872f8e66019c081d37d88cbc729030d2fd` — includes stage 7B: prospective collector on GeckoTerminal `new_pools`, verified buyer identification; and stage 7C: `scripts/shadow/preflight.mjs`). No dry or live run had been executed against this tag at the time preregistration was fixed. Any change to `src/`, collector thresholds (`POOL_MAX_AGE_MINUTES`, `TOKEN_MAX_AGE_DAYS`, `COPY_AMOUNT_USD`, `OUTCOME_HORIZON_DAYS`), sampling frame, or outcome criteria after run results are seen requires a new tag (`shadow-v2`, etc.) and a new numbered experiment — edits to the current tag / this file are prohibited.

---

## 1. Unit of Test

Trade `(wallet, mint, t)`, where:
- `wallet` — **buyer** wallet, identified by collector as the first transaction AFTER pool creation where token recipient is verified via `getAccountInfo` as a System-owned, non-executable account, non-PDA, and not the fee payer of the pool creation transaction (`scripts/shadow/collect.mjs`, `resolveBuyer`/`classifyAccountForBuyer`, task 3 stage 7B);
- `mint` — token address;
- `t` — unix timestamp (`blockTime`) of the BUY transaction (not pool creation, not mint creation).

A single wallet may enter the dataset multiple times — once for each tracked buy. Outcome labeling is performed solely by script (`scripts/shadow/outcomes.mjs`), deterministically, with no manual editing of individual labels (CLAUDE.md, rule 1).

---

## 2. Sampling Frame (TESTER-SPEC v2.2 §6, prospective)

A trade enters the frame if:
1. Pool was discovered via GeckoTerminal `new_pools` (network=solana) no older than `POOL_MAX_AGE_MINUTES = 15` minutes **at detection time** by the collector (not at outcome evaluation time) — source chosen via live verification in stage 7B, see `docs/SHADOW-COLLECTOR.md` §1.
2. Pool DEX matches `raydium`/`pump-fun`/`pumpswap` (regular expression `DEX_ID_REGEX` in `collect.mjs`, field `relationships.dex.data.id` of GeckoTerminal response). **Clarification relative to TESTER-SPEC.md §1**, where frame is described as "Jupiter/Raydium/PumpSwap": GeckoTerminal does not issue a separate DEX identifier "Jupiter" — Jupiter is an aggregator routing swaps THROUGH Raydium/PumpSwap/pump.fun, rather than a distinct venue in pool terms. Trades routed through Jupiter but executed on one of the three listed venues enter the frame via the venue itself; a separate "via Jupiter" flag is neither stored nor checked by the collector.
3. Minimum `pairCreatedAt` across ALL pairs of the mint on DexScreener is no older than `TOKEN_MAX_AGE_DAYS = 14` days from buy time (`checkTokenAge`) — otherwise `TOKEN_TOO_OLD`, record is not created at all (enters neither the frame nor exclusions below, as this is a filter PRIOR to record creation).
4. Buyer resolves according to definition in section 1 above. If within `BUYER_CANDIDATE_SCAN_LIMIT = 20` transactions after pool creation no candidate passes verification — `buyer = NULL`, record **is created** (not discarded), but marked `NO_BUYER` and **excluded** from primary metrics (section 5).

**Without the "buyer >= 20 prior transactions" filter** — TESTER-SPEC.md v2.1/v2.2 §6 explicitly removes this filter for the prospective frame (rationale therein). Results of this run **do not transfer** to the retrospective pilot of TESTER-SPEC.md §1/§5, which has a narrower frame, and vice versa.

### Strata (TESTER-SPEC.md §1, computed separately, never summed)

- **Stratum A** — mint at time `t` has `mintAuthority === null` AND `freezeAuthority === null`.
- **Stratum B** — mint at time `t` has active `mintAuthority` and/or `freezeAuthority`.

---

## 3. Outcome Horizon

`N = 3` days, unified for criteria (a) (buyer ATA freeze) and (b) (`liquidity.usd` drop >= 90%, net of migrations) — TESTER-SPEC.md v2.2 §2, `OUTCOME_HORIZON_DAYS` in `scripts/shadow/outcomes.mjs`. Criterion (c) (RugCheck) **is not implemented** in the shadow collector (called by neither `collect.mjs` nor `outcomes.mjs`) — metrics of this run do not include (c) in any form; this distinction from TESTER-SPEC.md §2(c) is fixed here explicitly rather than silently.

---

## 4. Primary Metric

### 4.1. Definition of `/gate-copy` Verdict Buckets

The `POST /gate-copy` response (`src/http-server.ts`, `toolGateCopy`) does not contain literal fields `VERIFIED_SAFE`/`LOW_TRUST_WARMING`/`BLOCKED` — these three names from CLAUDE.md/README pertain to the more general (and per CLAUDE.md partially invalidated for Experiment #1) three-tier scheme. For this run, the three-tier scheme is **derived** from actual fields `action`/`allow`, verified by reading `src/http-server.ts:431-548` (stage 7B/7C):

| Bucket | Condition in `toolGateCopy` code | `action` | `allow` |
|---|---|---|---|
| `BLOCKED` | `trustResult.verdict === "hold"` OR `trustResult.verdict === "unknown"` OR `simRes` yields `isBlocked`/`!safeToExecute` — in ALL these branches `allow: false`, copy trade is not executed | `"block"` or `"manual_review"` | `false` |
| `LOW_TRUST_WARMING` | simulation yields `isThrottled` — trade executes, but with reduced limit / delay | `"throttle"` | `true` |
| `VERIFIED_SAFE` | final unconditional branch, `reason` starts with literal `"VERIFIED_SAFE:"` in code itself | `"allow"` | `true` |

**Rationale for combining `action: "block"` and `action: "manual_review"` into single bucket `BLOCKED`:** both branches yield `allow: false` — from a copy-trading standpoint the trade is NOT executed in either case; separating them for this metric would introduce an extra third bucket beyond the three required by task. This decision is fixed here, BEFORE viewing results, and is not revisited mid-flight (rule 4 CLAUDE.md) — if distinguishing `"block"` and `"manual_review"` separately later proves important, that is a new numbered experiment.

### 4.2. Table 1 (Primary): `LOW_TRUST_WARMING` — Part of "Passed"

| | Blocked (`BLOCKED`) | Passed (`VERIFIED_SAFE` + `LOW_TRUST_WARMING`) |
|---|---|---|
| Share of `DANGEROUS` among outcomes | `x_block / n_block`, 95% Wilson CI | `x_pass / n_pass`, 95% Wilson CI |

Computed **separately for Stratum A and Stratum B** — 2 independent pairs of numbers, not one aggregate.

### 4.3. Table 2 (Alternative): `LOW_TRUST_WARMING` — Part of "Blocked"

| | Blocked (`BLOCKED` + `LOW_TRUST_WARMING`) | Passed (`VERIFIED_SAFE` only) |
|---|---|---|
| Share of `DANGEROUS` among outcomes | `x_block2 / n_block2`, 95% Wilson CI | `x_pass2 / n_pass2`, 95% Wilson CI |

Also separately by strata. Table 2 addresses the more conservative question: "what if throttle is treated as a form of warning/blocking rather than pass."

### 4.4. Wilson Confidence Interval (95%, `z = 1.96`)

For proportion `p̂ = x/n`:

```
center = (p̂ + z²/(2n)) / (1 + z²/n)
margin = z · sqrt(p̂(1-p̂)/n + z²/(4n²)) / (1 + z²/n)
CI95 = [center - margin, center + margin]
```

Implementation of formula in code at the time of preregistration **is absent** — will be added as a separate file (`scripts/audit/` or `scripts/shadow/`) immediately prior to first substantive (non-dry) metric computation, with a unit test against known reference values. Formula is fixed here in advance so it cannot be fitted to desirable results post-factum.

### 4.5. Criterion "Radar is Useful on this Frame"

For a specific table (1 or 2) and specific stratum (A or B), the conclusion **"radar is useful"** is drawn if SIMULTANEOUSLY:
1. `x_block/n_block >= 3 × (x_pass/n_pass)` (share of `DANGEROUS` among blocked is at least three times higher than among passed);
2. 95% Wilson intervals for the two proportions **do not overlap**.

If at least one condition is not satisfied — the conclusion is **not** "radar is useless", but **"difference not confirmed on this sample"** (which is not equivalent to proving absence of effect).

### 4.6. Threshold "Insufficient Data"

Regardless of §4.5 result, if a stratum (A or B) has **fewer than 30 `DANGEROUS` outcomes** (excluding `ISSUER_CONTROLLED`, `PAIR_MISSING`, "unrecoverable", `NO_BUYER`, `RADAR_ERROR`, `TOKEN_TOO_OLD` — section 5) — for that stratum report publishes **"insufficient data"** rather than a number, even if formal ratio of shares and non-overlap of intervals are satisfied. Threshold of 30 comes from TESTER-SPEC.md §5, applied here to each stratum and each table (1 and 2) independently.

---

## 5. Separate Lines (Never enter numerator/denominator of section 4)

Each is published as an individual report line, with absolute count and share of total collected records (including excluded) — neither hidden nor collapsed into general counter:

| Class | Source | Reason for separate accounting |
|---|---|---|
| `ISSUER_CONTROLLED` | `ground-truth/issuer-controlled-mints.jsonl` (TESTER-SPEC.md §2) | Assigned by token in advance, not outcome; FP rate here is expectedly higher than primary — not compared directly to primary metrics. |
| `PAIR_MISSING` | `outcomes.mjs`, `checkPoolLiquidityDrop` | Pair disappeared from DexScreener by `t+N` — neither `DANGEROUS` nor `SAFE`. Published with **two bounds** (lower: non-dangerous; upper: dangerous), `docs/SHADOW-RUNBOOK.md` §5.4a. |
| "unrecoverable" | `outcomes.mjs`, `classifyOutcome` (`ATA closed`, `NO_BUYER` as outcome if applicable) | State at `t+N` physically cannot be reconstructed (closed account) — do not pretend this is `SAFE`. |
| `NO_BUYER` | `collect.mjs`, `resolveBuyer` returned `buyer: null` | Buyer did not resolve within `BUYER_CANDIDATE_SCAN_LIMIT` transactions — trade never received genuine radar verdict (radar not called without wallet address). |
| `RADAR_ERROR` | `collect.mjs`, `queryGateCopy`, HTTP status `/gate-copy` != 200 | Not a verdict, but infrastructure failure — counting as `SAFE`/`DANGEROUS` would fabricate nonexistent result. |
| `TOKEN_TOO_OLD` | `collect.mjs`, `checkTokenAge` | Trade outside sampling frame (section 2, item 3) — record not created, but rejection counter maintained and published. |

Share of `NO_BUYER` out of total discovered pools additionally appears in `docs/TESTER-SPEC.md` as a separate limitation (task 4 stage 7D).

---

## 6. Prohibition of Post-hoc Changes

Fixed prior to viewing results, not changed after (CLAUDE.md, rule 4):
- Thresholds `POOL_MAX_AGE_MINUTES`, `TOKEN_MAX_AGE_DAYS`, `COPY_AMOUNT_USD`, `OUTCOME_HORIZON_DAYS`, `BUYER_CANDIDATE_SCAN_LIMIT`, `MAX_CONSECUTIVE_RADAR_ERRORS` — do not change for already collected data.
- `src/` — does not change within this experiment without separate explicit task (CLAUDE.md, rule 7); if a bug in `src/` is found along the way, it is recorded in report, not silently fixed mid-collection.
- Sampling frame (section 2) and outcome criteria (section 3, TESTER-SPEC.md §2) — do not expand or narrow post-factum, including bucket definitions `BLOCKED`/`VERIFIED_SAFE`/`LOW_TRUST_WARMING` (section 4.1).
- Any of the above, if modified after run results become visible, is formalized as a new tag (`shadow-v2`+) and new numbered experiment referencing what changed and why — not retroactive edits to this file or `shadow-v1`.

---

## 7. Status at Time of Fixation

Neither dry run nor live data collection was executed prior to publication of this document. First dry run (without outcome computation, testing pipeline functionality only) is described separately as a task of stage 7D, on separate database `shadow/dry.db`, unmixed with production `shadow/shadow.db`.

---

## 8. Run Parameters (Appendix, stage 7E)

Added as a separate appendix commit without rewriting sections 1–7 above (CLAUDE.md rule 4 — this is an ADDITION fixed prior to recording any data, not an edit of already published decisions).

| Parameter | Value | Source |
|---|---|---|
| Collector poll interval | `POLL_INTERVAL_MINUTES = 15` (default; CLI flag `--interval=<min>` in `collect.mjs`) | `docs/SHADOW-RUNBOOK.md` §2 |
| Maximum pool age at discovery | `POOL_MAX_AGE_MINUTES = 15` | `scripts/shadow/collect.mjs` |
| `copyAmountUsd` (amount passed to `/gate-copy`) | `COPY_AMOUNT_USD = 10` | `scripts/shadow/collect.mjs` |
| Daily ceiling on external requests | **`1500`** (`DAILY_REQUEST_CEILING`, user-set in stage 7F, matches default in code — see `shadow.env`, `docs/SHADOW-RUNBOOK.md` §2) | — |
| Source of new pools | GeckoTerminal `new_pools` (network=solana), see section 2 above and `docs/SHADOW-COLLECTOR.md` §1 | — |
| Minimum Node.js version | `22.13.0` (`node:sqlite` without flag, see `docs/SHADOW-RUNBOOK.md` §0, https://nodejs.org/docs/latest-v22.x/api/sqlite.html) | — |

**Dry-run database data is not included in analysis.** Any database created with `--dry-run` or explicitly named dry-run/test (e.g. `shadow/dry.db`, `shadow/*.dry.db`) is not counted in any metric of this run and not mixed with `shadow/shadow.db` — records in it are either not saved at all (`dryRun: true` in `runCollectionCycle` does not call `insertTrade`) or, if saved deliberately (as in stage 7B task 9), inspected exclusively manually for pipeline verification, never by automated analyzer (`scripts/shadow/analyze.mjs`).

---

## 9. Moving the `shadow-v1` Tag (stage 7E)

Initially tag `shadow-v1` was placed on commit `7a1387872f8e66019c081d37d88cbc729030d2fd` (end of stage 7C). Between preregistration fixation (section 0 / stage 7D) and this stage 7E note, code was further refined (`scripts/shadow/analyze.mjs`, field `radar_token_check_missing`, section 8 above) — preregistration itself was not rewritten (sections 1–7 unchanged, section 8 and this note are additions only), but the CODE version pointed to by tag was not final for run start. Prior to first live/dry data recording, tag `shadow-v1` was moved to final commit of `gemini/collector` branch after all commits of stages 7B–7E — commit immediately preceding this very note (see `git log --oneline`). At tag move time `shadow/shadow.db` and `shadow/dry.db` still do not exist (verified via `ls shadow/`, `git status --short`, stage 7E task 1/6) — no run against the new tag position had yet been performed.

**Code version of this run is always determined by command `git rev-parse shadow-v1`**, rather than hardcoded hash here — hash above (`7a13878...`) is valid only for tag move history, not current position.

---

## 10. Field `radar_token_check_missing` (Appendix, stage 7F)

Informational field (`scripts/shadow/collect.mjs`, `determineRadarTokenCheckMissing`), **enters no metric of section 4** — published as separate line (analogous to section 5 classes), diagnosing completeness of radar token check rather than trade danger.

**Verified by reading code** (`src/simulate.ts:246,319-330`, `src/http-server.ts:431-548`): rule `TOXIC_MINT` in `simulatePayment` triggers **only** on `mintRisk.freezeAuthority` — not on `mintAuthority`. Therefore field takes four values (stage 7F task 2, replacing stage 7E first version which erroneously marked mint with only `mintAuthority` as "missing"):

| Value | Condition |
|---|---|
| `NOT_APPLICABLE` | Mint at time `t` has **no** `freezeAuthority` (including case "only has `mintAuthority`" — rule `TOXIC_MINT` structurally cannot trigger on anything other than `freezeAuthority`), **OR** mint is in `MAJOR_MINTS`/`KNOWN_SAFE_MINTS` (whitelist, suppression intentional). |
| `NOT_DETERMINABLE` | `freezeAuthority` present, mint not in whitelist, but `/gate-copy` response lacks `details.simulation` (`trustResult.verdict` was `"hold"`/`"unknown"`, `simulatePayment` was not called, `http-server.ts:444-461`) — cannot verify, do not guess. |
| `true` | `freezeAuthority` present, mint not in whitelist, `details.simulation` present, but `TOXIC_MINT` **did not** trigger — check that should have been possible was not confirmed. |
| `false` | Same, but `TOXIC_MINT` **did trigger** — check confirmed. |

`analyze.mjs` outputs distribution across all four values plus `"null (no verdict)"` (rows without verdict at all — `NO_BUYER`/`RADAR_ERROR`, field not set) as separate informational section, without mixing into any section 4 metric.

---

## 11. `/gate-copy` Response Forms and Mapping to Buckets (Appendix, stage 7F)

Exhaustive list of all `return` statements from `toolGateCopy` (`src/http-server.ts:431-549`), by code. All six are the sole currently existing forms; seventh row (6a) is same `return` as 6, but with different actual `details` composition depending on whether `simulatePayment` was called.

| № | Condition | File:line | `allow` | `action` | `details` |
|---|---|---|---|---|---|
| 1 | `trustResult.verdict === "hold"` | `http-server.ts:443-454` | `false` | `"block"` | `{ trust }` — **without** `simulation` |
| 2 | `trustResult.verdict === "unknown"` | `http-server.ts:455-464` | `false` | `"manual_review"` | `{ trust }` — **without** `simulation` |
| 3 | `isBlocked` (inside simulation) | `http-server.ts:493-505` | `false` | `"block"` | `{ trust, simulation }` |
| 4 | `isThrottled` | `http-server.ts:507-520` | `true` | `"throttle"` | `{ trust, simulation }` |
| 5 | `!simRes.safeToExecute` | `http-server.ts:522-534` | `false` | `"manual_review"` | `{ trust, simulation }` |
| 6 | Final fallback, simulation ran and nothing triggered | `http-server.ts:538-548` | `true` | `"allow"` | `{ trust, simulation }` |
| 6a | Same `return` 538-548, but `copyAmountUsd` not set / <=0 — simulation block (467-535) skipped entirely, `simRes` remains `undefined` | `http-server.ts:538-548` | `true` | `"allow"` | `{ trust, simulation: undefined }` |

Collector (`collect.mjs`, `queryGateCopy`) always sends `copyAmountUsd: COPY_AMOUNT_USD` (fixed positive constant) — branch 6a is structurally unreachable from shadow run, but documented here for completeness of code enumeration.

### Mapping to Buckets (section 4.1)

| Form | Bucket |
|---|---|
| 1 | `BLOCKED` |
| 2 | `BLOCKED` |
| 3 | `BLOCKED` |
| 4 | `LOW_TRUST_WARMING` |
| 5 | `BLOCKED` |
| 6 / 6a | `VERIFIED_SAFE` |

All six actually existing forms map to the three buckets of section 4.1 via the `action` field — guessing was never required. **`UNCLASSIFIED`** (`scripts/shadow/analyze.mjs`, `classifyVerdictBucket`) is a guard bucket for any form not present in code today (missing/unparseable `radar_verdict`, or `action` value outside current four literals `block`/`manual_review`/`throttle`/`allow`). Enters no section 4 metric (`x_block`/`x_pass`/`n_block`/`n_pass`) — published as separate line per stratum, like other section 5 classes.

---

## 12. Second Moving of the `shadow-v1` Tag (stage 7F)

Tag `shadow-v1` is moved a **second time** (first move — section 9, stage 7E). Reasons:

1. **Run parameters.** Following first move, code was further refined: `radar_token_check_missing` received four states instead of misleading boolean (task 2), `skip_counters` table was added and hooked into `collect.mjs`/`analyze.mjs` (task 3, incidentally fixing a real DB connection leak in `runCollectionCycle`), all `/gate-copy` response forms were enumerated and tested with `UNCLASSIFIED` bucket (task 4), daily request ceiling was fixed as `1500` (task 5, section 8).
2. **Merge of `audit/claims`.** Branch `audit/claims` (retraction commit `a60c78c`, removing unsupported figures `96.0%`/`98.0%`/`71 wallets` from `README.md` and demo scripts) was merged into `gemini/collector` via conflict-free merge commit — code pointed to by tag must include this history.

At the time of this move `shadow/*.db` still does not exist (verified via `ls shadow/`, `git status --short`, stage 7F task 1 and again immediately prior to this commit) — no run against the new tag position had yet been performed. As in section 9: **code version of this run is always determined by command `git rev-parse shadow-v1`**, not hash fixed in text of this file.

---

## 13. Addition to Analysis (stage 7G)

**Numbering:** stage 7G task requested naming this section "12", but number 12 is already occupied by section above (second tag move, stage 7F, fixed PRIOR to this task). To avoid two sections numbered "12" and avoid rewriting already published text retroactively, this is section **13**. Noted explicitly here rather than silent choice.

**This addition was written AFTER placement of tag `shadow-v1`** (current position — commit `8fcf3e6f776629f6b5f68989cf7ed63e5f30655d`, section 12) **and BEFORE any data recording** by the collector. Collector code has not changed since tag placement — verified:

```
git diff shadow-v1..HEAD --stat -- scripts/shadow/collect.mjs scripts/shadow/db.mjs scripts/shadow/outcomes.mjs scripts/shadow/preflight.mjs src/
```
Empty output (see stage 7G task 4 below for full output of same command at report time). `shadow/*.db` does not exist — verified via `ls shadow/` before and after work on this section.

**Primary criterion, thresholds, and tables 1/2 (section 4) do not change.** This addition adds only descriptive secondary tables — used neither in "radar is useful" criterion (§4.5), nor in "insufficient data" threshold (§4.6), nor in any decision regarding structure or scope of further collection.

### 13.1. Response Forms F1–F6 by Record Count and DANGEROUS Share

Form is determined from already recorded `radar_verdict` (same classification as in section 11, but distinguishing presence of `details.simulation`):

| Form | Definition | File:line |
|---|---|---|
| F1 | `action="block"`, **without** `details.simulation` | `http-server.ts:443-454` |
| F2 | `action="manual_review"`, **without** `details.simulation` | `http-server.ts:455-464` |
| F3 | `action="block"`, **with** `details.simulation` | `http-server.ts:493-505` |
| F4 | `action="throttle"` | `http-server.ts:507-520` |
| F5 | `action="manual_review"`, **with** `details.simulation` | `http-server.ts:522-534` |
| F6 | `action="allow"` | `http-server.ts:538-548` |

For each form (`scripts/shadow/analyze.mjs`, `dangerousShareByForm`): record count (`n`), count of `DANGEROUS` (`x`), share `x/n` with 95% Wilson interval (formula §4.4) — **both strata combined, without breakdown** (unlike tables 1/2 of section 4, always calculated separately by strata — here breakdown by strata is intentionally omitted, as table is purely descriptive). **Without aggregation** (forms not summed together) **and without conclusions** (no formula "form X is more useful than form Y" exists or is implied here).

### 13.2. Simulation Did Not Run (F1, F2) vs Did Run (F3–F6)

Same two figures (`n`, `x`, share, Wilson interval), but across two form groups rather than six (`scripts/shadow/analyze.mjs`, `simulationSplit`). Also descriptive, also both strata combined, also without conclusion regarding "usefulness".

### 13.3. How to Read Table 1 in Light of This (One Sentence)

Forms F1 and F2 terminate **prior to** token check (`toolGateCopy` returns result based solely on trust check of buyer wallet, `simulatePayment` is never called) — therefore bucket `BLOCKED` in table 1 (section 4.2) may consist predominantly of blocks on buyer trust rather than token risk, and table 1 must be read with this in mind, not attributing entire `BLOCKED` share to the `TOXIC_MINT` detector.

### 13.4. Look-ahead Rule

**Prior to data collection halt and final outcome calculation run** (`outcomes.mjs`), `analyze.mjs` is executed **only** in `--counters-only` mode. In this mode, output prints exclusively: total record count in `shadow_trades`, record count in `error_logs`, `skip_counters` by rejection reasons, and record counts across response forms F1–F6 **without** outcomes and **without** `DANGEROUS` shares (`formatCountersOnlyReport` — function does not read `row.outcome` at all, ever, for any row). Full analysis (`analyze.mjs` without flag — tables 1/2, sections 13.1/13.2, anything showing `DANGEROUS` share) **is prohibited** until collection is halted and outcomes are computed for the final time. Reason: premature inspection of dangerous outcome share mid-collection introduces risk of unconscious adaptation of further collection/protocol to observed intermediate result — same consideration as prohibition of post-hoc changes (section 6), applied to the data reading process itself, not only code changes.

---

## 14. Pre-start Run Amendments (stage 7H)

Fixed BEFORE any data recording by collector. Section 13 (and all earlier sections) are not rewritten.

### 14a. Tag `shadow-v2`, Reasons for Replacing `shadow-v1`

This run uses tag **`shadow-v2`** (created at end of stage 7H, see section below regarding `git log`/`git tag`), not `shadow-v1`. `shadow-v1` was replaced prior to any data recording (`shadow/*.db` remained empty throughout stage 7H — verified repeatedly) for two reasons:

1. **Transaction version error.** `collect.mjs` called `getTransaction` with `maxSupportedTransactionVersion: 0` — real versioned transactions (`version: 1`) responded with RPC error `-32015` and were lost as `PROCESSING_ERROR`. Stage assignment stated that in dry run this cost **20–25% of lost pools**; in independent verification on 5 pools named in assignment (section below), this exact error was reproduced on 1 of 5 (`JtfZS5Pc3C63xRer87yhPqjJAM4bReRhsskuRqxqKe1`) — order of magnitude (1/5 = 20%) is consistent with reported estimate. Fixed: `maxSupportedTransactionVersion` raised to `1`, plus one-time retry with version parsed from error text in case of future transaction versions above 1.
2. **Shared request ceiling.** `request_counters` used key `(date)` — single ceiling for `collect.mjs` and `outcomes.mjs` together. Consequently: (i) collector cycle exhausted entire daily ceiling in first 1–2 hours (took all discovered candidates without per-cycle budget) — diurnal collection bias; (ii) outcome computation at 03:00 UTC (`docs/SHADOW-RUNBOOK.md` §4.3) risked finding ceiling already exhausted by collector, evaluating zero outcomes. Fixed: key `(date, script)`, separate ceilings `DAILY_REQUEST_CEILING_COLLECT`/`DAILY_REQUEST_CEILING_OUTCOMES` (both `1500`), and pool budget per cycle (`computeBudgetPools`, `scripts/shadow/collect.mjs`).

### 14b. Pseudorandom Candidate Selection

Candidates within cycle budget (`budget_pools`) are selected pseudorandomly (`selectCandidatesPseudoRandom`, seed is cycle timestamp, recorded in `pool_candidates.cycle_ts`), rather than "first N" — otherwise systematic bias toward one market segment / GeckoTerminal publication time. **Every** observed candidate (selected or not) is recorded in new table `pool_candidates (cycle_ts, pool, mint, seen_at, selected)` without extra queries — `analyze.mjs` displays observed and selected counts by UTC hour (`formatPoolCandidatesByHourReport`) to verify whether collection is truly uniform throughout the day, rather than merely asserting it.

### 14c. Stratum B Expected to Be Very Small

Stratum B (active `freezeAuthority`/`mintAuthority`) is known to be rare among new pump.fun/Raydium/PumpSwap pools (typical practice is revoking authority immediately at creation, stratum A). **Agreed in advance**: if stratum B by run completion yields fewer than 30 `DANGEROUS` outcomes, result for it is **"insufficient data"** (rule of section 4.6, stated here as explicit expectation rather than new rule) — a small stratum B is no reason to lower threshold 30 or modify criterion retroactively.

### 14d. Buyer Clustering — Requirement for "Radar is Useful" Criterion

Task 1 of this stage (live verification of 5 pools) uncovered the exact same buyer address resolving for TWO different pools (`4ipWkjXg9d9ppMuE6AXpM6oLbFKNrZkLLRL7Kqbg2D6m` and `qN8hbUgk5UzSzVQnoDPofGbkwuUd5Fi8mgQBsswDGku`, both -> `G3wwch5Cu8ApBaJq2XGPRKykDgE9SarwN2fJjvt1DSrT`) — concrete, non-hypothetical confirmation that "first resolved buyer" can be a sniper/bot yielding MULTIPLE observations in dataset rather than one (already documented as limitation in `docs/TESTER-SPEC.md`, stage 7D task 4 — here receiving quantitative check).

**Rule (implemented in `scripts/shadow/analyze.mjs`, `evaluateClusteredUsefulness`):** criterion "radar is useful" (section 4.5) for a given table/stratum is considered met **only if** met SIMULTANEOUSLY:
1. across all trades (primary table of section 4), **AND**
2. across secondary table "one record per buyer" (earliest record for each buyer, `oneRecordPerBuyer`) — same Wilson formula, same x3 threshold, same requirement of non-overlapping intervals.

If at least one of the two reports anything other than "RADAR_USEFUL" — outcome is **"insufficient data"**, rather than "useful per primary table". Result is stored as `result.strata[strat].tableN.clusteredStatus`, printed in full report.

### 14e. Mandatory Report on F1 Form Share

Share of form **F1** ("unfamiliar buyers" — `toolGateCopy` returns `action:"block"` based solely on wallet trust check, BEFORE `simulatePayment` is called, `http-server.ts:443-454`) out of **all** records is a mandatory line of full report (`result.f1Share`, `scripts/shadow/analyze.mjs`), not only descriptive table of section 13.1. Reason for mandate: F1 is the sole form where radar verdict NEVER depended on token risk (section 13.3) — high F1 share indicates that substantial portion of "blocks" in table 1 is explained purely by recency/history of buyer wallet rather than `TOXIC_MINT` detection, and this must be visible immediately rather than only on separate request of descriptive table.

### 14f. Immutability Verification — Now Relative to `shadow-v2`

Starting from this stage, verification "collector code has not changed since fixation" (`git diff <tag>..HEAD --stat -- scripts/shadow/collect.mjs scripts/shadow/db.mjs scripts/shadow/outcomes.mjs scripts/shadow/preflight.mjs src/`) is performed relative to **`shadow-v2`**, not `shadow-v1` — `shadow-v1` remains in repository history (not deleted), but is no longer the baseline for this check.

---

## 15. Pre-start Run Amendments, Part 2 (stages 7J/7K)

Fixed BEFORE any data recording by collector. Sections 1–14 are not rewritten.

### 15a. Tag `shadow-v3`, Reasons for Replacing `shadow-v2`

This run uses tag **`shadow-v3`** (tag NOT yet created at publication of this section — see item 5 of stage 7K report: halt/calculation date must be filled by user PRIOR to tagging). `shadow-v2` was replaced prior to any data recording for reasons:

1. **Report 7I** (code review without data recording): `liquidity_usd` was hardcoded to `NULL` (`scripts/shadow/collect.mjs`, prior to stage 7J); in `outcomes.mjs` liquidity drop formula could only assume `0` or `1.0`, never intermediate value; absence of `liquidity` field in DexScreener response for real existing pair was treated as 100% drop (false `DANGEROUS`); HTTP 200 with invalid `/gate-copy` body was not counted as error.
2. **Dry run 8C**: `REQUESTS_PER_POOL` remeasured as `204/22 = 9.27`, previously `7` (`138/20=6.9`) — outdated budget estimate understated actual request consumption per pool.

All listed issues were resolved in stages 7J/7K (sections 15b–15d below).

### 15b. Criterion (b), Clarified Formulation

Single source for L_t and L_t3 is **GeckoTerminal `reserve_in_usd`** (`GET https://api.geckoterminal.com/api/v2/networks/solana/pools/{pair}`, `scripts/shadow/outcomes.mjs:197`, `fetchGeckoTerminalPoolReserve`) — previously: DexScreener for L_t3, and L_t was not recorded at all. Minimum liquidity at t: `MIN_INITIAL_LIQUIDITY_USD = 1000` (`outcomes.mjs:55`) — below this or `NULL` -> "unrecoverable (no liquidity at t)" without querying for L_t3. Absence of data at t+3 (API error, 429, missing field): outcome remains `NULL` and is re-evaluated on subsequent runs, but no longer than `LIQUIDITY_T3_RETRY_MAX_DAYS = 3` days after `t+OUTCOME_HORIZON_DAYS` (`outcomes.mjs:56`) — thereafter "unrecoverable (liquidity unavailable)" permanently. Migration successor counts only if created **strictly after** `t` (unchanged from section 5 / stage 7F) — implementation `checkPoolLiquidityDrop`, `outcomes.mjs:266`.

**Live verification (stage 7K, read-only, see report):** route `GET /networks/solana/pools/{address}`; `reserve_in_usd` is present for pool under 30 minutes, pool over an hour old, and pool over a day old (three real examples with age in report); no `x-ratelimit-*` headers in response (limit not visible in advance, only via 429); nonexistent pool -> HTTP 404, body `{"errors":[{"status":"404","title":"Not Found"}],"meta":{"ref_id":"..."}}` — matches implementation in `outcomes.mjs` (`reserveRes.notFound` -> `PAIR_MISSING`), zero discrepancies found, code unchanged after this verification.

### 15c. Added Classes in Analysis

`scripts/shadow/analyze.mjs`, `classifyRow` — three new classes, each as its own line (not merged into old generic `IRRECOVERABLE`):
- `IRRECOVERABLE_NO_LIQUIDITY_AT_T` — outcome `"unrecoverable (no liquidity at t)"`.
- `IRRECOVERABLE_LIQUIDITY_T3_UNAVAILABLE` — outcome `"unrecoverable (liquidity unavailable)"`.
- `MIGRATION_UNDETERMINED` — outcome `"migration undetermined"` (successor candidate lacks `liquidity` field in DexScreener — do not guess either way).

### 15d. `REQUESTS_PER_POOL = 10`

Was `7` (measurement `138/20=6.9`), remeasured as `204/22=9.27`, rounded up to `10` (`scripts/shadow/collect.mjs`). Pool budget per cycle (`computeBudgetPools`, formula unchanged) at 15-minute interval (96 cycles/day), code ceiling (`1500`) unchanged:

| Ceiling per day | budget_pools/cycle |
|---|---|
| 1500 | 1 |
| 3000 | 3 |
| 5000 | 5 |

### 15e. Criterion (b) Compares Reserves in USD — Base Asset Price Does Not Affect

`reserve_in_usd` from GeckoTerminal is pool reserve value already expressed in USD (not token count, not price in SOL / quote currency) — criterion (b) compares this exact value at `t` and `t+3`, so price fluctuation of base asset (SOL etc.) alone does not affect `drop`, only actual change in dollar-denominated pool reserve volume.

### 15f. L_t Timestamp — Gap with `t`

Read from code (`scripts/shadow/collect.mjs`, read-only, no changes introduced):
- `t` (`collect.mjs:719`, `t: buyerRes.t ?? ...`) — timestamp (`blockTime`) of actual BUY transaction, determined via `resolveBuyer` live RPC query to pool history.
- `liquidity_usd` (`collect.mjs:710`, `const liquidityUsd = p.reserveInUsd ?? null`) — `reserve_in_usd` value captured **once across entire collection cycle**, at `fetchFreshPools()` call at cycle start (before buyer is resolved and `t` is known for SPECIFIC pool).

**The gap:** because `t` is the timestamp of an ALREADY confirmed on-chain transaction (necessarily occurring earlier than collector could see pool via GeckoTerminal), while `liquidity_usd` is captured when GeckoTerminal has ALREADY indexed pool — `liquidity_usd` systematically pertains to a moment **later** than `t`, rather than coinciding with it. Magnitude of gap is **at least ~1 minute** (previously measured GeckoTerminal indexing latency relative to pool creation, `docs/SHADOW-COLLECTOR.md`, stage 7B) and may be larger depending on ordinal position of pool processing within cycle budget — logic was not modified in this code reading; gap is fixed as a fact, not a discovered bug.

### 15g. Hard Run Dates

**Collection halts: `2026-10-06 18:00 UTC`.** **Final outcome computation: `2026-10-10 09:00 UTC`.** (User specified "October 6 evening (UTC)" and "October 10 morning" without exact times — fixed as 18:00 and 09:00 UTC respectively; if different time was intended, amendment of this section is required prior to tagging `shadow-v3`.) Dates were supplied by user PRIOR to tagging `shadow-v3` (see stage 7K report, item 5). Records whose outcome remains non-final (`outcome IS NULL`, including those pending within 3-day L_t3 retry window) as of `2026-10-10 09:00 UTC` are published as separate line **"unmatured"** and enter no metric of section 4/13/15b.

### 15h. What is Excluded from Analysis

Dry runs **8B** and **8C**, as well as results of **7I** (code reading, report without data recording) were used exclusively to verify pipeline functionality and justify decisions in sections 15a–15d above — in final analysis (`analyze.mjs` without `--counters-only`, after `2026-10-10 09:00 UTC`) they are not included.

### 15i. Immutability Verification — Now Relative to `shadow-v3`

From creation of `shadow-v3` onward, verification "collector code has not changed" is performed as `git diff shadow-v3..HEAD --stat -- scripts/shadow/collect.mjs scripts/shadow/db.mjs scripts/shadow/outcomes.mjs scripts/shadow/preflight.mjs src/` — `shadow-v1`/`shadow-v2` remain in history (not deleted), but are no longer the baseline.

---

## 16. Correction of §15e (stage 7L)

**§15e is not rewritten** (preserved as is, recorded below for history). This section corrects it.

### 16.0. The Error

In §15e it was stated: "criterion (b) compares pool reserves in USD, therefore price fluctuation of base asset alone does not affect `drop`". **This is incorrect.** `reserve_in_usd` is total USD value of both pool reserves; for a constant-product pool (`x*y=k`, without LP deposit/withdrawal) it is proportional to `sqrt(price)`, where `price` is base token price in quote asset. A ~99% `price` collapse (`price_new = 0.01 * price_old`) with zero liquidity removal yields `TVL_new/TVL_old = sqrt(0.01) = 0.1`, i.e. 90% reserve drop — precisely the DANGEROUS-eligible threshold from §15b/criterion (b). Base asset price **does affect** `drop`, and can be the sole cause of 90% reserve drop.

Formula derivation: `x*y=k` (constant product) => `y = sqrt(k*p)`, `x = sqrt(k/p)` (where `p = y/x` is base price in quote) => `TVL_quote = x*p + y = sqrt(k/p)*p + sqrt(k*p) = 2*sqrt(k*p)`, whence `TVL_quote ∝ sqrt(p)`. Holds under assumption that quote asset price (typically SOL) to USD did not change substantially across same window — simplification fixed here explicitly, not independently verified.

### 16.1. Corrected Criterion (b)

**(b) = "reserve collapse >= 90% (liquidity removal or price crash >= 99%)".** Threshold and DANGEROUS / "migration, not outcome" / "migration undetermined" classification from §15b **do not change** — still strictly `drop >= 0.9` and successor pool search result. Added separate **descriptive** (non-outcome-affecting) cause field in `outcome_details`, evaluated in `checkPoolLiquidityDrop` (`scripts/shadow/outcomes.mjs`) whenever `drop >= 0.9`:
- `PRICE_CRASH` — base token price (`base_token_price_usd`) at `t+3` dropped by more than 90% relative to price at observation time (`price_usd_seen`, see §16.3), i.e. `priceRatio = price_t3 / price_seen <= 0.1`.
- `LIQUIDITY_REMOVAL` — otherwise (price known at both endpoints, but `priceRatio > 0.1` — reserve collapse is not explained by price alone).
- `UNDETERMINED` — `price_usd_seen` or price at `t+3` missing (price unavailable).

Implementation: `scripts/shadow/outcomes.mjs`, inside `checkPoolLiquidityDrop`, branch `if (drop >= 0.9)` — evaluated once and present in all three return forms of this branch (`migrationUndetermined`, `migration`, regular DANGEROUS candidate); for `drop < 0.9` field `dropCause` is absent (neither computed nor set). Tests: `test/shadow-collector.test.mjs`, section "Stage 7L task 1" — PRICE_CRASH, LIQUIDITY_REMOVAL, both UNDETERMINED variants, and verifying `drop < 0.9` creates no such field.

### 16.2. Documentation Check: Pools for Which Relationship Holds

Verified by reading official documentation (not from model memory):

| DEX / pool type | Mechanism | Source | Relationship `TVL ∝ sqrt(price)` |
|---|---|---|---|
| Raydium AMM v4 | `x*y=k`, constant product | [docs.raydium.io/products/amm-v4](https://docs.raydium.io/products/amm-v4): "It maintains a constant-product invariant (xy=k)" | holds |
| Raydium CPMM (Standard AMM) | `x*y=k`, constant product | [docs.raydium.io/products/cpmm](https://docs.raydium.io/products/cpmm): "Pure constant-product AMM... xy=k invariant" | holds |
| PumpSwap (`pumpswap`, and bonding-curve phase `pump-fun`, same mechanism on virtual reserves) | `x*y=k`, constant product | [deepwiki.com/pump-fun/pump-public-docs, 4.1 AMM Mechanism](https://deepwiki.com/pump-fun/pump-public-docs/4.1-pumpswap-amm-mechanism): "implements the constant product formula x * y = k"; similarly for bonding curve — [docs.raydium.io/algorithms/bonding-curves](https://docs.raydium.io/algorithms/bonding-curves) describes virtual-reserve CPMM variant | holds (approximately, with same quote-price caveat) |
| Raydium CLMM | concentrated liquidity (ticks, position ranges, Uniswap v3 analog) | [docs.raydium.io/products/clmm](https://docs.raydium.io/products/clmm): "Concentrated-liquidity AMM... liquidity is deposited into price ranges (ticks)" | **DOES NOT hold** — TVL depends on ticks containing active liquidity and their distribution; no global `x*y=k` relation across entire pool |
| Raydium LaunchLab (pre/post graduation) | mixed: docs describe quadratic, linear, and CPMM bonding curve variants ([docs.raydium.io/algorithms/bonding-curves](https://docs.raydium.io/algorithms/bonding-curves): "quadratic, linear, and virtual-reserves CPMM variants") | **NOT VERIFIED** — exact curve utilized by specific pool cannot be determined from GeckoTerminal response |

For `raydium-clmm` and `raydium-launchlab`, formulation of §15c is applied as directional: `dropCause` for such pools is not reclassified separately (code does not branch on dex type when computing `dropCause` — redundant complexity without explicit request), but interpretation of PRICE_CRASH/LIQUIDITY_REMOVAL for these two dex_ids is considered **approximate**, rather than strictly grounded in constant product.

### 16.3. Real Finding: `DEX_ID_REGEX` Already Includes CLMM and LaunchLab

Verified via request `GET https://api.geckoterminal.com/api/v2/networks/solana/dexes` (live, secret-free): Raydium Solana dex_ids are `raydium`, `raydium-clmm`, `raydium-launchlab`. Current collector filter (`scripts/shadow/collect.mjs:60`, `DEX_ID_REGEX = /^(raydium|pump-?fun|pumpswap)/i`) is anchored only at line start and matches **all three** — thus CLMM and LaunchLab pools already enter the collected sample; this is not a hypothetical edge case. Not a separate task question, but directly affects what fraction of records should consider `dropCause` approximate (§16.2) — recorded here as ancillary yet material finding. Code of `DEX_ID_REGEX` was not modified (task did not require it).

### 16.4. `price_usd_seen` (task 2): Live Verification

Verified via two live queries (secret-free), without API key:
- `GET /networks/solana/new_pools?page=1`: pool age ~6.85 min, `base_token_price_usd = 0.0000033777405881864313810930258996393750582046565270934406782663006`, `reserve_in_usd = 2678.5907` — in same `data[].attributes` object.
- `GET /networks/solana/pools/Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE` (pool created `2023-07-05T14:34:02Z`, age ~1,182 days at check): `base_token_price_usd = 118.66091444137043419014986596`, `reserve_in_usd = 30725450.5071` — same `data.attributes`.

Both cases confirm: field is present in both `new_pools` and `GET /pools/{address}`, in same object as `reserve_in_usd` — no additional query required. Code matched this assumption; no edits needed regarding field presence, only its utilization added (below).

Implementation:
- `scripts/shadow/collect.mjs`, `fetchFreshPools`: `price_usd_seen` is read from `p.attributes.base_token_price_usd` in same loop reading `reserve_in_usd`; `NULL` on missing/non-numeric value, without fallback to `0`.
- `scripts/shadow/db.mjs`: new column `shadow_trades.price_usd_seen REAL`.
- `scripts/shadow/outcomes.mjs`, `fetchGeckoTerminalPoolReserve`: now also returns `priceUsd` from **same** GeckoTerminal response computing `L_t3` — without extra request. Unlike `reserve_in_usd`, missing price throws no exception (does not block `drop` computation), yielding `dropCause: "UNDETERMINED"`.

Tests: `test/shadow-collector.test.mjs` — `fetchFreshPools: priceUsdSeen...` (presence/absence), `runCollectionCycle: ... price_usd_seen saved...`, plus four `dropCause` tests from §16.1.

### 16.5. Distribution of seen_at − t (task 3)

`scripts/shadow/analyze.mjs`: `computeSeenAtVsTGapMinutes(rows, poolCandidateRows)` — distribution of (`pool_candidates.seen_at` for record with `selected=1` for given `pair`) minus record's `t`, in minutes: median, 90th percentile (nearest-rank), maximum. Records lacking `pool_candidates` with `selected=1` on same `pair` are counted separately (`unmatchedCount`) and explicitly excluded from distribution (neither silently dropped nor counted as zero gap) — `formatSeenAtVsTGapReport` prints this count as separate line when `> 0`. Function reads only `pair`/`t`/`seen_at`/`selected` — reads neither `outcome`/`radar_verdict`/`radar_error`, thus added to both `--counters-only` (`formatCountersOnlyReport`) and full report; `--counters-only` continues to omit outcomes and causes across all sections. Tests: `test/shadow-analyze.test.mjs` — median/p90/max on synthetic data, unmatched case, empty input, and explicit test that `formatSeenAtVsTGapReport` does not mention `outcome`/`DANGEROUS`/`SAFE`.

---

## 17. Outcomes Evaluation Transport and Logging Amendments (stage 7M)

### 17a. Scope and Timing of Amendments

Amendments of this section were introduced **after** tagging `shadow-v3` and **before** computing any outcome (`shadow/` was empty at time of edits — collection on Pi was running, but `outcomes.mjs` had not yet run in production mode). They affect solely request transport to GeckoTerminal (pause, exponential backoff honoring `Retry-After`), execution time limit per `outcomes.mjs` run, categorization of deferred (`DEFERRED`) records, and journal logging summary. Criteria (a)/(b), thresholds (`0.9`, `MIN_INITIAL_LIQUIDITY_USD`, `LIQUIDITY_T3_RETRY_MAX_DAYS`), outcome classes, and `drop` formula **did not change** (`classifyOutcome` untouched; `git diff` on `scripts/shadow/outcomes.mjs` shows only new pause/categorization functions and edits inside `runOutcomesWorker`/`fetchGeckoTerminalPoolReserve`, zero lines in `checkPoolLiquidityDrop` threshold logic or `classifyOutcome`). Data already recorded at time `t` (stage 7J/7L task 1) is unaffected — these amendments concern exclusively WHAT happens during outcome computation at `t+N`, not what was stored at buy time.

### 17b. Collector Version and Outcomes Evaluation Tag

Collector remains on version `shadow-v3`: `git diff 563a943..HEAD --stat -- scripts/shadow/collect.mjs scripts/shadow/db.mjs src/` — empty (executed in stage 7M report). Outcome evaluation from this commit forward runs under tag **`outcomes-v1`** — tag for `outcomes.mjs`/`analyze.mjs` code (transport and reporting), NOT a new collection data snapshot; data continues to be collected under `shadow-v3`.

### 17c. Actual Operation

- Collection started **2026-09-30 09:11:05 UTC** (first record in live database — `2026-09-30 09:11:08.631Z`; no data existed prior).
- Collector ceiling (`collect`): **1500** requests/day until **2026-09-30 10:14:31 UTC**, thereafter **1800**.
- Outcome evaluation ceiling (`outcomes`): **1500** requests/day.
- Both ceilings configured in environment (`DAILY_REQUEST_CEILING`/`DAILY_REQUEST_CEILING_OUTCOMES` or equivalent on Pi) — **not in code or tag**; default in code (`DEFAULT_DAILY_CEILING_COLLECT`/`DEFAULT_DAILY_CEILING_OUTCOMES`, `db.mjs`, unchanged in this stage) remains `1500`.
- Prior start attempt, **2026-09-30 09:08:03–09:08:59 UTC**, halted at clock verification step BEFORE starting Node — recorded no data (not part of live run).

### 17d. Device Power Outage Episode

Device (Orange Pi) lost power on evening of **2026-09-29** and was booted **2026-09-30 07:11:37 UTC**; data collection began later (17c) — this episode in itself does not affect collection data (collection was not active prior to shutdown or during interval).

### 17e. Backups and Notifications

Database backups and Telegram notifications (where present) are operational infrastructure surrounding collection, not affecting recorded data itself (`shadow_trades`, `pool_candidates`, `error_logs`).

### 17f. Task 1 Diagnostics — Live Reproduction

Locally (public GET/RPC requests only, without accessing `radar.env`): `node scripts/shadow/collect.mjs --once --db=scratch/dry-m.db` (10 consecutive cycles) -> 6 real records; then `node scripts/shadow/outcomes.mjs --force-all --db=scratch/dry-m.db` -> 1 of 6 records went to `[DEFERRED]` without specified reason (symptom reproduced). Cause found in `error_logs` (real record id=19): `"GeckoTerminal 429 Too Many Requests: https://api.geckoterminal.com/api/v2/networks/solana/pools/BSVx8Twdynuz1jWgMshdznaevFB5t4vfZSGuYqxdut4k"` — diagnostic sequence itself (rapid `collect.mjs` cycles without pause between GeckoTerminal requests, immediately followed by `outcomes.mjs --force-all`) triggered live GeckoTerminal rate-limiting. Direct justification for 17a / §16 task 2 amendments: pause `>= 2.5s` (`GECKOTERMINAL_MIN_INTERVAL_MS_DEFAULT`, `scripts/shadow/outcomes.mjs`) and respecting `Retry-After` on 429.

### 17g. Categorization of DEFERRED Reason

`categorizeDeferredReason` (`scripts/shadow/outcomes.mjs`) maps error text to one of five task categories (`RATE_LIMIT_429`, `HTTP_5xx`, `TIMEOUT`, `PARSE`, `NO_FIELD`) or `UNKNOWN` (explicit fallback outside the five — used only if no pattern matches, nothing invented). Reason and category are written to `shadow_trades.outcome_details` via separate `UPDATE` that NEVER touches the `outcome` column (which must remain `NULL` so `getPendingTrades` retries on next pass) — this is NOT `updateTradeOutcome` (which writes both columns together), but direct SQL inside `outcomes.mjs` without modifying `db.mjs`. Duplicated in `error_logs` (`action = 'deferred:<id>'`).

### 17h. Time Limit and Queue Order

`runOutcomesWorker({ timeLimitMinutes })`, default **90 minutes**: on reaching limit cycle halts cleanly (unprocessed records remain `outcome = NULL`, not lost, picked up by next pass), count of remaining unprocessed records logged. Queue order — by `t` ascending — was already provided by `getPendingTrades` (`db.mjs`, `ORDER BY t ASC`) **prior** to this stage and was not modified; confirmed by code reading and used as is.

---

## 18. Pre-outcome Observation and Rule: Record id 66 Outside Sampling Frame (stage 7N)

Fixed **before** computing any outcome (collection on Pi continues, final evaluation — 2026-10-10 09:00 UTC, §15g). Section 17 is not rewritten.

### 18a. Observation

In `shadow.db`, record `id = 66` has `t = 1715289046` (corresponding to `2024-05-09T21:10:46Z`), while `seen_at` of its matching pool record (`pool_candidates`, `selected = 1`) is `2026-10-01T01:14:44Z`. The difference `seen_at − t` is **1,258,803.97 minutes**.

Arithmetic verified in this session directly (`node -e "..."`, `(Date.parse('2026-10-01T01:14:44.000Z')/1000 - 1715289046) / 60` -> `1258803.97`, raw output: `t as ISO: 2024-05-09T21:10:46.000Z`, `seen_at as ISO: 2026-10-01T01:14:44.000Z`, `diff seconds: 75528238`, `diff minutes: 1258803.97`) — result matches stated figure. Raw `t`/`seen_at` values were not read from `shadow.db` in this session (database is on Pi; network/SSH access was not used in this stage); they are accepted as provided data.

Collector sampling frame — token no older than `POOL_MAX_AGE_MINUTES` (15 minutes) at processing time (`scripts/shadow/collect.mjs`) — is violated for this record by four orders of magnitude.

### 18b. Rule Fixed Prior to Viewing Outcome

- Record `id = 66` **is excluded** from primary and secondary analysis tables (`analyze.mjs`, section 4/13) and shown as separate line **"excluded as violating sampling frame"** — credited toward neither `DANGEROUS`, nor `SAFE`, nor any other outcome class.
- General rule (applied to future records identically, not only `id = 66`): any record where `seen_at − t` (in minutes, `pool_candidates.seen_at` for selected candidate minus `shadow_trades.t`) **exceeds 1000 minutes** is excluded identically — as separate line, not in primary/secondary table. Count of such excluded records is reported explicitly in report (as separate counter).
- Threshold `1000 minutes` is fixed now, prior to computing any outcomes, and must not be retroactively fitted to result (rule 4 of this document).
- **Code was not modified in this stage** (document-only stage, no code) — implementing this exclusion rule in `scripts/shadow/analyze.mjs` remains an open task for separate subsequent code stage; until implemented, `analyze.mjs` report does not apply this filtering automatically.

### 18c. Accounting Note: NO_BUYER Overlaps with UNCLASSIFIED Form

At check time, `NO_BUYER` accounts for **24 of 93** records and coincides with the `/gate-copy` response form classified as `UNCLASSIFIED` (`classifyResponseForm`, `analyze.mjs`) — for a record without buyer `/gate-copy` is not called at all, so its response form cannot be any of `F1`–`F6` and falls into `UNCLASSIFIED` by default, rather than because an unrecognized response arrived. In response form tables `NO_BUYER` should be shown as **separate line "no buyer"**, rather than collapsed into `UNCLASSIFIED` — otherwise `UNCLASSIFIED` share is distorted by confounding two distinct causes (unparsed server response vs absence of buyer where server was not called). Modifying classification in code is outside scope of this document-only stage.

### 18d. Outlier Cause Not Established

Why specifically record `id = 66` received `t` dating to May 2024 with `seen_at` in October 2026 **has not been established**. NOT VERIFIED: whether this stems from buyer resolution bug (`resolveBuyer`), timestamp overflow/parsing error, or other cause was not investigated — further inquiry requires code and live DB access on Pi, outside scope of this stage.

---

## 19. Publication Notes (`release` branch, stage 7O)

Sections 1–18 are not rewritten.

### 19a. What Actually Changed in `release` after `outcomes-v1`

Actual output:

```
git diff --stat outcomes-v1..HEAD
 ADVERSARIAL-TESTING.md        |   2 +-
 CHANGELOG.md                  |  15 +-
 README.md                     | 155 +++++++++++++-----
 SECURITY.md                   |   8 +-
 archive/exp1/NOTICE.md        |  48 ++++++
 assets/devnet-log-sample.json |  22 +++
 docs/KNOWN-ISSUES.md          | 372 ++++++++++++++++++++++++++++++++++++++++++
 docs/PREREGISTRATION.md       |  29 ++++
 docs/PROPOSED-DESCRIPTIONS.md |  84 ++++++++++
 docs/index.html               |  12 +-
 docs/oracle-spike.md          |   2 +-
 docs/trust-spec.md            |   2 +-
 examples/copy-bot-firewall.ts |   2 +-
 scripts/generate-voiceover.py |  12 +-
 scripts/render-video.py       |  63 ++++---
 src/hook/README.md            |   2 +-
 16 files changed, 740 insertions(+), 90 deletions(-)
```

All 16 files are documentation (`.md`/`.html`), video assets/scripts (`assets/devnet-log-sample.json`, `scripts/render-video.py`, `scripts/generate-voiceover.py`), comment in `examples/copy-bot-firewall.ts` (see 19b — confirmed to be comment only, not code), and `src/hook/README.md` (md file inside `src/`). Zero `.ts` code files and zero `scripts/shadow/` files appear in this list.

### 19b. Code Verification (Analogous to §17b)

Actual output (empty):

```
git diff 563a943..HEAD --stat -- 'src/*.ts' scripts/shadow/collect.mjs scripts/shadow/db.mjs scripts/shadow/preflight.mjs
```

General check across entire `src/` directory (without `.ts` restriction):

```
git diff 563a943..HEAD --stat -- src/
 src/hook/README.md | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

Sole difference in `src/` is `src/hook/README.md`, which is documentation, not code. Edit to this file (`DestinationHighRisk` -> `CounterpartyFlagged`, stage 9D) is textual in a commented description line, touching zero `.ts` lines.

### 19c. GitHub Publication Following Collection Start — Independent Confirmation

Commit and tag dates in git are set locally (by client at command execution) and do not in themselves constitute independent proof of event sequence. Independent confirmation of collection start time is the server journal on Pi (not git): collection started **2026-09-30 09:11:05 UTC** under commit `563a9435f8b290126bb3239647479c4b144dc524` (same commit pointed to by tag `shadow-v3^{commit}`), already recorded in §17c of this document independently of repository publication. Repository publication on GitHub (if/when it occurs) cannot by construction precede this server journal entry, since the `release` branch containing only documentation edits after `outcomes-v1` was created after commit `563a943` and does not modify the code under which collection was already running.

### 19d. Collection Data Not Published Prior to Final Computation

Copy of collection data (`shadow.db`, `shadow_trades`, `pool_candidates`, `error_logs`) is not published and not attached to repository prior to final outcome computation (**2026-10-10 09:00 UTC**, §15g). Prior to that date, only code, preregistered protocol (this document), and individual explicitly marked observations (e.g. §18) remain publicly accessible — not the full database dump.

---

## 20. Pre-Outcome Analysis Rules: Code Implementation and Version Lock (Stage 15C)

Recorded **before** computing any outcomes (collection on Pi continues, final outcome evaluation — **2026-10-10 09:00 UTC**, §15g). Sections 1–19 are not rewritten.

### 20a. Implemented Changes in analyze.mjs

The analysis script (`scripts/shadow/analyze.mjs`) implements the rules preregistered in §18b and §18c:
1. **Exclusion of records with gap `seen_at − t > 1000` minutes**:
   Records where the gap between `seen_at` of the matching selected candidate (`pool_candidates`, `selected = 1`, matched on `pool === pair`) and the trade purchase timestamp `shadow_trades.t` strictly exceeds 1000 minutes (`(new Date(candidate.seen_at).getTime() - row.t * 1000) / 60000 > 1000`) are excluded from primary (Tables 1 and 2 across strata A and B) and secondary (response forms, simulation split, one record per buyer) analysis tables. In the report (`formatReport`), such records are reported on a separate line:
   `excluded as violating sampling frame: N` with record identifiers (`ids: ...`).
2. **Separation of NO_BUYER and UNCLASSIFIED in response forms table**:
   Records without a buyer (`buyer is null`), where `/gate-copy` was never invoked, are displayed in the response forms table on a separate line `"no buyer"` rather than bundled into `UNCLASSIFIED` (`countRowsByForm`, `dangerousShareByForm`). The `UNCLASSIFIED` line is reserved strictly for genuine unparsed server responses.
3. **Mode `--counters-only` continues to never output outcomes**:
   The counters mode (`formatCountersOnlyReport`) reports response form distributions (including the `"no buyer"` line), the `seen_at − t` gap distribution, skip counters, and candidate counts, but strictly neither computes nor displays outcomes (`DANGEROUS`, `SAFE`, `RESOLVED`, danger shares, Wilson intervals, and Tables 1/2).

### 20b. Invariance of Threshold and Rule Formulation Relative to §18b

The 1000-minute threshold and the exclusion rule formulation established in §18b prior to computing outcomes were ported to the analysis code without alterations:
- cutoff criterion remains strictly greater than 1000 minutes (`> 1000`, not `>= 1000`);
- excluded records are credited toward neither `DANGEROUS`, nor `SAFE`, nor any other outcome class;
- threshold was fixed prior to viewing outcome results and was not retrofitted to data (rule 4 of this document).

### 20c. Development and Testing Exclusively on Synthetic Data without Access to Live Outcomes

All implementation and unit tests (`test/shadow-analyze.test.mjs`) were written and verified exclusively offline on synthetic in-memory databases (`:memory:`):
- without connecting to the live `shadow.db` database on Orange Pi and without network access;
- without reading live records and without computing real on-chain outcomes;
- tests explicitly verify five synthetic scenarios:
  - gap 1258803.97 minutes (analog of record id=66) is excluded from Tables 1/2 and reported on a separate line;
  - boundary gap 999 minutes is not excluded and enters table calculations;
  - boundary gap of exactly 1000 minutes is not excluded (strict inequality `> 1000`);
  - `NO_BUYER` is displayed on a separate line `"no buyer"` and does not enter `UNCLASSIFIED`;
  - mode `--counters-only` contains zero mentions of outcomes (`DANGEROUS`, `SAFE`, `RESOLVED`, `CI95`, Tables 1/2).

### 20d. Outcome Computation Module Unchanged (outcomes-v1)

The on-chain outcome evaluation code (`scripts/shadow/outcomes.mjs`), database schema (`scripts/shadow/db.mjs`), data collector (`scripts/shadow/collect.mjs`, `preflight.mjs`), detection engine (`src/`), and tag `outcomes-v1` were not modified in this stage.

### 20e. Code Version and Analysis Execution Schedule

1. **Code version**: implementation is locked with annotated tag `analysis-v1` on the final commit of the `analysis` branch.
2. **Execution schedule**: data analysis (`scripts/shadow/analyze.mjs`) will be performed on a separate copy of the live database strictly after completion of the collection window and outcome computation — after **2026-10-10 09:00 UTC** (§15g).

## 21. Code Changes After Collection Stopped

Sections 1-20 are not rewritten. Collection stopped at <STOP_UTC> (server journal on the board). The following was merged into main after the stop.

### 21a. What was merged
Branches fixes-a, fixes-b, fixes-c, analysis (tag analysis-v1) and dashboard. Changed files in src/: HTTP server authorization and rate limits (including /gate-copy), address validation (32 bytes), sanitized payment errors, 409 on a repeated signature, aligned x402 confirmation level between SDK and server, /analyze body validation before payment, the tokenCheck field and a token-check-unavailable marker, Token-2022 extensions in the TOXIC_MINT rule, a price-unavailable marker, TAINTED_FUNDING over all incoming transfers of the supplied history, the dormancy measure on the trust path for DORMANT_ACTIVE, an optional issuer token list (off by default), the new dashboard; analysis code scripts/shadow/analyze.mjs (section 20).

### 21b. What was not changed
scripts/shadow/collect.mjs, db.mjs, preflight.mjs, outcomes.mjs, tags shadow-v1, shadow-v2, shadow-v3 and outcomes-v1. The git diff check (shadow-v3 and outcomes-v1 against the merged branch) for these files is empty; the output is in the merge report.

### 21c. Which version the result refers to
Collection ran under shadow-v3, outcome computation under outcomes-v1. The changes in 21a were not deployed to the board and did not take part in collection or computation. The test result refers to shadow-v3 and does not transfer to the current main without re-verification: detection rules and thresholds in main differ from the tested version.

### 21d. Computation schedule
The outcome-computation timer was extended with runs at 09:00, 15:00 and 21:00 UTC (reason: GeckoTerminal rate limiting, HTTP 429). The outcomes-v1 code was not changed.
