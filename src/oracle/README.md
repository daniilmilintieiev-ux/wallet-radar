# Oracle Module (`src/oracle`)

This module provides the on-chain ZK-compressed scan ledger ("the Oracle") for Wallet Radar.

## Architecture

1. **Dual Attestation Pipeline**:
   - **Canonical ZK-Compressed State (Light Protocol & Helius)**: Instead of expensive traditional Solana accounts (~0.002 SOL rent per scan), Wallet Radar writes compact scan attestations to ZK-compressed state trees using Light Protocol's Stateless SDK (`@lightprotocol/stateless.js`). Storage cost is reduced by ~400× (~0.000005 SOL per attestation) while maintaining cryptographic verification on Solana L1.
   - **Verifiable SPL Memo Anchors**: Anchors signed `RS01` payloads on-chain via the SPL Memo Program with target wallet address indexing, allowing standard Solana RPCs to retrieve and verify attestations without a compression indexer.

2. **Compact Binary Encoding (`RS01`)**:
   - Fixed 48-byte zero-copy header: `magic: RS01` (4B), `wallet` (32B), `risk_score` (1B), `verdict_code` (1B), `timestamp` (8B), `payload_len` (2B).
   - JSON evidence payload: firing anomaly rules and triggering transaction signatures.
   - 96-byte Ed25519 cryptographic signature trailer (`oraclePublicKey` + `signature`) via `@noble/curves/ed25519`, preventing spoofing and unauthenticated tampering.

3. **Core API**:
   - `commitScan(scanResult, options)`: Commits signed scan attestation to Light Protocol ZK compression and anchors on-chain.
   - `readScanLedger(wallet, options)`: Reads, deserializes, and cryptographically verifies historical attestation timeline for any wallet.
   - `signAttestation(record, payer)` / `verifyAttestation(record, oraclePk)`: Cryptographic attestation signing and verification.

4. **Reliability & Performance**:
   - **Solana v0 Transaction Support**: Decodes versioned transaction responses across `staticAccountKeys`, address table lookups, `compiledInstructions`, and `Uint8Array` data buffers.
   - **Fast-Fail Indexer Polling**: Instantly detects standard Solana RPCs lacking Light Protocol compression indexers (`Method not found`, `-32601`, `404`) and cleanly falls back to memo anchors without 15-second polling hangs.
   - **Asynchronous Commitment**: Supports background anchoring via `Prefer: respond-async` HTTP header or `RADAR_ASYNC_COMMIT=1`.

