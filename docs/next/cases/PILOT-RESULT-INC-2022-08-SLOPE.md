# Descriptive Pilot Results: Incident INC-2022-08-SLOPE

## 1. Summary

- **Incident**: `INC-2022-08-SLOPE` (Slope Wallet Key Compromise)
- **Date of run**: 2026-10-17T19:18:16.332Z
- **Software version**: tag `submission-colosseum-fall2026` (commit `b5a0388431742acaa3a47e5ca6f0b716ecd76f23`)
- **Specification**: `docs/next/cases/SCORING-SPEC-PILOT.md` (including Amendment 1)
- **Total Helius API calls**: 13 (budget: 300)

### Overall Counts

- **Flagged at $T_a$** ($t_0$ drain tx included, `riskScore > 30`): **2 of 5**
- **Flagged at $T_b$** ($t_0 - 300\text{s}$ pre-drain state, `riskScore > 30`): **1 of 5**

> Note: These counts describe the pilot cases under the frozen evaluation pipeline without price or token-metadata feeds. They are raw descriptive counts and do not constitute a detection rate claim.

## 2. Case Results Table

| Case ID | Wallet | Depth Reached | Mode ($T_a$ / $T_b$) | Flagged at $T_a$ (Score) | Flagged at $T_b$ (Score) | History File SHA-256 |
|:--------|:-------|:--------------|:---------------------|:-------------------------|:-------------------------|:---------------------|
| C-001-1 | `4J7uT2PQnrfWazv3DJcM82i49WmTugyfpdmDvEjKLDks` | 101 txs | windowed / snapshot | **no** (20) | **no** (0) | `036d64a636384522...` |
| C-001-2 | `96StvqZyFUPtyMr4o9s7K4V29RSNyRpVi76vNwxG5rUf` | 401 txs | windowed / windowed | **yes** (50) | **yes** (50) | `1ff34abb3db2afb2...` |
| C-001-3 | `AWrN51REFu1ZWoT2qHjXaVaUuqmUV4SqTWPxSbC2DVqW` | 45 txs | windowed / snapshot | **no** (20) | **no** (0) | `07499a61fe8e5010...` |
| C-001-4 | `5K659U8aiopakWpVn3jH7ihXnEnuBBKmCavW3o185MZS` | 101 txs | windowed / snapshot | **yes** (35) | **no** (0) | `de1e1ab062ef8dc6...` |
| C-001-5 | `7GKE13Q3PW8EBMdVm6ENYyZPV5ELSYq4qGFVijFwRctd` | 63 txs | windowed / windowed | **no** (5) | **no** (15) | `acbf7c429ad8f8b7...` |

## 3. Detailed Case Breakdown

### Case C-001-1

- **Wallet Address**: `4J7uT2PQnrfWazv3DJcM82i49WmTugyfpdmDvEjKLDks`
- **$t_0$ Timestamp (UTC)**: `2022-08-02T23:27:55Z` (Unix: `1659482875`)
- **$t_0$ Drain Signature**: `3iBJ7p8wWUP7EFCfNit8PAytiSch9Pfq8XSj2SdYzBFL1deC3BJXboeyd4zMXxMFYSdYbBcEfKv7aFYjyWFcVqpC`
- **Raw History File**: `analysis-data/pilot/C-001-1.json`
- **Raw History SHA-256**: `036d64a636384522c0b8269b2e6dfe59cea65f1d16883684948e4aa7b564f2e2`
- **History Depth**: 101 txs, oldest: 2022-02-22T18:29:44.000Z (161.2 days before t0)

#### Checkpoint $T_a$ ($t_0$, compromise included):
- **Flagged**: no (`riskScore = 20`)
- **Baseline Mode**: windowed
- **Detected Anomalies** (2):
  - [MEDIUM] **DORMANT_ACTIVE**: Wallet reactivated after ~27 days of inactivity.
  - [LOW] **NEW_COUNTERPARTY**: New counterparty Htp9MGP8Tig923ZFY7Qf2zzbMUmYneFRAhSp7vSg4wxV (1 interaction) against 64 established relationships.

