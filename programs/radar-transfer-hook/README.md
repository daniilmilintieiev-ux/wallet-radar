# Radar Transfer Hook (SPL Token-22 "Scan-on-Transfer")

On-chain SPL Token-22 transfer hook program that enforces real-time risk checks before token transfers are executed.

## Overview

When an SPL Token-22 mint enables the `TransferHook` extension pointing to `radar-transfer-hook`, the Token-22 program automatically CPIs into this hook on every `transfer_checked`.

The hook resolves the **Radar Scan Ledger Record PDAs** for both the destination AND source wallets (`RS01` binary attestation header with seeds `[b"radar_record", mint, wallet]`) and verifies:
1. **Two-Sided Counterparty Gate**: Evaluates risk scores and verdicts for both the recipient AND sender accounts.
2. **Risk Score Gate**: `risk_score <= max_risk_score` (default: 80 / 100).
3. **Verdict Gate**: Neither counterparty can have an on-chain `HIGH RISK` verdict.
4. **Freshness Gate**: (Optional) Scan attestations must be within `max_attestation_age_sec`.
5. **Policy for Unverified Counterparties**: Configurable `allow_unverified: bool`.
6. **Mint Authority Authentication**: Instructions `initialize` and `initialize_extra_account_meta_list` enforce `mint_authority` signature, preventing front-running and hijacking.
7. **Safe Memory Management**: `close_scan_record` verifies program account ownership (`InvalidAccountOwner = 6011`) before deallocating memory and reclaiming rent lamports.

If any check fails, the transfer hook aborts with a descriptive error code (`RiskScoreTooHigh`, `CounterpartyFlagged`, `StaleOracleAttestation`, `UnverifiedCounterparty`, `Unauthorized`, or `InvalidAccountOwner`), immediately reverting the transfer before balances can change.

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
      ├──> Read Source Scan Record PDA ([b"radar_record", mint, src_wallet])
      │      └── Validate Sender Risk & Freshness
      │
      └──> Read Destination Scan Record PDA ([b"radar_record", mint, dest_wallet])
             │
             ├── Header Magic == "RS01"
             ├── Destination Risk Score <= max_risk_score
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
import {
  buildInitializeExtraAccountMetaListInstruction,
  buildUpdateExtraAccountMetaListInstruction,
} from "wallet-radar/hook";

const ix = buildInitializeExtraAccountMetaListInstruction({
  mint,
  authority: wallet.publicKey,
  maxRiskScore: 75,
  allowUnverified: true,
});
await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);

// 3. Update extra account metas on an existing mint (Anchor discriminator: 2c7d8de261b3a660)
const updateIx = buildUpdateExtraAccountMetaListInstruction({
  mint,
  authority: wallet.publicKey,
});
await sendAndConfirmTransaction(connection, new Transaction().add(updateIx), [wallet]);
```

