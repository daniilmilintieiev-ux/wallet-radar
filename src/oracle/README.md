# Oracle Module (`src/oracle`)

This module provides the on-chain ZK-compressed scan ledger ("the Oracle") for Wallet Radar.

## Architecture

1. **ZK-Compressed Accounts (Light Protocol & Helius)**:
   - Instead of expensive traditional Solana accounts (~0.002 SOL rent per scan), Wallet Radar writes compact scan attestations to ZK-compressed state trees using Light Protocol's Stateless SDK (`@lightprotocol/stateless.js`).
   - Storage cost is reduced by orders of magnitude (~thousands of scans per cent) while maintaining cryptographic verification on Solana L1.

2. **Core Components**:
   - `ledger.ts` (Task 24):
     - `commitScan(scanResult, options)`: serializes scan results (target wallet, risk score, verdict badge, timestamp, firing anomaly rules, recent transaction signatures) into a compressed state leaf.
     - `readScanLedger(wallet, options)`: queries compressed accounts via Helius/Light RPC to retrieve the historical verification trail for any wallet.
   - Scan Path Integration (Task 25):
     - Best-effort hook (`RADAR_ORACLE=1`) triggered after `radar_scan` in the engine, MCP server, and x402 endpoints.

## Implementation Details

- **SDK**: `@lightprotocol/stateless.js` + `@solana/web3.js`
- **RPC Support**: Any Solana RPC with ZK compression methods enabled (e.g. Helius DAS / compression endpoints).
- **Graceful Fallback**: Failure to commit to the on-chain oracle never breaks the live scan loop or off-chain consumers.