#### Checkpoint $T_b$ ($t_0 - 300\text{s}$, pre-compromise):
- **Flagged**: no (`riskScore = 0`)
- **Baseline Mode**: snapshot
- **Detected Anomalies** (0):
  - None

---

### Case C-001-2

- **Wallet Address**: `96StvqZyFUPtyMr4o9s7K4V29RSNyRpVi76vNwxG5rUf`
- **$t_0$ Timestamp (UTC)**: `2022-08-02T22:49:05Z` (Unix: `1659480545`)
- **$t_0$ Drain Signature**: `3g8G26zWLCep5QM8sVjsHQLfsg7e5oMXyFsmVERQnxtfhuBpbq5FntrPWq1755y6u7icYrvdN1zHDzUSEmVav426`
- **Raw History File**: `analysis-data/pilot/C-001-2.json`
- **Raw History SHA-256**: `1ff34abb3db2afb2f001bdc600825a6fad724c8cac4fd638855ea5d7221e4c8e`
- **History Depth**: 401 txs, oldest: 2022-05-04T16:04:30.000Z (90.3 days before t0)

#### Checkpoint $T_a$ ($t_0$, compromise included):
- **Flagged**: yes (`riskScore = 50`)
- **Baseline Mode**: windowed
- **Detected Anomalies** (8):
  - [LOW] **NEW_PROTOCOL**: First interaction with program HnSAxH8uhn2ouSQtxVByWzVRtrgNY3ewkjaUny6fMpfQ.
  - [LOW] **NEW_PROTOCOL**: First interaction with program EverSFw9uN5t1V8kS3ficHUcKffSjwpGzUSGd7mgmSks.
  - [LOW] **NEW_PROTOCOL**: First interaction with program CsFJ6i3nhUJq43KwGxALBAmSawv6cSQHYcVceczxbQrq.
  - [LOW] **NEW_PROTOCOL**: First interaction with program strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m.
  - [LOW] **NEW_COUNTERPARTY**: New counterparty CEzN7mqP9xoxn2HdyW6fjEJ73t7qaX9Rp2zyS6hb3iEu (3 interactions) against 64 established relationships.
  - [LOW] **NEW_COUNTERPARTY**: New counterparty 32cqCvRwLEFAX5hg2neqepW2JZpGf11oBGVA8zEigeah (2 interactions) against 64 established relationships.
  - [LOW] **NEW_COUNTERPARTY**: New counterparty MtvDRVATWdGwEG16kPgY5bvWVqN5zbjzzVDGxJFSW4R (2 interactions) against 64 established relationships.
  - [MEDIUM] **REGIME_SHIFT**: Regime shift: cadence (inter-activity interval decelerated to 3012s vs baseline 90s, 33.5x slower).

#### Checkpoint $T_b$ ($t_0 - 300\text{s}$, pre-compromise):
- **Flagged**: yes (`riskScore = 50`)
- **Baseline Mode**: windowed
- **Detected Anomalies** (8):
  - [LOW] **NEW_PROTOCOL**: First interaction with program HnSAxH8uhn2ouSQtxVByWzVRtrgNY3ewkjaUny6fMpfQ.
  - [LOW] **NEW_PROTOCOL**: First interaction with program EverSFw9uN5t1V8kS3ficHUcKffSjwpGzUSGd7mgmSks.
  - [LOW] **NEW_PROTOCOL**: First interaction with program CsFJ6i3nhUJq43KwGxALBAmSawv6cSQHYcVceczxbQrq.
  - [LOW] **NEW_PROTOCOL**: First interaction with program strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m.
  - [LOW] **NEW_COUNTERPARTY**: New counterparty 32cqCvRwLEFAX5hg2neqepW2JZpGf11oBGVA8zEigeah (2 interactions) against 64 established relationships.
  - [LOW] **NEW_COUNTERPARTY**: New counterparty MtvDRVATWdGwEG16kPgY5bvWVqN5zbjzzVDGxJFSW4R (2 interactions) against 64 established relationships.
  - [LOW] **NEW_COUNTERPARTY**: New counterparty 9vJADDrxKf6Ry1HezujpKeEu1X1DzSkzT1znBwBDbKYX (1 interaction) against 64 established relationships.
  - [MEDIUM] **REGIME_SHIFT**: Regime shift: cadence (inter-activity interval decelerated to 3161s vs baseline 90s, 35.1x slower).

