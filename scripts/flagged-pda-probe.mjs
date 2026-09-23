// Discriminating probe: call the P4 hook `execute` DIRECTLY (no Token-22) with
// different record PDAs. The error code reveals which executable actually runs:
//   6001/6009  -> new build (6000-range, record PDA check, declare_id P4)
//   12001/12009 -> build with 12000-range
//   12004      -> old build without PDA check reading an empty record
// V1: correct P4-derived record (has FLAGGED data from prior retries)
// V2: record PDA derived under the OLD program (likely nonexistent account)
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  buildTransferHookExecuteInstruction,
  deriveRadarRecordPda,
} from "../dist/src/hook/index.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const P4 = new PublicKey(process.env.HOOK_PROGRAM_ID || "wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV");
const OLD = new PublicKey("ASXvQYqhWYz82YFcqHUdcWDNotqt9atTJYp3xDHiV8Qz");
const MINT = new PublicKey(process.env.MINT_ID || "A3ZxXVM5JThQbCH5thF8jkTf1eNvB3uYWdtzXJbYXQbh");
const SENDER = new PublicKey(process.env.SENDER_TA || "4gaY71d7WfqWnwKF7JdKerKXNDEVgKUahyWVpG5MT5js");
const CP_TOKEN = new PublicKey(process.env.CP_TOKEN || "ETDFexyBDZaZ9vnokDYsBWmMuhRsyLR3Ld4jg9NYCEtD");
const CP_WALLET = new PublicKey(process.env.CP_WALLET || "4UAH3q1pVUQF3kUQ8SHHYu6HZtT8gCGXUdZ3AwX3BZAY");

const conn = new Connection(RPC, "confirmed");
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("E:/JOB/earn/solana-keys/devnet-deployer.json", "utf8"))),
);

function extractCode(err) {
  if (!err) return "OK";
  if (err.InstructionError) {
    const e = err.InstructionError[1];
    if (e && e.Custom !== undefined) return "Custom=" + e.Custom + " (ix " + err.InstructionError[0] + ")";
    return "IxErr:" + JSON.stringify(e);
  }
  if (err.Custom !== undefined) return "Custom=" + err.Custom;
  return "Err:" + JSON.stringify(err).slice(0, 80);
}
const [correctRecord] = deriveRadarRecordPda(CP_WALLET, P4);
const [wrongRecord] = deriveRadarRecordPda(CP_WALLET, OLD);
console.log(`correct record (P4-derived):  ${correctRecord.toBase58()}`);
console.log(`wrong record   (OLD-derived): ${wrongRecord.toBase58()}`);
const wrongAcc = await conn.getAccountInfo(wrongRecord);
console.log(`wrong record account exists:  ${wrongAcc !== null} (data len ${wrongAcc ? wrongAcc.data.length : 0})`);
const correctAcc = await conn.getAccountInfo(correctRecord);
console.log(`correct record data len:      ${correctAcc ? correctAcc.data.length : "missing"}`);

const variants = [
  ["V1-correct-flagged", correctRecord],
  ["V2-wrong-old-derived", wrongRecord],
];

for (let round = 1; round <= 3; round++) {
  for (const [label, record] of variants) {
    const ix = buildTransferHookExecuteInstruction({
      source: SENDER,
      mint: MINT,
      destination: CP_TOKEN,
      owner: deployer.publicKey,
      amount: 1_000_000n,
      record,
      programId: P4,
    });
    const bh = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    tx.add(ix);
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = deployer.publicKey;
    tx.sign(deployer);
    let out;
    try {
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      const resp = await conn.confirmTransaction(
        { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
        "confirmed",
      );
      out = `${extractCode(resp.value.err)}  sig=${sig.slice(0, 24)}...`;
      if (resp.value.err) {
        const full = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
        if (full && full.meta && full.meta.innerInstructions) {
          for (const ii of full.meta.innerInstructions) {
            for (const l of ii.programLogs || []) console.log(`     inner: ${l}`);
          }
        }
        if (full && full.meta && full.meta.logMessages) {
          for (const l of full.meta.logMessages.slice(-8)) console.log(`     log: ${l}`);
        }
      }
    } catch (e) {
      out = "SEND_ERR: " + String(e.message).slice(0, 90);
      if (e.logs) for (const l of e.logs.slice(-6)) console.log(`     prelog: ${l}`);
    }
    console.log(`[r${round}] ${label}: ${out}`);
    await new Promise((r) => setTimeout(r, 1200));
  }
}
