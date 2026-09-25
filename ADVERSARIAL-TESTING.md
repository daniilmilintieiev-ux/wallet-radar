# Automated Adversarial Testing Report

**Target Codebase:** `wallet-radar`  
**Execution Date:** September 25, 2026  
**Environment:** Local Sandbox, Node.js v24.19.0, Solana Web3.js v1.99.0, SPL Token-2022  
**Test Suite:** `test/adversarial.test.ts` (`dist/test/adversarial.test.js`)  
**Scope:** Two money-moving critical financial subsystems:
1. **x402 Server (`src/x402server.ts`)** — HTTP payment reception, micro-USDC verification, anti-replay, and settlement.
2. **Transfer Hook Program (`programs/radar-transfer-hook` & `src/hook/index.ts`)** — SPL Token-2022 on-chain transfer gating, binary scan record parsing, and counterparty evaluation.

---

## 1. Executive Summary

A comprehensive automated adversarial verification suite was executed to intentionally probe and attempt to break invariants within the financial pathways of `wallet-radar`. Rather than validating standard happy paths, this test harness subjected both systems to concurrent race conditions, spoofed token mints, precision edge cases, non-signer payment theft, malformed binary payloads, and timestamp manipulation.

A total of **12 adversarial scenarios** were evaluated:
- **12 Defended (100% PASS):** Strict invariant enforcement held across all financial pathways. One design gap (future timestamps bypassing attestation expiry, ADV-HOOK-02) was identified, patched via strict clock drift tolerance (`MAX_FUTURE_DRIFT_SEC = 60`), and verified with regression testing.

---

## 2. Adversarial Test Matrix

| Attack ID | Scenario Description | Target Subsystem | Result | Repro & Verification Command |
|---|---|---|:---:|---|
| **ADV-X402-01** | Parallel Double-Spend (20 concurrent requests with identical signature) | `src/x402server.ts` | **PASS (Defended)** | `node --test dist/test/adversarial.test.js --test-name-pattern="ADV-X402-01"` |
| **ADV-X402-02** | Off-by-One Payment Amount (0.004999 USDC vs 0.005 requirement, floating-point artifacts) | `src/x402server.ts` | **PASS (Defended)** | `node --test dist/test/adversarial.test.js --test-name-pattern="ADV-X402-02"` |
| **ADV-X402-03** | Spoofed Token Mint (Attacker pays 1,000,000 FakeUSDC disguised as USDC) | `src/x402server.ts` | **PASS (Defended)** | `node --test dist/test/adversarial.test.js --test-name-pattern="ADV-X402-03"` |
| **ADV-X402-04** | Payer Mismatch & Theft (Attacker claims valid payment signed by another wallet) | `src/x402server.ts` | **PASS (Defended)** | `node --test dist/test/adversarial.test.js --test-name-pattern="ADV-X402-04"` |
| **ADV-X402-05** | Unconfirmed, Failed, or Stale Transactions (`meta.err != null`, dropped tx, age > 300s) | `src/x402server.ts` | **PASS (Defended)** | `node --test dist/test/adversarial.test.js --test-name-pattern="ADV-X402-05"` |
| **ADV-X402-06** | Cross-Header Proof Replay (Replaying settled signature via alternative headers) | `src/x402server.ts` | **PASS (Defended)** | `node --test dist/test/adversarial.test.js --test-name-pattern="ADV-X402-06"` |
| **ADV-HOOK-01** | Malformed RS01 Binary Payload (Buffer truncation, out-of-bounds `payload_len`, broken JSON) | `programs/radar-transfer-hook` & `src/hook` | **PASS (Defended)** | `node --test dist/test/adversarial.test.js --test-name-pattern="ADV-HOOK-01"` |
| **ADV-HOOK-02** | Fuzzing 48-byte Header & Future Timestamp Exploit Analysis | `programs/radar-transfer-hook` & `src/hook` | **PASS (Fixed & Defended)** | `node --test dist/test/adversarial.test.js --test-name-pattern="ADV-HOOK-02"` |
| **ADV-HOOK-03** | Extra Accounts Spoofing in CPI `transfer_checked` (Attacker passes clean record PDA for flagged dest) | `programs/radar-transfer-hook` & `src/hook` | **PASS (Defended)** | `node --test dist/test/adversarial.test.js --test-name-pattern="ADV-HOOK-03"` |
| **ADV-HOOK-04** | `allowUnverified: bool` Policy Matrix (Ensuring high-risk records cannot evade gating in permissive mode) | `src/hook/index.ts` | **PASS (Defended)** | `node --test dist/test/adversarial.test.js --test-name-pattern="ADV-HOOK-04"` |
| **ADV-HOOK-05** | `maxAttestationAgeSec` Boundary Precision (Exact evaluation at `age == max` vs `age == max + 1`) | `src/hook/index.ts` | **PASS (Defended)** | `node --test dist/test/adversarial.test.js --test-name-pattern="ADV-HOOK-05"` |
| **ADV-HOOK-06** | Transfer Splitting / Chunking / Smurfing (Splitting transfer into 10 micro-transactions) | `src/hook/index.ts` | **PASS (Defended)** | `node --test dist/test/adversarial.test.js --test-name-pattern="ADV-HOOK-06"` |

