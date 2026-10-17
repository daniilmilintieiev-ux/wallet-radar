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

None. All executions followed the protocol in `SCORING-SPEC-PILOT.md` and Amendment 1 exactly.

## 6. Not Done

- Control/comparison wallets were not scored in this stage.
- False-alarm rate was not computed.
- Threshold sweeps were not performed.
- No claim is made regarding detection accuracy, sensitivity, or specificity.
