# Wallet Radar Token-22 Transfer Hook (Scan-on-Transfer)

Autonomous on-chain risk gating for Solana SPL Token-22 transfers.

## Features

- **Two-Sided Counterparty Gate**: Evaluates risk scores and verdicts for both the recipient (`destination`) AND sender (`source`) accounts during Token-22 `transfer_checked`.
- **Threshold Gating**: Reverts transfers if either counterparty's risk score exceeds `maxRiskScore` (e.g. 80) or is flagged as `HIGH RISK`.
- **Mint Authority Authentication**: Instructions `initialize` and `initialize_extra_account_meta_list` cryptographically unpack mint data and verify caller matches `mint_authority`, preventing configuration front-running.
- **Safe Memory Deallocation**: `close_scan_record` validates program ownership (`InvalidAccountOwner = 6011`) prior to zeroing memory and reclaiming lamports.
- **Authority Rotation**: `set_authority` instruction enables rotating admin rights or delegating to a multisig/governance PDA.
- **Deterministic Evaluation**: Replicates the exact on-chain Anchor hook rule in TypeScript via `evaluateTransferRisk`.

## Usage

```typescript
import {
  createRiskGatedTransferCheckedInstruction,
  evaluateTransferRisk,
  deriveRadarConfigPda,
  deriveRadarRecordPda,
} from "wallet-radar/hook";

// 1. Off-chain pre-flight simulation
const evaluation = evaluateTransferRisk(record, { maxRiskScore: 75 });
if (!evaluation.allowed) {
  throw new Error(`Transfer blocked: ${evaluation.reason}`);
}

// 2. Build on-chain Token-22 transfer instruction with hook accounts (two-sided)
const ix = createRiskGatedTransferCheckedInstruction({
  source: senderAta,
  mint: tokenMint,
  destination: recipientAta,
  owner: senderWallet.publicKey,
  amount: 1_000_000n,
  decimals: 6,
  destinationWallet: recipientWallet.publicKey,
  sourceWallet: senderWallet.publicKey, // Audit 2.2: passes sender record for two-sided gating
});
```