---

## 3. Detailed Component Breakdown

### 3.1 x402 Server (`src/x402server.ts`)

#### ADV-X402-01: Parallel Double-Spend / Race Condition
- **Attack Hypothesis:** An attacker generates a single valid on-chain payment of 0.005 USDC and fires 20 simultaneous HTTP POST requests to `/scan`. If payment settlement occurs only after the scan handler completes, concurrent requests might pass verification before the signature is recorded in SQLite.
- **Observed Behavior:** Defended. The server uses an in-memory lock `inFlightPayments.add(proof.signature)` before executing verification. The first request acquires the lock, while the remaining 19 concurrent requests immediately hit `inFlightPayments.has(proof.signature)` and return HTTP 402 with `Payment signature already settled (replay rejected)`. After completion, the signature is persisted to the SQLite `settled_payments` table with a PRIMARY KEY constraint, permanently preventing post-completion replays.
- **Verification:** 1 request succeeded (HTTP 200), 19 requests failed (HTTP 402).

#### ADV-X402-02: Off-by-One Payment Amount & Micro-Precision
- **Attack Hypothesis:** An attacker transfers 0.004999 USDC (4,999 micro-USDC instead of 5,000) or exploits IEEE-754 floating-point inaccuracies (e.g. `0.0049994`) to achieve service execution for less than the required fee.
- **Observed Behavior:** Defended. `verifySolanaPaymentRpc` computes balance deltas and instruction transfers, then applies explicit rounding:
  ```typescript
  transferred = Math.round(transferred * 1e6) / 1e6;
  if (transferred < requirement.minAmount) {
    return { valid: false, error: `Insufficient payment: found ${transferred} USDC...` };
  }
  ```
  Payments of 0.004999 USDC, 0.0049994 USDC, and 0.000000 USDC were rejected with HTTP 402. Exactly 0.005000 USDC succeeded.

#### ADV-X402-03: Spoofed Mint (Token Disguised as USDC)
- **Attack Hypothesis:** An attacker mints a worthless custom SPL or Token-2022 token and transfers 1,000,000 tokens to the recipient wallet.
- **Observed Behavior:** Defended. `verifySolanaPaymentRpc` enforces strict equality against the target mint (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). In both `postTokenBalances[].mint` inspection and instruction-level fallback (`info.mint`), non-USDC transfers are ignored. `transferred` remains 0, resulting in immediate rejection.

#### ADV-X402-04: Payer Mismatch & Non-Signer Theft
- **Attack Hypothesis:** An attacker observes a legitimate 0.005 USDC transfer from victim Alice to the recipient on-chain. The attacker immediately takes Alice's transaction signature and submits an HTTP request setting `X-Payment-Payer: AttackerWallet`.
- **Observed Behavior:** Defended. The server inspects `tx.transaction.message.accountKeys` and `numRequiredSignatures`. If `proof.payer` is not flagged as a signer (`signer === true` or within `numRequiredSignatures`), the server aborts verification with `X-Payment-Payer <attacker> is not a signer of the payment transaction`.

