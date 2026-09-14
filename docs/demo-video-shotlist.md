# Wallet Radar — Hackathon Demo Video Shot List & Script

**Duration**: 90 seconds  
**Resolution**: 1080p (1920x1080) @ 60fps  
**Format**: Live terminal capture, browser screen recordings, and crisp monospace overlay graphics.  
**Tagline**: *History is the only receipt.*

---

## Shot-by-Shot Script

### Scene 1: The Problem — Blind Execution on Solana
- **Timecode**: `00:00 - 00:12` (12s)
- **Visual**:
  - Fast-paced visual of Telegram copy-trading bots (BonkBot, Trojan, Maestro) firing automated buy/copy orders.
  - Red alert flashes: Copying an unverified wallet that suddenly awakens after 180 days of dormancy, executes a 15x swap, and pulls liquidity.
- **Voiceover**:
  > *"Solana copy-trading bots and AI agents move fast — but they move blind. Every day, agents copy wallets or accept payments without verifying behavioral risk. Point-in-time checks miss the pattern: What changed, and does it matter?"*
- **On-Screen Text**:
  - `WALLET RADAR · The Gate Before You Copy`

---

### Scene 2: The Solution — Solana Actions & One-Tap Blinks
- **Timecode**: `00:12 - 00:26` (14s)
- **Visual**:
  - Screen recording on Twitter/X and Dialect (`dial.to`). A user drops a Wallet Radar Blink URL.
  - The URL unfolds into an interactive Solana Action card.
  - Target address is entered. One tap clicks **"Run Radar Scan (0.005 USDC)"**.
  - Phantom wallet prompt pops up with the audit memo + 0.005 USDC micropayment.
  - Instant verdict rendered in-place: **Score: 85/100 · Verdict: HIGH RISK · Rules: DORMANT_ACTIVE, LARGE_SWAP**.
- **Voiceover**:
  > *"Introducing Wallet Radar. First, we turn wallet audits into Solana Actions and Blinks. Any human or agent can audit any Solana address with one tap directly inside Dialect, Twitter, Phantom, or Solflare."*
- **On-Screen Text**:
  - `Solana Actions & Blinks (src/blink)`
  - `GET /actions.json · 1-Tap Audit Memo + x402 Micropayment`

---

### Scene 3: Autonomous Agent SDK & x402 Protocol
- **Timecode**: `00:26 - 00:42` (16s)
- **Visual**:
  - Split screen: TypeScript code on left, live terminal logs on right.
  - Code snippet:
    ```typescript
    import { createRadarClient } from "wallet-radar/sdk";
    const client = createRadarClient({ x402Payer: agentKeypair });
    const result = await client.scan(counterparty);
    ```
  - Terminal runs script: Server returns `402 Payment Required` with USDC invoice.
  - Client auto-signs and submits 0.005 USDC on-chain transaction.
  - Server verifies on-chain transfer, settles signature in SQLite, executes scan, and returns verdict with `onchainLedgerSig`.
- **Voiceover**:
  > *"For AI agents, Radar speaks the x402 payment protocol natively. Using our Agent SDK, autonomous trading agents automatically handle 402 micropayments, verify counterparties, and receive tamper-evident receipts."*
- **On-Screen Text**:
  - `Agent SDK v1 (src/sdk) · Native x402 Pay-per-Call`

---

### Scene 4: The ZK Scan Ledger (On-chain Oracle)
- **Timecode**: `00:42 - 00:56` (14s)
- **Visual**:
  - Light Protocol state tree diagram animating a compressed PDA write.
  - Terminal shows:
    ```bash
    node dist/src/cli.js ledger <wallet>
    ```
  - Terminal displays table with `SLOT`, `SCORE`, `VERDICT`, `RULES FIRED`, and `TX SIGNATURE`.
  - Solana Explorer tab opens showing the compressed transaction signature and rent-free compressed account state.
