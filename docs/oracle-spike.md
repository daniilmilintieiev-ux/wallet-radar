# Oracle & Blinks Technical Spike (Colosseum Hackathon Foundation)

**Document**: Research & Architecture Spike for Batch 3 (Tasks 23–28)  
**Date**: 2026-09-13  
**Status**: Ready for In-Window Implementation (Sep 14 11:00 UTC kickoff)

---

## 1. Executive Summary & Value Proposition

Wallet Radar monitors Solana wallets for behavioral anomalies, rug pulls, and counterparty risks. For the Colosseum Hackathon (Sep 14 – Oct 13), we bridge off-chain risk intelligence to on-chain composability through two Solana primitives:

1. **The Oracle via ZK Compression (Light Protocol + Helius)**:
   - An on-chain attestation ledger recording every completed wallet scan (`riskScore`, `verdict`, timestamp, firing rules, tx signatures).
   - **Why ZK Compression?** Regular Solana PDA account creation costs ~0.002039 SOL (~$0.30) for 100 bytes of rent-exempt storage. Continuous scanning of thousands of wallets would cost thousands of dollars in rent. With Light Protocol ZK compression, state accounts are stored off-chain in indexed Merkle trees with cryptographic root proofs on L1, reducing account cost to ~0.000005 SOL per scan (~400x cheaper).
2. **Solana Actions & Blinks (Dialect + @solana/actions)**:
   - Exposes one-tap risk scans across Twitter/X feeds, Discord, Telegram, and Phantom/Solflare wallet extensions.
   - Interacts seamlessly with our x402 micro-payment protocol to monetize queries on-chain.
3. **Agent SDK (`@sendaifun/wallet-radar-sdk`)**:
   - Programmatic TypeScript client allowing AI agents, trading bots, and AMMs to run pre-flight trust checks before executing transactions.

---

## 2. ZK Compression Architecture & Exact APIs

### 2.1 Dependencies & Versions
- `@lightprotocol/stateless.js`: `^0.23.3`
- `@solana/web3.js`: `^1.99.0`
- `@lightprotocol/compressed-token`: Optional helper for token state.

### 2.2 RPC Connection & Infrastructure
Light Protocol utilizes standard Solana JSON-RPC endpoints augmented with ZK Compression methods (`getCompressedAccount`, `getCompressedAccountsByOwner`, `getValidityProof`, etc.). On Helius RPC, compression methods are natively available at the primary endpoint URL.

```typescript
import { createRpc, Rpc } from "@lightprotocol/stateless.js";

// Initialize RPC client with Helius endpoint supporting compression
export function getCompressionRpc(endpoint: string): Rpc {
  return createRpc(endpoint, endpoint);
}
```

### 2.3 On-chain Scan Ledger Record Schema
The attestation data is packed into a compact binary buffer or serialized Borsh layout:

```typescript
export interface ScanLedgerRecord {
  /** Target wallet address scanned (32-byte Pubkey base58) */
  wallet: string;
  /** Risk score 0-100 (1 byte uint8) */
  riskScore: number;
  /** Verdict code: 0 = SAFE, 1 = LOW RISK, 2 = SUSPICIOUS, 3 = HIGH RISK (1 byte uint8) */
  verdict: "SAFE" | "LOW RISK" | "SUSPICIOUS" | "HIGH RISK";
  /** Evaluation timestamp (8 bytes uint64 LE) */
  timestamp: number;
  /** Encoded bitfield or short string array of fired anomaly rule IDs */
  topRules: string[];
  /** Latest evaluated Solana transaction signatures (array of base58 strings) */
  txSignatures: string[];
}
```

### 2.4 Writing Compressed Scan Attestations (`commitScan`)

Creating and writing a compressed account on Solana using `@lightprotocol/stateless.js`:

