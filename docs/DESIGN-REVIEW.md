# Design review of the wallet scoring method (written before the test outcomes were viewed)

Written and committed before outcome values were viewed; the preregistered rules and analysis are unchanged.

Source: the internal review report `REPORT-R1.md` (a local working file, not part of this repository). Every number below is copied from it. Labels follow the report: FACT (a code reference or a number from a run), INFERENCE (drawn from facts), ASSUMPTION. "NOT VERIFIED" means it was not checked.

## 1. Scope and method

- FACT: the code path of `POST /gate-copy` and the scoring rules were read, with file and line references.
- FACT: the scoring was run offline on 1001 cached wallet histories, without labels, by two paths: the trust path (no token metadata, as in `trust.ts`) and a walk-forward model (one transaction at a time, with token metadata from the cache).
- FACT: 12 synthetic wallets were pushed through the real `/gate-copy` handler on a local server with network stubs.
- FACT: no network, no outcome values, no shadow database; no source files were changed.
- FACT: the cache holds at most 50 latest transactions per wallet (median 50, maximum 50), so "age" and "transaction count" describe the cache window, not the wallet. 673 wallets look younger than a day; 688 fall into "50+".
- ASSUMPTION: the composition of the 1001 wallets is unknown and they are probably not buyers of new pools.

## 2. What the test's "blocked" bucket contains

In `scripts/shadow/analyze.mjs` the actions `block` and `manual_review` both go to the BLOCKED bucket (forms F1, F2, F3, F5). `throttle` (F4) is "passed" in table 1 and "blocked" in table 2; `allow` (F6) is "passed".

- Low balance (FACT): liquidity below $50 gives hold, form F1, even at risk 0 (scenario S8: balance about $23, risk 0, F1).
- Reactivation after a pause of 7 days or more (FACT): any `DORMANT_ACTIVE` leads to form F5 (`manual_review`) even at risk 15 (scenario S4).
- Data failures (FACT): F2 when the history or balance fetch fails; F5 when the token check is unavailable.
- Behavior inside the buyer's own window (FACT): in snapshot mode (section 3) the window is compared with itself.
- Token check (FACT): an active freeze authority blocks regardless of the wallet (S7, risk 0, F3).

The share of each reason is unknown (section 5). INFERENCE: the test compares outcomes of "blocked by the gate for any reason" with "passed".

## 3. Findings with numbers

All FACT unless marked.

1. Reproducibility: three full runs of each path on the same data gave identical result hashes. Trust path `eb6434beafcf849f` x3, walk-forward `ab5aeaa65575f184` x3. Differences 0.
2. Snapshot mode (trust path): with fewer than 3 trades older than 7 days, the baseline is the evaluated trades themselves. This applies to 802 of 1001 wallets. Novelty rules fire for 4.1% of wallets in snapshot mode against 95.4% in windowed mode.
3. Additive scoring: points are summed over rule instances (low 5, medium 15, high 30, cap 100). 153 of 1001 wallets are at exactly 100. 59 of 391 hold wallets are scored by a single repeated rule type.
4. `REGIME_SHIFT` double counting: it adds 30 points on top of rules already counted. Scenario S2 (fresh wallet, 5 swaps in 10 minutes into one new token): risk 80 from five rules, form F1.
5. `COUNTERPARTY_ESCALATION`: fired for 23 of 197 wallets in windowed mode (11.7%). In the synthetic control S11 with random counterparty choice it moved a stationary wallet to hold (risk 45); with deterministic equal windows it did not. The report does not establish that those 23 cache wallets are stationary.
6. Price dependence: replacing prices with `null` changes the verdict for 7.4% of wallets (trust path) and 2.2% (walk-forward). "With prices" here means only the built-in bluechip price table.
7. Evasion: gradual growth of swap size to $118 (S5, risk 0, allow) and splitting $600 into 6 x $100 swaps 45 minutes apart (S5b, risk 15, allow) both stay under the 3x rule.
8. Empty or very short history gives safe: 10 of 10 wallets with 1-2 transactions (trust path), 2 of 2 with 0 transactions; an empty history gives risk 0, not `unknown`.
9. `KNOWN_EXPLOITERS` has 6 addresses; 0 hits on 1001 wallets; origin of the addresses NOT VERIFIED. `KNOWN_CEX_WALLETS` is not referenced anywhere in `src`.
10. Freeze authority: S7 (clean wallet, token with active freeze authority) gives trust safe at risk 0 and a block in form F3.

## 4. Novelty hypothesis

Hypothesis: novelty rules (new venue, new program, new counterparty, reactivation) fire more often for short histories only because there is nothing to count as normal. Report verdict: partially.

