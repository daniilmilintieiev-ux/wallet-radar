# Radar Transfer Hook (SPL Token-22 "Scan-on-Transfer")

On-chain SPL Token-22 transfer hook program that enforces real-time risk checks before token transfers are executed.

## Overview

When an SPL Token-22 mint enables the `TransferHook` extension pointing to `radar-transfer-hook`, the Token-22 program automatically CPIs into this hook on every `transfer_checked`.

The hook resolves the destination wallet's **Radar Scan Ledger Record PDA** (`RS01` binary attestation header) and verifies:
1. **Risk Score Gate**: `risk_score <= max_risk_score` (default: 80 / 100).
2. **Verdict Gate**: Destination cannot have an on-chain `HIGH RISK` verdict.
3. **Freshness Gate**: (Optional) Scan attestation must be within `max_attestation_age_sec`.
4. **Policy for Unverified Counterparties**: Configurable `allow_unverified: bool`.

If any check fails, the transfer hook aborts with a descriptive error code (`RiskScoreTooHigh`, `CounterpartyFlagged`, `StaleOracleAttestation`, or `UnverifiedCounterparty`), immediately reverting the transfer before balances can change.

## Architecture

```
User Transfer (transfer_checked)
      │
      ▼
SPL Token-22 Program (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)
      │
      ▼ (CPI Execute)
Radar Transfer Hook Program
      │
      ├──> Read RadarHookConfig PDA ([b"radar_config", mint])
      │
      └──> Read Destination Scan Record PDA ([b"radar_record", dest_wallet])
             │
             ├── Header Magic == "RS01"
             ├── Destination Risk Score <= 80
             └── Verdict != HIGH_RISK
                   │
           ┌───────┴───────┐
         PASS            FAIL
           │               │
     Transfer OK      CPI Revert (Transfer Cancelled)
```

## Compilation & Deployment

```bash
# Build the Solana SBF binary
anchor build

# Deploy to Solana Devnet / Mainnet
solana program deploy target/deploy/radar_transfer_hook.so
```

## Initializing for an SPL Token-22 Mint

1. Create a Token-22 mint with the transfer hook extension:
```bash
spl-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  create-token --transfer-hook wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV
```

2. Initialize the transfer hook configuration and extra account metas:
```typescript
import { buildInitializeExtraAccountMetaListInstruction } from "wallet-radar/hook";

const ix = buildInitializeExtraAccountMetaListInstruction({
  mint,
  authority: wallet.publicKey,
  maxRiskScore: 75,
  allowUnverified: true,
});
await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
```
