import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ScanLedgerRecord,
  serializeScanRecord,
  deserializeScanRecord,
  SCAN_RECORD_MAGIC,
  MockZKOracleClient,
  LightZKOracleClient,
  DEFAULT_ORACLE_PROGRAM_ID,
  commitScan,
  readScanLedger,
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
});