#### ADV-X402-05: Unconfirmed, Failed, or Stale Transactions
- **Attack Hypothesis:** An attacker submits a transaction that failed on-chain (`meta.err != null`), a signature that has not yet been processed by the cluster (`result: null`), or a replayed transaction older than the allowed freshness window.
- **Observed Behavior:** Defended.
  - Missing/unconfirmed transactions fail with `Transaction not found on-chain`.
  - Reverted transactions fail with `Transaction failed on-chain`.
  - Transactions where `nowSec - tx.blockTime > maxAgeSec` fail with `Transaction too old`.
  - If an upstream RPC error occurs, the server does not burn the payment, allowing clean client retries.

#### ADV-X402-06: Cross-Header Proof Replay
- **Attack Hypothesis:** An attacker redeems signature `SIG` via standard `X-Payment-Signature` headers, and subsequently submits `SIG` using alternate ingestion schemes: `Authorization: x402 <SIG>:<PAYER>`, `X-Payment: {"signature": ...}`, or JSON body `{ payment: { signature: ... } }`.
- **Observed Behavior:** Defended. All header extractors resolve to the unified `PaymentProof.signature`. Deduplication checks occur against the signature string itself before routing. All secondary attempts were rejected with HTTP 402.

---

### 3.2 Radar Transfer Hook (`programs/radar-transfer-hook` & `src/hook/index.ts`)

#### ADV-HOOK-01: Malformed RS01 Payload & Out-of-Bounds Parsing
- **Attack Hypothesis:** An attacker creates an on-chain scan record account with truncated data (< 48 bytes), an inflated `payload_len: 65535` in the header, or corrupted non-JSON payload bytes, attempting to trigger out-of-bounds panics or deserialization crashes.
- **Observed Behavior:** Defended.
  - Data lengths < 48 bytes return `None` in Rust and `InvalidScanRecordMagic (6004)` in TypeScript without memory exceptions.
  - Inflated `payload_len` values are clamped safely by buffer slicing: `buf.subarray(48, 48 + payloadLen)` cannot exceed physical buffer bounds in Node.js, and the Rust on-chain program only reads the fixed 48-byte header `ScanRecordHeader::try_parse`.
  - Malformed JSON payloads in client deserialization are handled within `try { JSON.parse(...) } catch { ... }`, defaulting safely to an empty payload without crashing.

#### ADV-HOOK-02: Fuzzing 48-byte Header & Future Timestamp Exploit Analysis
- **Attack Hypothesis:** An attacker tests corrupt magic bytes, out-of-range risk scores (e.g. 255), and manipulated timestamps.
- **Findings & Identified Gap:**
  - Header magic validation correctly rejects corrupted headers (`BAD0`, `RS00`) with `InvalidScanRecordMagic`.
  - Risk scores exceeding the configured threshold (e.g. `255 > 80`) are blocked with `RiskScoreTooHigh (6000)`.
  - **Identified Gap (Future Timestamp Expiration Bypass):**
    In `programs/radar-transfer-hook/src/lib.rs` (lines 182-184 & 269-271):
    ```rust
    if current_ts > header.timestamp
        && (current_ts - header.timestamp) > config.max_attestation_age_sec
    {
        return Err(RadarHookError::StaleOracleAttestation.into());
    }
    ```
    And in `src/hook/index.ts` (lines 844-845):
    ```typescript
    const age = nowSec - timestamp;
    if (age > maxAge) { ... }
    ```
    If an attestation was created with a timestamp set in the future (e.g. `timestamp = current_ts + 1_000_000`), the condition `current_ts > header.timestamp` previously evaluated to `false`. In TypeScript, `age` was negative (`-1_000_000`), so `age > maxAge` was also `false`. Consequently, an attestation stamped with a future timestamp bypassed expiration under `max_attestation_age_sec`.
  - **Applied Resolution & Invariant Defense:** A strict bound `MAX_FUTURE_DRIFT_SEC = 60` was implemented in both `programs/radar-transfer-hook/src/lib.rs` and `src/hook/index.ts`. Attestations with timestamps exceeding the current clock time by more than 60 seconds (accounting for Solana `Clock` sysvar slot delays) are now explicitly rejected with `StaleOracleAttestation (6002)`. Normal clock drift within 60 seconds is permitted.
  - **Verification:** Unit test `ADV-HOOK-02` reproduces rejection on future timestamps and tolerates minor drift within 60s.