---

### Case C-001-3

- **Wallet Address**: `AWrN51REFu1ZWoT2qHjXaVaUuqmUV4SqTWPxSbC2DVqW`
- **$t_0$ Timestamp (UTC)**: `2022-08-02T23:33:07Z` (Unix: `1659483187`)
- **$t_0$ Drain Signature**: `5QqrGFCexVirqer79JeiyXPiRyv9YD7KiAoXErjb3UzEAkHvkfmu3eaDuv9c6x6TvkQZtUSYSEdVFX1AHpREW8TL`
- **Raw History File**: `analysis-data/pilot/C-001-3.json`
- **Raw History SHA-256**: `07499a61fe8e501025210df47e985bac7f29c026d9535f0742eea8afe39744b1`
- **History Depth**: 45 txs, oldest: 2021-10-28T05:15:00.000Z (278.8 days before t0)

#### Checkpoint $T_a$ ($t_0$, compromise included):
- **Flagged**: no (`riskScore = 20`)
- **Baseline Mode**: windowed
- **Detected Anomalies** (2):
  - [MEDIUM] **DORMANT_ACTIVE**: Wallet reactivated after ~27 days of inactivity.
  - [LOW] **NEW_COUNTERPARTY**: New counterparty CEzN7mqP9xoxn2HdyW6fjEJ73t7qaX9Rp2zyS6hb3iEu (1 interaction) against 39 established relationships.

#### Checkpoint $T_b$ ($t_0 - 300\text{s}$, pre-compromise):
- **Flagged**: no (`riskScore = 0`)
- **Baseline Mode**: snapshot
- **Detected Anomalies** (0):
  - None

---

### Case C-001-4

- **Wallet Address**: `5K659U8aiopakWpVn3jH7ihXnEnuBBKmCavW3o185MZS`
- **$t_0$ Timestamp (UTC)**: `2022-08-03T01:10:35Z` (Unix: `1659489035`)
- **$t_0$ Drain Signature**: `5PT4zqJwLcZFYkt4r2AZcA91hcn2b6W8AG47W51T4aNrHcVn5hGhcSpKDPizPpwDZiUqZiFhnSMg5YCHsimpZAzm`
- **Raw History File**: `analysis-data/pilot/C-001-4.json`
- **Raw History SHA-256**: `de1e1ab062ef8dc6b0559d34d2bd5a8ebfa04d68ab6cafab99cff8f3d6849453`
- **History Depth**: 101 txs, oldest: 2021-11-07T06:43:24.000Z (268.8 days before t0)

#### Checkpoint $T_a$ ($t_0$, compromise included):
- **Flagged**: yes (`riskScore = 35`)
- **Baseline Mode**: windowed
- **Detected Anomalies** (2):
  - [HIGH] **DORMANT_ACTIVE**: Wallet reactivated after ~149 days of inactivity.
  - [LOW] **NEW_COUNTERPARTY**: New counterparty GeEccGJ9BEzVbVor1njkBCCiqXJbXVeDHaXDCrBDbmuy (1 interaction) against 55 established relationships.

#### Checkpoint $T_b$ ($t_0 - 300\text{s}$, pre-compromise):
- **Flagged**: no (`riskScore = 0`)
- **Baseline Mode**: snapshot
- **Detected Anomalies** (0):
  - None

---

### Case C-001-5

