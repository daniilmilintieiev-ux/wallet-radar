// Focused diagnostic: re-run ONLY the FLAGGED transfer (record write + transfer in
// one tx) several times to see whether the stale 12000-range error is per-validator
// (a retry might hit a fresh executable -> 6001) or deterministic (always 12001).
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  buildWriteScanRecordInstruction,
  createRiskGatedTransferCheckedInstruction,
} from "../dist/src/hook/index.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const P2 = new PublicKey(process.env.HOOK_PROGRAM_ID || "7DeRG1BDToqYnfACzSdS4MfEwTGBCmkFo7Y61dmE2t2C");
const MINT = new PublicKey(process.env.MINT_ID || "5K9UhdJZVqWDHrBQcCBsfzqwEZ4APTgu7UTd1iA9JYXG");
const SENDER = new PublicKey(process.env.SENDER_TA || "FEYUp5ssyqpKHx6eBwPzcCf5TXSJkLrveZmvGt9Tv14r");
const CP_TOKEN = new PublicKey(process.env.CP_TOKEN || "GRUz478i33wf3j3M5A8WYGLRGGQrGGhUHnJiD1gafsuG");
const CP_WALLET = new PublicKey(process.env.CP_WALLET || "2gjFkrw3BdioMKnbzf6KaKxQZsewVERjaAZyRp5CRDF6");
const decimals = 6;
const amount = 1_000_000n;

const conn = new Connection(RPC, "confirmed");
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("E:/JOB/earn/solana-keys/devnet-deployer.json", "utf8"))),
);

function extractCode(err) {
  if (!err) return undefined;
  if (err.InstructionError) {
    const e = err.InstructionError[1];
    if (e && e.Custom !== undefined) return e.Custom;
  }
  if (err.Custom !== undefined) return err.Custom;
  return undefined;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const senderBal = (await conn.getTokenAccountBalance(SENDER)).value.uiAmount;
console.log(`[retry] sender balance before: ${senderBal}`);

for (let i = 1; i <= 6; i++) {
  const now = Math.floor(Date.now() / 1000);
  const recordIx = buildWriteScanRecordInstruction({
    wallet: CP_WALLET,
    riskScore: 70,
    verdictCode: 3, // HIGH RISK
    timestamp: now,
    authority: deployer.publicKey,
    programId: P2,
  });
  const transferIx = createRiskGatedTransferCheckedInstruction({
    source: SENDER,
    mint: MINT,
    destination: CP_TOKEN,
    owner: deployer.publicKey,
    amount,
    decimals,
    destinationWallet: CP_WALLET,
    hookProgramId: P2,
  });
  const bh = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.add(recordIx);
  tx.add(transferIx);
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = deployer.publicKey;
  tx.sign(deployer);
  let code, sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    const resp = await conn.confirmTransaction(
      { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
      "confirmed",
    );
    code = extractCode(resp.value.err);
  } catch (e) {
    code = "SEND_ERR:" + String(e.message).slice(0, 70);
  }
  console.log(`[retry ${i}] FLAGGED -> Custom=${code}  sig=${sig}`);
  await sleep(1500);
}
