import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  buildUpdateConfigInstruction,
  buildSetAuthorityInstruction,
  RADAR_SET_AUTHORITY_DISCRIMINATOR,
  buildCloseScanRecordInstruction,
  RADAR_CLOSE_RECORD_DISCRIMINATOR,
  buildWriteScanRecordInstruction,
  buildTransferHookExecuteInstruction,
  buildRecordPdaMetaSeeds,
  buildSourceRecordPdaMetaSeeds,
  publishScanRecordToHook,
  buildEnvHookBridge,
  createRiskGatedTransferCheckedInstruction,
  evaluateTransferRisk,
  type HookMetaSpec,
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
      "wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV",
    );

    // Verify execute discriminator sha256("spl-transfer-hook-interface:execute")[0..8]
    const expectedExecDisc = createHash("sha256")
      .update("spl-transfer-hook-interface:execute")
      .digest()
      .subarray(0, 8);
    assert.deepEqual(TRANSFER_HOOK_EXECUTE_DISCRIMINATOR, expectedExecDisc);

    // Verify the initialize-extra-account-metas discriminator: inherited from
    // spl-transfer-hook-interface = sha256("spl-transfer-hook-interface:initialize-extra-account-metas")[0..8]
    // (see anchor-syn parse_interface_instruction).
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

    const [recordPda, bump3] = deriveRadarRecordPda(destWallet, mint);
    assert.ok(recordPda instanceof PublicKey);
    assert.ok(bump3 >= 0 && bump3 <= 255);
  });

  test("buildInitializeExtraAccountMetaListInstruction: constructs valid initialization layout", () => {
    const [configPda] = deriveRadarConfigPda(mint);
    const metas: HookMetaSpec[] = [
      { kind: "pubkey", pubkey: configPda, isSigner: false, isWritable: false },
      { kind: "seeds", seeds: buildRecordPdaMetaSeeds(), isSigner: false, isWritable: false },
    ];

    const ix = buildInitializeExtraAccountMetaListInstruction({
      mint,
      authority,
      metas,
    });

    assert.equal(ix.programId.toBase58(), DEFAULT_HOOK_PROGRAM_ID.toBase58());
    // Account order must match the transfer-hook interface:
    // [meta-list PDA (w), mint (r), authority (s), system_program (r)]
    const [expectedMetaListPda] = deriveExtraAccountMetaListPda(mint);
    assert.equal(ix.keys.length, 4);
    assert.equal(ix.keys[0].pubkey.toBase58(), expectedMetaListPda.toBase58());
    assert.equal(ix.keys[0].isWritable, true);
    assert.equal(ix.keys[1].pubkey.toBase58(), mint.toBase58());
    assert.equal(ix.keys[2].pubkey.toBase58(), authority.toBase58());
    assert.equal(ix.keys[2].isSigner, true);
    assert.equal(ix.keys[3].pubkey.toBase58(), "11111111111111111111111111111111");

    // Verify data layout: 8 disc + 4 (u32 count) + 2 * 35 (metas) = 82 bytes
    assert.equal(ix.data.length, 8 + 4 + 2 * 35);
    assert.deepEqual(
      ix.data.subarray(0, 8),
      INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR,
    );
    assert.equal(ix.data.readUInt32LE(8), 2); // metas count
    // First meta entry at offset 12: static config PDA
    assert.equal(ix.data.readUInt8(12), 0); // discriminator: 0 = static pubkey
    assert.deepEqual(ix.data.subarray(13, 45), configPda.toBuffer());
    assert.equal(ix.data.readUInt8(45), 0); // is_signer: false
    assert.equal(ix.data.readUInt8(46), 0); // is_writable: false
    // Second meta entry at offset 12 + 35 = 47: seed-based scan-record PDA
    assert.equal(ix.data.readUInt8(47), 1); // discriminator: 1 = seed-based PDA
    // Packed seeds: Literal("radar_record") [1, 12, 12B] +
    // AccountKey [3, accountIndex=1 (mint)] +
    // AccountData [4, accountIndex=2 (destination), dataIndex=32, length=32]
    assert.equal(ix.data.readUInt8(48), 1); // seed discriminator: literal
    assert.equal(ix.data.readUInt8(49), 12); // literal length
    assert.equal(
      ix.data.subarray(50, 62).toString("utf-8"),
      "radar_record",
    );
    assert.equal(ix.data.readUInt8(62), 3); // seed discriminator: accountKey (mint)
    assert.equal(ix.data.readUInt8(63), 1); // accountIndex: mint (account 1)
    assert.equal(ix.data.readUInt8(64), 4); // seed discriminator: accountData
    assert.equal(ix.data.readUInt8(65), 2); // accountIndex: destination token account
    assert.equal(ix.data.readUInt8(66), 32); // dataIndex: owner field offset
    assert.equal(ix.data.readUInt8(67), 32); // length
  });

  test("buildWriteScanRecordInstruction: includes config PDA and mint keys", () => {
    const [recordPda] = deriveRadarRecordPda(destWallet, mint);
    const [configPda] = deriveRadarConfigPda(mint);

    const ix = buildWriteScanRecordInstruction({
      wallet: destWallet,
      mint,
      riskScore: 20,
      verdictCode: 0,
      timestamp: 1726300000,
      authority,
    });

    // Keys: [0] wallet (r), [1] record PDA (w), [2] config PDA (r),
    // [3] mint (r), [4] authority (s, w), [5] system (r)
    assert.equal(ix.keys.length, 6);
    assert.equal(ix.keys[0].pubkey.toBase58(), destWallet.toBase58());
    assert.equal(ix.keys[1].pubkey.toBase58(), recordPda.toBase58());
    assert.equal(ix.keys[1].isWritable, true);
    assert.equal(ix.keys[2].pubkey.toBase58(), configPda.toBase58());
    assert.equal(ix.keys[3].pubkey.toBase58(), mint.toBase58());
    assert.equal(ix.keys[4].pubkey.toBase58(), authority.toBase58());
    assert.equal(ix.keys[4].isSigner, true);
    assert.equal(ix.keys[5].pubkey.toBase58(), "11111111111111111111111111111111");

    // Data: 8 disc + 1 risk + 1 verdict + 8 timestamp + 2 payloadLen = 20
    assert.equal(ix.data.length, 20);
    assert.equal(ix.data.readUInt8(8), 20);
    assert.equal(ix.data.readUInt8(9), 0);
    assert.equal(ix.data.readBigUInt64LE(10), 1726300000n);
  });

  test("buildUpdateConfigInstruction: constructs config update layout", () => {
    const [configPda] = deriveRadarConfigPda(mint);

    const ix = buildUpdateConfigInstruction({
      mint,
      authority,
      newMaxRiskScore: 90,
      allowUnverified: true,
      maxAttestationAgeSec: 3600,
    });

    // Keys: [0] config PDA (w), [1] authority (s, w)
    assert.equal(ix.keys.length, 2);
    assert.equal(ix.keys[0].pubkey.toBase58(), configPda.toBase58());
    assert.equal(ix.keys[0].isWritable, true);
    assert.equal(ix.keys[1].pubkey.toBase58(), authority.toBase58());
    assert.equal(ix.keys[1].isSigner, true);

    // Data: 8 disc + 1 maxRisk + 1 allowUnverified + 8 age = 18
    assert.equal(ix.data.length, 18);
    assert.equal(ix.data.readUInt8(8), 90);
    assert.equal(ix.data.readUInt8(9), 1);
    assert.equal(ix.data.readBigUInt64LE(10), 3600n);
  });

  test("buildTransferHookExecuteInstruction: constructs valid transfer hook execute layout", () => {
    const [recordPda] = deriveRadarRecordPda(destWallet, mint);
    const amount = 50_000_000n;

    const ix = buildTransferHookExecuteInstruction({
      source,
      mint,
      destination: dest,
      owner: authority,
      amount,
      record: recordPda,
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
      // 1. Default: allowUnverified is false (secure by default)
      const defaultRes = evaluateTransferRisk(null);
      assert.equal(defaultRes.allowed, false);
      assert.equal(defaultRes.errorCode, RadarHookErrorCode.UnverifiedCounterparty);

      // 2. allowUnverified: true (explicit permissive mode)
      const allowedRes = evaluateTransferRisk(null, { allowUnverified: true });
      assert.equal(allowedRes.allowed, true);
      assert.ok(allowedRes.reason?.includes("unverified policy"));

      // 3. allowUnverified: false (strict security mode, explicit)
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

  describe("Audit 2.3: Oracle to Transfer Hook Bridge (publishScanRecordToHook & buildEnvHookBridge)", () => {
    test("audit 2.3 & 1.1-NEW: PDA-derivation with mint isolation prevents cross-mint PDA spoofing", () => {
      const [recordPda, bump] = deriveRadarRecordPda(destWallet, mint);
      assert.ok(recordPda instanceof PublicKey);
      assert.ok(typeof bump === "number");

      // Verify PDA reproduces using findProgramAddressSync under DEFAULT_HOOK_PROGRAM_ID
      const [expectedPda, expectedBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("radar_record"), mint.toBuffer(), destWallet.toBuffer()],
        DEFAULT_HOOK_PROGRAM_ID,
      );
      assert.equal(recordPda.toBase58(), expectedPda.toBase58());
      assert.equal(bump, expectedBump);

      // Verify cross-mint isolation: another mint derives a distinct PDA for the same wallet
      const otherMint = Keypair.generate().publicKey;
      const [otherRecordPda] = deriveRadarRecordPda(destWallet, otherMint);
      assert.notEqual(recordPda.toBase58(), otherRecordPda.toBase58(), "Mints must have isolated PDAs for the same wallet");

      const [configPda] = deriveRadarConfigPda(mint);
      const [expectedConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("radar_config"), mint.toBuffer()],
        DEFAULT_HOOK_PROGRAM_ID,
      );
      assert.equal(configPda.toBase58(), expectedConfigPda.toBase58());
    });

    test("audit 2.3: publishScanRecordToHook: writes to record PDA and confirms transaction with stub connection", async () => {
      let sentRawTx: Buffer | null = null;
      let confirmedSig: string | null = null;

      const stubConn = {
        getLatestBlockhash: async () => ({
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 150_000,
        }),
        sendRawTransaction: async (raw: Buffer) => {
          sentRawTx = raw;
          return "tx_hook_record_published_sig_123";
        },
        confirmTransaction: async (conf: any) => {
          confirmedSig = conf.signature;
          return { value: { err: null } };
        },
      };

      const res = await publishScanRecordToHook({
        wallet: destWallet,
        mint,
        riskScore: 35,
        verdict: "LOW RISK",
        timestamp: 1726300000,
        authority: authorityKp,
        connection: stubConn as any,
      });

      assert.equal(res.signature, "tx_hook_record_published_sig_123");
      const [expectedRecordPda] = deriveRadarRecordPda(destWallet, mint);
      assert.equal(res.recordPda.toBase58(), expectedRecordPda.toBase58());
      assert.equal(confirmedSig, "tx_hook_record_published_sig_123");
      assert.ok(sentRawTx !== null, "sendRawTransaction must be called with serialized tx");
    });

    test("audit 2.3: buildEnvHookBridge: returns null when env is missing and callable bridge when env is configured", async () => {
      const savedMint = process.env.RADAR_HOOK_MINT;
      const savedKeypair = process.env.RADAR_HOOK_KEYPAIR;
      const dir = mkdtempSync(join(tmpdir(), "radar-hook-bridge-test-"));
      const keypairFile = join(dir, "hook-authority.json");
      const hookAuthKp = Keypair.generate();
      writeFileSync(keypairFile, JSON.stringify(Array.from(hookAuthKp.secretKey)));

      try {
        // 1. Unconfigured env returns null
        delete process.env.RADAR_HOOK_MINT;
        delete process.env.RADAR_HOOK_KEYPAIR;
        assert.equal(buildEnvHookBridge(), null);

        // 2. Valid configured env returns working bridge function
        process.env.RADAR_HOOK_MINT = mint.toBase58();
        process.env.RADAR_HOOK_KEYPAIR = keypairFile;

        const bridge = buildEnvHookBridge();
        assert.ok(typeof bridge === "function");
      } finally {
        if (savedMint !== undefined) process.env.RADAR_HOOK_MINT = savedMint;
        else delete process.env.RADAR_HOOK_MINT;
        if (savedKeypair !== undefined) process.env.RADAR_HOOK_KEYPAIR = savedKeypair;
        else delete process.env.RADAR_HOOK_KEYPAIR;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("audit 1.4: buildSetAuthorityInstruction produces instruction with correct discriminator and accounts", () => {
      const currentAuth = Keypair.generate().publicKey;
      const newAuth = Keypair.generate().publicKey;
      const [configPda] = deriveRadarConfigPda(mint);

      const ix = buildSetAuthorityInstruction({
        mint,
        currentAuthority: currentAuth,
        newAuthority: newAuth,
      });

      assert.equal(ix.programId.toBase58(), DEFAULT_HOOK_PROGRAM_ID.toBase58());
      assert.equal(ix.keys.length, 2);
      assert.equal(ix.keys[0].pubkey.toBase58(), configPda.toBase58());
      assert.equal(ix.keys[0].isWritable, true);
      assert.equal(ix.keys[1].pubkey.toBase58(), currentAuth.toBase58());
      assert.equal(ix.keys[1].isSigner, true);

      // Discriminator sha256("global:set_authority")[0..8] = [0x85, 0xfa, 0x25, 0x15, 0x6e, 0xa3, 0x1a, 0x79]
      assert.deepEqual(ix.data.subarray(0, 8), RADAR_SET_AUTHORITY_DISCRIMINATOR);
      // Data contains new_authority pubkey bytes (32 bytes)
      assert.deepEqual(Array.from(ix.data.subarray(8, 40)), Array.from(newAuth.toBytes()));
    });

    test("audit 1.5: evaluateTransferRisk performs two-sided counterparty check on source and destination", () => {
      const safeRecord: ScanLedgerRecord = {
        wallet: "SafeWallet11111111111111111111111111111111",
        riskScore: 20,
        verdict: "SAFE",
        timestamp: Math.floor(Date.now() / 1000),
        topRules: [],
        txSignatures: [],
      };

      const highRiskRecord: ScanLedgerRecord = {
        wallet: "CompromisedSender1111111111111111111111111",
        riskScore: 92,
        verdict: "HIGH RISK",
        timestamp: Math.floor(Date.now() / 1000),
        topRules: ["REGIME_SHIFT"],
        txSignatures: [],
      };

      // 1. Both safe -> allowed
      const resOk = evaluateTransferRisk(safeRecord, { maxRiskScore: 80 }, undefined, safeRecord);
      assert.equal(resOk.allowed, true);

      // 2. High risk sender, safe recipient -> blocked
      const resBlockedSender = evaluateTransferRisk(safeRecord, { maxRiskScore: 80 }, undefined, highRiskRecord);
      assert.equal(resBlockedSender.allowed, false);
      assert.ok(resBlockedSender.reason?.includes("Source wallet risk"));

      // 3. Safe sender, high risk recipient -> blocked
      const resBlockedDest = evaluateTransferRisk(highRiskRecord, { maxRiskScore: 80 }, undefined, safeRecord);
      assert.equal(resBlockedDest.allowed, false);
      assert.ok(resBlockedDest.reason?.includes("Destination wallet"));
    });

    test("audit 3.5: buildCloseScanRecordInstruction creates instruction with correct discriminator and accounts", () => {
      const mintPk = Keypair.generate().publicKey;
      const walletPk = Keypair.generate().publicKey;
      const authorityPk = Keypair.generate().publicKey;

      const ix = buildCloseScanRecordInstruction({
        mint: mintPk,
        wallet: walletPk,
        authority: authorityPk,
      });

      assert.equal(ix.programId.toBase58(), DEFAULT_HOOK_PROGRAM_ID.toBase58());
      assert.equal(ix.keys.length, 5);
      // Keys: [0] wallet, [1] record, [2] config, [3] mint, [4] authority
      assert.equal(ix.keys[0].pubkey.toBase58(), walletPk.toBase58());
      assert.equal(ix.keys[3].pubkey.toBase58(), mintPk.toBase58());
      assert.equal(ix.keys[4].pubkey.toBase58(), authorityPk.toBase58());
      assert.equal(ix.keys[4].isSigner, true);
      assert.equal(ix.keys[4].isWritable, true);

      // Discriminator sha256("global:close_scan_record")[0..8] = [0xfd, 0xee, 0x66, 0x33, 0x5f, 0x42, 0x5b, 0xcc]
      assert.deepEqual(ix.data.subarray(0, 8), RADAR_CLOSE_RECORD_DISCRIMINATOR);
    });

    test("audit 2.2: createRiskGatedTransferCheckedInstruction includes sourceRecord PDA when sourceWallet provided", () => {
      const mintPk = Keypair.generate().publicKey;
      const srcAta = Keypair.generate().publicKey;
      const dstAta = Keypair.generate().publicKey;
      const ownerPk = Keypair.generate().publicKey;
      const dstWalletPk = Keypair.generate().publicKey;
      const srcWalletPk = Keypair.generate().publicKey;

      // Without sourceWallet
      const ixStandard = createRiskGatedTransferCheckedInstruction({
        source: srcAta,
        mint: mintPk,
        destination: dstAta,
        owner: ownerPk,
        amount: 1000000n,
        decimals: 6,
        destinationWallet: dstWalletPk,
      });
      assert.equal(ixStandard.keys.length, 8);

      // With sourceWallet (Audit 2.2)
      const ixTwoSided = createRiskGatedTransferCheckedInstruction({
        source: srcAta,
        mint: mintPk,
        destination: dstAta,
        owner: ownerPk,
        amount: 1000000n,
        decimals: 6,
        destinationWallet: dstWalletPk,
        sourceWallet: srcWalletPk,
      });
      assert.equal(ixTwoSided.keys.length, 9);
      const [expectedSrcRecord] = deriveRadarRecordPda(srcWalletPk, mintPk);
      assert.equal(ixTwoSided.keys[8].pubkey.toBase58(), expectedSrcRecord.toBase58());
    });

    test("audit 1.1: buildSourceRecordPdaMetaSeeds resolves source owner from account 0 bytes 32..64", () => {
      const seeds = buildSourceRecordPdaMetaSeeds();
      assert.equal(seeds.length, 3);
      assert.deepEqual(seeds[0], { type: "literal", value: "radar_record" });
      assert.deepEqual(seeds[1], { type: "accountKey", index: 1 });
      assert.deepEqual(seeds[2], { type: "accountData", accountIndex: 0, dataIndex: 32, length: 32 });
    });

    test("audit revision 9: RadarHookErrorCode.InvalidAccountOwner is 6011", () => {
      assert.equal(RadarHookErrorCode.InvalidAccountOwner, 6011);
    });
  });
});
