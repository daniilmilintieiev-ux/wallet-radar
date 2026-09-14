import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  DEFAULT_HOOK_PROGRAM_ID,
  EXTRA_ACCOUNT_METAS_SEED,
  RADAR_CONFIG_SEED,
  RADAR_RECORD_SEED,
  TRANSFER_HOOK_EXECUTE_DISCRIMINATOR,
  INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR,
  RadarHookErrorCode,
  deriveExtraAccountMetaListPda,
  deriveRadarConfigPda,
  deriveRadarRecordPda,
  buildInitializeExtraAccountMetaListInstruction,
  buildTransferHookExecuteInstruction,
  createRiskGatedTransferCheckedInstruction,
  evaluateTransferRisk,
} from "../src/hook/index.js";
import {
  ScanLedgerRecord,
  serializeScanRecord,
} from "../src/oracle/index.js";

describe("SPL Token-22 Transfer Hook (src/hook)", () => {
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const authorityKp = Keypair.generate();
  const authority = authorityKp.publicKey;
  const sourceKp = Keypair.generate();
  const source = sourceKp.publicKey;
  const destKp = Keypair.generate();
  const dest = destKp.publicKey;
  const destWalletKp = Keypair.generate();
  const destWallet = destWalletKp.publicKey;

  test("Constants & Discriminators: match SPL specifications", () => {
    assert.equal(
      TOKEN_2022_PROGRAM_ID.toBase58(),
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    );
    assert.equal(
      DEFAULT_HOOK_PROGRAM_ID.toBase58(),
      "Hook111111111111111111111111111111111111111",
    );

    // Verify execute discriminator sha256("spl-transfer-hook-interface:execute")[0..8]
    const expectedExecDisc = createHash("sha256")
      .update("spl-transfer-hook-interface:execute")
      .digest()
      .subarray(0, 8);
    assert.deepEqual(TRANSFER_HOOK_EXECUTE_DISCRIMINATOR, expectedExecDisc);

    // Verify init discriminator sha256("spl-transfer-hook-interface:initialize-extra-account-metas")[0..8]
    const expectedInitDisc = createHash("sha256")
      .update("spl-transfer-hook-interface:initialize-extra-account-metas")
      .digest()
      .subarray(0, 8);
    assert.deepEqual(INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR, expectedInitDisc);
  });

  test("PDA Derivations: deterministically derive required accounts", () => {
    const [extraMetas, bump1] = deriveExtraAccountMetaListPda(mint);
    assert.ok(extraMetas instanceof PublicKey);
    assert.ok(bump1 >= 0 && bump1 <= 255);

    const [configPda, bump2] = deriveRadarConfigPda(mint);
    assert.ok(configPda instanceof PublicKey);
    assert.ok(bump2 >= 0 && bump2 <= 255);
    assert.notEqual(extraMetas.toBase58(), configPda.toBase58());

    const [recordPda, bump3] = deriveRadarRecordPda(destWallet);
    assert.ok(recordPda instanceof PublicKey);
    assert.ok(bump3 >= 0 && bump3 <= 255);
  });

  test("buildInitializeExtraAccountMetaListInstruction: constructs valid initialization layout", () => {
    const ix = buildInitializeExtraAccountMetaListInstruction({
      mint,
      authority,
      maxRiskScore: 75,
      allowUnverified: false,
      maxAttestationAgeSec: 3600,
    });

    assert.equal(ix.programId.toBase58(), DEFAULT_HOOK_PROGRAM_ID.toBase58());
    assert.equal(ix.keys.length, 5);
    assert.equal(ix.keys[2].pubkey.toBase58(), mint.toBase58());
    assert.equal(ix.keys[3].pubkey.toBase58(), authority.toBase58());
    assert.equal(ix.keys[3].isSigner, true);

    // Verify data layout (18 bytes total)
    assert.equal(ix.data.length, 18);
    assert.deepEqual(
      ix.data.subarray(0, 8),
      INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR,
    );
    assert.equal(ix.data.readUInt8(8), 75); // maxRiskScore
    assert.equal(ix.data.readUInt8(9), 0); // allowUnverified: false
    assert.equal(ix.data.readBigUInt64LE(10), 3600n); // maxAttestationAgeSec
  });

  test("buildTransferHookExecuteInstruction: constructs valid transfer hook execute layout", () => {
    const [recordPda] = deriveRadarRecordPda(destWallet);
    const amount = 50_000_000n;

    const ix = buildTransferHookExecuteInstruction({
      source,
      mint,
      destination: dest,
      owner: authority,
      amount,
      oracleRecord: recordPda,
    });

    assert.equal(ix.programId.toBase58(), DEFAULT_HOOK_PROGRAM_ID.toBase58());
    assert.equal(ix.keys.length, 7); // 6 standard + 1 oracle record
    assert.equal(ix.keys[0].pubkey.toBase58(), source.toBase58());
    assert.equal(ix.keys[1].pubkey.toBase58(), mint.toBase58());
    assert.equal(ix.keys[2].pubkey.toBase58(), dest.toBase58());
    assert.equal(ix.keys[3].pubkey.toBase58(), authority.toBase58());
    assert.equal(ix.keys[6].pubkey.toBase58(), recordPda.toBase58());

    // Verify data layout (16 bytes: 8 discriminator + 8 amount LE)
    assert.equal(ix.data.length, 16);
    assert.deepEqual(
      ix.data.subarray(0, 8),
      TRANSFER_HOOK_EXECUTE_DISCRIMINATOR,
    );
    assert.equal(ix.data.readBigUInt64LE(8), amount);
  });

  test("createRiskGatedTransferCheckedInstruction: creates Token-22 TransferChecked with hook accounts", () => {
    const amount = 1_000_000n;
    const decimals = 6;

    const ix = createRiskGatedTransferCheckedInstruction({
      source,
      mint,
      destination: dest,
      owner: authority,
      amount,
      decimals,
      destinationWallet: destWallet,
    });

    assert.equal(ix.programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
    assert.equal(ix.keys.length, 8); // 4 token keys + 3 hook keys + 1 oracle key
    assert.equal(ix.keys[0].pubkey.toBase58(), source.toBase58());
    assert.equal(ix.keys[0].isWritable, true);
    assert.equal(ix.keys[3].isSigner, true);

    // Verify Token-22 TransferChecked instruction data: index 12 (1 byte) + amount (8 bytes) + decimals (1 byte)
    assert.equal(ix.data.length, 10);
    assert.equal(ix.data.readUInt8(0), 12); // TransferChecked tag
    assert.equal(ix.data.readBigUInt64LE(1), amount);
    assert.equal(ix.data.readUInt8(9), decimals);
  });

  describe("evaluateTransferRisk: deterministic rule execution", () => {
    const nowSec = 1726300000;

    test("allows transfer to verified safe counterparty", () => {
      const record: ScanLedgerRecord = {
        wallet: destWallet.toBase58(),
        riskScore: 25,
        verdict: "SAFE",
        timestamp: nowSec - 600,
        topRules: [],
        txSignatures: [],
      };

      const res = evaluateTransferRisk(record, { maxRiskScore: 80 }, nowSec);
      assert.equal(res.allowed, true);
      assert.equal(res.riskScore, 25);
      assert.equal(res.verdict, "SAFE");
    });

    test("allows transfer when score is medium but below maxRiskScore", () => {
      const record: ScanLedgerRecord = {
        wallet: destWallet.toBase58(),
        riskScore: 65,
        verdict: "SUSPICIOUS",
        timestamp: nowSec - 300,
        topRules: ["LARGE_SWAP"],
        txSignatures: [],
      };

      const res = evaluateTransferRisk(record, { maxRiskScore: 70 }, nowSec);
      assert.equal(res.allowed, true);
      assert.equal(res.riskScore, 65);
    });

    test("rejects transfer when riskScore exceeds maxRiskScore", () => {
      const record: ScanLedgerRecord = {
        wallet: destWallet.toBase58(),
        riskScore: 85,
        verdict: "SUSPICIOUS",
        timestamp: nowSec - 100,
        topRules: ["DORMANT_ACTIVE", "LARGE_SWAP"],
        txSignatures: [],
      };

      const res = evaluateTransferRisk(record, { maxRiskScore: 80 }, nowSec);
      assert.equal(res.allowed, false);
      assert.equal(res.errorCode, RadarHookErrorCode.RiskScoreTooHigh);
      assert.ok(res.reason?.includes("exceeds maximum allowed"));
    });

    test("rejects transfer when verdict is HIGH RISK regardless of numeric threshold", () => {
      const record: ScanLedgerRecord = {
        wallet: destWallet.toBase58(),
        riskScore: 40,
        verdict: "HIGH RISK",
        timestamp: nowSec - 100,
        topRules: ["TOXIC_MINT"],
        txSignatures: [],
      };

      const res = evaluateTransferRisk(record, { maxRiskScore: 90 }, nowSec);
      assert.equal(res.allowed, false);
      assert.equal(res.errorCode, RadarHookErrorCode.CounterpartyFlagged);
      assert.ok(res.reason?.includes("HIGH RISK"));
    });

    test("rejects transfer when attestation is stale and maxAttestationAgeSec is set", () => {
      const record: ScanLedgerRecord = {
        wallet: destWallet.toBase58(),
        riskScore: 15,
        verdict: "SAFE",
        timestamp: nowSec - 7200, // 2 hours old
        topRules: [],
        txSignatures: [],
      };

      const res = evaluateTransferRisk(
        record,
        { maxAttestationAgeSec: 3600 }, // 1 hour max age
        nowSec,
      );
      assert.equal(res.allowed, false);
      assert.equal(res.errorCode, RadarHookErrorCode.StaleOracleAttestation);
      assert.ok(res.reason?.includes("stale"));
    });

    test("handles unverified / missing scan records per allowUnverified policy", () => {
      // 1. allowUnverified: true (default)
      const allowedRes = evaluateTransferRisk(null, { allowUnverified: true });
      assert.equal(allowedRes.allowed, true);
      assert.ok(allowedRes.reason?.includes("unverified policy"));

      // 2. allowUnverified: false (strict security mode)
      const rejectedRes = evaluateTransferRisk(null, { allowUnverified: false });
      assert.equal(rejectedRes.allowed, false);
      assert.equal(rejectedRes.errorCode, RadarHookErrorCode.UnverifiedCounterparty);
      assert.ok(rejectedRes.reason?.includes("no verified on-chain scan record"));
    });

    test("evaluates raw serialized binary buffer from ZK scan ledger", () => {
      const record: ScanLedgerRecord = {
        wallet: destWallet.toBase58(),
        riskScore: 30,
        verdict: "LOW RISK",
        timestamp: nowSec - 500,
        topRules: ["NEW_VENUE"],
        txSignatures: ["sig1"],
      };

      const buffer = serializeScanRecord(record);
      const res = evaluateTransferRisk(buffer, { maxRiskScore: 80 }, nowSec);
      assert.equal(res.allowed, true);
      assert.equal(res.riskScore, 30);
      assert.equal(res.verdict, "LOW RISK");
    });

    test("rejects binary buffer with invalid header magic", () => {
      const corruptedBuf = Buffer.alloc(50);
      corruptedBuf.write("BAD0", 0); // Invalid magic (not RS01)

      const res = evaluateTransferRisk(corruptedBuf);
      assert.equal(res.allowed, false);
      assert.equal(res.errorCode, RadarHookErrorCode.InvalidScanRecordMagic);
    });

    test("rejects binary buffer that is truncated", () => {
      const truncatedBuf = Buffer.from("RS01short");
      const res = evaluateTransferRisk(truncatedBuf);
      assert.equal(res.allowed, false);
      assert.equal(res.errorCode, RadarHookErrorCode.InvalidScanRecordMagic);
    });
  });
});
