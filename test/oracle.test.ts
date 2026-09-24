import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  ScanLedgerRecord,
  serializeScanRecord,
  deserializeScanRecord,
  SCAN_RECORD_MAGIC,
  MockZKOracleClient,
  LightZKOracleClient,
  DEFAULT_ORACLE_PROGRAM_ID,
  loadPayerFromEnv,
  commitScan,
  readScanLedger,
  signAttestation,
  verifyAttestation,
  buildAttestationDigest,
} from "../src/oracle/index.js";

describe("ZK scan ledger oracle", () => {
  const testKp = Keypair.generate();
  const testWallet = testKp.publicKey.toBase58();

  test("serializeScanRecord and deserializeScanRecord: roundtrip with standard Solana address", () => {
    const record: ScanLedgerRecord = {
      wallet: testWallet,
      riskScore: 75,
      verdict: "HIGH RISK",
      timestamp: 1726261234,
      topRules: ["DORMANT_ACTIVE", "LARGE_SWAP", "NEW_VENUE"],
      txSignatures: ["txSig1111111111111111111111111111111111111111111111111111111111111111", "txSig2"],
    };

    const buf = serializeScanRecord(record);
    assert.ok(buf instanceof Buffer);
    assert.ok(buf.length >= 48, "buffer must have at least 48 bytes header");
    assert.deepEqual(buf.subarray(0, 4), SCAN_RECORD_MAGIC);

    const parsed = deserializeScanRecord(buf);
    assert.equal(parsed.wallet, record.wallet);
    assert.equal(parsed.riskScore, 75);
    assert.equal(parsed.verdict, "HIGH RISK");
    assert.equal(parsed.timestamp, 1726261234);
    assert.deepEqual(parsed.topRules, record.topRules);
    assert.deepEqual(parsed.txSignatures, record.txSignatures);
  });

  test("serializeScanRecord: clamps riskScore and normalizes millisecond timestamp", () => {
    const recordUnder: ScanLedgerRecord = {
      wallet: testWallet,
      riskScore: -15,
      verdict: "SAFE",
      timestamp: 1726261234000, // ms timestamp
      topRules: [],
      txSignatures: [],
    };
    const parsedUnder = deserializeScanRecord(serializeScanRecord(recordUnder));
    assert.equal(parsedUnder.riskScore, 0);
    assert.equal(parsedUnder.timestamp, 1726261234);

    const recordOver: ScanLedgerRecord = {
      wallet: testWallet,
      riskScore: 120,
      verdict: "SAFE",
      timestamp: 1726261234,
      topRules: [],
      txSignatures: [],
    };
    const parsedOver = deserializeScanRecord(serializeScanRecord(recordOver));
    assert.equal(parsedOver.riskScore, 100);
  });

  test("serializeScanRecord: handles all verdict types and custom verdict strings", () => {
    const verdicts: Array<ScanLedgerRecord["verdict"]> = [
      "SAFE",
      "LOW RISK",
      "SUSPICIOUS",
      "HIGH RISK",
      "CUSTOM_FLAGGED",
    ];

    for (const v of verdicts) {
      const rec: ScanLedgerRecord = {
        wallet: testWallet,
        riskScore: 50,
        verdict: v,
        timestamp: 1726260000,
        topRules: ["RULE_A"],
        txSignatures: ["sigA"],
      };
      const parsed = deserializeScanRecord(serializeScanRecord(rec));
      assert.equal(parsed.verdict, v);
    }
  });

  test("serializeScanRecord: handles non-base58 synthetic test addresses via payload fallback", () => {
    const syntheticWallet = "synthetic-test-wallet-abc-123";
    const record: ScanLedgerRecord = {
      wallet: syntheticWallet,
      riskScore: 30,
      verdict: "LOW RISK",
      timestamp: 1726260000,
      topRules: ["NEW_PROTOCOL"],
      txSignatures: ["sigX"],
    };

    const buf = serializeScanRecord(record);
    const parsed = deserializeScanRecord(buf);
    assert.equal(parsed.wallet, syntheticWallet);
    assert.equal(parsed.riskScore, 30);
    assert.equal(parsed.verdict, "LOW RISK");
  });

  test("deserializeScanRecord: handles legacy/plain JSON string buffers", () => {
    const jsonRecord = {
      wallet: testWallet,
      riskScore: 90,
      verdict: "HIGH RISK",
      timestamp: 1726265000,
      topRules: ["TOXIC_MINT"],
      txSignatures: ["sig99"],
      onchainSignature: "onchainSig123",
      slot: 123456,
      compressedAddress: "addrXYZ",
    };
    const buf = Buffer.from(JSON.stringify(jsonRecord), "utf-8");
    const parsed = deserializeScanRecord(buf);
    assert.equal(parsed.wallet, testWallet);
    assert.equal(parsed.riskScore, 90);
    assert.equal(parsed.verdict, "HIGH RISK");
    assert.equal(parsed.onchainSignature, "onchainSig123");
    assert.equal(parsed.slot, 123456);
  });

  test("deserializeScanRecord: throws on invalid garbage buffer", () => {
    const garbage = Buffer.from("invalid-random-bytes-not-json-or-rs01");
    assert.throws(() => deserializeScanRecord(garbage), /missing RS01 magic header/);
  });

  test("MockZKOracleClient: commit, query, ordering, filtering, and limits", async () => {
    const mock = new MockZKOracleClient();
    const wallet1 = testWallet;
    const wallet2 = Keypair.generate().publicKey.toBase58();

    // Commit 3 records for wallet1 at different timestamps
    const res1 = await mock.commit({
      wallet: wallet1,
      riskScore: 10,
      verdict: "SAFE",
      timestamp: 1000,
      topRules: [],
      txSignatures: ["sig1"],
    });
    assert.ok(res1.signature.startsWith("sig_"));
    assert.ok(res1.compressedAddress.startsWith("comp_"));
    assert.equal(res1.slot, 300_000_001);

    const res2 = await mock.commit({
      wallet: wallet1,
      riskScore: 50,
      verdict: "SUSPICIOUS",
      timestamp: 2000,
      topRules: ["ACTIVITY_BURST"],
      txSignatures: ["sig2"],
    });
    assert.equal(res2.slot, 300_000_002);

    const res3 = await mock.commit({
      wallet: wallet1,
      riskScore: 90,
      verdict: "HIGH RISK",
      timestamp: 3000,
      topRules: ["TOXIC_MINT"],
      txSignatures: ["sig3"],
    });
    assert.equal(res3.slot, 300_000_003);

    // Commit 1 record for wallet2
    await mock.commit({
      wallet: wallet2,
      riskScore: 0,
      verdict: "SAFE",
      timestamp: 1500,
      topRules: [],
      txSignatures: ["sigW2"],
    });

    // Query wallet1: should return all 3, newest first (3000 -> 2000 -> 1000)
    const recordsW1 = await mock.query(wallet1);
    assert.equal(recordsW1.length, 3);
    assert.equal(recordsW1[0].timestamp, 3000);
    assert.equal(recordsW1[1].timestamp, 2000);
    assert.equal(recordsW1[2].timestamp, 1000);
    assert.equal(recordsW1[0].riskScore, 90);
    assert.equal(recordsW1[0].onchainSignature, res3.signature);

    // Query wallet1 with limit 2
    const limited = await mock.query(wallet1, 2);
    assert.equal(limited.length, 2);
    assert.equal(limited[0].timestamp, 3000);
    assert.equal(limited[1].timestamp, 2000);

    // Query wallet2
    const recordsW2 = await mock.query(wallet2);
    assert.equal(recordsW2.length, 1);
    assert.equal(recordsW2[0].wallet, wallet2);

    // Query unknown wallet
    const empty = await mock.query("unknown-wallet");
    assert.equal(empty.length, 0);

    // Check getAllRecords and clear
    assert.equal(mock.getAllRecords().length, 4);
    mock.clear();
    assert.equal(mock.getAllRecords().length, 0);
  });

  test("MockZKOracleClient: simulates commit and query failures", async () => {
    const mock = new MockZKOracleClient();
    mock.setFailCommit("Simulated RPC rate limit (429)");

    await assert.rejects(
      () =>
        mock.commit({
          wallet: testWallet,
          riskScore: 0,
          verdict: "SAFE",
          timestamp: 1000,
          topRules: [],
          txSignatures: [],
        }),
      /429/,
    );

    mock.setFailCommit(null);
    await mock.commit({
      wallet: testWallet,
      riskScore: 0,
      verdict: "SAFE",
      timestamp: 1000,
      topRules: [],
      txSignatures: [],
    });

    mock.setFailQuery("Simulated connection timeout");
    await assert.rejects(() => mock.query(testWallet), /timeout/);
  });

  test("commitScan: respects enabled flag and RADAR_ORACLE env", async () => {
    const record: ScanLedgerRecord = {
      wallet: testWallet,
      riskScore: 10,
      verdict: "SAFE",
      timestamp: 1000,
      topRules: [],
      txSignatures: [],
    };

    // Explicitly disabled
    const disabledRes = await commitScan(record, { enabled: false });
    assert.equal(disabledRes.success, false);
    assert.equal(disabledRes.signature, null);
    assert.match(disabledRes.error || "", /disabled/);

    // With mock client: automatically considered enabled
    const mock = new MockZKOracleClient();
    const mockRes = await commitScan(record, { client: mock });
    assert.equal(mockRes.success, true);
    assert.ok(mockRes.signature?.startsWith("sig_"));
    assert.ok(mockRes.compressedAddress?.startsWith("comp_"));
  });

  test("commitScan: handles client error gracefully without throwing", async () => {
    const mock = new MockZKOracleClient();
    mock.setFailCommit("Node connection dropped");

    const record: ScanLedgerRecord = {
      wallet: testWallet,
      riskScore: 80,
      verdict: "HIGH RISK",
      timestamp: 1000,
      topRules: ["LARGE_SWAP"],
      txSignatures: ["sig1"],
    };

    const res = await commitScan(record, { client: mock });
    assert.equal(res.success, false);
    assert.equal(res.signature, null);
    assert.equal(res.error, "Node connection dropped");
  });

  test("readScanLedger: reads back attestations using client or returns empty on failure", async () => {
    const mock = new MockZKOracleClient();
    const record: ScanLedgerRecord = {
      wallet: testWallet,
      riskScore: 40,
      verdict: "LOW RISK",
      timestamp: 5000,
      topRules: ["NEW_VENUE"],
      txSignatures: ["sig5"],
    };

    await commitScan(record, { client: mock });

    // Read back
    const history = await readScanLedger(testWallet, { client: mock, limit: 5 });
    assert.equal(history.length, 1);
    assert.equal(history[0].wallet, testWallet);
    assert.equal(history[0].riskScore, 40);
    assert.equal(history[0].verdict, "LOW RISK");

    // Failure simulation: returns [] instead of throwing
    mock.setFailQuery("RPC network partition");
    const safeFallback = await readScanLedger(testWallet, { client: mock });
    assert.deepEqual(safeFallback, []);
  });

  test("LightZKOracleClient: initializes with default program ID and constructs RPC client", () => {
    const client = new LightZKOracleClient();
    assert.equal(client.oracleProgramId.toBase58(), DEFAULT_ORACLE_PROGRAM_ID.toBase58());
    assert.ok(client.rpcUrl.length > 0);

    const rpc = client.getRpc();
    assert.ok(rpc);

    // Custom program ID
    const customPid = Keypair.generate().publicKey;
    const customClient = new LightZKOracleClient({ oracleProgramId: customPid, rpcUrl: "https://custom.rpc" });
    assert.equal(customClient.oracleProgramId.toBase58(), customPid.toBase58());
    assert.equal(customClient.rpcUrl, "https://custom.rpc");
  });

  test("loadPayerFromEnv: returns null when neither keypair source is configured", () => {
    const saved = {
      keypair: process.env.RADAR_ORACLE_KEYPAIR,
      payer: process.env.RADAR_ORACLE_PAYER,
    };
    delete process.env.RADAR_ORACLE_KEYPAIR;
    delete process.env.RADAR_ORACLE_PAYER;
    try {
      assert.equal(loadPayerFromEnv(), null);
    } finally {
      process.env.RADAR_ORACLE_KEYPAIR = saved.keypair;
      process.env.RADAR_ORACLE_PAYER = saved.payer;
    }
  });

  test("loadPayerFromEnv: reads a valid 64-byte keypair file", () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-kp-test-"));
    const kp = Keypair.generate();
    const file = join(dir, "payer.json");
    writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    const saved = {
      keypair: process.env.RADAR_ORACLE_KEYPAIR,
      payer: process.env.RADAR_ORACLE_PAYER,
    };
    process.env.RADAR_ORACLE_KEYPAIR = file;
    delete process.env.RADAR_ORACLE_PAYER;
    try {
      const loaded = loadPayerFromEnv();
      assert.ok(loaded, "expected a keypair to be loaded");
      assert.equal(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
    } finally {
      process.env.RADAR_ORACLE_KEYPAIR = saved.keypair;
      process.env.RADAR_ORACLE_PAYER = saved.payer;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadPayerFromEnv: prefers the keypair file over RADAR_ORACLE_PAYER", () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-kp-test-"));
    const fileKp = Keypair.generate();
    const envKp = Keypair.generate();
    const file = join(dir, "payer.json");
    writeFileSync(file, JSON.stringify(Array.from(fileKp.secretKey)));
    const saved = {
      keypair: process.env.RADAR_ORACLE_KEYPAIR,
      payer: process.env.RADAR_ORACLE_PAYER,
    };
    process.env.RADAR_ORACLE_KEYPAIR = file;
    process.env.RADAR_ORACLE_PAYER = bs58.encode(envKp.secretKey);
    try {
      const loaded = loadPayerFromEnv();
      assert.ok(loaded, "expected a keypair to be loaded");
      assert.equal(loaded.publicKey.toBase58(), fileKp.publicKey.toBase58(), "file must win over env");
    } finally {
      process.env.RADAR_ORACLE_KEYPAIR = saved.keypair;
      process.env.RADAR_ORACLE_PAYER = saved.payer;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadPayerFromEnv: falls back to RADAR_ORACLE_PAYER when the file is missing or malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-kp-test-"));
    const envKp = Keypair.generate();
    const saved = {
      keypair: process.env.RADAR_ORACLE_KEYPAIR,
      payer: process.env.RADAR_ORACLE_PAYER,
    };
    process.env.RADAR_ORACLE_PAYER = bs58.encode(envKp.secretKey);
    try {
      // Missing file -> fallback to env
      process.env.RADAR_ORACLE_KEYPAIR = join(dir, "does-not-exist.json");
      let loaded = loadPayerFromEnv();
      assert.ok(loaded, "expected fallback to env keypair");
      assert.equal(loaded.publicKey.toBase58(), envKp.publicKey.toBase58());

      // Malformed file (wrong length) -> fallback to env
      const bad = join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify([1, 2, 3]));
      process.env.RADAR_ORACLE_KEYPAIR = bad;
      loaded = loadPayerFromEnv();
      assert.ok(loaded, "expected fallback to env keypair on malformed file");
      assert.equal(loaded.publicKey.toBase58(), envKp.publicKey.toBase58());
    } finally {
      process.env.RADAR_ORACLE_KEYPAIR = saved.keypair;
      process.env.RADAR_ORACLE_PAYER = saved.payer;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("LightZKOracleClient: lamports pack/unpack round-trips risk (0..100) x verdict (0..3)", () => {
    const unpack = (LightZKOracleClient as unknown as {
      unpackLamports(n: number): { risk: number; verdictCode: number };
    }).unpackLamports;

    // Concrete on-chain example: risk=72, verdictCode=3 (HIGH RISK) -> 72004 -> back
    assert.deepEqual(unpack(72004), { risk: 72, verdictCode: 3 });

    for (let risk = 0; risk <= 100; risk++) {
      for (let code = 0; code <= 3; code++) {
        const lamports = risk * 1000 + code + 1;
        const { risk: r2, verdictCode: c2 } = unpack(lamports);
        assert.equal(r2, risk, `risk round-trip failed for risk=${risk} code=${code}`);
        assert.equal(c2, code, `verdict round-trip failed for risk=${risk} code=${code}`);
      }
    }
  });

  test("audit 1.2: signAttestation and verifyAttestation: roundtrip signature verification and tamper detection", () => {
    const oracleKp = Keypair.generate();
    const targetWallet = Keypair.generate().publicKey.toBase58();
    const record = {
      wallet: targetWallet,
      riskScore: 85,
      verdict: "HIGH RISK",
      timestamp: 1726300000,
    };

    const signed = signAttestation(record, oracleKp);
    assert.equal(signed.oraclePublicKey, oracleKp.publicKey.toBase58());
    assert.ok(typeof signed.signature === "string" && signed.signature.length > 0);

    // 1. Valid signature verifies against expected oracle public key
    const fullRecord = { ...record, ...signed };
    assert.equal(verifyAttestation(fullRecord, oracleKp.publicKey.toBase58()), true);
    assert.equal(verifyAttestation(fullRecord), true);

    // 2. Tampered risk score fails
    assert.equal(verifyAttestation({ ...fullRecord, riskScore: 84 }, oracleKp.publicKey.toBase58()), false);

    // 3. Tampered wallet address fails
    const otherWallet = Keypair.generate().publicKey.toBase58();
    assert.equal(verifyAttestation({ ...fullRecord, wallet: otherWallet }, oracleKp.publicKey.toBase58()), false);

    // 4. Tampered timestamp fails
    assert.equal(verifyAttestation({ ...fullRecord, timestamp: record.timestamp + 10 }, oracleKp.publicKey.toBase58()), false);

    // 5. Attestation signed by a different keypair fails verification against expected key
    const attackerKp = Keypair.generate();
    const forged = signAttestation(record, attackerKp);
    assert.equal(verifyAttestation({ ...record, ...forged }, oracleKp.publicKey.toBase58()), false);
  });

  test("audit 1.2: serializeScanRecord and deserializeScanRecord: RS01-trailer roundtrip and legacy compatibility", () => {
    const oracleKp = Keypair.generate();
    const targetWallet = Keypair.generate().publicKey.toBase58();
    const record: ScanLedgerRecord = {
      wallet: targetWallet,
      riskScore: 45,
      verdict: "SUSPICIOUS",
      timestamp: 1726301234,
      topRules: ["LARGE_SWAP", "NEW_VENUE"],
      txSignatures: ["sig1", "sig2"],
    };

    const signed = signAttestation(record, oracleKp);
    const signedRecord: ScanLedgerRecord = { ...record, ...signed };

    // 1. Serialized buffer carries the 96-byte trailer (64 bytes sig + 32 bytes pubkey)
    const buf = serializeScanRecord(signedRecord);
    const parsed = deserializeScanRecord(buf);
    assert.equal(parsed.wallet, targetWallet);
    assert.equal(parsed.riskScore, 45);
    assert.equal(parsed.verdict, "SUSPICIOUS");
    assert.equal(parsed.signature, signed.signature);
    assert.equal(parsed.oraclePublicKey, signed.oraclePublicKey);
    assert.equal(verifyAttestation(parsed, oracleKp.publicKey.toBase58()), true);

    // 2. Legacy compatibility: buffer without trailer deserializes cleanly without signature
    const legacyBuf = serializeScanRecord(record);
    const legacyParsed = deserializeScanRecord(legacyBuf);
    assert.equal(legacyParsed.wallet, targetWallet);
    assert.equal(legacyParsed.riskScore, 45);
    assert.equal(legacyParsed.signature, undefined);
    assert.equal(legacyParsed.oraclePublicKey, undefined);
  });

  test("audit 1.2: LightZKOracleClient query: extracts signed memo anchors and marks verified: true", async () => {
    const oracleKp = Keypair.generate();
    const targetWallet = Keypair.generate().publicKey.toBase58();
    const record: ScanLedgerRecord = {
      wallet: targetWallet,
      riskScore: 90,
      verdict: "HIGH RISK",
      timestamp: 1726305000,
      topRules: ["DORMANT_ACTIVE"],
      txSignatures: ["sig100"],
    };
    const signed = signAttestation(record, oracleKp);
    const signedRecord: ScanLedgerRecord = { ...record, ...signed };

    const memoPayload = Buffer.concat([
      Buffer.from("RADAR_ORACLE:"),
      serializeScanRecord(signedRecord),
    ]);

    const memoProgramId = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    const mockTx = {
      slot: 250_000_100,
      meta: { err: null },
      transaction: {
        signatures: ["tx_sig_signed_anchor_1"],
        message: {
          accountKeys: [oracleKp.publicKey.toBase58(), memoProgramId.toBase58()],
          instructions: [
            {
              programIdIndex: 1,
              data: bs58.encode(memoPayload),
            },
          ],
        },
      },
    };

    const mockConn = {
      getSignaturesForAddress: async () => [{ signature: "tx_sig_signed_anchor_1" }],
      getTransactions: async () => [mockTx],
    };

    const client = new LightZKOracleClient({
      rpcUrl: "https://mock-rpc.solana.com",
      oraclePublicKey: oracleKp.publicKey.toBase58(),
      connectionFactory: () => mockConn as any,
    });

    const results = await client.query(targetWallet, 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].wallet, targetWallet);
    assert.equal(results[0].riskScore, 90);
    assert.equal(results[0].verdict, "HIGH RISK");
    assert.equal(results[0].verified, true);
    assert.equal(results[0].onchainSignature, "tx_sig_signed_anchor_1");
  });

  test("audit 1.2: LightZKOracleClient query: rejects forged/fake memo attestation signed by non-oracle key", async () => {
    const genuineOracleKp = Keypair.generate();
    const attackerKp = Keypair.generate();
    const targetWallet = Keypair.generate().publicKey.toBase58();

    // Attacker crafts a fake attestation signed by their own key
    const forgedRecord: ScanLedgerRecord = {
      wallet: targetWallet,
      riskScore: 100,
      verdict: "HIGH RISK",
      timestamp: 1726306000,
      topRules: ["DORMANT_ACTIVE"],
      txSignatures: ["sigAttacker"],
    };
    const forgedSigned = signAttestation(forgedRecord, attackerKp);
    const signedRecord: ScanLedgerRecord = { ...forgedRecord, ...forgedSigned };

    const memoPayload = Buffer.concat([
      Buffer.from("RADAR_ORACLE:"),
      serializeScanRecord(signedRecord),
    ]);

    const memoProgramId = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    const mockTx = {
      slot: 250_000_200,
      meta: { err: null },
      transaction: {
        signatures: ["tx_sig_forged_1"],
        message: {
          accountKeys: [attackerKp.publicKey.toBase58(), memoProgramId.toBase58()],
          instructions: [
            {
              programIdIndex: 1,
              data: bs58.encode(memoPayload),
            },
          ],
        },
      },
    };

    const mockConn = {
      getSignaturesForAddress: async () => [{ signature: "tx_sig_forged_1" }],
      getTransactions: async () => [mockTx],
    };

    const client = new LightZKOracleClient({
      rpcUrl: "https://mock-rpc.solana.com",
      oraclePublicKey: genuineOracleKp.publicKey.toBase58(),
      connectionFactory: () => mockConn as any,
    });

    const results = await client.query(targetWallet, 10);
    // Forged record MUST be rejected because its signature does not match genuineOracleKp
    assert.equal(results.length, 0);
  });

  test("audit 1.2: LightZKOracleClient query: uses legacy lamports query in unauthenticated mode without oracle key", async () => {
    const targetWallet = Keypair.generate().publicKey.toBase58();

    const mockFailingConn = {
      getSignaturesForAddress: async () => {
        throw new Error("RPC network failure (e.g. rate limit 429)");
      },
    };

    const mockJsonRpc = async (method: string, _params: unknown[]) => {
      if (method === "getCompressedAccountsByOwner") {
        return {
          value: {
            items: [
              {
                address: "compressed_account_legacy_1",
                lamports: 72004, // risk: 72, verdictCode: 3 (HIGH RISK)
                slotCreated: 240_000_000,
              },
            ],
          },
        };
      }
      return {};
    };

    // Unauthenticated client (no oraclePublicKey configured)
    const client = new LightZKOracleClient({
      rpcUrl: "https://mock-rpc.solana.com",
      connectionFactory: () => mockFailingConn as any,
      jsonRpcFactory: mockJsonRpc as any,
    });

    const results = await client.query(targetWallet, 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].riskScore, 72);
    assert.equal(results[0].verdict, "HIGH RISK");
    assert.equal(results[0].verified, false, "legacy items must be marked verified: false");
  });

  test("audit 2.3 & revision 11: LightZKOracleClient query: returns empty array when querySignedAnchors finds 0 records (WR-CRIT-02)", async () => {
    const oracleKp = Keypair.generate();
    const targetWallet = Keypair.generate().publicKey.toBase58();

    // Oracle connection returns recent signatures, but none match this wallet
    const mockConn = {
      getSignaturesForAddress: async () => [{ signature: "other_tx_sig" }],
      getTransactions: async () => [],
    };

    let legacyRpcCalled = false;
    const mockJsonRpc = async (method: string, _params: unknown[]) => {
      if (method === "getCompressedAccountsByOwner") {
        legacyRpcCalled = true;
        return {
          value: {
            items: [
              {
                address: "compressed_account_legacy_historical",
                lamports: 15001, // risk: 15, verdictCode: 0 (SAFE) -> 15001
                slotCreated: 230_000_000,
              },
            ],
          },
        };
      }
      return {};
    };

    const client = new LightZKOracleClient({
      rpcUrl: "https://mock-rpc.solana.com",
      oraclePublicKey: oracleKp.publicKey.toBase58(),
      connectionFactory: () => mockConn as any,
      jsonRpcFactory: mockJsonRpc as any,
    });

    const results = await client.query(targetWallet, 10);
    // Audit Revision 11 (WR-CRIT-02): Must return 0 records instead of falling back to legacy lamports
    assert.equal(results.length, 0);
    assert.equal(legacyRpcCalled, false, "must not query legacy compressed accounts when oracle key is configured");
  });

  test("audit 2.4: sendMemoAnchor overlong record compacts without destroying Ed25519 signature trailer", async () => {
    const oracleKp = Keypair.generate();
    const targetWallet = Keypair.generate().publicKey.toBase58();

    // Create a record with large payload (> 512 bytes)
    const longRules = Array.from({ length: 40 }, (_, i) => `ANOMALOUS_LONG_RULE_NAME_EXCEEDING_LIMIT_${i}`);
    const longSigs = Array.from({ length: 20 }, (_, i) => `5UfDkvStqGnutGQjH5e26Q3yQy4f5b7Y${i}1111111111111111111111111111`);
    const record: ScanLedgerRecord = {
      wallet: targetWallet,
      riskScore: 65,
      verdict: "SUSPICIOUS",
      timestamp: 1726309000,
      topRules: longRules,
      txSignatures: longSigs,
    };

    const signed = signAttestation(record, oracleKp);
    const signedRecord: ScanLedgerRecord = { ...record, ...signed };

    let capturedMemoData: any = null;
    const mockConn = {
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 12345 }),
      sendRawTransaction: async (rawTxBuf: Buffer) => {
        const tx = Transaction.from(rawTxBuf);
        capturedMemoData = tx.instructions[0].data;
        return "mock_memo_sig_123";
      },
      confirmTransaction: async () => ({ value: null }),
    };

    const client = new LightZKOracleClient({
      rpcUrl: "https://mock-rpc.solana.com",
      oraclePublicKey: oracleKp.publicKey.toBase58(),
      connectionFactory: () => mockConn as any,
    });

    // Call private sendMemoAnchor
    const sig = await (client as any).sendMemoAnchor(oracleKp, signedRecord);
    assert.equal(sig, "mock_memo_sig_123");
    assert.ok(capturedMemoData !== null);

    // Verify memo length is <= 512 bytes
    assert.ok(capturedMemoData!.length <= 512, `Memo length ${capturedMemoData!.length} must be <= 512`);

    // Verify memo payload deserializes and retains valid Ed25519 signature
    const prefix = Buffer.from("RADAR_ORACLE:");
    assert.ok(capturedMemoData!.subarray(0, prefix.length).equals(prefix));
    const payload = capturedMemoData!.subarray(prefix.length);
    const deserialized = deserializeScanRecord(payload);

    assert.equal(deserialized.wallet, targetWallet);
    assert.equal(deserialized.riskScore, 65);
    assert.equal(deserialized.verdict, "SUSPICIOUS");
    assert.ok(deserialized.signature, "Signature trailer must be preserved");
    assert.equal(deserialized.oraclePublicKey, oracleKp.publicKey.toBase58());
    assert.equal(verifyAttestation(deserialized, oracleKp.publicKey.toBase58()), true, "Compacted attestation signature must verify");
  });

  test("audit 2.3: publishOnchainRecord includes targetWallet in memo instruction keys for RPC indexing", async () => {
    const oracleKp = Keypair.generate();
    const targetWallet = Keypair.generate().publicKey.toBase58();

    let capturedKeys: any[] = [];
    const mockConn = {
      getLatestBlockhash: async () => ({ blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 100 }),
      sendRawTransaction: async (rawTxBuf: Buffer) => {
        const tx = Transaction.from(rawTxBuf);
        capturedKeys = tx.instructions[0].keys;
        return "mock_memo_sig_456";
      },
      confirmTransaction: async () => ({ value: null }),
    };

    const record: ScanLedgerRecord = {
      wallet: targetWallet,
      riskScore: 25,
      verdict: "SAFE",
      timestamp: Math.floor(Date.now() / 1000),
      topRules: [],
      txSignatures: [],
    };

    const client = new LightZKOracleClient({
      rpcUrl: "https://mock-rpc.solana.com",
      oraclePublicKey: oracleKp.publicKey.toBase58(),
      connectionFactory: () => mockConn as any,
    });

    const sig = await (client as any).sendMemoAnchor(oracleKp, record);
    assert.equal(sig, "mock_memo_sig_456");
    assert.equal(capturedKeys.length, 2);
    assert.equal(capturedKeys[0].pubkey.toBase58(), oracleKp.publicKey.toBase58());
    assert.equal(capturedKeys[1].pubkey.toBase58(), targetWallet);
    assert.equal(capturedKeys[1].isSigner, false);
  });

  test("audit 1.4: LightZKOracleClient querySignedAnchors: negative caching prevents RPC quota exhaustion", async () => {
    const oracleKp = Keypair.generate();
    const unknownWallet = Keypair.generate().publicKey.toBase58();

    let sigsCallCount = 0;
    const mockConn = {
      getSignaturesForAddress: async () => {
        sigsCallCount++;
        return [];
      },
      getTransactions: async () => [],
    };

    const client = new LightZKOracleClient({
      rpcUrl: "https://mock-rpc.solana.com",
      oraclePublicKey: oracleKp.publicKey.toBase58(),
      connectionFactory: () => mockConn as any,
    });

    // First query: queries RPC (target wallet + oracle key fallback), finds 0 records, caches empty array
    const first = await (client as any).querySignedAnchors(unknownWallet, oracleKp.publicKey.toBase58(), 10);
    assert.deepEqual(first, []);
    assert.equal(sigsCallCount, 2);

    // Second query: served from negative cache, sigsCallCount remains 2 (no RPC calls)
    const second = await (client as any).querySignedAnchors(unknownWallet, oracleKp.publicKey.toBase58(), 10);
    assert.deepEqual(second, []);
    assert.equal(sigsCallCount, 2, "second query must be served from cache without querying RPC");
  });

  test("audit 2.2: extractMemoAnchors extracts records from Solana v0 versioned transactions (staticAccountKeys)", () => {
    const oracleKp = Keypair.generate();
    const targetWallet = Keypair.generate().publicKey.toBase58();
    const memoProgramId = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

    const record: ScanLedgerRecord = {
      wallet: targetWallet,
      riskScore: 42,
      verdict: "SUSPICIOUS",
      timestamp: 1726307000,
      topRules: ["LARGE_SWAP"],
      txSignatures: ["sigV0Tx1"],
    };
    const signed = signAttestation(record, oracleKp);
    const fullRecord: ScanLedgerRecord = { ...record, ...signed };

    const memoBytes = Buffer.concat([
      Buffer.from("RADAR_ORACLE:"),
      serializeScanRecord(fullRecord),
    ]);

    // Construct a Solana v0 VersionedTransactionResponse object
    // Notice: message does NOT have accountKeys, it has staticAccountKeys and compiledInstructions!
    const v0Tx = {
      slot: 300_000_123,
      meta: {
        err: null,
        loadedAddresses: {
          writable: [],
          readonly: [],
        },
      },
      transaction: {
        signatures: ["sig_v0_anchor_test"],
        message: {
          staticAccountKeys: [oracleKp.publicKey, memoProgramId],
          compiledInstructions: [
            {
              programIdIndex: 1, // Points to memoProgramId
              data: new Uint8Array(memoBytes), // Uint8Array format
            },
          ],
        },
      },
    };

    const client = new LightZKOracleClient({
      rpcUrl: "https://mock-rpc.solana.com",
      oraclePublicKey: oracleKp.publicKey.toBase58(),
    });

    const records = (client as any).extractMemoAnchors(v0Tx);
    assert.equal(records.length, 1);
    assert.equal(records[0].wallet, targetWallet);
    assert.equal(records[0].riskScore, 42);
    assert.equal(records[0].verdict, "SUSPICIOUS");
    assert.equal(records[0].oraclePublicKey, oracleKp.publicKey.toBase58());
    assert.equal(verifyAttestation(records[0], oracleKp.publicKey.toBase58()), true);
  });

  test("audit revision 9: LightZKOracleClient commit fast-fails polling without 15s hang on standard RPC", async () => {
    const payer = Keypair.generate();
    let jsonRpcCalls = 0;
    const client = new LightZKOracleClient({
      rpcUrl: "https://mock-rpc.solana.com",
      oraclePublicKey: payer.publicKey.toBase58(),
      jsonRpcFactory: (async <T>(method: string, _params: unknown[]): Promise<T> => {
        if (method === "getCompressedAccountsByOwner") {
          jsonRpcCalls++;
          throw new Error("Method not found (-32601)");
        }
        return {} as T;
      }) as any,
    });

    (client as any).sendMemoAnchor = async () => "sig_memo_fast_fallback";
    (client as any).conn = {
      getSignaturesForAddress: async () => [],
    };

    const startTime = Date.now();
    const res = await client.commit(
      {
        wallet: Keypair.generate().publicKey.toBase58(),
        riskScore: 20,
        verdict: "SAFE",
        timestamp: 1726000000,
        topRules: [],
        txSignatures: [],
      },
      payer,
    );

    const elapsed = Date.now() - startTime;
    assert.equal(res.signature, "sig_memo_fast_fallback");
    assert.equal(jsonRpcCalls, 1, "Should have broken after first unsupported method response");
    assert.ok(elapsed < 2000, `Expected elapsed time < 2000ms, took ${elapsed}ms`);
  });

  test("audit revision 11 WR-CRIT-02: query does not degrade to unsigned legacy lamports when oracle key is configured", async () => {
    const oracleKp = Keypair.generate();
    const attackerWallet = Keypair.generate().publicKey.toBase58();

    let legacyRpcCalled = false;
    const client = new LightZKOracleClient({
      rpcUrl: "https://mock-rpc.solana.com",
      oraclePublicKey: oracleKp.publicKey.toBase58(),
      connectionFactory: () =>
        ({
          getSignaturesForAddress: async () => [],
          getTransactions: async () => [],
        }) as any,
      jsonRpcFactory: (async <T>(method: string): Promise<T> => {
        if (method === "getCompressedAccountsByOwner") {
          legacyRpcCalled = true;
          return {
            value: {
              items: [
                {
                  lamports: 1, // unpacks to risk 0, verdict SAFE
                  slotCreated: 100000,
                },
              ],
            },
          } as T;
        }
        return {} as T;
      }) as any,
    });

    const records = await client.query(attackerWallet, 10);
    assert.equal(records.length, 0, "must return empty array and not fall back to unsigned compressed accounts");
    assert.equal(legacyRpcCalled, false, "must not query getCompressedAccountsByOwner when oracle key is configured");
  });
});


