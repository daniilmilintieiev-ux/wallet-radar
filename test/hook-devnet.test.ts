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
  test("buildCreateToken22MintInstructions: creates valid 3-instruction Token-22 mint setup", () => {
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

    assert.equal(ixs.length, 3);

    // 1. SystemProgram createAccount for mint with 150 bytes
    const createIx = ixs[0];
    assert.equal(createIx.keys.length, 2);
    assert.equal(createIx.keys[1].pubkey.toBase58(), mint.toBase58());

    // 2. TransferHook extension init (tag 36, sub 0)
    const initHookIx = ixs[1];
    assert.equal(initHookIx.programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
    assert.equal(initHookIx.data[0], 36); // Extension tag
    assert.equal(initHookIx.data[1], 0);  // Initialize sub-instruction
    assert.deepEqual(initHookIx.data.subarray(2, 34), authority.toBuffer());
    assert.deepEqual(initHookIx.data.subarray(34, 66), hookProgramId.toBuffer());

    // 3. InitializeMint2 (tag 20)
    const initMintIx = ixs[2];
    assert.equal(initMintIx.programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
    assert.equal(initMintIx.data[0], 20); // InitializeMint2 tag
    assert.equal(initMintIx.data[1], 6);  // Decimals
    assert.deepEqual(initMintIx.data.subarray(2, 34), authority.toBuffer());
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
