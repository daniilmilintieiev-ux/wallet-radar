# Result of the preregistered live test

Computed on 2026-10-10 from a copy of the collection database (sha256 above). Rules, thresholds and analysis code are those preregistered in docs/PREREGISTRATION.md (sections 1-25); nothing was changed after outcome values were viewed.

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

Check (derived): 138 + 8 + 1 + 1 + 217 + 73 + 167 = 605

Resolved records are 167 of 605 (derived: 27.6%).

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

In every variant the passed group is small (7 to 13 records) and the intervals overlap widely; no threshold is selected and no conclusion is drawn.

## What this does and does not say

It does not show that the radar works, and it does not show that it fails. Descriptively, 55 of 167 resolved first-buyer records (32.93%) ended with a frozen buyer token account or a liquidity drop of 90% or more within 3 days (definitions in docs/TESTER-SPEC.md section 2; the split between liquidity removal and price collapse is not reported here).

## Caveats

Only 167 of 605 records could be evaluated; 290 are irrecoverable (derived: 217 + 73). The resolved sample is dominated by one buyer address. The population is the first resolved buyer of a new pool (mostly bots and snipers), not copy-traders. The 'blocked' group mixes reasons (low balance, reactivation after a pause, data failures, behavior in the window; see docs/DESIGN-REVIEW.md, written before the outcomes were viewed).

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
