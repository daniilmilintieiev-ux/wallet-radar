import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  DEFAULT_HOOK_PROGRAM_ID,
  deriveExtraAccountMetaListPda,
  deriveRadarConfigPda,
  deriveRadarRecordPda,
  buildInitializeInstruction,
  buildInitializeExtraAccountMetaListInstruction,
  buildWriteScanRecordInstruction,
  createRiskGatedTransferCheckedInstruction,
  evaluateTransferRisk,
  RadarHookErrorCode,
} from "../src/hook/index.js";
import {
  ScanLedgerRecord,
  serializeScanRecord,
} from "../src/oracle/index.js";

/**
 * Token account size for this mint.
 *
 * A plain Token-22 mint needs 165 bytes, but this mint's TransferHook
 * extension was written with the hook-first creation order (extension added
 * before `InitializeMint`), which leaves a zero-padded region ahead of the
 * TLV. Token-22's `InitializeAccount` then rejects the standard 165-byte
 * account with `InvalidAccountData`; a 173-byte account succeeds (verified on
 * devnet). We allocate 173 bytes for every token account of this mint.
 */
const TOKEN_ACCOUNT_SPACE = 173;
/** Token-22 `InitializeAccount` instruction index. */
const IX_INITIALIZE_ACCOUNT = 1;
/** Token-22 `MintTo` instruction index. */
const IX_MINT_TO = 7;

export interface TransferProofResult {
  programId: string;
  mint: string;
  flaggedWallet: string;
  unflaggedWallet: string;
  flaggedRevertReason?: string;
  flaggedErrorCode?: number;
  flaggedTxSignature?: string;
  successTxSignature?: string;
  success: boolean;
}

/**
 * Loads deployer keypair from path or generates a new one.
 */
export function loadDeployerKeypair(keypairPath?: string): Keypair {
  const filePath =
    keypairPath ||
    process.env.SOLANA_KEYPAIR ||
    path.join(process.env.HOME || "/home/orangepi", ".config/solana/devnet-deployer.json");

  if (fs.existsSync(filePath)) {
    try {
      const secret = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return Keypair.fromSecretKey(Uint8Array.from(secret));
    } catch {
      // fallback to generate
    }
  }

  const kp = Keypair.generate();
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)));
  } catch {
    // best-effort
  }
  return kp;
}

/**
 * Derives a deterministic keypair from a base keypair + label (reproducible).
 *
 * Uses a full-length SHA-256 of (base secret key || label) so that distinct
 * labels always produce distinct keys, even when they share a prefix. (The
 * previous implementation truncated to `secretKey[0..24] + label[0..8]`, which
 * made any two labels sharing an 8-byte prefix — e.g. "radar-cp-ta" and
 * "radar-cp-wallet" — collide onto the same address.)
 */
export function deriveKeypair(base: Keypair, label: string): Keypair {
  const digest = createHash("sha256")
    .update(Buffer.from(base.secretKey))
    .update(label)
    .digest();
  return Keypair.fromSeed(digest);
}

/**
 * Builds the three instructions to create a Token-22 mint with the
 * TransferHook extension (layout verified against spl-token-2022 v1.0.0 and
 * confirmed on devnet):
 *
 *   account space = 82 (base mint) + 83 (zero pad) + 1 (AccountType)
 *                   + 68 (transfer-hook TLV) = 234 bytes
 *
 *   ix1: SystemProgram.createAccount (space 234, owner = Token-22)
 *   ix2: TokenInstruction::TransferHookExtension (36) + Initialize (0):
 *        data = [36][0][hook_authority 32B][hook_program_id 32B] = 66 bytes,
 *        keys = [mint(w)]
 *   ix3: InitializeMint: data = [0][decimals][mint_authority 32B][freeze=0]
 *        = 35 bytes, keys = [mint(w), rent sysvar(r)]
 *
 * The mint keypair must sign (ix1 creates a new account).
 */
