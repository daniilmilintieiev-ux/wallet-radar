# Result of the preregistered live test

Computed on 2026-10-10 from a copy of the collection database (sha256 above). Rules, thresholds and analysis code are those preregistered in docs/PREREGISTRATION.md (sections 1-25); nothing was changed after outcome values were viewed.

## In plain words

We collected 605 cases (first buyers of new Solana token pools) and could check the outcome of 167 of them. In the other 438 the outcome could not be checked: no buyer was found (138), the pool was outside the sample frame (8), the radar returned an error (1), liquidity moved to another venue (1), or the state could not be reconstructed afterwards (290). Of the 167 checked cases, 55 (about a third) ended badly: the buyer's token account was frozen or the pool's liquidity fell by 90% or more within 3 days. The radar blocked all 167 of them (164 at the first check of the buyer's wallet or balance, 1 by the token check, 2 sent to manual review). Because nobody was let through, there was no group to compare the blocked cases with. So this test cannot show whether the radar separates dangerous from safe cases, and it does not show that it fails. The preregistered criterion 'radar is useful' is therefore not met.

Calculated: 605 - 167 = 438; 138 + 8 + 1 + 1 + 290 = 438; 217 + 73 = 290 (formulas shown in the table below).

## Hashes and versions

| Artifact | Identifier / SHA256 | Note / Timestamp |
|---|---|---|
| analysis-v1 | d3d406d50dec416b2f0d8d39e6542de02aa5b15d | Commit hash of the primary analysis code |
| outcomes-v1 | 5ff5ddc24a6672fcf58174237ec277c90563a6e3 | Commit hash of the outcome worker on the board |
| sensitivity-v1 | 82dcd007bd8b4c6984c8e80f46693b6a493102aa | Commit hash of the sensitivity analysis code |
| Database copy (605 records) | e8029e4941cbbf4604706162ccd50236fc79f8cb93f9ddb7b17e819fe3b5af5a | Snapshot taken 2026-10-10T12:01:20Z |
| report-full.txt | C3E2A068B32814165758DAC494CC88B0929B492CEEAC85B131F0CBA268692AA5 | Primary report, run 2026-10-10T12:04:06Z |
| report-sensitivity.txt | 8FF0769A3D241F7BBC995AA9FBB313B9796ED5F2BCE10D30AB768ACC2D7729BB | Sensitivity report, run 2026-10-10T12:04:16Z |

## Headline

Preregistered verdict for the 'radar is useful' criterion (sections 4.5, 4.6, 14г): NOT MET.

- Stratum A, Table 1 (throttle=passed) and Table 2 (throttle=blocked): DIFFERENCE_NOT_ESTABLISHED
- Secondary tables "one record per buyer": INSUFFICIENT_DATA (only 25 DANGEROUS, below 30)
- Stratum B, Table 1 and Table 2: INSUFFICIENT_DATA (0 resolved records)

In the primary definition all 167 resolved records fell into the 'blocked' group; the 'passed' group is empty (n=0). Blocked and passed therefore could not be compared, and this test cannot show whether the radar separates dangerous from safe outcomes.

## Accounting of the 605 records

| Category | Count | Report status / Description |
|---|---|---|
| NO_BUYER | 138 | No buyer found for the pool |
| excluded as violating sampling frame | 8 | ids: 66, 155, 266, 272, 300, 337, 445, 484 |
| RADAR_ERROR | 1 | Radar execution error |
| MIGRATION_NOT_AN_OUTCOME | 1 | Pool migration (not an outcome) |
| IRRECOVERABLE | 217 | Irrecoverable data |
| IRRECOVERABLE_NO_LIQUIDITY_AT_T | 73 | No liquidity at transaction time t |
| Resolved records | 167 | RESOLVED (DANGEROUS+SAFE), of which DANGEROUS: 55 |
| PENDING | 0 | Pending computation |
| ISSUER_CONTROLLED | 0 | Issuer controlled |
| PAIR_MISSING | 0 | Pair missing (both bounds: 0) |

Check (calculated): 138 + 8 + 1 + 1 + 217 + 73 + 167 = 605

Resolved records are 167 of 605 (calculated: 167 / 605 = 27.6%).

## Primary tables (Stratum A)

- Blocked: x=55/n=167 p=32.93% CI95=[26.26%, 40.38%]
- Passed: n=0 (undefined)
- One-record-per-buyer (Stratum A): 25/54 p=46.30% CI95=[33.69%, 59.39%]
- Distinct buyers among resolved records: 54; the largest single buyer address accounts for 94 resolved records (BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s)
- Share of all records answered by form F1 (blocked before the token check): 390/605 (64.46%)

## Exploratory sensitivity (section 22; NOT a result)

EXPLORATORY ANALYSIS: same data, thresholds not independently validated; the primary result is the analysis-v1 report and is not replaced by this table.

| Threshold | Blocked (x/n, p, CI95) | Passed (x/n, p, CI95) | Ratio (block/pass) | Status |
|---|---|---|---|---|
| T=20 | x=51/n=160 p=31.87% CI95=[25.15%, 39.45%] | x=4/n=7 p=57.14% CI95=[25.05%, 84.18%] | 0.56x | DIFFERENCE_NOT_ESTABLISHED |
| T=30 | x=50/n=158 p=31.65% CI95=[24.90%, 39.26%] | x=5/n=9 p=55.56% CI95=[26.66%, 81.12%] | 0.57x | DIFFERENCE_NOT_ESTABLISHED |
| T=40 | x=50/n=158 p=31.65% CI95=[24.90%, 39.26%] | x=5/n=9 p=55.56% CI95=[26.66%, 81.12%] | 0.57x | DIFFERENCE_NOT_ESTABLISHED |
| T=50 | x=48/n=155 p=30.97% CI95=[24.22%, 38.63%] | x=7/n=12 p=58.33% CI95=[31.95%, 80.67%] | 0.53x | DIFFERENCE_NOT_ESTABLISHED |
| T=60 | x=47/n=154 p=30.52% CI95=[23.79%, 38.19%] | x=8/n=13 p=61.54% CI95=[35.52%, 82.29%] | 0.50x | DIFFERENCE_NOT_ESTABLISHED |

agreement with primary bucket at T=30: 360 of 458 (98 differing)

In this exploratory table the small 'passed' group (7 to 13 records) had a higher share of dangerous outcomes (55% to 62%) than the 'blocked' group (about 31% to 32%); the groups are small, the intervals overlap widely, and no conclusion is drawn.

In every variant the passed group is small (7 to 13 records) and the intervals overlap widely; no threshold is selected and no conclusion is drawn.

## What this does and does not say

It does not show whether the radar separates dangerous from safe cases, and it does not show that it fails. Descriptively, 55 of 167 resolved first-buyer records (32.93%) ended with a frozen buyer token account or a liquidity drop of 90% or more within 3 days (definitions in docs/TESTER-SPEC.md section 2; the split between liquidity removal and price collapse is not reported here).

## Caveats

- Only 167 of 605 records could be evaluated; 290 are irrecoverable (calculated: 217 + 73 = 290).
- Of the 167 resolved records, 164 were blocked at the first check (form F1), so the test mostly measured whether the buyer's wallet or balance triggered a block, not the danger of the token itself (see docs/DESIGN-REVIEW.md).
- The resolved sample is dominated by one buyer address.
- The population is the first resolved buyer of a new pool (mostly bots and snipers), not copy-traders.
- The 'blocked' group mixes reasons (low balance, reactivation after a pause, data failures, behavior in the window; see docs/DESIGN-REVIEW.md, written before the outcomes were viewed).

## Glossary

- **blocked / passed**: The two operational buckets based on the gateway verdict. In Stratum A, blocked has n=167 records (`report-full.txt:47`), passed has n=0 records (`report-full.txt:48`).
- **dangerous outcome**: An outcome where the buyer's token account was frozen or the pool's liquidity fell by 90% or more within 3 days (docs/TESTER-SPEC.md section 2). In Stratum A, 55 records had dangerous outcomes (`report-full.txt:43`), and 25 under the one-record-per-buyer filter (`report-full.txt:83`).
- **resolved record**: A record whose outcome could be determined as either DANGEROUS or SAFE (excluding unresolvable and excluded cases). There are 167 resolved records in Stratum A (`report-full.txt:43`) and 0 in Stratum B (`report-full.txt:56`).
- **stratum A and B**: Two preregistered slices of the sample (docs/PREREGISTRATION.md section 4.2). Stratum A has 167 resolved records (`report-full.txt:43`); Stratum B has 0 resolved records (`report-full.txt:56`).
- **DIFFERENCE_NOT_ESTABLISHED**: "a difference between the groups could not be shown; here because the passed group is empty" (n=0, `report-full.txt:48`). Recorded for Stratum A Table 1 (`report-full.txt:46`) and Table 2 (`report-full.txt:50`).
- **INSUFFICIENT_DATA**: "fewer than 30 dangerous outcomes, so no conclusion may be drawn" (preregistration threshold < 30, `report-full.txt:59, 84`). Found in one-record-per-buyer Stratum A with 25 dangerous outcomes (`report-full.txt:84`), and in Stratum B with 0 dangerous outcomes (`report-full.txt:59`).
- **CI95**: "the range that contains the true share with 95% confidence" (Wilson score interval, docs/PREREGISTRATION.md section 4.4). For Stratum A blocked: [26.26%, 40.38%] (`report-full.txt:47`).
- **IRRECOVERABLE**: "the outcome could not be checked afterwards; the report does not break this down by cause; 73 of them had no liquidity value saved at the time of purchase" (217 records in `report-full.txt:6`; 73 in `report-full.txt:7`).
- **form F1 / F3 / F5**: Response forms of `/gate-copy` (docs/PREREGISTRATION.md section 12a; docs/DESIGN-REVIEW.md). F1: blocked at the first check of buyer history/balance (164 resolved records, `report-full.txt:26`); F3: blocked by the token check (1 resolved record, `report-full.txt:28`); F5: sent to manual review (2 resolved records, `report-full.txt:30`).

## How to reproduce

Commands to reproduce the reports:
```bash
git checkout analysis-v1
node scripts/shadow/analyze.mjs --db=<copy>

git checkout sensitivity-v1
node scripts/shadow/sensitivity.mjs --db=<copy>
```

Artifacts and verification checksums:
- Database copy (605 records): sha256 `e8029e4941cbbf4604706162ccd50236fc79f8cb93f9ddb7b17e819fe3b5af5a`
- `report-full.txt`: sha256 `C3E2A068B32814165758DAC494CC88B0929B492CEEAC85B131F0CBA268692AA5`
- `report-sensitivity.txt`: sha256 `8FF0769A3D241F7BBC995AA9FBB313B9796ED5F2BCE10D30AB768ACC2D7729BB`

## Data publication

The database copy contains raw error logs and is not published as is; a sanitized export will be added after checking it for secrets. Its sha256 is listed above.
