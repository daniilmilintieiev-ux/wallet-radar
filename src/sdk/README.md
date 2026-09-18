# Agent SDK v1 (`src/sdk`)

The official TypeScript/JavaScript Client SDK for **Wallet Radar**. Enables autonomous AI agents, trading bots, DeFi protocols, and dApps to perform pre-flight wallet risk checks with automated x402 micropayments and on-chain ZK-compressed oracle verification.

## Features

- **Automated x402 Micropayments**: Intercepts HTTP 402 responses, builds/signs Solana USDC micropayment transfer proofs via your Keypair or custom signer, and retries seamlessly.
- **On-chain ZK Oracle Integration**: Automatically retrieves and verifies the on-chain scan attestation signature committed to the Light Protocol state tree.
- **Agent-Ready**: Zero external runtime dependencies beyond `@solana/web3.js`. Fully typed with TypeScript declarations.

## Installation & Import

```typescript
import { createRadarClient } from "./src/sdk/index.js";
import { Keypair, Connection } from "@solana/web3.js";
```

## Quick Start

### 1. Initialize Client

```typescript
// With Solana Keypair for automatic x402 micropayments
const payer = Keypair.fromSecretKey(Uint8Array.from([...]));

const client = createRadarClient({
  baseUrl: "https://pay.cbellory.xyz", // or http://127.0.0.1:4020
  rpc: "https://api.mainnet-beta.solana.com", // or Connection instance
  x402Payer: payer,
  recipient: "RecipientUSDCWalletAddress1111111111111111",
});
```

### 2. Scan a Target Wallet

Calls the x402 server, handles the payment handshake automatically, and reads the on-chain ledger signature:

```typescript
const { riskScore, verdict, evidence, onchainLedgerSig } = await client.scan(
  "TargetWalletAddress1111111111111111111111111111"
);

console.log(`Risk Score: ${riskScore}/100`);
console.log(`Verdict: ${verdict}`); // "SAFE" | "LOW RISK" | "SUSPICIOUS" | "HIGH RISK"
console.log(`Evidence:`, evidence);
console.log(`ZK Attestation Signature: ${onchainLedgerSig}`);
```

### 3. Read Historical On-chain ZK Attestations

Directly inspect historical attestations stored in the ZK-compressed oracle ledger on Solana:

```typescript
const attestations = await client.readOnchainLedger(
  "TargetWalletAddress1111111111111111111111111111",
  5 // limit to latest 5 records
);

for (const attestation of attestations) {
  console.log(`[Slot ${attestation.slot}] Score: ${attestation.riskScore} (${attestation.verdict})`);
  console.log(`Top Rules: ${attestation.topRules.join(", ")}`);
  console.log(`Tx Sig: ${attestation.onchainSignature}`);
}
```

### 4. Offline Analysis Fixtures

Analyze raw transaction fixtures without querying external RPCs:

```typescript
const result = await client.analyze("TargetWalletAddress...", txFixtureArray);
console.log(`Score: ${result.riskScore}, Anomalies: ${result.anomalies.length}`);
```

### 5. Free Service Smoke Test

```typescript
const health = await client.selftest();
console.log(`Radar Engine Status: ${health.ok ? "Ready" : "Offline"}`);
```

## Configuration Options

| Option | Type | Description |
| --- | --- | --- |
| `baseUrl` | `string` | URL of the x402 server (default: `process.env.RADAR_API_URL` or `http://127.0.0.1:4020`) |
| `rpc` | `string \| Connection` | Solana RPC endpoint URL or Connection instance |
| `rpcUrl` | `string` | Synonym for `rpc` when string URL is passed |
| `x402Payer` | `Keypair \| Function \| Object` | Keypair or payment signer for x402 micropayments |
| `recipient` | `string` | Default recipient USDC address (falls back to server's 402 challenge) |
| `paymentSigner` | `Function` | Custom async signer callback `(req) => Promise<{ signature, payer }>` |
| `fetchFn` | `typeof fetch` | Injectable fetch implementation (for testing/mocking) |
| `oracleClient` | `ZKOracleClient` | Injectable Light Protocol ZK client instance |
