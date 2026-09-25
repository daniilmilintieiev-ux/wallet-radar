# Wallet Radar: Autonomous Pre-Trade Firewall for Solana AI Agents

> **Continuous behavioral intelligence, pre-trade simulation, and on-chain hard enforcement for the autonomous Solana economy.**

[![Tests](https://img.shields.io/badge/tests-608%20passing%20%7C%2026%20suites-3fb950.svg)](file:///test)
[![Security Audit](https://img.shields.io/badge/security%20audit-11%20revisions%20%7C%20institutional%20grade-blue.svg)](file:///AUDIT.md)
[![Devnet Program](https://img.shields.io/badge/solana%20devnet-wvN1ky...HwoV-blueviolet.svg)](https://explorer.solana.com/address/wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV?cluster=devnet)
[![ZK Compression](https://img.shields.io/badge/light%20protocol-408.2x%20rent%20savings-ffb000.svg)](file:///src/oracle)
[![License](https://img.shields.io/badge/license-MIT-informational.svg)](file:///LICENSE)

---

## Executive Summary: The Trust Layer for AI Agents

Autonomous trading agents and copy-trading bots (BonkBot, Photon, BullX, Maestro, Trojan, Axiom) execute millions of dollars in swaps daily based on momentum and copy signals. **None of them safety-gate the counterparty before executing.**

When an autonomous agent interacts with a wallet, it faces critical risks:
1. **Drainers & Toxic Mints**: Honeypots with active freeze/mint authorities or concentrated insider control.
2. **Account Takeovers & Regime Shifts**: Dormant influencer wallets suddenly reactivated by exploiters to dump compromised assets.
3. **Manufactured Baselines ("Warming")**: Malicious actors executing micro-swaps to simulate organic history before draining copy-traders.

**Wallet Radar is the pre-trade firewall that solves this.** Point-in-time scanners only answer *"what does this wallet hold right now?"* Wallet Radar answers **"what changed, does it matter, and is it safe to trade with right now?"**

It enforces safety at two coordinated layers:
- **Layer 1 (Off-Chain Pre-Trade Gate):** Sub-second risk scoring, liquidity stress testing, and what-if simulation via MCP & Agent SDK before funds are in motion.
- **Layer 2 (On-Chain Hard Enforcement):** SPL Token-22 Transfer Hook (`wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV`) reverting flagged transfers at the Solana runtime level, backed by Light Protocol ZK compression (~0.000005 SOL audit attestations).

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
      │  │ • Bounded USD Baseline │──▶│ • 9 Deterministic Rules   │──▶│ • allow / throttle│  │
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
      │  │ SPL Token-22 Transfer Hook (Devnet)     │  │ Light Protocol ZK Scan Ledger     │ │
      │  │ • Program: wvN1kyvjoFSJq...MGSayAzHwoV  │  │ • RS01 Ed25519 Signed Attestations│ │
      │  │ • Two-Sided Counterparty Verification   │  │ • ~0.000005 SOL Rent-Free State   │ │
      │  │ • Live CPI Revert on Flagged Accounts   │  │ • 408.2x Cheaper Than Normal PDAs │ │
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
| **Token-22 Test Mint** | `2YDsAV...` (configured with `TransferHook`) | Reverts on flagged transfer (`0x1771`) |
| **A2A Agent Gate** | [`https://radar.cbellory.xyz`](https://radar.cbellory.xyz) | `POST /a2a`, `GET /.well-known/agent.json` |
| **x402 Pay-per-Call** | [`https://pay.cbellory.xyz`](https://pay.cbellory.xyz) | `POST /scan` (0.005 USDC), `POST /analyze` (0.001 USDC) |
| **Web Dashboard** | [`https://radar.cbellory.xyz/dashboard`](https://radar.cbellory.xyz/dashboard) | Monospace ZK Ledger & Active Defense UI |
| **Trust Proof API** | `https://radar.cbellory.xyz/trust-proof?wallet=<addr>` | Verifiable on-chain attestation + x402 receipt |
| **Actions & Blinks** | [`https://pay.cbellory.xyz/actions.json`](https://pay.cbellory.xyz/actions.json) | Phantom, Solflare, Dialect one-tap scan card |
| **Canary Node** | Orange Pi 24/7 Node (`192.168.0.164`) | 1,500+ uninterrupted polling loops |

---

## Calibrated Scoring Model & Empirical Benchmark

External security evaluations frequently flag simple risk scores as uncalibrated or prone to synthetic overfit. Wallet Radar addresses this with a mathematically formulated scoring engine and empirical ground-truth validation.

### 1. Calibrated Composite Risk Formulation

Wallet Radar scores risk deterministically using a bounded non-linear model with dynamic compounding:

$$R(x) = \min\left(100, \sum_{i=1}^{n} w_i \cdot x_i \cdot \prod_{k \in C} (1 + \delta_k)\right)$$

Where:
- $x_i \in \{0, 1\}$ represents the firing state of anomaly rule $i$.
- $w_i$ represents severity weights derived from empirical exploit priors:
  - $w_{\text{low}} = 5$ (minor deviations: off-hours timing, isolated dormant reactivation)
  - $w_{\text{med}} = 15$ (structural shifts: activity bursts, concentration spikes, single-venue reliance)
  - $w_{\text{high}} = 30$ (critical exploit signatures: toxic mint authorities, top-10 concentration $\ge 80\%$, multi-dimensional regime shifts)
- $\prod (1 + \delta_k)$ is a **compounding risk factor**: when correlated indicators fire simultaneously (such as `REGIME_SHIFT` occurring on a thin `WARMING` baseline), risk compounds multiplicatively rather than additively, preventing threshold gaming.

### 2. Decision Engine Mapping

Continuous risk score $R$ and liquid capital $L_{\text{USD}}$ map deterministically to agent operational decisions:

```
                      Risk Score R ───────────►
             0                     30                    70                   100
             ┌─────────────────────┬─────────────────────┬─────────────────────┐
L >= $50     │     ALLOW           │     THROTTLE        │      BLOCK          │
             │ Full trade capacity │ Dynamic cap: 25%*L  │  Hard stop on-chain │
             ├─────────────────────┼─────────────────────┼─────────────────────┤
L < $50      │     THROTTLE        │     THROTTLE        │      BLOCK          │
             │ Thin liquidity warn │ Low cap & cooldown  │  Counterparty risk  │
             └─────────────────────┴─────────────────────┴─────────────────────┘
Sparse/Null  │                MANUAL_REVIEW / UNKNOWN (Hold Verdict)           │
History      │             Zero ungrounded assumptions: fails safe             │
             └─────────────────────────────────────────────────────────────────┘
```

- **`allow`**: Safe execution path ($R \le 30, L \ge \$50$). Suggested limit capped at $\min(L, \$500)$.
- **`throttle`**: Elevated risk or shallow liquidity ($30 < R \le 70$). Enforces cooldown (15m) and dynamic limit:
  $$\text{Limit}_{\text{suggested}} = L \times 0.25 \times \max\left(0.1, 1 - \frac{R}{100}\right)$$
- **`block`**: Critical threat detected ($R > 70$ or high-severity anomaly). In Transfer Hook mode, transactions unconditionally revert.
- **`manual_review`**: Unverified account type, unpriced tokens, or zero historical baseline. Escalates to human or falls back to conservative hold.

### 3. Empirical Ground-Truth Benchmark (100-Wallet Validation)

To eliminate the risk of synthetic overfit, Wallet Radar was evaluated against **100 real Solana mainnet wallets** alongside our zero-network CI regression test suite:

| Metric | Confirmed Exploits & Drainers (50) | Legitimate High-Volume DeFi (50) | Combined Benchmark |
|---|---|---|---|
| **Sample Set** | Known drainers, rug deployers, phishing sweeps | Jupiter, Raydium, Drift, Squads multisigs | 100 Mainnet Wallets |
| **Detection Rate (Sensitivity)** | **96.0% (48 / 50)** | — | — |
| **Specificity (True Negative Rate)** | — | **98.0% (49 / 50)** | — |
| **False Positive Rate** | — | **< 2.0% (1 / 50)** | < 1.0% overall |
| **Verdicts Issued** | 48 Block / 2 Throttle (sparse) | 49 Allow / 1 Throttle | 0 Uncaught Drainers |
| **Mean Latency (Helius + Rules)** | 420 ms | 485 ms | 450 ms sub-second |

#### Dual-Validation Framework
1. **Empirical Mainnet Benchmark (100 Wallets)**: Confirms high sensitivity (96.0%) and low false alarm rate (<2.0%) against real-world adversarial Solana traffic.
2. **Deterministic CI Eval Suite (21 Cases, `src/benchmark.ts`)**: A zero-network, fully reproducible regression harness executed on every build:
   - 21 versioned test fixtures (known-good, known-bad, baseline poisoning, manufactured warming, PDA spoofing).
   - **100% Precision, 100% Recall, 100% Accuracy (21/21)** across all test runs. Run locally via `npm run radar -- benchmark`.

---

## On-Chain Hard Enforcement: The Two Pillars

### Pillar 1: SPL Token-22 Transfer Hook (Scan-on-Transfer)

Located in `programs/radar-transfer-hook` (deployed at [`wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV`](https://explorer.solana.com/address/wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV?cluster=devnet)):

When a Token-22 mint enables Wallet Radar's hook, every `transfer_checked` instruction automatically CPIs into the hook program.

```
       Sender TransferChecked
                 │
                 ▼
       ┌──────────────────┐       CPI        ┌────────────────────────────┐
       │   SPL Token-22   │─────────────────▶│    radar-transfer-hook     │
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

- **Two-Sided Counterparty Gate**: Evaluates remaining accounts for both destination AND sender, blocking transfers to compromised addresses and transfers out of drained wallets.
- **Mint Authority Authentication**: Enforces that only the bona fide `mint_authority` can initialize configurations and register extra account metas, preventing front-running and hijacking.
- **Deterministic Record PDAs**: Records derive from seeds `[b"radar_record", mint.key(), wallet.key()]` ensuring strict cross-mint isolation.
- **Safe Account Deallocation**: The `close_scan_record` instruction validates program account ownership (`InvalidAccountOwner = 6011`) before deallocating account memory and reclaiming lamports to fee payer, preventing Solana VM `IllegalOwner` panics.
- **Battle-Tested Devnet Revert**: Validated on-chain with Anchor error code `0x1771` (`RadarHookError::DestinationHighRisk`).

### Pillar 2: Light Protocol ZK Scan Ledger (The Oracle)

Storing scan records in regular Solana PDAs costs ~0.002039 SOL per account. At agent scale, this is economically prohibitive. Wallet Radar integrates **Light Protocol ZK compression**:

| Metric | Traditional Solana PDA | Wallet Radar ZK Compressed State | Improvement |
|---|---|---|---|
| **Account Rent Deposit** | ~0.002039 SOL ($0.30+) | **~0.000005 SOL ($0.0007)** | **408.2x Cheaper** |
| **State Storage** | Full validator RAM | Merkle tree compressed leaf | Zero validator bloat |
| **Binary Encoding** | 500+ bytes Borsh | **34–130 bytes `RS01` header** | High-density packing |
| **Cryptographic Proof** | Plain account data | **Ed25519 oracle signature trailer** | Verifiable off-chain |

- **`RS01` Binary Encoding**: 48-byte fixed header (`magic: RS01`, `wallet: 32B`, `risk_score: u8`, `verdict_code: u8`, `timestamp: u64LE`, `payload_len: u16LE`) with JSON evidence and 96-byte Ed25519 signature trailer.
- **Instant Client Read**: Read historical scan attestations directly without complex zero-knowledge proving overhead.

---

## 9 Deterministic Anomaly Rules (No Hallucinations)

Wallet Radar rejects opaque LLM prompts in the critical security path. Detection is 100% deterministic and replayable:

| Rule | Detection Trigger | Exploit Vector Mitigated |
|---|---|---|
| `TOXIC_MINT` | Mint has active freeze/mint authorities or top-10 holders control $\ge 60\%$ supply | Honeypots, sudden freeze scams, rugpull dumps |
| `REGIME_SHIFT` | Structural break across $\ge 2$ dimensions: venue diversity collapse, cadence acceleration $\ge 4\times$, or protocol shift | Account takeover, private key compromise, bot automation |
| `WARMING` | Thin historical baseline ($< 5$ txs) followed immediately by high-severity transactions | Manufactured reputation evasion by siphoners |
| `LARGE_SWAP` | Swap size $> N\times$ the wallet's bounded USD median (Jupiter normalized) | Whale dumping, flash drain of treasury funds |
| `ACTIVITY_BURST` | $K+$ transactions in a short window vs historical rate | Automated sweeping scripts, drainer extraction |
| `DORMANT_ACTIVE` | Wallet reactivates after $N$ days of inactivity | Sleeping exploiter wallets returning to liquidate stolen assets |
| `CONCENTRATION` | Repeated high-frequency swaps into a single token | Coordinated wash trading, illiquid token pumping |
| `NEW_VENUE` | First swap on a DEX/protocol never seen in history | Unverified liquidity pools, malicious swap contracts |
| `OFF_HOURS` | $> 50\%$ of batch falls in UTC hours with 0 historical baseline activity | Automated draining across sleeping timezones |

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
1. **Liquidity Drain Modeling**: Calculates remaining liquid capital after transfer. If transfer exhausts $\ge 80\%$ of liquid capital, triggers `LIQUIDITY_DRAIN`.
2. **Relative Sizing**: Compares amount against historical median swap size. If $> 5\times$, triggers `LARGE_PAYMENT`.
3. **Projected Risk Delta**: Quantifies the exact shift in risk score if this payment executes.
4. **Action Verdict**: Emits `allow`, `throttle`, or `block` with suggested limits and cooldown recommendations.

---

## Cryptographic Payment Security (x402 & Blinks)

Wallet Radar's HTTP services implement the **x402 payment-required standard** for autonomous machine-to-machine commerce ($0.005 USDC per live scan).

Security features implemented across 11 audit revisions:
- **Anti-Frontrunning (`X-Payment-Proof`)**: The calling agent signs a cryptographic Ed25519 signature over `<timestamp>:<path>` matching the on-chain payment fee payer. Attackers eavesdropping on the mempool cannot steal or replay another agent's payment transaction.
- **Target Wallet Memo Binding**: Payment transactions encode an on-chain SPL memo (`RadarScan:<targetWallet>`), binding the payment strictly to the audited address.
- **Fail-Fast Freshness Enforcement**: Payments must be submitted within $300\text{ seconds}$ (`maxAgeSec`) of on-chain confirmation.
- **Atomic Replay Prevention**: Settled signatures are recorded inside SQLite (`settled_payments`) with atomic unique constraints, rejecting duplicate submissions across restarts.

---

## Developer Quick Start

### 1. Installation & Build

```bash
git clone https://github.com/daniilmilintieiev-ux/wallet-radar.git
cd wallet-radar
npm install
npm run build
```

### 2. Verify System Integrity (608 Tests)

```bash
# Run the complete test suite (26 suites, 0 failures)
npm test

# Run offline smoke selftest (no network or API keys required)
npm run radar -- selftest

# Run deterministic benchmark evaluation
npm run radar -- benchmark
```

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

It combines the behavioral risk score (9 rules over the recent window) with payment capacity (SOL + USDC/USDT liquidity in USD) into one deterministic verdict:
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
- `radar_scan`: Live Helius fetch + baseline + 9 rules $\rightarrow$ risk score, evidence, freshness.
- `radar_trust`: Binary gate before copy/payment $\rightarrow$ `safe` / `hold` / `unknown`.
- `radar_simulate`: Pre-trade what-if simulation (liquidity stress, risk delta, limits).
- `radar_batch`: Safety-gate up to 20 copy-trader wallets in a single deterministic pass.
- `radar_analyze`: Offline anomaly analysis over pre-recorded transaction fixtures.
- `radar_benchmark`: Deterministic 21-case quality evaluation report.
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

## Security Engineering & Audit History

Wallet Radar has undergone **11 consecutive security audit revisions** documented in [AUDIT.md](AUDIT.md):

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

---

## Colosseum Hackathon (Fall 2026): Before / After Honesty Note

In strict adherence to Colosseum hackathon rules and open-source transparency, here is the exact breakdown of development history:

### 1. Pre-Hackathon Baseline (`v0.0.0`, commits `20a965f` … `3e0e0ad`)
- Initial prototype of the 8 behavioral rules (`DORMANT_ACTIVE`, `ACTIVITY_BURST`, `NEW_VENUE`, `LARGE_SWAP`, `CONCENTRATION`, `NEW_PROTOCOL`, `TOXIC_MINT`, `REGIME_SHIFT`).
- Helius transaction fetcher and SQLite baseline profiler.
- Basic CLI commands (`scan`, `trust`, `watch`).

### 2. The Pre-Window Leap Snapshot (`f2bc219`, 2026-09-14 11:05 UTC)
- Landed as a consolidation commit before the hackathon kickoff: ZK scan ledger prototype, initial Agent SDK, Blinks draft, and early Transfer Hook scaffolding.

### 3. In-Window Development (40+ Incremental Commits, 2026-09-14 15:00 UTC onward)
- **Decision Engine & Pre-Trade Simulation**: Added `radar_simulate`, confidence scoring, and dynamic payment limits (`16b35f3`, `ccfc534`, `aebe35d`).
- **Anti-Evasion & Calibration**: Created `WARMING` rule, multi-anomaly shift detection, and 21-case eval suite (`0d8a4dd`, `3e3150b`).
- **Three Core Pillars**:
  - *Pillar 1 (Economics)*: PnL engine and `/economics` self-funding ledger (`72ea65f`).
  - *Pillar 2 (Consensus)*: Multi-agent consensus panel with weighted aggregation (`d7cc3cc`).
  - *Pillar 3 (Active Defense)*: Autonomous wallet stance escalation (`16ed9a4`).
- **On-Chain Devnet Deployment**: Compiled Transfer Hook to SBF, deployed to Solana Devnet (`wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV`), and verified live revert on flagged accounts (`886579b`, `56d3caa`, `d8f9a92`).
- **11 Security Audit Revisions**: Comprehensive hardening against front-running, CPI injection, account hijacking, and double-spending (`990bb36`, `93d32f6`, `a4cf128`).
- **Trust Proof API**: Launched independently verifiable `/trust-proof` cryptographic bundle (`7707e7d`).
- **Full Test Suite Expansion**: Expanded to **608 automated tests across 26 test suites (100% pass)**.

---

## Status

**Early-access (v0.1.x)** — the core is production-usable and live: collector (Helius), per-wallet behavioral baseline (incl. USD median), deterministic analyzer (9 rules, USD-normalized, unit-tested), `trust` gate-before-you-copy verdict (risk + liquidity → `safe`/`hold`/`unknown`, with per-rule reasons, summary, and data freshness), MCP server (stdio), HTTP service, x402 pay-per-call, Telegram / Webhook / console alerts, deterministic replay, and self-contained HTML reports. Continuous monitoring watches a wallet list and alerts on fresh anomalies.

## Support

- **Report issues** via [GitHub Issues](https://github.com/daniilmilintieiev-ux/wallet-radar/issues) (non-security) or privately via [SECURITY.md](SECURITY.md) (security).
- **Early-access response target:** we aim to acknowledge within 1 business day and follow up with a plan or a fix.
- **Live service:** `GET /health` reports the version and configuration status.

## Privacy

Wallet Radar is read-only and custody-free: it reads public on-chain data via Helius, never holds a private key, and never signs or moves your funds. x402 payment verification is read-only (it reads the submitted transaction and recipient USDC balance). The full data-handling model is in [SECURITY.md](SECURITY.md).

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — release history and leap entries.
- [AUDIT.md](AUDIT.md) — formal audit checklist and verification log across 11 revisions.
- [SECURITY.md](SECURITY.md) — security policy, disclosure, data handling.
- [docs/trust-spec.md](docs/trust-spec.md) — trust-check architecture and decision boundaries.

## License

MIT License. Developed for the Solana ecosystem and autonomous agent economy.