- **Voiceover**:
  > *"Every scan is permanently committed to Solana using Light Protocol ZK compression. At ~0.000005 SOL per attestation — four hundred times cheaper than regular accounts — Radar turns risk intelligence into an immutable, on-chain oracle."*
- **On-Screen Text**:
  - `Light Protocol ZK Compression (src/oracle)`
  - `~0.000005 SOL Rent-Free Attestations · 400x Cost Reduction`

---

### Scene 5: Web Dashboard & Historical Timeline
- **Timecode**: `00:56 - 01:10` (14s)
- **Visual**:
  - Browser displays `http://localhost:8080/dashboard?wallet=<address>`.
  - Dark terminal theme: Monospace hero card displaying `Score: 85/100`, red `HIGH RISK` badge, compressed PDA, and clickable Solana Explorer transaction link.
  - Interactive watchlist chips filtering monitored wallets.
  - Historical timeline table displaying past scans over time to prove behavioral drift.
- **Voiceover**:
  > *"Our self-contained web dashboard and JSON API let anyone inspect a wallet's risk history over time. Zero external CDNs, deterministic HTML, and live watchlist quick-filtering."*
- **On-Screen Text**:
  - `Web Dashboard & Ledger API (src/dashboard)`
  - `Zero CDN Dependencies · Factual & Deterministic`

---

### Scene 6: Token-22 Transfer Hook ("Scan-on-Transfer")
- **Timecode**: `01:10 - 01:24` (14s)
- **Visual**:
  - Anchor Rust program code (`programs/radar-transfer-hook/src/lib.rs`).
  - Terminal executes a simulated Token-22 `transfer_checked` to the flagged address.
  - Transaction immediately reverts on-chain:
    ```
    Program Error: Custom(6000) - Destination wallet risk score exceeds maximum allowed threshold
    ```
  - Safe transfer to a clean address executes with confirmation.
- **Voiceover**:
  > *"And with SPL Token-22, Radar enforces safety at the protocol layer. Our transfer hook inspects the destination's on-chain oracle attestation during transfer_checked — automatically blocking transfers to drainers and sanctioned counterparties."*
- **On-Screen Text**:
  - `SPL Token-22 Transfer Hook (programs/radar-transfer-hook)`
  - `Scan-on-Transfer · Autonomous Protocol Risk Gating`

---

### Scene 7: Wrap-up & Call to Action
- **Timecode**: `01:24 - 01:30` (6s)
- **Visual**:
  - Clean animated title card:
    - **WALLET RADAR**
    - `Autonomous Risk Intelligence for Solana AI Agents`
    - `ZK Oracle · Agent SDK · Blinks · Dashboard · Token-22 Hook`
    - `github.com/sendaifun/wallet-radar`
    - *Colosseum Hackathon — Fall 2026*
- **Voiceover**:
  > *"Wallet Radar: Continuous monitoring, on-chain attestations, and the gate before you copy. Because history is the only receipt."*

---

## Production Checklist & Asset Mapping

| Scene | Required Assets | Status |
|---|---|---|
| Scene 1 | Bot trading screen captures, alert notification mockup | Ready (`docs/videos`, `docs/posters`) |
| Scene 2 | Dialect Blinks demo (`dial.to`), Phantom prompt | Ready (`src/blink/index.ts`, `test/blink.test.ts`) |
| Scene 3 | Agent SDK TypeScript demo, x402 402/200 flow | Ready (`src/sdk/index.ts`, `test/sdk.test.ts`) |
| Scene 4 | Light Protocol ZK compression CLI ledger table | Ready (`src/oracle/ledger.ts`, `src/cli.ts`) |
| Scene 5 | `/dashboard` browser screen capture | Ready (`src/dashboard.ts`, `test/dashboard.test.ts`) |
| Scene 6 | Anchor Token-22 Transfer Hook revert capture | Ready (`programs/radar-transfer-hook`, `test/hook.test.ts`) |
| Scene 7 | Title card graphic with GitHub repository link | Ready (`docs/posters`, `README.md`) |