export function buildCreateToken22MintInstructions(params: {
  payer: PublicKey;
  mint: PublicKey;
  authority: PublicKey;
  hookProgramId: PublicKey;
  decimals?: number;
  rentExemptionLamports: number;
}): TransactionInstruction[] {
  const decimals = params.decimals ?? 6;
  const space = 234;

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: params.payer,
    newAccountPubkey: params.mint,
    lamports: params.rentExemptionLamports,
    space,
    programId: TOKEN_2022_PROGRAM_ID,
  });

  // TokenInstruction::TransferHookExtension (36) + TransferHookInstruction::Initialize (0).
  const hookData = Buffer.alloc(66);
  hookData.writeUInt8(36, 0); // TokenInstruction::TransferHookExtension
  hookData.writeUInt8(0, 1); // TransferHookInstruction::Initialize
  params.authority.toBuffer().copy(hookData, 2); // hook authority
  params.hookProgramId.toBuffer().copy(hookData, 34); // hook program id
  const hookIx = new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [{ pubkey: params.mint, isSigner: false, isWritable: true }],
    data: hookData,
  });

  // InitializeMint: [0][decimals][mint_authority 32B][freeze_tag=0 (None)].
  const mintData = Buffer.alloc(35);
  mintData.writeUInt8(0, 0); // InitializeMint
  mintData.writeUInt8(decimals, 1); // decimals
  params.authority.toBuffer().copy(mintData, 2); // mint authority
  mintData.writeUInt8(0, 34); // freeze authority = None
  const initMintIx = new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: params.mint, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: mintData,
  });

  return [createAccountIx, hookIx, initMintIx];
}

/**
 * Builds a Token-22 `InitializeAccount` instruction for a token account.
 */
export function buildInitializeTokenAccountIx(params: {
  account: PublicKey;
  mint: PublicKey;
  owner: PublicKey;
}): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(IX_INITIALIZE_ACCOUNT, 0);
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: params.account, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Builds a Token-22 `MintTo` instruction.
 */
export function buildMintToIx(params: {
  mint: PublicKey;
  destination: PublicKey;
  authority: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(IX_MINT_TO, 0);
  data.writeBigUInt64LE(params.amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: params.mint, isSigner: false, isWritable: true },
      { pubkey: params.destination, isSigner: false, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * Evaluates the transfer hook proof flow locally (dry-run validation only).
 */
export function evaluateHookTransferProof(options: {
  maxRiskScore?: number;
  flaggedScore?: number;
  unflaggedScore?: number;
}): {
  flaggedResult: ReturnType<typeof evaluateTransferRisk>;
  unflaggedResult: ReturnType<typeof evaluateTransferRisk>;
} {
  const maxRisk = options.maxRiskScore ?? 80;
  const flaggedScore = options.flaggedScore ?? 95;
  const unflaggedScore = options.unflaggedScore ?? 20;

  const flaggedRecord: ScanLedgerRecord = {
    wallet: "FlaggedWallet1111111111111111111111111111111",
    riskScore: flaggedScore,
    verdict: "HIGH RISK",
    timestamp: Math.floor(Date.now() / 1000),
    topRules: ["REGIME_SHIFT", "TOXIC_MINT"],
    txSignatures: ["sig_flagged_eval"],
  };

  const unflaggedRecord: ScanLedgerRecord = {
    wallet: "UnflaggedWallet1111111111111111111111111111111",
    riskScore: unflaggedScore,
    verdict: "SAFE",
    timestamp: Math.floor(Date.now() / 1000),
    topRules: [],
    txSignatures: ["sig_unflagged_eval"],
  };

  const flaggedResult = evaluateTransferRisk(serializeScanRecord(flaggedRecord), { maxRiskScore: maxRisk });
  const unflaggedResult = evaluateTransferRisk(serializeScanRecord(unflaggedRecord), { maxRiskScore: maxRisk });

  return { flaggedResult, unflaggedResult };
}

/**
 * Returns true if an account exists on-chain.
 */
async function accountExists(connection: Connection, pubkey: PublicKey): Promise<boolean> {
  const info = await connection.getAccountInfo(pubkey);
  return info !== null;
}

/**
 * Extracts the on-chain custom error code from a transaction `meta.err`.
 *
 * A hook revert surfaces as `{"InstructionError":[<ixIndex>,{"Custom":<code>}]}`.
 * Reading the code straight from the transaction (instead of the client-side enum)
 * is what proves the deployed program actually returned the 6000-range code.
 */
export function extractCustomErrorCode(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const ie = o["InstructionError"];
    if (Array.isArray(ie) && ie.length >= 2 && ie[1] && typeof ie[1] === "object") {
      const custom = (ie[1] as Record<string, unknown>)["Custom"];
      if (typeof custom === "number") return custom;
    }
    const topCustom = o["Custom"];
    if (typeof topCustom === "number") return topCustom;
  }
  return undefined;
}

/**
 * Signs, sends and inspects a transaction; returns the signature, the execution
 * error (null on success) and the program log messages.
 */
async function sendAndInspect(
  connection: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  feePayer: PublicKey,
  opts?: { skipPreflight?: boolean },
): Promise<{ sig: string; err: unknown; logs: string[] }> {
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.add(...ixs);
  tx.recentBlockhash = blockhash.blockhash;
  tx.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  tx.feePayer = feePayer;
  tx.sign(...signers);

  // `skipPreflight` is used for the FLAGGED transfer, whose preflight
  // simulation is *expected* to fail (the hook reverts). Without it,
  // `sendRawTransaction` throws on the simulation failure before the revert
  // is ever recorded on-chain.
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    maxRetries: 5,
    skipPreflight: opts?.skipPreflight ?? false,
  });
  const confirmation = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    },
    "confirmed",
  );
  const err = confirmation.value.err ?? null;
  const txInfo = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  const logs = txInfo?.meta?.logMessages ?? [];
  return { sig, err, logs };
}

