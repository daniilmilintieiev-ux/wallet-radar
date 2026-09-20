import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  DEFAULT_HOOK_PROGRAM_ID,
  RadarHookErrorCode,
} from "../src/hook/index.js";
import {
  buildCreateToken22MintInstructions,
  evaluateHookTransferProof,
  runTransferHookDevnet,
  loadDeployerKeypair,
} from "../scripts/transfer-hook-devnet.js";

describe("Token-22 Transfer Hook Devnet Proof (scripts/transfer-hook-devnet)", () => {
  test("buildCreateToken22MintInstructions: creates valid 2-instruction Token-22 mint setup", () => {
    const payer = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey;
    const hookProgramId = DEFAULT_HOOK_PROGRAM_ID;

    const ixs = buildCreateToken22MintInstructions({
      payer,
      mint,
      authority,
      hookProgramId,
      decimals: 6,
      rentExemptionLamports: 1500000,
    });

    // Devnet-verified flow (56d3caa): the hook extension is embedded as a TLV
    // inside InitializeMint — there is no separate hook-init instruction.
    assert.equal(ixs.length, 2);

    // 1. SystemProgram createAccount for mint with 150 bytes
    const createIx = ixs[0];
    assert.equal(createIx.keys.length, 2);
    assert.equal(createIx.keys[1].pubkey.toBase58(), mint.toBase58());

    // 2. InitializeMint v1 (tag 0) with TransferHook extension TLV (111 bytes)
    const initMintIx = ixs[1];
    assert.equal(initMintIx.programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
    assert.equal(initMintIx.keys.length, 2);
    assert.equal(initMintIx.keys[0].pubkey.toBase58(), mint.toBase58());
    assert.equal(initMintIx.data.length, 111);
    assert.equal(initMintIx.data[0], 0); // InitializeMint v1
    assert.equal(initMintIx.data[1], 6); // decimals
    assert.deepEqual(initMintIx.data.subarray(2, 34), authority.toBuffer());
    assert.equal(initMintIx.data[34], 0); // freeze authority: None
    assert.equal(initMintIx.data.readUInt16LE(43), 11); // ext_type: TransferHook
    assert.equal(initMintIx.data.readUInt16LE(45), 64); // ext_len
    assert.deepEqual(initMintIx.data.subarray(47, 79), authority.toBuffer()); // hook authority
    assert.deepEqual(initMintIx.data.subarray(79, 111), hookProgramId.toBuffer()); // hook program id
  });

  test("evaluateHookTransferProof: asserts revert-on-flagged and allow-on-unflagged", () => {
    const proof = evaluateHookTransferProof({
      maxRiskScore: 80,
      flaggedScore: 92,
      unflaggedScore: 15,
    });

    // Flagged wallet transfer must revert
    assert.equal(proof.flaggedResult.allowed, false);
    assert.equal(proof.flaggedResult.errorCode, RadarHookErrorCode.RiskScoreTooHigh);
    assert.match(
      proof.flaggedResult.reason || "",
      /Destination wallet risk score 92 exceeds maximum allowed 80/,
    );

    // Unflagged wallet transfer must be allowed
    assert.equal(proof.unflaggedResult.allowed, true);
    assert.equal(proof.unflaggedResult.riskScore, 15);
  });

  test("runTransferHookDevnet: dry-run mode returns success with captured revert reason", async () => {
    const result = await runTransferHookDevnet({ dryRun: true });

    assert.equal(result.success, true);
    assert.equal(result.programId, DEFAULT_HOOK_PROGRAM_ID.toBase58());
    assert.equal(result.flaggedErrorCode, RadarHookErrorCode.RiskScoreTooHigh);
    assert.ok(result.flaggedRevertReason?.includes("exceeds maximum allowed"));
  });

  test("loadDeployerKeypair: persists and reloads consistent keypair", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-deployer-test-"));
    const tmpKeyPath = path.join(tmpDir, "test-deployer.json");

    try {
      const kp1 = loadDeployerKeypair(tmpKeyPath);
      assert.ok(fs.existsSync(tmpKeyPath));

      const kp2 = loadDeployerKeypair(tmpKeyPath);
      assert.equal(kp1.publicKey.toBase58(), kp2.publicKey.toBase58());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