- **Wallet Address**: `7GKE13Q3PW8EBMdVm6ENYyZPV5ELSYq4qGFVijFwRctd`
- **$t_0$ Timestamp (UTC)**: `2022-08-03T02:14:21Z` (Unix: `1659492861`)
- **$t_0$ Drain Signature**: `5xfejG6QzDKBBC77ZgYCgd9MDK5zk7ZqPZrpoTpEGMk5ysMhZ6H6a2f2cDmNfkWN6b143sJJN58MBrYo3h4JymEy`
- **Raw History File**: `analysis-data/pilot/C-001-5.json`
- **Raw History SHA-256**: `acbf7c429ad8f8b7a14c00006a23e33a83a5fe48697e44a97b9b1e826e0f3439`
- **History Depth**: 63 txs, oldest: 2022-03-26T14:31:54.000Z (129.5 days before t0)

#### Checkpoint $T_a$ ($t_0$, compromise included):
- **Flagged**: no (`riskScore = 5`)
- **Baseline Mode**: windowed
- **Detected Anomalies** (1):
  - [LOW] **NEW_COUNTERPARTY**: New counterparty GeEccGJ9BEzVbVor1njkBCCiqXJbXVeDHaXDCrBDbmuy (1 interaction) against 15 established relationships.

#### Checkpoint $T_b$ ($t_0 - 300\text{s}$, pre-compromise):
- **Flagged**: no (`riskScore = 15`)
- **Baseline Mode**: windowed
- **Detected Anomalies** (1):
  - [MEDIUM] **REGIME_SHIFT**: Regime shift: venue (diversity collapsed from 3 baseline venues to single venue SOLANA_PROGRAM_LIBRARY).

---

## 4. Price-Dependent Rules Note

As specified in Amendment 1, the pilot was executed with `prices = null` and `mintRisk = null`:
- `TOXIC_MINT` was omitted for all cases because token metadata and holder concentration were not fetched.
- `LARGE_SWAP` fell back to raw quantities for major mints (SOL, USDC, USDT) where applicable; non-major token swaps were not sized.
- `REGIME_SHIFT` amount dimension fell back to raw major token quantities.

## 5. Deviations

None (superseded: see Deviation 1).

## 6. Not Done

- Control/comparison wallets were not scored in this stage.
- False-alarm rate was not computed.
- Threshold sweeps were not performed.
- No claim is made regarding detection accuracy, sensitivity, or specificity.

## 7. Deviation 1: Reporting Defect in Baseline Mode Selection (`pilot_score.mjs:54`)

### 7.1. Published Table (Run 1, Commit `50d0343`)

In the initial pilot report (commit `50d0343`), the case results were published as follows:

| Case ID | Wallet | Depth Reached | Mode ($T_a$ / $T_b$) | Flagged at $T_a$ (Score) | Flagged at $T_b$ (Score) | History File SHA-256 |
|:--------|:-------|:--------------|:---------------------|:-------------------------|:-------------------------|:---------------------|
| C-001-1 | `4J7uT2PQnrfWazv3DJcM82i49WmTugyfpdmDvEjKLDks` | 101 txs | windowed / snapshot | **no** (20) | **no** (0) | `036d64a636384522...` |
| C-001-2 | `96StvqZyFUPtyMr4o9s7K4V29RSNyRpVi76vNwxG5rUf` | 401 txs | windowed / windowed | **yes** (50) | **yes** (50) | `1ff34abb3db2afb2...` |
| C-001-3 | `AWrN51REFu1ZWoT2qHjXaVaUuqmUV4SqTWPxSbC2DVqW` | 45 txs | windowed / snapshot | **no** (20) | **no** (0) | `07499a61fe8e5010...` |
| C-001-4 | `5K659U8aiopakWpVn3jH7ihXnEnuBBKmCavW3o185MZS` | 101 txs | windowed / snapshot | **yes** (35) | **no** (0) | `de1e1ab062ef8dc6...` |
| C-001-5 | `7GKE13Q3PW8EBMdVm6ENYyZPV5ELSYq4qGFVijFwRctd` | 63 txs | windowed / windowed | **no** (5) | **no** (15) | `acbf7c429ad8f8b7...` |

