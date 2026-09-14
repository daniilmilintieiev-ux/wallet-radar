# Wallet Radar Token-22 Transfer Hook (Scan-on-Transfer)

Autonomous on-chain risk gating for Solana SPL Token-22 transfers.

## Features

- **On-chain Scan Enforcement**: Automatically reads the destination wallet's Radar Scan Ledger record during Token-22 `transfer_checked`.
- **Threshold Gating**: Reverts transfers if the counterparty's risk score exceeds `maxRiskScore` (e.g. 80) or is flagged as `HIGH RISK`.
- **Configurable Freshness**: Rejects stale oracle attestations beyond `maxAttestationAgeSec`.
- **Deterministic Evaluation**: Replicates the exact on-chain Rust rule in TypeScript via `evaluateTransferRisk`.

## Usage

```typescript
import {
  createRiskGatedTransferCheckedInstruction,
  evaluateTransferRisk,
  deriveExtraAccountMetaListPda,
} from "wallet-radar/hook";

// 1. Off-chain pre-flight simulation
const evaluation = evaluateTransferRisk(record, { maxRiskScore: 75 });
if (!evaluation.allowed) {
  throw new Error(`Transfer blocked: ${evaluation.reason}`);
}

// 2. Build on-chain Token-22 transfer instruction with hook accounts
const ix = createRiskGatedTransferCheckedInstruction({
  source: senderAta,
  mint: tokenMint,
  destination: recipientAta,
  owner: senderWallet.publicKey,
  amount: 1_000_000n,
  decimals: 6,
  destinationWallet: recipientWallet.publicKey,
});
```
