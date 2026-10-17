# Pilot Scoring Specification: INC-2022-08-SLOPE

## 1. Purpose

This document specifies the descriptive pilot evaluation for sampled incident cases:
- `C-001-1` through `C-001-5` (Slope wallet compromise, August 2022).
- When available, `C-002` (Whale wallet compromise).

**Important**:
This is a descriptive pilot of existing system behavior on historical data, **not** a formal statistical test. It makes **no claims** about detection quality, accuracy, false-positive rate, or generalizability to other incidents.

## 2. Version Under Test

- **Git tag**: `submission-colosseum-fall2026`
- **Git commit**: `b5a0388431742acaa3a47e5ca6f0b716ecd76f23`
- **Execution**: Run in a clean isolated worktree checked out at `submission-colosseum-fall2026`.
- **Code modifications**: Zero (`git diff` against `submission-colosseum-fall2026` must be strictly empty for `src/`, `test/`, and `package.json`).

## 3. Inputs

1. **Transaction History**:
   - Fetched once per wallet using the Helius Enhanced Transactions API (`/v0/addresses/{wallet}/transactions`).
   - Query covers all transactions up to the check time.
   - History JSON files are saved **outside** the git repository in `analysis-data/` to avoid committing large raw payloads.
   - The SHA-256 hash of each stored raw JSON file is committed in the pilot results.
2. **Prices**:
   - Zero price API calls.
   - Historical USD price feeds are not queried during this pilot.
   - `prices = null` is passed into the analysis functions.
   - Anomalies that strictly require USD pricing are reported as `price-dependent: not evaluated`, never as `not fired`.
3. **Token Metadata / Mint Risk**:
   - No live token metadata or live mint risk fetches (`mintRisk = null`).

## 4. Check Times

For each case, two evaluation checkpoints are scored:

1. **$T_a$ (At compromised transaction)**:
   - $T_a = t_0$, where $t_0$ is the on-chain timestamp (`blockTime`) of the confirmed compromise transaction.
   - The $t_0$ drain transaction itself is **included** in the evaluation batch.
   - Question addressed: Does the detection engine flag the wallet when the unauthorized transfer occurs?

2. **$T_b$ (Pre-compromise baseline)**:
   - $T_b = t_0 - 300\text{ seconds}$ ($t_0$ minus 5 minutes).
   - History strictly before $T_b$ is evaluated (transactions with `timestamp < T_b`).
   - The drain transaction and any subsequent transactions are excluded.
   - Question addressed: Was the wallet already flagged prior to the compromise (clean pre-state)?

## 5. Scoring Path

The pilot uses the behavioral risk scoring path implemented in the submitted codebase (`submission-colosseum-fall2026`):

### Function Call Chain

1. **Window Parameters** (`src/trust.ts:312-315`):
   - `windowDays`: `opts.windowDays ?? TRUST_DEFAULTS.windowDays` (`src/trust.ts:98`, default value: `7`).
   - `generatedAt`: Evaluation timestamp $T$ ($T_a$ or $T_b$) in unix seconds.
   - `windowStart = generatedAt - windowDays * 86_400` (`src/trust.ts:314`).
   - `priorStart = generatedAt - 2 * windowDays * 86_400` (`src/trust.ts:315`).

2. **Partitioning History** (`selectScoring` in `src/trust.ts:285-296`):
   ```typescript
   export function selectScoring(
     txs: EnhancedTx[],
     windowStart: number,
     minPriorSamples: number = MIN_PRIOR_SAMPLES, // MIN_PRIOR_SAMPLES = 3 (src/trust.ts:277)
   ): { baselineTxs: EnhancedTx[]; evalTxs: EnhancedTx[] } {
     const priorTxs = txs.filter((t) => (t.timestamp ?? 0) < windowStart);
     const recentTxs = txs.filter((t) => (t.timestamp ?? 0) >= windowStart);
     if (priorTxs.length >= minPriorSamples) {
       return { baselineTxs: priorTxs, evalTxs: recentTxs };
     }
     return { baselineTxs: txs, evalTxs: txs };
   }
   ```
   - **Windowed mode**: If `priorTxs.length >= 3`, baseline is learned over `priorTxs` ($[T - 14\text{d}, T - 7\text{d})$) and evaluated on `recentTxs` ($[T - 7\text{d}, T]$).
   - **Snapshot mode**: If `priorTxs.length < 3`, the whole batch is used for both baseline and evaluation (`baselineTxs = txs`, `evalTxs = txs`).

