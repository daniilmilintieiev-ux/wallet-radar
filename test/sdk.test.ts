import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createRadarClient,
  encodeBase58,
  deriveAssociatedTokenAddress,
  buildSplTransferInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "../src/sdk/index.js";
import { createX402Server, PaymentProof, PaymentRequirement } from "../src/x402server.js";
import { MockZKOracleClient } from "../src/oracle/index.js";
import { Store } from "../src/store.js";
import { USDC_MINT } from "../src/types.js";

function tmpDb(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-sdk-test-"));
  const dbPath = path.join(dir, "test.db");
  const store = new Store(dbPath);
  return { store, dir };
}

function startServer(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const close = () =>
        new Promise<void>((res) => {
          server.close(() => res());
        });
      resolve({ port: addr.port, close });
    });
  });
}

describe("Agent SDK v1 (src/sdk)", () => {
  const targetWallet = "DemoTargetWallet1111111111111111111111111";
  const recipient = "RecipientWallet111111111111111111111111111";
  const payerKeypair = Keypair.generate();

  test("encodeBase58: accurately encodes bytes matching Solana Keypair public keys", () => {
    const kp = Keypair.generate();
    const pubkeyStr = kp.publicKey.toBase58();
    const encoded = encodeBase58(kp.publicKey.toBytes());
    assert.equal(encoded, pubkeyStr);
    assert.equal(encodeBase58(new Uint8Array(0)), "");
  });

  test("deriveAssociatedTokenAddress: computes deterministic ATA", () => {
    const wallet = Keypair.generate().publicKey;
    const ata = deriveAssociatedTokenAddress(wallet);
    assert.ok(ata instanceof PublicKey);
    assert.ok(ata.toBase58().length >= 32);

    // Verify deterministic match
    const [expected] = PublicKey.findProgramAddressSync(
      [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(USDC_MINT).toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    assert.equal(ata.toBase58(), expected.toBase58());
  });

  test("buildSplTransferInstruction: produces well-formed transfer instruction", () => {
    const source = Keypair.generate().publicKey;
    const dest = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const ix = buildSplTransferInstruction(source, dest, owner, 5000);

    assert.equal(ix.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
    assert.equal(ix.keys.length, 3);
    assert.equal(ix.keys[0].pubkey.toBase58(), source.toBase58());
    assert.equal(ix.keys[1].pubkey.toBase58(), dest.toBase58());
    assert.equal(ix.keys[2].pubkey.toBase58(), owner.toBase58());
    assert.equal(ix.data.readUInt8(0), 3); // SPL transfer instruction index 3
    assert.equal(ix.data.readBigUInt64LE(1), 5000n);
  });

  test("createRadarClient: initializes with default and custom configurations", () => {
    const c1 = createRadarClient();
    assert.ok(c1);
    assert.equal(typeof c1.scan, "function");
    assert.equal(typeof c1.analyze, "function");
    assert.equal(typeof c1.selftest, "function");
    assert.equal(typeof c1.readOnchainLedger, "function");

    const c2 = createRadarClient({
      baseUrl: "https://api.example.com/",
      rpc: "https://rpc.example.com",
      x402Payer: payerKeypair,
      recipient,
    });
    assert.ok(c2);
  });

  test("client.selftest(): executes free smoke test over HTTP without payment", async () => {
    const { store, dir } = tmpDb();
    const server = createX402Server({ store, recipient });
    const { port, close } = await startServer(server);

    try {
      const client = createRadarClient({
        baseUrl: `http://127.0.0.1:${port}`,
      });

      const res = await client.selftest();
      assert.equal(res.ok, true);
      assert.equal(typeof res.riskScore, "number");
      assert.ok(Array.isArray(res.anomalies));
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("client.scan(addr): throws if wallet address is missing or invalid", async () => {
    const client = createRadarClient();
    await assert.rejects(
      async () => {
        await client.scan("");
      },
      { message: /wallet address is required/i },
    );
  });

  test("client.scan(addr): throws descriptive error when 402 received without x402Payer configured", async () => {
    const { store, dir } = tmpDb();
    const server = createX402Server({ store, recipient });
    const { port, close } = await startServer(server);

    try {
      const client = createRadarClient({
        baseUrl: `http://127.0.0.1:${port}`,
        // No x402Payer
      });

      await assert.rejects(
        async () => {
          await client.scan(targetWallet);
        },
        { message: /no x402Payer configured/i },
      );
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("client.scan(addr): auto-pays x402 requirement using Keypair and returns scan result", async () => {
    const { store, dir } = tmpDb();
    const mockOracle = new MockZKOracleClient();

    let verifierCalls = 0;
    let lastProofSig = "";
    const stubVerifier = async (proof: PaymentProof, req: PaymentRequirement) => {
      verifierCalls++;
      lastProofSig = proof.signature;
      assert.equal(req.minAmount, 0.005);
      assert.equal(proof.payer, payerKeypair.publicKey.toBase58());
      assert.ok(proof.signature.length > 10);
      return { valid: true, amount: req.minAmount, payer: proof.payer, recipient: req.recipient };
    };

    const stubScan = async (wallet: string) => ({
      wallet,
      riskScore: 25,
      verdict: "LOW RISK",
      anomalies: [
        { type: "NEW_VENUE", wallet, severity: "medium", timestamp: 12345, evidence: {}, text: "new venue" },
      ],
      digest: "Low risk wallet",
      txCount: 8,
    });

    const server = createX402Server({
      store,
      recipient,
      paymentVerifier: stubVerifier,
      scanHandler: stubScan,
      oracleClient: mockOracle,
      enableOracle: true,
    });
    const { port, close } = await startServer(server);

    try {
      const client = createRadarClient({
        baseUrl: `http://127.0.0.1:${port}`,
        x402Payer: payerKeypair,
        recipient,
        oracleClient: mockOracle,
      });

      const result = await client.scan(targetWallet);

      // Verifies exact structure: { riskScore, verdict, evidence, onchainLedgerSig }
      assert.equal(result.wallet, targetWallet);
      assert.equal(result.riskScore, 25);
      assert.equal(result.verdict, "LOW RISK");
      assert.ok(result.evidence, "evidence should be present");
      assert.ok(result.onchainLedgerSig, "onchainLedgerSig should be present");
      assert.ok(result.onchainLedgerSig.startsWith("sig_"));
      assert.equal(verifierCalls, 1, "payment verifier was called once during auto-payment");

      // Verify payment was settled in store ledger
      assert.ok(lastProofSig);
      const settled = store.getSettledPayment(lastProofSig);
      assert.ok(settled, "payment signature must be recorded in store settled ledger");
      assert.equal(settled.payer, payerKeypair.publicKey.toBase58());
      assert.equal(settled.amount, 0.005);
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("client.scan(addr): auto-pays using custom paymentSigner callback", async () => {
    const { store, dir } = tmpDb();
    let signerCalled = 0;

    const customSigner = async (req: { amount: number; recipient: string; token: string }) => {
      signerCalled++;
      assert.equal(req.amount, 0.005);
      assert.equal(req.recipient, recipient);
      return {
        signature: "sig_custom_callback_999",
        payer: "CustomSignerWallet111111111111111111111",
      };
    };

    const stubVerifier = async (proof: PaymentProof, req: PaymentRequirement) => {
      if (proof.signature === "sig_custom_callback_999") {
        return { valid: true, amount: req.minAmount, payer: proof.payer, recipient: req.recipient };
      }
      return { valid: false, error: "Invalid payment proof" };
    };

    const stubScan = async (wallet: string) => ({
      wallet,
      riskScore: 0,
      verdict: "SAFE",
      anomalies: [],
    });

    const server = createX402Server({
      store,
      recipient,
      paymentVerifier: stubVerifier,
      scanHandler: stubScan,
    });
    const { port, close } = await startServer(server);

    try {
      const client = createRadarClient({
        baseUrl: `http://127.0.0.1:${port}`,
        paymentSigner: customSigner,
      });

      const result = await client.scan(targetWallet);
      assert.equal(signerCalled, 1);
      assert.equal(result.riskScore, 0);
      assert.equal(result.verdict, "SAFE");
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("client.scan(addr): falls back to reading on-chain ledger if server does not include onchainLedgerSig", async () => {
    const { store, dir } = tmpDb();
    const mockOracle = new MockZKOracleClient();

    // Pre-record an on-chain ledger attestation in the mock oracle
    await mockOracle.commit({
      wallet: targetWallet,
      riskScore: 60,
      verdict: "SUSPICIOUS",
      timestamp: 1700000000,
      topRules: ["ACTIVITY_BURST"],
      txSignatures: ["sigTxA"],
    });

    const stubVerifier = async (proof: PaymentProof, req: PaymentRequirement) => ({
      valid: true,
      amount: req.minAmount,
      payer: proof.payer,
      recipient: req.recipient,
    });

    // Scan handler that does NOT return onchainLedgerSig
    const stubScan = async (wallet: string) => ({
      wallet,
      riskScore: 60,
      verdict: "SUSPICIOUS",
      anomalies: [],
    });

    const server = createX402Server({
      store,
      recipient,
      paymentVerifier: stubVerifier,
      scanHandler: stubScan,
      enableOracle: false, // Server oracle commit disabled
    });
    const { port, close } = await startServer(server);

    try {
      const client = createRadarClient({
        baseUrl: `http://127.0.0.1:${port}`,
        x402Payer: payerKeypair,
        oracleClient: mockOracle,
      });

      const result = await client.scan(targetWallet);
      assert.equal(result.riskScore, 60);
      assert.equal(result.verdict, "SUSPICIOUS");
      assert.ok(result.onchainLedgerSig, "SDK should read onchain ledger sig when missing from HTTP body");
      assert.ok(result.onchainLedgerSig.startsWith("sig_"));
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("client.analyze(addr, txs): auto-pays and returns analyze result", async () => {
    const { store, dir } = tmpDb();
    const stubVerifier = async (proof: PaymentProof, req: PaymentRequirement) => {
      assert.equal(req.minAmount, 0.001); // 0.001 USDC for /analyze
      return { valid: true, amount: req.minAmount, payer: proof.payer, recipient: req.recipient };
    };

    const server = createX402Server({
      store,
      recipient,
      paymentVerifier: stubVerifier,
    });
    const { port, close } = await startServer(server);

    try {
      const client = createRadarClient({
        baseUrl: `http://127.0.0.1:${port}`,
        x402Payer: payerKeypair,
      });

      const result = await client.analyze(targetWallet, [
        {
          signature: "sig1",
          timestamp: 100,
          source: "JUPITER",
          programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
        },
      ]);

      assert.equal(result.wallet, targetWallet);
      assert.equal(typeof result.riskScore, "number");
      assert.ok(Array.isArray(result.anomalies));
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("client.readOnchainLedger(addr): reads historical attestations from ZK oracle", async () => {
    const mockOracle = new MockZKOracleClient();
    await mockOracle.commit({
      wallet: targetWallet,
      riskScore: 80,
      verdict: "HIGH RISK",
      timestamp: 1700000010,
      topRules: ["LARGE_SWAP"],
      txSignatures: ["sigTx1"],
    });

    const client = createRadarClient({
      oracleClient: mockOracle,
    });

    const records = await client.readOnchainLedger(targetWallet);
    assert.equal(records.length, 1);
    assert.equal(records[0].wallet, targetWallet);
    assert.equal(records[0].riskScore, 80);
    assert.equal(records[0].verdict, "HIGH RISK");
  });

  test("client.scan(addr): handles payment rejection with descriptive error", async () => {
    const { store, dir } = tmpDb();
    const stubVerifier = async () => ({
      valid: false,
      error: "Payer token balance empty",
    });

    const server = createX402Server({
      store,
      recipient,
      paymentVerifier: stubVerifier,
    });
    const { port, close } = await startServer(server);

    try {
      const client = createRadarClient({
        baseUrl: `http://127.0.0.1:${port}`,
        x402Payer: payerKeypair,
      });

      await assert.rejects(
        async () => {
          await client.scan(targetWallet);
        },
        { message: /Payer token balance empty/i },
      );
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