```typescript
import {
  LightSystemProgram,
  Rpc,
  confirmTx,
  buildAndSignTx,
  deriveAddressSeed,
  deriveAddress,
} from "@lightprotocol/stateless.js";
import { Keypair, PublicKey } from "@solana/web3.js";

export async function commitScanToLedger(
  rpc: Rpc,
  payer: Keypair,
  oracleProgramId: PublicKey,
  record: ScanLedgerRecord,
): Promise<string> {
  // 1. Derive deterministic seed and compressed PDA address
  const targetWalletPubkey = new PublicKey(record.wallet);
  const seed = deriveAddressSeed(
    [Buffer.from("radar-scan"), targetWalletPubkey.toBuffer()],
    oracleProgramId,
  );
  
  // 2. Query default address tree and derive address
  const addressTree = await rpc.getDefaultAddressTreeInfo();
  const compressedAddress = deriveAddress(seed, addressTree.tree, oracleProgramId);

  // 3. Serialize record into payload buffer
  const payloadData = serializeScanRecord(record);

  // 4. Retrieve state tree info and validity proofs from RPC
  const stateTreeInfos = await rpc.getStateTreeInfos();
  const validityProof = await rpc.getValidityProof([]);

  // 5. Construct instruction via LightSystemProgram
  const ix = await LightSystemProgram.createAccount({
    payer: payer.publicKey,
    newAddressParams: {
      seed,
      addressMerkleTreeRootIndex: addressTree.rootIndex,
      addressMerkleTreePubkey: addressTree.tree,
      addressQueuePubkey: addressTree.queue,
    },
    newAddress: compressedAddress,
    recentValidityProof: validityProof,
    outputStateTreeInfo: stateTreeInfos[0],
    lamports: 0, // Rent-free compressed state
  });

  // 6. Build, sign, and submit transaction
  const tx = await buildAndSignTx([ix], payer, await rpc.getLatestBlockhash());
  const txSig = await rpc.sendTransaction(tx);
  await rpc.confirmTransactionIndexed(txSig);

  return txSig;
}
```

### 2.5 Reading Back Compressed Accounts (`readScanLedger`)

Historical scan attestations are queried from the RPC indexer:

```typescript
export async function readScanLedger(
  rpc: Rpc,
  oracleProgramId: PublicKey,
  targetWallet: string,
  limit: number = 10,
): Promise<ScanLedgerRecord[]> {
  // Query all compressed accounts owned by the oracle program
  const result = await rpc.getCompressedAccountsByOwner(oracleProgramId, {
    limit,
  });

  const records: ScanLedgerRecord[] = [];
  for (const account of result.items) {
    if (!account.data) continue;
    const parsed = deserializeScanRecord(account.data);
    if (parsed.wallet === targetWallet) {
      records.push(parsed);
    }
  }

  // Sort descending by timestamp (newest first)
  return records.sort((a, b) => b.timestamp - a.timestamp);
}
```

### 2.6 Unit Testing & Stubbing Strategy
For deterministic tests in CI/CD without active network requests or devnet SOL:
- Create an injectable `OracleClient` interface with `commitScan` and `readScanLedger`.
- Implement `MockOracleClient` backed by an in-memory Map of compressed account records.
- Assert serialization/deserialization byte layouts and error recovery when the RPC returns network errors.

---

## 3. Solana Actions & Blinks Architecture & Exact APIs

### 3.1 Dependencies & Specifications
- `@solana/actions`: `^1.6.6`
- Supported clients: Dialect Blinks, Phantom, Solflare, Backpack, Twitter/X inline cards.

### 3.2 CORS Headers
Every Action endpoint MUST respond to CORS pre-flight (`OPTIONS`) with `ACTIONS_CORS_HEADERS`:
```typescript
import { ACTIONS_CORS_HEADERS } from "@solana/actions";

// Exposed headers:
// 'Access-Control-Allow-Origin': '*'
// 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'
// 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids'
// 'Access-Control-Expose-Headers': 'X-Action-Version, X-Blockchain-Ids'
```

### 3.3 GET Handler (`/api/actions/radar-scan`)
Returns metadata describing the action and parameter inputs:

```typescript
import { ActionGetResponse } from "@solana/actions";

export function handleGetRadarScanAction(): ActionGetResponse {
  return {
    type: "action",
    icon: "https://wallet-radar.app/radar-icon-512.png",
    title: "Wallet Radar Security Scan",
    description: "Instant behavioral anomaly detection and risk scoring for Solana wallets.",
    label: "Scan Wallet",
    links: {
      actions: [
        {
          label: "Run Radar Scan",
          href: "/api/actions/radar-scan?wallet={wallet}",
          parameters: [
            {
              name: "wallet",
              label: "Solana Wallet Address to audit",
              required: true,
            },
          ],
        },
      ],
    },
  };
}
```

### 3.4 POST Handler (`/api/actions/radar-scan`)
Receives the user's connected wallet address, verifies parameters, builds the transaction, and returns the serialized transaction via `createPostResponse`:

```typescript
import { createPostResponse, ActionPostResponse } from "@solana/actions";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

export async function handlePostRadarScanAction(
  connection: Connection,
  userPubkey: PublicKey,
  targetWallet: string,
): Promise<ActionPostResponse> {
  // 1. Build payment instruction (e.g. 0.005 USDC transfer or memo check)
  const tx = new Transaction();
  
  // Memo attestation instruction linking user request to target wallet
  tx.add(
    new TransactionInstruction({
      keys: [{ pubkey: userPubkey, isSigner: true, isWritable: true }],
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      data: Buffer.from(`RadarScan:${targetWallet}`, "utf-8"),
    }),
  );

  tx.feePayer = userPubkey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  // 2. Package response using @solana/actions helper
  return await createPostResponse({
    fields: {
      transaction: tx,
      message: `Audit request initiated for ${targetWallet.slice(0, 4)}...${targetWallet.slice(-4)}`,
    },
  });
}
```

### 3.5 Action Discovery (`/actions.json`)
The standard mapping hosted at the root of the server:

```json
{
  "rules": [
    {
      "pathPattern": "/scan/*",
      "apiPath": "/api/actions/radar-scan?wallet=*"
    },
    {
      "pathPattern": "/api/actions/**",
      "apiPath": "/api/actions/**"
    }
  ]
}
```

### 3.6 Dialect Blinks URL Formatting
Users can share Blinks on social media via the Dialect proxy:
`https://dial.to/?action=solana-action:https://wallet-radar.app/api/actions/radar-scan`

---

## 4. Agent SDK Integration Architecture (`src/sdk`)

The SDK provides client ergonomics for AI agents to scan counterparties and handle payments automatically:

```typescript
export interface RadarClientConfig {
  baseUrl?: string;
  rpcUrl?: string;
  x402PayerKeypair?: Keypair;
}

export class RadarClient {
  constructor(private config: RadarClientConfig) {}

  async scan(targetWallet: string): Promise<ScanResult> {
    // 1. Request scan from x402 endpoint
    // 2. If 402 received, assemble USDC micro-payment signature
    // 3. Resend with Authorization proof header
    // 4. Optionally query on-chain ZK ledger for verification proof
  }

  async readOracleHistory(targetWallet: string): Promise<ScanLedgerRecord[]> {
    // Direct RPC query to Light Protocol compressed accounts
  }
}
```

---

## 5. Execution Roadmap for Hackathon Window

| Task | Title | Focus | Target Commits |
|---|---|---|---|
| **23** | **Prep & Toolchain Scaffold** *(Completed)* | Clean tree, install SDKs, scaffold dirs, write spike doc | Pre-window |
| **24** | **ZK Scan Ledger v1** | `src/oracle/ledger.ts`, Borsh schema, unit tests with mocked Light SDK | In-window (Sep 14) |
| **25** | **Wire Oracle into Scan Path** | Hook into `radar_scan`, MCP server, x402 endpoints (`RADAR_ORACLE=1`) | In-window |
| **26** | **Agent SDK v1** | `src/sdk/index.ts`, standalone client, auto-pay, tests | In-window |
| **27** | **Solana Action & Blink** | `src/blink/`, action handlers, `/actions.json`, deep links | In-window |
| **28** | **Dashboard Scaffold** | Lightweight browser dashboard visualizing on-chain scan ledgers | In-window |
| **29** | **Token-22 Transfer Hook** *(Stretch)* | On-chain transfer hook calling the oracle | In-window |
| **30** | **E2E & Hackathon Release** | Full integration flow, README update, demo video shot list | In-window |

---