Notice that for dormant cases C-001-1, C-001-3, and C-001-4, the mode at $T_b$ was reported as `snapshot`.

### 7.2. Defect Description (`scripts/next/pilot_score.mjs:54`)

During Stage N7 diagnostics and independent recomputation (`scripts/next/pilot_recompute.mjs`), a discrepancy was identified in how `scripts/next/pilot_score.mjs` computed the descriptive string `baselineMode`.

Line 54 originally read:
```javascript
const baselineMode = baselineTxs.length !== txs.length ? "windowed" : "snapshot";
```

In `selectScoring` (`src/trust.ts:167-175`), the scoring mode branch is determined by whether the wallet has at least 3 transactions older than the 7-day evaluation window (`priorCount >= 3`):
```javascript
const prior = txs.filter((t) => (t.timestamp ?? 0) < windowStart);
if (prior.length >= 3) {
  return { baselineTxs: prior, evalTxs: recent };
}
return { baselineTxs: txs, evalTxs: txs };
```

For wallets that were completely dormant during the 7-day evaluation window $[T_b - 7\text{d}, T_b]$ (cases C-001-1, C-001-3, C-001-4), `recent.length === 0`. Consequently, all transactions in the evaluated history set `txs` were prior transactions, making `baselineTxs.length === txs.length`.
Because `baselineTxs.length !== txs.length` evaluated to `false`, `pilot_score.mjs` erroneously assigned `baselineMode = "snapshot"`, even though `selectScoring` had taken the windowed branch (`prior.length >= 3`) and passed `evalTxs = []` to `detectAnomalies`.

The scoring calculations (`riskScore` and `anomalies`) were completely unaffected because `selectScoring` correctly routed the data in `runTrustCheck`. Only the reported string label `baselineMode` was incorrect.

### 7.3. The Fix (Commit `4bbc6e0`)

In commit `4bbc6e0` (`fix(next): pilot script defect (Deviation 1)`), line 54 of `scripts/next/pilot_score.mjs` was replaced with the exact condition evaluated by `selectScoring`:
```javascript
const priorCount = txs.filter((t) => (t.timestamp ?? 0) < windowStart).length;
const baselineMode = priorCount >= 3 ? "windowed" : "snapshot";
```

### 7.4. Recomputed Table (Run 2, Post-Fix Offline Recompute)

Recomputation performed strictly offline using the preserved raw transaction histories in `analysis-data/pilot/`:

| Case ID | Wallet | Depth Reached | Mode ($T_a$ / $T_b$) | Flagged at $T_a$ (Score) | Flagged at $T_b$ (Score) | History File SHA-256 |
|:--------|:-------|:--------------|:---------------------|:-------------------------|:-------------------------|:---------------------|
| C-001-1 | `4J7uT2PQnrfWazv3DJcM82i49WmTugyfpdmDvEjKLDks` | 101 txs | windowed / windowed | **no** (20) | **no** (0) | `036d64a636384522...` |
| C-001-2 | `96StvqZyFUPtyMr4o9s7K4V29RSNyRpVi76vNwxG5rUf` | 401 txs | windowed / windowed | **yes** (50) | **yes** (50) | `1ff34abb3db2afb2...` |
| C-001-3 | `AWrN51REFu1ZWoT2qHjXaVaUuqmUV4SqTWPxSbC2DVqW` | 45 txs | windowed / windowed | **no** (20) | **no** (0) | `07499a61fe8e5010...` |
| C-001-4 | `5K659U8aiopakWpVn3jH7ihXnEnuBBKmCavW3o185MZS` | 101 txs | windowed / windowed | **yes** (35) | **no** (0) | `de1e1ab062ef8dc6...` |
| C-001-5 | `7GKE13Q3PW8EBMdVm6ENYyZPV5ELSYq4qGFVijFwRctd` | 63 txs | windowed / windowed | **no** (5) | **no** (15) | `acbf7c429ad8f8b7...` |