- Walk-forward: confirmed, with a caveat. Share of steps with a novelty rule by number of previous transactions: 1 -> 45.3%, 2 -> 40.2%, 3-4 -> 43.9%, 5-9 -> 35.7%, 10-19 -> 25.8%, 20-49 -> 22.3%. A control that permutes transaction payloads inside each wallet's own time slots (5 fixed seeds) gives 50.6 / 47.6 / 51.2 / 42.3 / 27.9 / 19.4 % against the observed 44.2 / 39.4 / 43.1 / 35.1 / 25.3 / 21.3 %. The observed decline (-22.9 pp) is not larger than under random order (-31.2 pp). INFERENCE: the decline comes from the growth of the known set, not from short wallets behaving differently. Paired within wallet (852 wallets with at least 40 transactions): steps 1-5 fire in 40.1%, steps 26-45 in 21.9%; earlier higher for 455 wallets, lower for 151, equal for 246.
- Trust path (the `/gate-copy` path): not confirmed, the mechanism is the reverse. Novelty fires for 4.1% of wallets in snapshot mode and 95.4% in windowed mode (with the 14-day fetch window: 3.5% and 92.1%). Within windowed mode it is dominated by `DORMANT_ACTIVE` (67.5%) and `NEW_COUNTERPARTY` (71.6%). By number of evaluated transactions (14-day window) it is non-monotonic: 1-4 -> 8.2%, 5-9 -> 23.9%, 10-19 -> 18.4%, 20-49 -> 35.0%, 50+ -> 4.8%. INFERENCE: for short histories novelty is switched off in the trust path (`trust.ts:292-295`); it fires for wallets with at least 3 older transactions plus fresh activity.
- ASSUMPTION: buyers of new pools more often fall into snapshot mode, where self-referential rules (burst, concentration, large swap, regime shift) drive the result rather than novelty.

## 5. What is unknown

- The share of F1 caused by low liquidity versus risk (no balances offline).
- The share of pool buyers in snapshot mode versus windowed mode (the cache contains no pool buyers).
- How often token metadata for a new token is unavailable at request time (token check unavailable, form F5).
- The relation between the scoring and true danger (there are no labels).

## 6. Ideas for a next version (not implemented)

- Store and analyze the F1 reason separately (risk, liquidity, account owner); the `reasons` field is already in the response.
- Count distinct rules and cap each rule's contribution instead of summing instances; remove the `REGIME_SHIFT` double counting.
- Mark snapshot mode as "insufficient data" instead of scoring the window against itself; add a minimum history for a verdict.
- Equal-length windows with a minimum activity for `COUNTERPARTY_ESCALATION` and similar rules, with tolerance for random fluctuation.
- Report the token part (freeze, mint, concentration at trade time) separately from the wallet part.
- Record data features with each response (transactions in the window, window mode, balance, `degraded`) so strata by history length need no new request.
- Keep a medium `DORMANT_ACTIVE` as a separate class, not as a block.

## 7. Limits of this review

- Cache: at most 50 transactions per wallet, one fetch moment; in the trust path "now" is the wallet's last transaction plus 1 second. In a real request 99 wallets whose last transaction is older than 7 days from the end of the cache would have an empty window and risk 0.
- Prices: only the built-in bluechip table. No balances, so trust-path verdicts use risk only and `unknown` is not observable.
- Token metadata for the walk-forward model is a snapshot from fetch time, not from trade time. The walk-forward model evaluates one transaction at a time and is not the `/gate-copy` path.
- The permutation control covers three rules, 5 seeds; `DORMANT_ACTIVE` was not permuted.
- The 12 synthetic wallets show mechanics, not frequencies, and depend on the network stubs. The deterministic regime was added after the first run was viewed; both results are reported.

## 8. Report rows used (English titles)

The full STRONG / WEAK / UNKNOWN table stays in `REPORT-R1.md`; only the rows used above are listed.

| Row | Rating | Statement |
|---|---|---|
| 1 | STRONG | The method is deterministic: three runs on 1001 wallets give identical results on both paths. |
| 2 | STRONG | A token with an active freeze authority is blocked regardless of the wallet (form F3 at risk 0). |
| 4 | WEAK | Risk is additive over rule instances: 153 of 1001 wallets at 100; 59 hold wallets scored by one repeated rule. |
| 5 | WEAK | For 802 of 1001 wallets (trust path) the baseline is the evaluated transactions: novelty is off (4.1%). |
| 7 | WEAK | Liquidity below $50 gives hold (F1) regardless of behavior (S8: risk 0). |
| 8 | WEAK | Any `DORMANT_ACTIVE` (even medium, risk 15) leads to F5 `manual_review`, a "blocked" bucket. |
| 10 | WEAK | `COUNTERPARTY_ESCALATION` fires on a stationary regime with equal windows. |
| 11 | WEAK | Known evasions: growth under 3x (S5), splitting beyond 30 minutes (S5b). |
| 12 | WEAK | The `REGIME_SHIFT` meta-rule adds 30 points on top of rules already counted (S2). |
| 13 | WEAK | Several rules depend on prices; without prices the verdict changes for 7.4% (trust) and 2.2% (walk-forward). |
| 15 | WEAK | Novelty hypothesis: true for walk-forward, not for the trust path. |
| 16 | WEAK | `KNOWN_EXPLOITERS`: 6 addresses, 0 hits, origin NOT VERIFIED; `KNOWN_CEX_WALLETS` unused. |
| 17-20 | UNKNOWN | Share of F1 from liquidity; share of snapshot-mode pool buyers; link to true danger; availability of new-token metadata. |