3. **Baseline Computation** (`updateBaseline` in `src/baseline.ts:34-154`):
   - `baseline = updateBaseline(wallet, null, baselineTxs, generatedAt, prices)`
   - Computes known venues, known programs, swap statistics, median interval, active hours, and transaction counts.

4. **Anomaly Detection** (`detectAnomalies` in `src/analyzer.ts:545-1143`):
   - `anomalies = detectAnomalies(wallet, evalTxs, baseline, { ...loadConfig(), dormantMeasure: "first" }, prices)`
   - Configuration values from `DEFAULT_CONFIG` (`src/types.ts:255-266`):
     - `dormantDays`: `7`
     - `burstWindowMin`: `10`
     - `burstThreshold`: `5`
     - `largeSwapMultiplier`: `3`
     - `concentrationWindowMin`: `30`
     - `concentrationCount`: `2`
     - `dormantMeasure`: `"first"` (explicitly set by the trust path at `src/trust.ts:351` to measure the gap from `evalTxs`'s earliest transaction).

5. **Risk Score Aggregation** (`computeRiskScore` in `src/analyzer.ts:1157-1163`):
   ```typescript
   const SEVERITY_POINTS: Record<string, number> = {
     low: 5,
     medium: 15,
     high: 30,
   };

   export function computeRiskScore(anomalies: Anomaly[]): number {
     const total = anomalies.reduce(
       (sum, a) => sum + (a.type === "TOKEN_CHECK_UNAVAILABLE" ? 0 : SEVERITY_POINTS[a.severity] ?? 0),
       0,
     );
     return Math.min(100, total);
   }
   ```

## 6. Flag Definition

- **Flagged**: `riskScore > 30` (strictly greater than default `TRUST_DEFAULTS.maxRisk = 30`).
- **Unflagged**: `riskScore <= 30`.
- **Exclusions**:
  - Live token balances and live liquidity (`liquidityUsd`) are **not** used because current balances reflect post-incident state, not the state at historical check time $T$.
  - The deterministic trust verdict (`computeTrustVerdict`) is **not** used directly because it requires live balances. The evaluation relies solely on the historical behavioral `riskScore` and detected anomalies.

## 7. Reporting per Case

For each case, report:
- `case_id` and `wallet`
- Flagged at $T_a$ (`yes` / `no`)
- `riskScore` at $T_a$ (0–100)
- Detected anomalies at $T_a$ (type, severity, description)
- Flagged at $T_b$ (`yes` / `no`)
- `riskScore` at $T_b$ (0–100)
- Detected anomalies at $T_b$ (type, severity, description)
- Number of transactions in fetched history up to $T_a$
- Baseline mode at $T_a$ and $T_b$ (`windowed` or `snapshot`)
- Any price-dependent rules skipped (`price-dependent: not evaluated`)

## 8. Reporting Overall

Report overall summary in raw counts only:
- Flagged at $T_a$: $X$ of $N$
- Flagged at $T_b$: $Y$ of $N$
- No claim of percentage accuracy or detection power.
- No arithmetic averaging of risk scores across cases.

## 9. Not Done

- Comparison / control wallets are not evaluated in this pilot (deferred to a separate sampling and preregistered protocol).
- False-alarm rate is not measured here.
- Alternative threshold sweeps are not performed.
- No marketing claims or statements about operational efficacy.

## 10. Preregistration & Deviations

This specification is committed and pushed to `next` **before** any evaluation script is run on the pilot cases.
If any technical adjustment is required during execution, it must be recorded under a `Deviations` section in the results file with exact rationale.