### 7.5. Comparison of Counters Across Runs

| Metric | Run 1 (Published, commit `50d0343`) | Run 2 (Post-fix recompute, commit `4bbc6e0`) | Difference |
|:-------|:------------------------------------|:----------------------------------------------|:-----------|
| Flagged at $T_a$ (`riskScore > 30`) | **2 of 5** (C-001-2: 50, C-001-4: 35) | **2 of 5** (C-001-2: 50, C-001-4: 35) | 0 (identical) |
| Flagged at $T_b$ (`riskScore > 30`) | **1 of 5** (C-001-2: 50) | **1 of 5** (C-001-2: 50) | 0 (identical) |
| Risk Scores ($T_a$) | `[20, 50, 20, 35, 5]` | `[20, 50, 20, 35, 5]` | None |
| Risk Scores ($T_b$) | `[0, 50, 0, 0, 15]` | `[0, 50, 0, 0, 15]` | None |
| Anomalies ($T_a$) | Identical across all 5 cases | Identical across all 5 cases | None |
| Anomalies ($T_b$) | Identical across all 5 cases | Identical across all 5 cases | None |
| Baseline Modes | 3 cases mislabeled `snapshot` at $T_b$ | All 5 cases correctly labeled `windowed` | Mode label only |

## 8. Corrected reading of the results (published after Deviation 1; scores unchanged)

### 8.1. Case Summary Table

| Case ID | History Txs | Recent Txs ($T_a$ / $T_b$) | Score at $T_a$ | Anomalies at $T_a$ | Score at $T_b$ | Anomalies at $T_b$ / Evaluability |
|:---|:---:|:---:|:---:|:---|:---:|:---|
| C-001-1 | 101 | 1 / 0 | 20 | [MEDIUM] DORMANT_ACTIVE, [LOW] NEW_COUNTERPARTY | 0 | not evaluable (no transactions in the 7 days before T_b) |
| C-001-2 | 401 | 25 / 22 | 50 | [LOW] NEW_PROTOCOL (×4), [LOW] NEW_COUNTERPARTY (×3), [MEDIUM] REGIME_SHIFT | 50 | [LOW] NEW_PROTOCOL (×4), [LOW] NEW_COUNTERPARTY (×3), [MEDIUM] REGIME_SHIFT |
| C-001-3 | 45 | 1 / 0 | 20 | [MEDIUM] DORMANT_ACTIVE, [LOW] NEW_COUNTERPARTY | 0 | not evaluable (no transactions in the 7 days before T_b) |
| C-001-4 | 101 | 1 / 0 | 35 | [HIGH] DORMANT_ACTIVE, [LOW] NEW_COUNTERPARTY | 0 | not evaluable (no transactions in the 7 days before T_b) |
| C-001-5 | 63 | 6 / 5 | 5 | [LOW] NEW_COUNTERPARTY | 15 | [MEDIUM] REGIME_SHIFT |

### 8.2. Summary Counters

- **Flagged at $T_a$**: **2 of 5** (C-001-2: score 50; C-001-4: score 35)
- **Evaluable at $T_b$**: **2 of 5**; **flagged at $T_b$**: **1 of 2 evaluable** (C-001-2: score 50; C-001-5: score 15)
- **Newly flagged at $t_0$ (not flagged at $T_b$, flagged at $T_a$)**: **0 of 2 evaluable**; **1 case flagged at $T_a$ is not evaluable at $T_b$** (Case C-001-4 was flagged at $T_a$ with score 35 due to `DORMANT_ACTIVE` triggered by the drain transaction, but had no transactions in the 7 days before $T_b$; Case C-001-2 was already flagged at $T_b$)

### 8.3. Corrected History Fetch Stop Reasons

Under the pilot retrieval logic, transactions older than $t_0$ were fetched in pages of up to 100 transactions using `before=<cursor>`:

- **C-001-1**:
  - Pages fetched: 1 page (100 history transactions + 1 separate $t_0$ transaction = 101 total).
  - Last page size: 100 transactions.
  - Earliest transaction: `2022-02-22T18:29:44Z` (161.21 days before $t_0$).
  - Stop reason: `first page older than 90 days` (single batch of 100 transactions already reached beyond $t_0 - 90\text{d}$).
  - *Note*: Older on-chain transactions may exist beyond 161 days; the baseline was constructed from the latest 100 fetched transactions.
- **C-001-2**:
  - Pages fetched: 4 pages (400 history transactions + 1 separate $t_0$ transaction = 401 total).
  - Last page size: 100 transactions (all 4 pages were full).
  - Earliest transaction: `2022-05-04T16:04:30Z` (90.28 days before $t_0$).
  - Stop reason: `reached the 90-day rule after several pages` (stopped after 4 full pages upon crossing the 90-day threshold).
  - *Note*: Older on-chain transactions may exist; the baseline was constructed from the 376 transactions older than 7 days from the fetched set.
- **C-001-3**:
  - Pages fetched: 1 page (44 history transactions + 1 separate $t_0$ transaction = 45 total).
  - Last page size: 44 transactions (< 100).
  - Earliest transaction: `2021-10-28T05:15:00Z` (278.76 days before $t_0$).
  - Stop reason: `history exhausted` (returned a partial page of 44 transactions; entire on-chain history of the wallet was retrieved).
- **C-001-4**:
  - Pages fetched: 1 page (100 history transactions + 1 separate $t_0$ transaction = 101 total).
  - Last page size: 100 transactions.
  - Earliest transaction: `2021-11-07T06:43:24Z` (268.77 days before $t_0$).
  - Stop reason: `first page older than 90 days` (single batch of 100 transactions already reached beyond $t_0 - 90\text{d}$).
  - *Note*: Older on-chain transactions may exist beyond 268 days; the baseline was constructed from the latest 100 fetched transactions.
- **C-001-5**:
  - Pages fetched: 1 page (62 history transactions + 1 separate $t_0$ transaction = 63 total).
  - Last page size: 62 transactions (< 100).
  - Earliest transaction: `2022-03-26T14:31:54Z` (129.49 days before $t_0$).
  - Stop reason: `history exhausted` (returned a partial page of 62 transactions; entire on-chain history of the wallet was retrieved).

### 8.4. What This Pilot Can and Cannot Say

- **What it CAN say**:
  - It demonstrates the exact, reproducible behavior of the frozen submitted version (tag `submission-colosseum-fall2026`) on five sampled wallets from one documented real-world incident (`INC-2022-08-SLOPE`), evaluated at two stated check times ($T_a$ and $T_b$).
- **What it CANNOT say**:
  - It cannot determine detection quality, sensitivity, or detection rate.
  - It cannot determine false-alarm rate (FAR) or specificity, as no control or ordinary wallets were scored.
  - It cannot generalize to other incidents, key-theft mechanisms, or wallet types.
  - The sample was drawn exclusively from victims whose seed phrases/keys were documented in the S3 transmission logs (1,326 identified out of an estimated ~9,231 affected wallets).
  - History depth differs substantially between cases (from 45 to 401 transactions, spanning 90 to 278 days).
  - Price feeds and token metadata were not available (`prices = null`, `mintRisk = null`), meaning price-dependent and token-concentration rules were not evaluated.

### 8.5. Hypothesis for a Future Version (Not Tested, Not Tuned on These Cases)

A private key compromise or unauthorized wallet takeover typically sweeps most or all assets to a newly seen address in a short burst of outgoing transfers. The current submitted rules focus heavily on decentralized exchange swaps, token metadata, and behavioral novelty (such as counterparty/protocol introduction and cadence shifts).

Any new rule designed to detect asset drainage or balance depletion sweeps would need to be preregistered and evaluated strictly on incidents not used in this exploratory pilot and against an appropriate control group of ordinary non-compromised wallets.
