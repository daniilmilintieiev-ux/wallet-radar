<p align="center"><img src="docs/brand/lockup-horizontal.svg" width="360" alt="Wallet Radar"></p>

# Wallet Radar: Autonomous Pre-Trade Firewall for Solana AI Agents

> **Continuous behavioral intelligence, pre-trade simulation, and on-chain hard enforcement for the autonomous Solana economy.**

[![Tests](https://img.shields.io/badge/tests-791%20passing-3fb950.svg)](https://github.com/daniilmilintieiev-ux/wallet-radar/tree/main/test)
[![Security Hardening](https://img.shields.io/badge/security%20hardening-11%20internal%20revisions-blue.svg)](https://github.com/daniilmilintieiev-ux/wallet-radar/blob/main/SECURITY.md)
[![Devnet Program](https://img.shields.io/badge/solana%20devnet-wvN1ky...HwoV-blueviolet.svg)](https://explorer.solana.com/address/wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV?cluster=devnet)
[![ZK Compression](https://img.shields.io/badge/light%20protocol-~400x%20less%20locked--up%20rent-ffb000.svg)](https://github.com/daniilmilintieiev-ux/wallet-radar/tree/main/src/oracle)
[![License](https://img.shields.io/badge/license-MIT-informational.svg)](https://github.com/daniilmilintieiev-ux/wallet-radar/blob/main/LICENSE)

---

## Executive Summary: The Trust Layer for AI Agents

Autonomous trading agents and copy-trading bots (BonkBot, Photon, BullX, Maestro, Trojan, Axiom) execute millions of dollars in swaps daily based on momentum and copy signals. **None of them safety-gate the counterparty before executing.**

When an autonomous agent interacts with a wallet, it faces critical risks:
1. **Drainers & Toxic Mints**: Honeypots with active freeze/mint authorities or concentrated insider control.
2. **Account Takeovers & Regime Shifts**: Dormant influencer wallets suddenly reactivated by exploiters to dump compromised assets.
3. **Manufactured Baselines ("Warming")**: Malicious actors executing micro-swaps to simulate organic history before draining copy-traders.

**Wallet Radar is the pre-trade firewall that solves this.** Point-in-time scanners only answer *"what does this wallet hold right now?"* Wallet Radar answers **"what changed, does it matter, and is it safe to trade with right now?"**

It enforces safety at two coordinated layers:
- **Layer 1 (Off-Chain Pre-Trade Gate):** Offline analysis: milliseconds. Live check: about 1-2 seconds. Risk scoring, liquidity stress testing, and what-if simulation via MCP & Agent SDK before funds are in motion.
- **Layer 2 (On-Chain Hard Enforcement):** SPL Token-2022 Transfer Hook (`wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV`) reverting flagged transfers at the Solana runtime level; signed scan records (offline-verified); on-chain anchoring not working yet, see KNOWN-ISSUES D1.

```
                     ┌────────────────────────────────────────────────────────┐
                     │              SOLANA AI AGENTS & TRADERS                │
                     │  (Claude Code / Cursor / Solana Agent Kit / Copy Bots) │
                     └───────────────────────────┬────────────────────────────┘
                                                 │
                                                 ▼
      ┌─────────────────────────────────────────────────────────────────────────────────────┐
      │                        LAYER 1: OFF-CHAIN PRE-TRADE GATE                            │
      │                                                                                     │
      │  ┌───────────────────────┐   ┌───────────────────────────┐   ┌───────────────────┐  │
      │  │  Behavioral Profiler   │   │     Anomaly Detector      │   │  Decision Engine  │  │
      │  │ • Bounded USD Baseline │──▶│ • 9 behavioral rules      │──▶│ • allow / throttle│  │
      │  │ • PnL-Lite FIFO Engine │   │ • Anti-Evasion / Warming  │   │ • block / review  │  │
      │  └───────────────────────┘   └───────────────────────────┘   └───────────────────┘  │
      │                                                                        │            │
      │  ┌────────────────────────────────────────────────────────┐            │            │
      │  │ What-If Simulation: radar_simulate / POST /simulate   │◀───────────┘            │
      │  │ (Projected risk delta, liquidity drain, payment limits)│                         │
      │  └────────────────────────────────────────────────────────┘                         │
      └──────────────────────────────────────────┬──────────────────────────────────────────┘
                                                 │
                                                 ▼
      ┌─────────────────────────────────────────────────────────────────────────────────────┐
      │                     LAYER 2: ON-CHAIN HARD ENFORCEMENT                              │
      │                                                                                     │
      │  ┌─────────────────────────────────────────┐  ┌───────────────────────────────────┐ │
      │  │ SPL Token-2022 Transfer Hook (Devnet)   │  │ Light Protocol ZK Scan Ledger     │ │
      │  │ • Program: wvN1kyvjoFSJq...MGSayAzHwoV  │  │ • RS01 Ed25519 Signed Attestations│ │
      │  │ • Two-Sided Counterparty Verification   │  │ • ~0.000005 SOL Rent-Free State   │ │
      │  │ • Live CPI Revert on Flagged Accounts   │  │ • ~400x Less Locked-Up Rent       │ │
      │  └─────────────────────────────────────────┘  └───────────────────────────────────┘ │
      └─────────────────────────────────────────────────────────────────────────────────────┘
                                                 ▲
                                                 │
                     ┌───────────────────────────┴────────────────────────────┐
                     │             UNIVERSAL INTERFACE ADAPTERS               │
                     │ • MCP Server (stdio / AgenticTrade)                    │
                     │ • x402 HTTP Pay-per-Call (0.005 USDC with caller proof)│
                     │ • Solana Actions & Blinks (1-tap Twitter/Discord card) │
                     │ • Continuous Watchlist & Adaptive Polling (systemd)    │
                     └────────────────────────────────────────────────────────┘
```

---

## Live Deployments & On-Chain Verification

| Surface | Endpoint / Identifier | Verification Status |
|---|---|---|
| **Devnet Transfer Hook** | [`wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV`](https://explorer.solana.com/address/wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV?cluster=devnet) | **LIVE ON DEVNET** (ProgramData: 245,778 B, `d8f9a92`) |
| **Hook Authority** | `4bDZPMF9j3Jm6rUVofT3be6JH67C1tRFBff9MnrsE2EY` | On-chain verified upgrade authority |
| **Token-2022 Test Mint** | [`2YDsAV3y99TCKNVQHB71FgrvsN3sf5f4NoTnHhr4dHUV`](https://explorer.solana.com/address/2YDsAV3y99TCKNVQHB71FgrvsN3sf5f4NoTnHhr4dHUV?cluster=devnet) (configured with `TransferHook`) | Reverts on flagged transfer (`0x1771`); full address found by searching the program's transaction history, stage 9B |
| **A2A Agent Gate** | [`https://radar.cbellory.xyz`](https://radar.cbellory.xyz) | `POST /a2a`, `GET /.well-known/agent.json` |
| **x402 Pay-per-Call** | [`https://pay.cbellory.xyz`](https://pay.cbellory.xyz) | `POST /scan` (0.005 USDC), `POST /analyze` (0.001 USDC) |
| **Web Dashboard** | [`https://radar.cbellory.xyz/dashboard`](https://radar.cbellory.xyz/dashboard) | radar view of detected anomalies, a recorded replay (?demo=replay), the on-chain hook log, and the independent-test timeline; shows behavioral signals, not accuracy |
| **Trust Proof API** | `https://radar.cbellory.xyz/trust-proof?wallet=<addr>` | Signed scan record (offline-verified) + x402-style receipt |
| **Actions & Blinks** | [`https://pay.cbellory.xyz/actions.json`](https://pay.cbellory.xyz/actions.json) | Phantom, Solflare, Dialect one-tap scan card |
| **Canary Node** | Orange Pi 6 Plus (ARM64, 12 cores, 32 GB RAM, Armbian) (`192.168.0.164`) | Continuous monitoring; restarts after power interruptions are logged |

---

## Calibrated Scoring Model & Empirical Benchmark

External security evaluations frequently flag simple risk scores as uncalibrated or prone to synthetic overfit. Wallet Radar addresses this with a mathematically formulated, deterministic scoring engine and empirical ground-truth validation.

### 1. Deterministic Additive Risk Formulation

Wallet Radar scores risk deterministically using a transparent, integer-weighted additive model:

$$R(x) = \min\left(100, \sum_{i=1}^{n} w_i \cdot x_i\right)$$

Where:
- $x_i \in \{0, 1\}$ represents the firing state of anomaly rule $i$.
- $w_i$ represents severity weights derived from empirical exploit priors:
  - $w_{\text{low}} = 5$ (minor deviations: off-hours timing, isolated dormant reactivation)
  - $w_{\text{med}} = 15$ (structural shifts: single-dimension regime shift, activity bursts, concentration spikes, single-venue reliance)
  - $w_{\text{high}} = 30$ (critical exploit signatures: toxic mint authorities, top-10 concentration $\ge 80\%$, multi-dimensional regime shifts, large unexpected swaps)
- **Zero Black-Box Multipliers:** The core anomaly scorer intentionally uses pure integer addition without floating-point drift, ensuring 100% reproducible and verifiable verdicts. Multi-anomaly correlation (e.g. `REGIME_SHIFT` occurring alongside `WARMING` or multiple distinct anomaly classes) is handled explicitly by the `REGIME_SHIFT` meta-detector (escalating severity to `high`), rather than ungrounded multiplicative compounding.

### 2. Decision Engine Mapping (verified against code, stage 9E)

There is no single continuous risk-score axis mapping to `allow`/`throttle`/`block`. Three separate mechanisms are involved, each with its own thresholds:

1. **Base trust verdict** (`safe` / `hold` / `unknown`, `src/trust.ts:130-153`): a binary check — `riskScore > maxRisk` (default **30**) and/or `liquidityUsd < minLiquidityUsd` (default **$50**) each push toward `hold`; `hold` if either reason fired, otherwise `safe`. There is no "70" anywhere in this check.
2. **Agent-facing verdict** (`allow` / `throttle` / `block` / `manual_review`, `computeDecision`, `src/decision.ts:102-159`): **not** a numeric risk-score cutoff. `block` fires whenever *any* anomaly has `severity === "high"` other than `DORMANT_ACTIVE` (`decision.ts:118-126`) — regardless of the risk score's numeric value. Several rules (e.g. `LARGE_SWAP`) always carry a fixed `"high"` severity, not one scaled by magnitude — so a single qualifying anomaly forces `block` at whatever risk score that one anomaly contributes, no matter how large the underlying trade is past its trigger threshold. `manual_review`/`throttle` for the remaining cases come from the base verdict combined with `maxRisk × 1.5` / `minLiquidityUsd × 0.5` escalation multipliers (`decision.ts:136,147`) — again, no `30`/`70` split.
3. **Simulation-time tiered limits** (`src/simulate.ts:104-121`, only reached inside `toolGateCopy` when both an amount and a mint are supplied — see `docs/PROPOSED-DESCRIPTIONS.md`): a literal `riskScore >= 70` zeroes out every payment tier ("Strictly blocked"). This governs per-tier `maxAmountUsd`/`allowed`, a different mechanism from `computeDecision`'s verdict field, though `toolGateCopy` folds the result into its own final answer.

**Reproduced offline** (`scratch/task2-large-swap.mjs`, not committed — a single swap at 5×, 50×, and 500× the wallet's baseline median, all else identical): all three multiples produced the *identical* result — `riskScore: 30`, base verdict `safe` (30 is not `>` `maxRisk` 30), yet `computeDecision`'s verdict was `block` every time, because `LARGE_SWAP` is always severity `"high"`. **The trade's magnitude past the trigger threshold makes no difference to the verdict.** This directly contradicts a claim that "one large trade gives a hold, not a block, at any amount": in this reproduction, it is neither `hold` (the base verdict is actually `safe`) nor merely held back — `computeDecision` blocks it outright, independent of size.

#### Which field decides

These are three separate systems on the same data; they can disagree. For a copy decision use the action field of /gate-copy.

| Endpoint | Field | Values | Purpose |
|---|---|---|---|
| `POST /gate-copy` | `action` | `allow`, `throttle`, `block`, `manual_review` | Pre-trade copy-trading firewall decision (combines wallet trust with token mint check) |
| `POST /trust` | `verdict` | `safe`, `hold`, `unknown` | verdict from behavioral risk <= 30 and liquidity >= $50; does not check the token mint |
| `GET /defense/:wallet` | `state` (`state.state`) | `armed`, `alerting`, `gated`, `blocked` | Persistent longitudinal defense stance across monitored windows (escalates on repeated anomalies, requires `RADAR_WATCH=1`) |

### 3. Risk Score vs. Defense State vs. Verdict — three distinct concepts

These are computed by different code paths, on different timescales, and are easy to conflate:

| Concept | Range / values | Computed by | Persists across calls? |
|---|---|---|---|
| **Risk score** | 0–100, integer | `computeRiskScore`, sum of firing anomalies' severity points (`src/analyzer.ts:1073-1085`; `low=5, medium=15, high=30`, capped at 100) | No — recomputed fresh each evaluation from the current anomaly list |
| **Defense state** | `armed` → `alerting` → `gated` → `blocked` | `src/defense.ts:103-118` (`DEFENSE_THRESHOLDS`: `alerting: 30`, `gated: 50`, `blocked: 75`, plus any high-severity anomaly forces `blocked` directly) | **Yes** — a persistent per-wallet posture (Pillar 3, Active Defense) that escalates on repeated bad observations and only de-escalates after a quiet/clean streak (`defense.ts:173-220`) |
| **Verdict** | `safe`/`hold`/`unknown` (trust) or `allow`/`throttle`/`block`/`manual_review` (decision) | `src/trust.ts:130-153` / `src/decision.ts:102-159` (see above) | No — a fresh, stateless answer for this one call, though `DecisionResult.enforcedByDefense` can note that a persistent defense state tightened it |

### 4. CI Regression Suite (synthetic fixtures, not an empirical benchmark)

**Deterministic CI Regression Suite (24 Cases, `src/benchmark.ts`)**: a zero-network, fully reproducible regression harness executed on every build, using 24 versioned, hand-authored test fixtures (known-good, known-bad, baseline poisoning, manufactured warming, PDA spoofing). The `/benchmark` endpoint and `radar_benchmark` tool run a regression suite of 24 fixtures; its accuracy value is not a measure of detection quality. Each fixture's expected outcome is defined by construction (the author writes a transaction sequence designed to trigger, or not trigger, a specific rule) — this is a **regression test against the ruleset itself**, not an independent measurement against real-world wallets. It currently passes 24/24 (100% precision/recall/accuracy on this fixture set). Run locally via `npm run radar -- benchmark`.

This regression suite is a different kind of evidence than an empirical accuracy claim on real mainnet wallets, and should not be read as one. See **Status of independent evaluation** below for where that empirical validation currently stands.

---

## Status of independent evaluation

Independent validation of detection quality on real on-chain data is not yet complete: the first run (archive: [archive/exp1](archive/exp1), tag `exp1-invalid`) was declared invalid (labels were overwritten by the radar's own verdicts, dataset was not in git, mint state was captured at script runtime rather than at the transaction date) and does not support any accuracy percentage claims. The numbers `96.0%` / `98.0%` / `71 wallets` previously stated in this README and in demo materials were not supported by a reproducible artifact in this repository and have been removed; an independent relabeling methodology is under development in [ground-truth/PROTOCOL.md](ground-truth/PROTOCOL.md).

The full protocol of the current run — including criteria (a)/(b), thresholds, outcome classes, lookahead rules, and pre-start amendment log — is documented in advance in [docs/PREREGISTRATION.md](docs/PREREGISTRATION.md). The live test is already underway: data collection is conducted under tag `shadow-v3` (`docs/PREREGISTRATION.md`, section 17c) and halts on **2026-10-06 18:00 UTC**; final outcome computation runs on **2026-10-10**. Rules and thresholds are frozen until that date and will not change based on observation results. An outcome of "insufficient data" (INSUFFICIENT_DATA / "unmatured", depending on which specific metric did not reach target volume) is an acceptable outcome and will be published as is, without fitting to expectations.

English translations of the protocol documents are provided next to the Russian originals (docs/PREREGISTRATION.en.md, docs/TESTER-SPEC.en.md, docs/SHADOW-COLLECTOR.en.md, docs/SHADOW-RUNBOOK.en.md, ground-truth/PROTOCOL.en.md); the Russian text is authoritative.

---

## Modular Multi-Layer Architecture

Wallet Radar does not rely on a single defensive checkpoint. It provides an end-to-end, multi-layer security stack designed for the autonomous Solana economy:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      1. CLIENT & AGENT ADAPTERS                        │
│   Model Context Protocol (MCP) · x402 Micropayments · Blinks · CLI    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                    2. PRE-TRADE SIMULATION LAYER                       │
│    radar_simulate: what-if outgoing drain, sizing ratio, risk delta    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                   3. DETERMINISTIC DETECTION LAYER                     │
│    9 Anomaly Rules + Supporting Signals (Zero LLM In Decision Path)    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                     4. POLICY & DECISION ENGINE                        │
│   R(x) Integer Sum + Liquidity Cap ──► allow / throttle / block / hold │
└───────────────────┬────────────────────────────────┬───────────────────┘
                    │                                │
┌───────────────────▼──────────────┐  ┌──────────────▼───────────────────┐
│     5. ACTIVE DEFENSE LAYER      │  │  6. ATTESTATION & AUDIT LAYER    │
│  State Machine: armed → blocked  │  │  Light Protocol ZK Scan Ledger   │
│  Dynamic Rate-Limits & Alarms    │  │  Ed25519 Signed Universal Proofs │
└───────────────────┬──────────────┘  └──────────────┬───────────────────┘
                    │                                │
┌───────────────────▼────────────────────────────────▼───────────────────┐
│                   7. ON-CHAIN ENFORCEMENT LAYER                        │
│   Token-2022 Transfer Hook (Devnet Proven · Mainnet-Ready Revert Gate) │
└────────────────────────────────────────────────────────────────────────┘
```

### 1. SPL Token-2022 Transfer Hook (Scan-on-Transfer)

Located in `programs/radar-transfer-hook` (deployed and validated on Solana Devnet at [`wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV`](https://explorer.solana.com/address/wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV?cluster=devnet)):

When a Token-2022 mint enables Wallet Radar's hook, every `transfer_checked` instruction automatically CPIs into the hook program.

```
       Sender TransferChecked
                 │
                 ▼
       ┌──────────────────┐       CPI        ┌────────────────────────────┐
       │   SPL Token-2022 │─────────────────▶│    radar-transfer-hook     │
       │     Program      │                  │ (wvN1ky...MGSayAzHwoV)     │
       └──────────────────┘                  └─────────────┬──────────────┘
                                                           │
                                        Checks PDA [b"radar_record", mint, wallet]
                                                           │
                                             ┌─────────────┴─────────────┐
                                             ▼                           ▼
                                      [Risk <= Max]              [Risk > Max (Flagged)]
                                             │                           │
                                             ▼                           ▼
                                      SUCCESS (Allow)            REVERT: Error 0x1771
                                                              (CounterpartyFlagged)
```

- **Deployed on Devnet**: Functional on Devnet (`wvN1ky...HwoV`), demonstrating live reverts with Anchor error code `0x1771` (`RadarHookError::CounterpartyFlagged`). Real example, verified via `getSignaturesForAddress` + `getTransaction` (stage 9B/9D): [`3TYaAkc3QRRqGC4ppMJ3pei9HfkznQwvtGuDmedwp54SY9x2CAeu3usvfLUW1n6YR9qxVxdEKtXjU3QJw96mt5aj`](https://explorer.solana.com/tx/3TYaAkc3QRRqGC4ppMJ3pei9HfkznQwvtGuDmedwp54SY9x2CAeu3usvfLUW1n6YR9qxVxdEKtXjU3QJw96mt5aj?cluster=devnet) (`InstructionError: [0, {"Custom":6001}]`). This is devnet functional testing, not adversarial testing at scale ("battle-tested" was an overstatement and has been removed). Mainnet deployment requires ~1.72 SOL rent-exemption for program account allocation and is scheduled alongside production token deployments.
- **Two-Sided Counterparty Gate**: Evaluates remaining accounts for both destination AND sender, blocking transfers to compromised addresses and transfers out of drained wallets.
- **Mint Authority Authentication**: Enforces that only the bona fide `mint_authority` can initialize configurations and register extra account metas, preventing front-running and hijacking.
- **Deterministic Record PDAs**: Records derive from seeds `[b"radar_record", mint.key(), wallet.key()]` ensuring strict cross-mint isolation.
- **Safe Account Deallocation**: The `close_scan_record` instruction validates program account ownership (`InvalidAccountOwner = 6011`) before deallocating account memory and reclaiming lamports to fee payer, preventing Solana VM `IllegalOwner` panics.

#### Scope and limitations of the hook

The hook is invoked only for Token-2022 mints that configure this program as their transfer-hook extension. It does not protect native SOL, legacy SPL tokens, or Token-2022 mints that do not use this hook. Per mint, the allow_unverified setting decides whether a counterparty without an on-chain scan record may receive transfers (allow_unverified: true) or is rejected (UnverifiedCounterparty). The hook enforces a verdict written on-chain by the operator; it does not detect anything by itself. Verified on devnet: nine rejections with error 6001.

### 2. Light Protocol ZK Scan Ledger (The Oracle)

Storing scan records in regular Solana PDAs costs ~0.002039 SOL per account. At agent scale, this is economically prohibitive. Wallet Radar integrates **Light Protocol ZK compression** (signed scan records (offline-verified); on-chain anchoring not working yet, see KNOWN-ISSUES D1):

Signed scan records are verified offline. The SPL Memo anchoring path currently fails: the record is not valid UTF-8 (confirmed by a devnet simulation; see docs/KNOWN-ISSUES.md D1). Writing to the Light Protocol compressed ledger on a live cluster has not been verified.

| Metric | Traditional Solana PDA | Wallet Radar ZK Compressed State | Improvement |
|---|---|---|---|
| **Account Rent Deposit** | ~0.002039 SOL ($0.30+) | **~0.000005 SOL ($0.0007)** | **~400x less locked-up rent deposit** (a rent deposit is refundable on account close either way — this compares how much SOL is tied up while the account is open, not a fee) |
| **State Storage** | Full validator RAM | Merkle tree compressed leaf | Zero validator bloat |
| **Binary Encoding** | 500+ bytes Borsh | **34–130 bytes `RS01` header** | High-density packing |
| **Cryptographic Proof** | Plain account data | **Ed25519 oracle signature trailer** | Verifiable off-chain |

- **`RS01` Binary Encoding**: 48-byte fixed header (`magic: RS01`, `wallet: 32B`, `risk_score: u8`, `verdict_code: u8`, `timestamp: u64LE`, `payload_len: u16LE`) with JSON evidence and 96-byte Ed25519 signature trailer.
- **Instant Client Read**: Read historical scan attestations directly without complex zero-knowledge proving overhead.

### 3. Web Dashboard

The web dashboard (`GET /dashboard`) provides a radar view of detected anomalies, a recorded replay (`?demo=replay`), the on-chain hook log, and the independent-test timeline. It displays an empty prompt state when no wallet is selected or found. The dashboard visualizes behavioral signals and does not compute detection verdicts itself.

[https://daniilmilintieiev-ux.github.io/wallet-radar/dashboard-preview.html](https://daniilmilintieiev-ux.github.io/wallet-radar/dashboard-preview.html) — static preview with a recorded replay

---

## 9 behavioral rules plus a funding-source check

Wallet Radar rejects opaque LLM prompts in the critical security path. Detection is 100% deterministic and replayable:

| Rule | Detection Trigger | Severity | Exploit Vector Mitigated |
|---|---|---|---|
| `TOXIC_MINT` | Mint has an active freeze authority, OR an active mint authority, OR top-10 holders control $\ge 60\%$ supply, OR (Token-2022) a `permanentDelegate`/frozen `defaultAccountState`/`pausable`/foreign `transferHook` extension | Medium, or High if the freeze authority is present, OR concentration $\ge 80\%$, OR (pump.fun token AND (mint authority OR $\ge 60\%$ concentration)), OR `permanentDelegate`/frozen `defaultAccountState` (Token-2022: `pausable`/foreign `transferHook` are Medium) | Honeypots, sudden freeze scams, rugpull dumps, Token-2022 clawback/freeze/pause/transfer-hook mints |
| `REGIME_SHIFT` | Structural break: amount ($\ge 3\times$), venue/protocol dominance ($\ge 70\%$), or cadence shift ($\ge 4\times$) | Medium (1 dim) / High ($\ge 2$ dims, or $\ge 3$ distinct anomaly categories with $\ge 2$ substantive ones, or $\ge 4$ categories) | Account takeover, private key compromise, bot automation |
| `WARMING` | Thin historical baseline ($< 5$ txs) followed immediately by high-severity transactions | Medium | Manufactured reputation evasion by siphoners |
| `LARGE_SWAP` | Swap size $> N\times$ the wallet's bounded USD median (Jupiter normalized) | High | Whale dumping, flash drain of treasury funds |
| `ACTIVITY_BURST` | $K+$ transactions in a short window vs historical rate | Medium / High ($\ge 2K$) | Automated sweeping scripts, drainer extraction |
| `DORMANT_ACTIVE` | Wallet reactivates after $N$ days of inactivity | High (or Medium below a 60-day reactivation gap) | Sleeping exploiter wallets returning to liquidate stolen assets |
| `CONCENTRATION` | Repeated high-frequency swaps into a single token | Medium | Coordinated wash trading, illiquid token pumping |
| `NEW_VENUE` | First swap on a DEX venue not present in baseline profile | Medium | Unverified liquidity pools, malicious swap contracts |
| `OFF_HOURS` | Batch $\ge 3$ txs with $\ge 2$ txs ($\ge 50\%$) landing in 0-baseline UTC hours (baseline $\ge 20$ txs) | Medium | Automated draining across sleeping timezones |

`TOXIC_MINT`'s Token-2022 extension fields are populated only via the RPC `getAccountInfo` jsonParsed
fallback path (`parseRpcAccountInfoResponse`), not the Helius DAS `getAsset` path; and this extended
check is not currently wired into `/gate-copy`'s own mint check (`simulate.ts`'s TOXIC_MINT-equivalent
logic there only looks at `freezeAuthority`/`top10Pct`) — see `docs/KNOWN-ISSUES.md`.

### Supporting Behavioral Signals
In addition to the 9 primary rules, the engine tracks contextual signals that enrich anomaly evidence without causing unilateral blocks:
- **`NEW_PROTOCOL` (Low Severity)**: Emitted upon first interaction with an on-chain program/contract not present in baseline history.
- **`COUNTERPARTY_CLUSTER` (Low Severity)**: Emitted when $\ge 50\%$ of counterparty interactions (min 4 txs) concentrate into a single address.
- **`COUNTERPARTY_MEMORY`**: Three underlying types (`NEW_COUNTERPARTY`, `COUNTERPARTY_HUB`, `COUNTERPARTY_ESCALATION`, defined in `src/counterparty.ts`) — detects relationship escalation, new counterparty emergence, and dominant hub routing.

Additionally: funding source check (`TAINTED_FUNDING`, `src/analyzer.ts:471-501`) — triggers on the earliest incoming transfer in the supplied history that came from an address on the known exploiter list; checks every incoming native transfer, not just the first one found. This is a distinct check, independent of the nine core rules and auxiliary signals; it does not count toward the "9 rules" total (see `docs/KNOWN-ISSUES.md` regarding the count desynchronization between this README, `src/http-server.ts`/`src/mcp.ts`, and `test/regime.test.ts`).

---

## Pre-Trade Simulation Mode (`radar_simulate`)

Agents invoke `POST /simulate` or MCP tool `radar_simulate` **before signing** an outbound transfer:

```json
// POST /simulate
{
  "wallet": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "amountUsd": 250,
  "balances": { "sol": 0.5, "usdc": 600, "usdt": 0 }
}
```

**Simulation Analysis Engine:**
1. **Liquidity Drain Modeling**: Calculates remaining liquid capital after transfer. If post-payment capital drops below $\$10$ (while prior was $> \$50$), triggers `LIQUIDITY_DRAIN` (+10 risk delta).
2. **Relative Sizing Multipliers**:
   - If payment $\ge 3.0\times$ median swap size: triggers `LARGE_PAYMENT` (+20 risk delta).
   - If payment $\ge 1.5\times$ median swap size: moderate payment escalation (+8 risk delta).
3. **Projected Risk Delta**: Quantifies the exact shift in risk score if this payment executes ($R_{\text{projected}} = \min(100, R + \Delta)$).
4. **Action Verdict**: Emits `allow`, `throttle`, `block`, or `manual_review` with suggested limits and cooldown recommendations.

---

## Cryptographic Payment Security (x402 & Blinks)

Wallet Radar's HTTP services implement an **x402-style payment-required protocol** (own X-Payment-* headers and payment-proof format; not validated against official x402 v2 clients, which use PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE) for autonomous machine-to-machine commerce ($0.005 USDC per live scan).

Security features implemented across 11 audit revisions:
- **Anti-Frontrunning (`X-Payment-Proof`)**: The calling agent signs a cryptographic Ed25519 signature over message format `RadarScan:<targetWallet>:<timestamp>` (or `RadarScan:<targetWallet>`) matching the on-chain payment fee payer. Attackers eavesdropping on the mempool cannot steal or replay another agent's payment transaction.
- **Target Wallet Memo Binding**: Payment transactions encode an on-chain SPL memo (`RadarScan:<targetWallet>`), binding the payment strictly to the audited address.
- **Fail-Fast Freshness Enforcement**: Payments must be submitted within $300\text{ seconds}$ (`maxAgeSec`) of on-chain confirmation.
- **Atomic Replay Prevention**: Settled signatures are recorded inside SQLite (`settled_payments`) with atomic unique constraints, rejecting duplicate submissions across restarts.

---

## Developer Quick Start

### 1. Installation & Build

Install by cloning the repository and building (npm ci && npm run build). The npm package metadata is incomplete: no type declarations are generated and dist/ is not part of the packed tarball (see docs/KNOWN-ISSUES.md).

```bash
git clone https://github.com/daniilmilintieiev-ux/wallet-radar.git
cd wallet-radar
npm install
npm run build
```

### 2. Verify System Integrity (791 passing, 5 documented known gaps (todo), 46 suites)

```bash
# Run the complete test suite (791 passing, 5 documented known gaps (todo), 46 suites)
npm test

# Run offline smoke selftest (no network or API keys required)
npm run radar -- selftest

# Run deterministic benchmark evaluation
npm run radar -- benchmark
```

Note: the number of counted tests depends on the Node version. Node 24 (Windows): 796 tests, 791 passing; Node 22 (Linux ARM64): 765 tests, 760 passing; 0 failures and 5 documented todo in both. The cause of the difference in the number of counted tests has not been investigated.

### 3. Live Wallet Scan

```bash
export HELIUS_API_KEY="your-helius-key"

# Live scan via CLI (returns structured JSON with risk score and evidence)
npm run radar -- scan <wallet-address>

# Trust gate check before copying
npm run radar -- trust <wallet-address> --max-risk 30 --min-liquidity 50
```

### Trust Check (The Gate Before You Copy)

`trust` answers the question every copy-trader and agent asks before copying or paying an unverified wallet: **"is it safe to trust this wallet right now?"**

It combines the behavioral risk score (9 behavioral rules plus a funding-source check (TAINTED_FUNDING) and supporting signals over the recent window; `TOXIC_MINT` is one of the 9 but never actually fires on this specific path, since `runTrustCheck` does not fetch or pass mint risk data, `src/trust.ts:329`) with payment capacity (SOL + USDC/USDT liquidity in USD) into one deterministic verdict:
- `safe`: risk under max and liquidity over min threshold.
- `hold`: data available, but risk exceeds max or liquidity is below minimum.
- `unknown`: insufficient historical data to safely evaluate (conservative fail-safe).

```bash
node dist/src/cli.js trust <wallet>                        # defaults: max-risk 30, min-liquidity $50, window 7d
node dist/src/cli.js trust <wallet> --max-risk 50 --min-liquidity 100 --json
```

---

## Agent Integration Guide

### 1. Model Context Protocol (MCP)

Add Wallet Radar to your MCP host configuration (`claude_desktop_config.json`, Cursor, or Eliza):

```json
{
  "mcpServers": {
    "wallet-radar": {
      "command": "node",
      "args": ["<path-to-wallet-radar>/dist/src/mcp.js"],
      "env": {
        "HELIUS_API_KEY": "your-helius-key"
      }
    }
  }
}
```

**Exposed MCP Tools:**
- `radar_scan`: Live Helius fetch + baseline + all 9 rules, including `TOXIC_MINT` (this endpoint does fetch mint risk data, unlike `radar_trust`) $\rightarrow$ risk score, evidence, freshness.
- `radar_trust`: Binary gate before copy/payment $\rightarrow$ `safe` / `hold` / `unknown`.
- `radar_simulate`: Pre-trade what-if simulation (liquidity stress, risk delta, limits).
- `radar_gate_copy`: Pre-trade copy-trading firewall: gates a proposed copy-trade, swap, or payment before execution. Evaluates behavioral risk against the wallet's history. When both an amount and a specific token mint are supplied, additionally checks that mint's freeze authority and top-10-holder concentration (not mint authority) before allowing execution. Returns an immediate ALLOW, THROTTLE, or BLOCK verdict.
- `radar_batch`: Safety-gate up to 20 copy-trader wallets in a single deterministic pass.
- `radar_analyze`: Offline anomaly analysis over pre-recorded transaction fixtures.
- `radar_benchmark`: Deterministic 24-case quality evaluation report (a regression suite of 24 fixtures; its accuracy value is not a measure of detection quality).
- `radar_selftest`: System health check and self-test.

### 2. Autonomous Agent TypeScript SDK

```typescript
import { createRadarClient } from "wallet-radar/sdk";
import { Keypair } from "@solana/web3.js";

const client = createRadarClient({
  baseUrl: "https://pay.cbellory.xyz",
  rpc: "https://api.mainnet-beta.solana.com",
  x402Payer: Keypair.fromSecretKey(/* ... */), // Auto-pays 0.005 USDC per scan
  recipient: "F6wWPy4c...BNR",
});

// 1. One-tap pre-trade safety scan
const result = await client.scan("TargetSolanaWallet1111111111111111111111111");
console.log(`Risk: ${result.riskScore}/100, Verdict: ${result.verdict}`);

// 2. Fetch verifiable trust proof bundle
const proof = await client.trustProof("TargetSolanaWallet1111111111111111111111111");
console.log(`On-Chain Attestation Slot: ${proof.attestation?.slot}`);

// 3. Read historical ZK compressed attestations from Light Protocol
const history = await client.readOnchainLedger("TargetSolanaWallet1111111111111111111111111", 5);
```

### 3. Solana Actions & Blinks (Interactive Social Gate)

Wallet Radar serves official Solana Actions and Blinks from `https://pay.cbellory.xyz`:
- **Dialect Blinks Explorer**:
  ```
  https://dial.to/?action=solana-action:https://pay.cbellory.xyz/api/actions/radar-scan
  ```
- **Phantom & Solflare Instant Links**:
  ```
  https://phantom.app/ul/browse/https%3A%2F%2Fpay.cbellory.xyz%2Fapi%2Factions%2Fradar-scan?ref=wallet-radar
  https://solflare.com/ul/v1/browse/https%3A%2F%2Fpay.cbellory.xyz%2Fapi%2Factions%2Fradar-scan
  ```

---

## Verifiable Trust Proofs (`GET /trust-proof`)

Anyone—human auditor or peer AI agent—can independently verify audit authenticity without trusting our API server:

```bash
curl "https://radar.cbellory.xyz/trust-proof?wallet=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
```

```json
{
  "wallet": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "verified": true,
  "attestation": {
    "signature": "5Knm...3ZtW",
    "slot": 312845920,
    "compressedAddress": "comp_a1b2c3d4...",
    "timestamp": 1726700000
  },
  "riskScore": 88,
  "verdict": "HIGH RISK",
  "topRules": ["REGIME_SHIFT", "TOXIC_MINT"],
  "payment": {
    "payer": "4uQeVj5tqViQh7yWWGStvfEG1Zmhx6uasJtWCJziofM",
    "amountUsdc": 0.005,
    "txSignature": "3Fpq...7VwX",
    "signature": "3Fpq...7VwX",
    "settledAt": 1726700000
  },
  "generatedAt": 1726700000
}
```

---

## Security Engineering & Hardening History

Wallet Radar has undergone **11 consecutive security hardening revisions** (detailed security model and vulnerability policy in [SECURITY.md](SECURITY.md)):

- **Revision 11 (Latest Hardening)**:
  - `WR-CRIT-01`: Enforced non-empty `accountKeys` validation in RPC payment verifiers.
  - `WR-CRIT-02`: Oracle signing pipeline strictly halts on missing signer keys, eliminating silent downgrade to unsigned attestations.
  - `WR-HIGH-01`: Expanded account list capacity for Transfer Hook extra accounts.
  - `WR-HIGH-02`: Fixed Anchor discriminator parsing for `update_extra_account_meta_list`.
- **Revisions 1–10**:
  - Implemented Ed25519 `X-Payment-Proof` caller signatures against mempool front-running.
  - Fixed CPI counterparty spoofing via remaining account introspection.
  - Validated mint account layout and authentication for hook initialization.
  - Resolved `IllegalOwner` panics in account deallocation.
  - Configured atomic SQLite transaction settlement to eliminate double-spend race conditions.

---

## Environment Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HELIUS_API_KEY` | — | Required for live Helius Enhanced Transactions queries |
| `SOLANA_RPC_URL` | Helius / Mainnet | Custom Solana RPC endpoint |
| `RADAR_THRESHOLD_SCALE` | `1.0` | Global multiplier on all detection thresholds ($<1.0$ stricter, $>1.0$ permissive) |
| `RADAR_MAX_RISK` | `30` | Maximum acceptable risk score for `safe` verdict (0–100) |
| `RADAR_MIN_LIQUIDITY_USD` | `50` | Minimum wallet liquidity threshold in USD |
| `RADAR_ALLOW_SMART_ACCOUNTS` | `0` | Set to `1` to allow verified smart accounts/multisigs (Squads) to receive `safe` verdict |
| `RADAR_ASYNC_COMMIT` | `0` | Set to `1` (or header `Prefer: respond-async`) to return scan results immediately and commit on-chain in background |
| `RADAR_ORACLE` | `0` | Set to `1` to commit each scan to the Light Protocol ZK scan ledger |
| `RADAR_ORACLE_KEYPAIR` | — | Path to 64-byte keypair JSON file for oracle payer |
| `RADAR_X402_RECIPIENT` | — | Recipient USDC address for x402 micropayments |
| `RADAR_WATCH` | `0` | Set to `1` to start continuous watchlist monitoring service |
| `WEBHOOK_URL` | — | Webhook destination for structured JSON anomaly alerts |
| `RADAR_ISSUER_MINTS_FILE` | — | Path to a JSON array of issuer-controlled mint addresses; a freeze-authority `TOXIC_MINT` finding on a listed mint is downgraded from High to Medium. Optional, off by default (empty list when unset) |

See `docs/DEPLOY-CHECKLIST.md` for the auth/rate-limit env vars (`RADAR_API_TOKEN`, `RADAR_ALLOW_UNAUTH_MUTATIONS`, `RADAR_ALLOW_ANON_ONCHAIN_WRITES`, `RADAR_AUTH_HEAVY`/`RADAR_REQUIRE_AUTH`, `RADAR_PROTECT_READS`, `RADAR_TRUST_PROXY`, `RADAR_LIVE_RATE_LIMIT_PER_MIN`, `RADAR_RATE_LIMIT_PER_MIN`) relevant to a public-facing deployment.

---

## Colosseum Hackathon (Fall 2026): Before / After Honesty Note

In strict adherence to Colosseum hackathon rules and open-source transparency, here is the exact breakdown of development history:

### 1. Pre-Hackathon Baseline (`v0.0.0`, commits `20a965f` … `3e0e0ad`)
- Initial prototype of the 8 behavioral rules (`DORMANT_ACTIVE`, `ACTIVITY_BURST`, `NEW_VENUE`, `LARGE_SWAP`, `CONCENTRATION`, `NEW_PROTOCOL`, `TOXIC_MINT`, `REGIME_SHIFT`).
- Helius transaction fetcher and SQLite baseline profiler.
- Basic CLI commands (`scan`, `trust`, `watch`).

### 2. The Pre-Window Leap Snapshot (`f2bc219`, 2026-09-14 11:05 UTC)
- Landed as a consolidation commit before the hackathon kickoff: ZK scan ledger prototype, initial Agent SDK, Blinks draft, and early Transfer Hook scaffolding.

### 3. In-Window Development (40 Incremental Commits as of the hackathon-submission checkpoint, 2026-09-14 15:00 UTC onward)

> **Commit-count note:** `git rev-list --count f2bc219..3f299bf~1` = **40**, confirming the figure below as of the commit that first stated it (`3f299bf`). The branch has continued past the hackathon window since then (post-submission auditing, shadow-collector data-collection work) — `git rev-list --count f2bc219..HEAD` on the current commit returns a much larger number, which is **not** "hackathon in-window commits" and isn't a like-for-like comparison to the count below.

- **Decision Engine & Pre-Trade Simulation**: Added `radar_simulate`, confidence scoring, and dynamic payment limits (`16b35f3`, `ccfc534`, `aebe35d`).
- **Anti-Evasion & Calibration**: Created `WARMING` rule, multi-anomaly shift detection, and 21-case eval suite (`0d8a4dd`, `3e3150b`).
- **Three Core Pillars**:
  - *Pillar 1 (Economics)*: PnL engine and `/economics` unit-economics ledger (`72ea65f`).
  - *Pillar 2 (Consensus)*: Multi-agent consensus panel with weighted aggregation (`d7cc3cc`).
  - *Pillar 3 (Active Defense)*: Autonomous wallet stance escalation (`16ed9a4`).
- **On-Chain Devnet Deployment**: Compiled Transfer Hook to SBF, deployed to Solana Devnet (`wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV`), and verified live revert on flagged accounts (`886579b`, `56d3caa`, `d8f9a92`).
- **11 Security Audit Revisions**: Comprehensive hardening against front-running, CPI injection, account hijacking, and double-spending (`990bb36`, `93d32f6`, `a4cf128`).
- **Trust Proof API**: Launched independently verifiable `/trust-proof` cryptographic bundle (`7707e7d`).
- **Full Test Suite Expansion**: Expanded to **791 passing, 5 documented known gaps (todo), 46 suites**.

---

## Status

**Early-access (package `1.0.0`, per `package.json`)** — the core is production-usable and live: collector (Helius), per-wallet behavioral baseline (incl. USD median), behavioral analyzer (9 rules plus a funding-source check, USD-normalized, unit-tested), `trust` gate-before-you-copy verdict (risk + liquidity → `safe`/`hold`/`unknown`, with per-rule reasons, summary, and data freshness), MCP server (stdio), HTTP service, x402 pay-per-call, Telegram / Webhook / console alerts, deterministic replay, and self-contained HTML reports. Continuous monitoring watches a wallet list and alerts on fresh anomalies.

## Feature status

Verified on branch `docs/claims-fix`, date 2026-09-30.

| Feature | Status | Limitation |
|---|---|---|
| CLI `radar selftest` | live run | built-in synthetic fixture, no network required |
| CLI `radar benchmark` | live run | 24 deterministic cases, no network required |
| CLI `radar analyze` | live run | local history JSON file, no network required |
| CLI `radar prices` | live run | public GET to Jupiter Price API |
| CLI `radar add` / `history` / `report` / `alerts` / `remove` | live run | local SQLite read/write, no network required |
| CLI `radar digest` | live run | local run without Telegram keys |
| CLI `radar replay` | tests | not verified with live run without Helius key (6 tests in `test/replay.test.js`) |
| CLI `radar scan` | code only | CLI wrapper not verified with live run; HTTP `/scan` confirmed separately (below) |
| CLI `radar trust` | tests | algorithm verified by 38 tests in `test/trust.test.js`; live run confirmed only for HTTP `/trust` |
| CLI `radar watch` | tests | loop verified by tests in `test/watch.test.js`/`test/defense.test.js` and systemd service on board |
| `GET /health`, `POST /selftest`, `POST /benchmark`, `GET /.well-known/agent.json`, `GET /dashboard`, `GET /economics`, `GET /trust-proof`, `POST /a2a` — 23 endpoints (see GET /health) | live run | without paid Helius key (offline/public data) |
| `POST /analyze` | live run | offline, median response time 3.69 ms |
| `POST /trust` | live run (Helius key, 1-2.5 s) | verified across 5 wallets |
| `POST /scan` | live run (Helius key, 1-2.5 s) | verified across 5 wallets |
| `POST /gate-copy` | live run (Helius key, 1-2.5 s) | unauthenticated by default, see "Limitations and known issues" |
| x402 payment | live run (one test payment of 0.005 USDC) | confirms payment pipeline execution, not external revenue; see "Limitations and known issues" |
| `POST /simulate` | tests | covered by `test/simulate.test.js` |
| `POST /batch` | tests | covered by `test/trust.test.js` |
| MCP `radar_selftest` / `radar_benchmark` / `radar_analyze` | live run | |
| MCP `radar_scan` / `radar_trust` / `radar_batch` / `radar_simulate` / `radar_gate_copy` | tests | covered by `test/mcp.test.js` |
| SPL Token-2022 Transfer Hook (Devnet) | live run | real transaction with rollback `0x1771`/`CounterpartyFlagged` |
| Demo `examples/copy-bot-firewall.ts` | unconfirmed | `fetchFn` uses built-in mocks with hardcoded verdicts, no real call to radar by default |
| Light Protocol attestation recording (on-chain, Devnet) | unconfirmed | `getCompressedAccountsByOwner` unavailable on standard Devnet RPC (`-32601 Method not found`); only offline logic confirmed (`test/oracle.test.js`) |

## Limitations and known issues

Full list with file:line — [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md). In brief:

- Fixed: the A2A card version is taken from package.json; the public server has returned 1.0.0 since 2026-10-07.
- Rule count: 9 behavioral rules plus a funding-source check (`TAINTED_FUNDING`, `src/analyzer.ts:471-501`) — previously counted in code as "9 rules" without reflecting the funding check (`src/http-server.ts`, `src/mcp.ts`, `test/regime.test.ts`).
- ~~`TAINTED_FUNDING` checks only the very first inbound transfer~~ — fixed in main, deployed 2026-10-07 (build 2dc3e37): now checks every incoming transfer in the supplied history.
- ~~`DORMANT_ACTIVE` may fire on a wallet that trades daily without real gaps, as an artifact of the trust-window boundary~~ — fixed in main, deployed 2026-10-07 (build 2dc3e37): the `trust` path now measures the dormancy gap from the evaluated batch's earliest tx (`RadarConfig.dormantMeasure: "first"`) instead of its newest; the `scan`/walk-forward path is unchanged (`"newest"`, the default). Confirmed against `benchmarks/history-cache` (1001 wallets, offline): `DORMANT_ACTIVE` firings on the `trust` path caused by the trust-window boundary dropped from 197 to 133 (no ground-truth labels exist for these wallets, so whether any individual firing was "correct" or not is not established either way); live-data confirmation after shadow collector stops is still open.
- ~~`/gate-copy` is not part of either authorization set (`isMutating`/`isHeavy`, `src/http-server.ts:108-131`) and cannot be gated by `RADAR_API_TOKEN` under any configuration; calls Helius and without a token all routes are open by default (`authorizeMutating`, `:115`).~~ — fixed in branch `secaudit2`: `/gate-copy` is now included in `isHeavy` (`src/http-server.ts:134`) and can be gated by `RADAR_AUTH_HEAVY=1`/`RADAR_REQUIRE_AUTH=1`. Without `RADAR_API_TOKEN`, mutating routes (`POST /watch`, `/unwatch`, `/poll`, `/defense/:wallet/clear`) return 403 (unless `RADAR_ALLOW_UNAUTH_MUTATIONS=1` is set); `/scan`, `/trust`, `/batch`, `/simulate`, `/gate-copy`, `/analyze` remain open by default (with rate limits).
- ~~`fetchMintMetadata`/`getTokenLargestAccounts` failure leads to silently skipping metadata~~ — fixed in main, deployed 2026-10-07 (build 2dc3e37) for `/gate-copy` specifically: a failed mint check now sets `tokenCheck: "unavailable"`, emits a `TOKEN_CHECK_UNAVAILABLE` anomaly, and caps the verdict at `manual_review` when `copyAmountUsd > 0`. `/scan`/`/trust`'s batch mint-risk path (`fetchSwapMintRisk`, `src/analyzer.ts:780`) still fails open — out of this stage's scope.
- `BLUECHIP_FALLBACK_PRICES` (`src/pricing.ts:115-128`) stays defined (kept for `scripts/audit/*.mjs`'s offline replay) but is now explicitly commented as not-for-live-use; `/scan`, `/trust`/`/batch`, and `/gate-copy` report `degraded: ["PRICES_UNAVAILABLE"]` when the price fetch actually fails.
- ~~`TOXIC_MINT` does not take into account Token-2022 extensions~~ — fixed in main, deployed 2026-10-07 (build 2dc3e37) for the RPC `getAccountInfo` jsonParsed fallback path: `MintRiskInfo` gained `permanentDelegate`, `pausable`, `transferHook`, `defaultAccountStateFrozen`. Not yet extended to the Helius DAS path or to `/gate-copy`'s own (separate, simpler) mint check in `simulate.ts`.
- x402: payment replay protection is synchronous and non-racy within a single process, but across processes duplicate delivery for a single signature is possible (`src/x402server.ts:1000-1005`, `:1161-1169`).
- Payment verification error message may include `err.message` (`src/x402server.ts:492-493`); inclusion of URL with API key in this message was not tested (requires a real network failure).
- Transfer Hook: single upgrade authority for the program itself and single `config.authority` per mint (no multisig at protocol level); `risk_score` in `write_scan_record` is not explicitly bounded to <= 100 (`lib.rs:492`).
- Test quality: mutating `REGIME_DOMINANT_RATIO` and `DEFENSE_THRESHOLDS.blocked` breaks zero tests; 5 tests verify results against the exact constant read by tested code (list in `docs/KNOWN-ISSUES.md`).
- `npm audit`: 12 known vulnerabilities in dependency tree (9 moderate, 3 high — `bigint-buffer`, `@solana/buffer-layout-utils`, `@solana/spl-token`), all via `@solana/spl-token@0.4.15`, unchanged as of branch `fixes-b`. Reachability analysis (branch `fixes-b`, not a fix — no dependency changed): the only `@solana/spl-token` function this project calls (`createAssociatedTokenAccountIdempotentInstruction`) never reaches the flagged `bigint-buffer` functions through its own call graph — see `docs/KNOWN-ISSUES.md` for the full trace.
- The "sub-second" claim held only for offline `/analyze` (median 3.69 ms); live check `/trust` measured at 1.0-2.4 s across 5 wallets — wording below is corrected.
- Demo `examples/copy-bot-firewall.ts` uses built-in mock responses and does not query a real server even if running.
- Light Protocol oracle: logic confirmed in tests; real write to Light Protocol network was not verified during this audit. `DEFAULT_ORACLE_PROGRAM_ID` (`src/oracle/ledger.ts:77`) is Light Protocol's system program, not a contract of this project.

## How to verify

Five reproducible commands (each verified in stages 9B–9E):

1. **Full test suite**: `npm test` → 791 passing, 5 documented known gaps (todo), 46 suites.
2. **Deterministic benchmark**: `npm run radar -- benchmark` → 24/24 on a versioned synthetic fixture set (this is a regression test on the rules themselves, not an independent empirical accuracy benchmark on real data — see "Status of independent evaluation").
3. **Offline self-test**: `npm run radar -- selftest` → no network or API keys, runs the full detection pipeline on a synthetic wallet.
4. **Deterministic replay**: `node dist/src/cli.js replay <wallet> --since <unix-ts> --until <unix-ts>` → replays the detector over a historical window of a real wallet; identical input data always yields an identical verdict.
5. **Live devnet hook** (public RPC, read-only):
   ```bash
   curl -s https://api.devnet.solana.com -X POST -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV",{"encoding":"base64"}]}'
   ```
   → confirms `executable: true`, owner is upgradeable BPF loader.
## Support

- **Report issues** via [GitHub Issues](https://github.com/daniilmilintieiev-ux/wallet-radar/issues) (non-security) or privately via [SECURITY.md](SECURITY.md) (security).
- **Early-access response target:** we aim to acknowledge within 1 business day and follow up with a plan or a fix.
- **Live service:** `GET /health` reports the version and configuration status.

## Privacy

Wallet Radar is read-only and custody-free: it reads public on-chain data via Helius, never holds a private key, and never signs or moves your funds. x402 payment verification is read-only (it reads the submitted transaction and recipient USDC balance). The full data-handling model is in [SECURITY.md](SECURITY.md).

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — release history and leap entries.
- [SECURITY.md](SECURITY.md) — security policy, disclosure, data handling.
- [docs/trust-spec.md](docs/trust-spec.md) — trust-check architecture and decision boundaries.
- [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) — tracked documentation/code inconsistencies, with file:line citations.
- [docs/PROPOSED-DESCRIPTIONS.md](docs/PROPOSED-DESCRIPTIONS.md) — proposed corrected tool/endpoint descriptions, not yet applied to `src/`.
- [ADVERSARIAL-TESTING.md](ADVERSARIAL-TESTING.md) — adversarial test matrix for the x402 server and Transfer Hook.

## License

MIT License. Developed for the Solana ecosystem and autonomous agent economy.