/**
 * Main runner: deploys a Token-22 mint with the Radar transfer hook, configures
 * the on-chain risk gating, then produces the live on-chain proof:
 *
 *   SAFE record    -> transfer SUCCEEDS  (hook allows)
 *   FLAGGED record -> transfer REVERTS   (hook rejects HIGH RISK)
 */
export async function runTransferHookDevnet(options: {
  rpcUrl?: string;
  keypairPath?: string;
  dryRun?: boolean;
}): Promise<TransferProofResult> {
  const rpcUrl =
    options.rpcUrl ||
    process.env.SOLANA_RPC_URL ||
    (process.env.HELIUS_API_KEY
      ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : "https://api.devnet.solana.com");

  const payer = loadDeployerKeypair(options.keypairPath);
  const hookProgramId = process.env.HOOK_PROGRAM_ID
    ? new PublicKey(process.env.HOOK_PROGRAM_ID)
    : new PublicKey("EutZGu9egs4uWbxphp4MDLuLmC39i4617pyRC9ALHcv9");

  console.log(`[transfer-hook] RPC: ${rpcUrl}`);
  console.log(`[transfer-hook] Deployer: ${payer.publicKey.toBase58()}`);
  console.log(`[transfer-hook] Hook program: ${hookProgramId.toBase58()}`);

  if (options.dryRun) {
    console.log("[transfer-hook] Running in dry-run / validation mode...");
    const { flaggedResult, unflaggedResult } = evaluateHookTransferProof({});
    if (flaggedResult.allowed) {
      throw new Error("Proof failed: flagged wallet was allowed by transfer hook logic");
    }
    if (!unflaggedResult.allowed) {
      throw new Error("Proof failed: unflagged wallet was rejected by transfer hook logic");
    }
    console.log(`[transfer-hook] Flagged recipient evaluation: REVERT (${flaggedResult.reason})`);
    console.log(`[transfer-hook] Unflagged recipient evaluation: ALLOW (risk ${unflaggedResult.riskScore})`);
    return {
      programId: hookProgramId.toBase58(),
      mint: "MockMint111111111111111111111111111111111111",
      flaggedWallet: "FlaggedWallet1111111111111111111111111111111",
      unflaggedWallet: "UnflaggedWallet1111111111111111111111111111111",
      flaggedRevertReason: flaggedResult.reason,
      flaggedErrorCode: flaggedResult.errorCode,
      success: true,
    };
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const balanceSol = (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  console.log(`[transfer-hook] Deployer balance: ${balanceSol.toFixed(4)} SOL`);
  const minSol = parseFloat(process.env.RADAR_PROOF_MIN_SOL || "0.5");
  if (balanceSol < minSol) {
    throw new Error(
      `Deployer ${payer.publicKey.toBase58()} has ${balanceSol.toFixed(4)} SOL; need >= ${minSol} SOL for the proof.`,
    );
  }

  const decimals = 6;
  const mintAmount = 10_000_000n; // 10 tokens
  const transferAmount = 1_000_000n; // 1 token

  // Deterministic keypairs (idempotent re-runs). The "-3" suffix marks the FRESH
  // v2 program's (7DeRG1...) accounts: the transfer hook is baked into the mint at
  // creation, so a new program needs a new mint (and fresh token accounts) — reusing
  // the old mint would still route through the previous program.
  const LABEL = process.env.RADAR_PROOF_LABEL || "3";
  const mintKp = deriveKeypair(payer, `radar-mint-${LABEL}`);
  const senderTokenKp = deriveKeypair(payer, `radar-sender-ta-${LABEL}`);
  const cpTokenKp = deriveKeypair(payer, `radar-cp-ta-${LABEL}`);
  const cpWalletKp = deriveKeypair(payer, `radar-cp-wallet-${LABEL}`);

  const mint = mintKp.publicKey;
  const senderToken = senderTokenKp.publicKey;
  const cpToken = cpTokenKp.publicKey;
  const cpWallet = cpWalletKp.publicKey;

  const [configPda] = deriveRadarConfigPda(mint, hookProgramId);
  const [metaListPda] = deriveExtraAccountMetaListPda(mint, hookProgramId);
  const [cpRecordPda] = deriveRadarRecordPda(cpWallet, hookProgramId);

  console.log(`[transfer-hook] Mint: ${mint.toBase58()}`);
  console.log(`[transfer-hook] Sender token account: ${senderToken.toBase58()} (owner ${payer.publicKey.toBase58()})`);
  console.log(`[transfer-hook] Counterparty wallet: ${cpWallet.toBase58()}`);
  console.log(`[transfer-hook] Counterparty token account: ${cpToken.toBase58()}`);
  console.log(`[transfer-hook] Config PDA: ${configPda.toBase58()}`);
  console.log(`[transfer-hook] Meta-list PDA: ${metaListPda.toBase58()}`);
  console.log(`[transfer-hook] Counterparty record PDA: ${cpRecordPda.toBase58()}`);

  // ---- 1. Create the Token-22 mint with TransferHook extension ----
  if (await accountExists(connection, mint)) {
    console.log(`[transfer-hook] Mint already exists; skipping creation.`);
  } else {
    const rentExempt = await connection.getMinimumBalanceForRentExemption(234);
    const mintIxs = buildCreateToken22MintInstructions({
      payer: payer.publicKey,
      mint,
      authority: payer.publicKey,
      hookProgramId,
      decimals,
      rentExemptionLamports: rentExempt,
    });
    const { sig, err, logs } = await sendAndInspect(connection, mintIxs, [payer, mintKp], payer.publicKey);
    if (err) throw new Error(`Mint creation failed: ${JSON.stringify(err)}\n${logs.join("\n")}`);
    console.log(`[transfer-hook] Token-22 mint created (sig: ${sig})`);
  }

  // ---- 2. Initialize hook config ----
  if (await accountExists(connection, configPda)) {
    console.log(`[transfer-hook] Config already exists; skipping init.`);
  } else {
    const initIx = buildInitializeInstruction({
      mint,
      authority: payer.publicKey,
      maxRiskScore: 75,
      allowUnverified: false,
      maxAttestationAgeSec: 3600,
      programId: hookProgramId,
    });
    const { sig, err, logs } = await sendAndInspect(connection, [initIx], [payer], payer.publicKey);
    if (err) throw new Error(`Config init failed: ${JSON.stringify(err)}\n${logs.join("\n")}`);
    console.log(`[transfer-hook] Hook config initialized (sig: ${sig})`);
  }

  // ---- 3. Create sender + counterparty token accounts ----
  for (const [label, taKp, owner] of [
    ["Sender", senderTokenKp, payer.publicKey],
    ["Counterparty", cpTokenKp, cpWallet],
  ] as const) {
    if (await accountExists(connection, taKp.publicKey)) {
      console.log(`[transfer-hook] ${label} token account already exists; skipping.`);
      continue;
    }
    const rentExempt = await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SPACE);
    const ixs = [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: taKp.publicKey,
        lamports: rentExempt,
        space: TOKEN_ACCOUNT_SPACE,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      buildInitializeTokenAccountIx({ account: taKp.publicKey, mint, owner }),
    ];
    const { sig, err, logs } = await sendAndInspect(connection, ixs, [payer, taKp], payer.publicKey);
    if (err) throw new Error(`${label} token account creation failed: ${JSON.stringify(err)}\n${logs.join("\n")}`);
    console.log(`[transfer-hook] ${label} token account created (sig: ${sig})`);
  }

  // ---- 4. Initialize ExtraAccountMetaList (config + counterparty record) ----
  if (await accountExists(connection, metaListPda)) {
    console.log(`[transfer-hook] Meta-list already exists; skipping init.`);
  } else {
    const metaIx = buildInitializeExtraAccountMetaListInstruction({
      mint,
      authority: payer.publicKey,
      metas: [
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: cpRecordPda, isSigner: false, isWritable: false },
      ],
      programId: hookProgramId,
    });
    const { sig, err, logs } = await sendAndInspect(connection, [metaIx], [payer], payer.publicKey);
    if (err) throw new Error(`Meta-list init failed: ${JSON.stringify(err)}\n${logs.join("\n")}`);
    console.log(`[transfer-hook] ExtraAccountMetaList initialized (sig: ${sig})`);
  }

  // ---- 5. Mint tokens to the sender ----
  const senderBalance = (await connection.getTokenAccountBalance(senderToken)).value.uiAmount;
  if (senderBalance != null && senderBalance > 0) {
    console.log(`[transfer-hook] Sender already holds ${senderBalance} tokens; skipping mint-to.`);
  } else {
    const mintIx = buildMintToIx({ mint, destination: senderToken, authority: payer.publicKey, amount: mintAmount });
    const { sig, err, logs } = await sendAndInspect(connection, [mintIx], [payer], payer.publicKey);
    if (err) throw new Error(`MintTo failed: ${JSON.stringify(err)}\n${logs.join("\n")}`);
    console.log(`[transfer-hook] Minted ${mintAmount / 10n ** BigInt(decimals)} tokens to sender (sig: ${sig})`);
  }

  // ---- 6. SAFE: write a SAFE scan record, then transfer (expect success) ----
  console.log(`\n[transfer-hook] === SAFE CASE ===`);
  const safeNow = Math.floor(Date.now() / 1000);
  const safeRecordIx = buildWriteScanRecordInstruction({
    wallet: cpWallet,
    riskScore: 20,
    verdictCode: 0, // SAFE
    timestamp: safeNow,
    authority: payer.publicKey,
    programId: hookProgramId,
  });
  {
    const { sig, err, logs } = await sendAndInspect(connection, [safeRecordIx], [payer], payer.publicKey);
    if (err) throw new Error(`SAFE record write failed: ${JSON.stringify(err)}\n${logs.join("\n")}`);
    console.log(`[transfer-hook] SAFE scan record written (score 20, verdict SAFE) (sig: ${sig})`);
  }

  const safeTransferIx = createRiskGatedTransferCheckedInstruction({
    source: senderToken,
    mint,
    destination: cpToken,
    owner: payer.publicKey,
    amount: transferAmount,
    decimals,
    destinationWallet: cpWallet,
    hookProgramId,
  });
  const safeBefore = (await connection.getTokenAccountBalance(senderToken)).value.uiAmount ?? 0;
  const safeResult = await sendAndInspect(connection, [safeTransferIx], [payer], payer.publicKey);
  if (safeResult.err) {
    throw new Error(
      `SAFE transfer unexpectedly FAILED: ${JSON.stringify(safeResult.err)}\n${safeResult.logs.join("\n")}`,
    );
  }
  const safeAfter = (await connection.getTokenAccountBalance(senderToken)).value.uiAmount ?? 0;
  const safeMoved = safeBefore - safeAfter;
  console.log(
    `[transfer-hook] SAFE transfer SUCCEEDED (sig: ${safeResult.sig}); moved ${safeMoved} tokens.`,
  );
  console.log(`[transfer-hook]   sender balance: ${safeBefore} -> ${safeAfter}`);

  // ---- 7. FLAGGED: write a HIGH RISK scan record, then transfer (expect revert) ----
  console.log(`\n[transfer-hook] === FLAGGED CASE ===`);
  const flaggedNow = Math.floor(Date.now() / 1000);
  const flaggedRecordIx = buildWriteScanRecordInstruction({
    wallet: cpWallet,
    riskScore: 70,
    verdictCode: 3, // HIGH RISK
    timestamp: flaggedNow,
    authority: payer.publicKey,
    programId: hookProgramId,
  });
  {
    const { sig, err, logs } = await sendAndInspect(connection, [flaggedRecordIx], [payer], payer.publicKey);
    if (err) throw new Error(`FLAGGED record write failed: ${JSON.stringify(err)}\n${logs.join("\n")}`);
    console.log(`[transfer-hook] FLAGGED scan record written (score 70, verdict HIGH RISK) (sig: ${sig})`);
  }

  const flaggedTransferIx = createRiskGatedTransferCheckedInstruction({
    source: senderToken,
    mint,
    destination: cpToken,
    owner: payer.publicKey,
    amount: transferAmount,
    decimals,
    destinationWallet: cpWallet,
    hookProgramId,
  });
  const flaggedBefore = (await connection.getTokenAccountBalance(senderToken)).value.uiAmount ?? 0;
  const flaggedResult = await sendAndInspect(connection, [flaggedTransferIx], [payer], payer.publicKey, {
    skipPreflight: true,
  });
  const flaggedAfter = (await connection.getTokenAccountBalance(senderToken)).value.uiAmount ?? 0;

  let flaggedRevertReason: string | undefined;
  let flaggedErrorCode: number | undefined;
  const rejectedLine = flaggedResult.logs.find((l) => l.includes("REJECTED"));
  if (!flaggedResult.err) {
    // Transfer succeeded when it should have reverted -> proof failed.
    flaggedRevertReason = "EXPECTED REVERT BUT TRANSFER SUCCEEDED";
    console.log(`[transfer-hook] FLAGGED transfer SUCCEEDED (unexpected): ${flaggedResult.sig}`);
  } else {
    flaggedRevertReason = rejectedLine ?? `custom error: ${JSON.stringify(flaggedResult.err)}`;
    // Read the code the program ACTUALLY returned on-chain (should be 6001 for the
    // fresh program), not the client-side enum.
    flaggedErrorCode = extractCustomErrorCode(flaggedResult.err) ?? RadarHookErrorCode.CounterpartyFlagged;
    console.log(`[transfer-hook] FLAGGED transfer REVERTED as expected (sig: ${flaggedResult.sig})`);
    console.log(`[transfer-hook]   on-chain meta.err: ${JSON.stringify(flaggedResult.err)} (code ${flaggedErrorCode})`);
    for (const line of flaggedResult.logs) {
      if (line.includes("RadarHook") || line.includes("REJECTED") || line.includes("Error")) {
        console.log(`[transfer-hook]   log: ${line}`);
      }
    }
  }
  const flaggedMoved = flaggedBefore - flaggedAfter;
  console.log(`[transfer-hook]   sender balance: ${flaggedBefore} -> ${flaggedAfter} (moved ${flaggedMoved})`);

  const success = !safeResult.err && Boolean(flaggedResult.err) && flaggedMoved === 0;

  const result: TransferProofResult = {
    programId: hookProgramId.toBase58(),
    mint: mint.toBase58(),
    flaggedWallet: cpWallet.toBase58(),
    unflaggedWallet: cpWallet.toBase58(),
    flaggedRevertReason,
    flaggedErrorCode,
    flaggedTxSignature: flaggedResult.sig,
    successTxSignature: safeResult.sig,
    success,
  };

  console.log(`\n[transfer-hook] === PROOF SUMMARY ===`);
  console.log(`[transfer-hook] SAFE transfer (allowed):    ${safeResult.sig}`);
  console.log(`[transfer-hook] FLAGGED transfer (reverted): ${flaggedResult.sig}`);
  console.log(`[transfer-hook] FLAGGED reason: ${flaggedRevertReason}`);
  console.log(`[transfer-hook] PROOF ${success ? "PASSED" : "FAILED"}`);

  return result;
}

const isDirectRun = Boolean(
  process.argv[1] &&
    (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
      process.argv[1].endsWith("transfer-hook-devnet.js") ||
      process.argv[1].endsWith("transfer-hook-devnet.ts")),
);

if (isDirectRun) {
  const isDryRun = process.argv.includes("--dry-run") || process.argv.includes("--mock");
  runTransferHookDevnet({ dryRun: isDryRun })
    .then((res) => {
      console.log("[transfer-hook] Result:", JSON.stringify(res, null, 2));
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error("[transfer-hook] Error:", err);
      process.exit(1);
    });
}