#### ADV-HOOK-03: Extra Accounts Spoofing in CPI `transfer_checked`
- **Attack Hypothesis:** When transferring to a flagged destination wallet, an attacker passes a clean wallet's scan-record PDA in the instruction's remaining accounts, hoping the hook reads the clean record instead of the destination's record.
- **Observed Behavior:** Defended.
  The hook explicitly inspects the destination token account's owner field (bytes 32..64) and re-derives the expected PDA on-chain:
  ```rust
  let (expected_record, _bump) = Pubkey::find_program_address(
      &[RADAR_RECORD_SEED, mint.as_ref(), destination_owner.as_ref()],
      &crate::ID,
  );
  if ctx.accounts.record.key() != expected_record {
      return Err(RadarHookError::RecordPdaMismatch.into());
  }
  ```
  Any spoofed PDA is rejected with `RecordPdaMismatch (6009)`.

#### ADV-HOOK-04: `allowUnverified: bool` Policy Matrix
- **Attack Hypothesis:** An attacker enables permissive mode (`allowUnverified: true`) on a mint to transfer tokens to a known high-risk or flagged counterparty.
- **Observed Behavior:** Defended.
  - When `allowUnverified: true` and no record exists: transfer is allowed.
  - When `allowUnverified: true` and an on-chain record exists with `risk_score: 95`: transfer is rejected with `RiskScoreTooHigh (6000)`.
  - When `allowUnverified: true` and an on-chain record exists with `verdict: "HIGH RISK"`: transfer is rejected with `CounterpartyFlagged (6001)`.
  Permissive mode does not grant immunity to flagged wallets; it only waives the requirement for un-scanned addresses.

#### ADV-HOOK-05: `maxAttestationAgeSec` Boundary Precision
- **Attack Hypothesis:** Testing exact boundary conditions at second-level granularity for attestation expiration (`maxAttestationAgeSec = 3600`).
- **Observed Behavior:** Defended.
  - `age == 3599s`: Allowed.
  - `age == 3600s`: Allowed (inclusive boundary).
  - `age == 3601s`: Rejected with `StaleOracleAttestation (6002)`.

#### ADV-HOOK-06: Transfer Splitting / Chunking / Smurfing
- **Attack Hypothesis:** An attacker attempts to bypass transfer hook risk gating by splitting a 1,000 token transfer into 10 smaller micro-transfers of 100 tokens each.
- **Observed Behavior:** Defended. The Radar Transfer Hook does not enforce per-transaction volume limits; it enforces counterparty integrity. Because the counterparty's on-chain verdict and risk score are evaluated on every transfer attempt regardless of denomination, 100% of the micro-transfers were blocked.

---

## 4. Untested Operational Boundaries

While the automated adversarial suite validates deterministic invariants against synthetic attacks, the following physical and production boundaries remain outside the test environment:

1. **Live Mainnet Validator Forks and Reorgs:**
   The test suite runs against a deterministic mock RPC. On live Solana mainnet, a transaction confirmed under `"confirmed"` commitment can theoretically be dropped during a fork switch before reaching `"finalized"` commitment. `verifySolanaPaymentRpc` relies on the RPC node's default commitment level unless explicitly configured with finalized commitment.
2. **Cluster-Partitioned Split-Brain RPCs:**
   If an x402 server connects to an RPC load balancer where nodes are desynchronized by several slots, an attacker could observe different block heights or temporary missing transaction errors across concurrent requests.
3. **Ultra-High Concurrency (> 10,000 req/sec):**
   The local test evaluated 20 simultaneous concurrent requests against the in-memory `Set` and SQLite store. Under multi-process clustering (e.g. running 8 Node.js worker processes behind NGINX without a shared Redis lock), `inFlightPayments` is local to each process, meaning cross-process races would fall back entirely to SQLite database locks.
4. **Physical Solana Clock Skew:**
   On Solana mainnet, the on-chain `Clock` sysvar can occasionally drift several seconds from real UTC time due to slot production delays.
