// Closes a BPF upgradeable loader buffer (reclaims rent) via `Close` (disc 5).
//   accounts: [buffer(w), recipient(w), authority(signer)]
// Env: BUFFER_LABEL (default radar-buffer-fresh)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DEFAULT_KEY_DIR = process.env.SOLANA_KEY_DIR || path.join(process.cwd(), "keys");
const AUTHORITY_PATH =
  process.env.AUTHORITY_KEYPAIR || path.join(DEFAULT_KEY_DIR, "radar-hook-program-keypair.json");
const DEPLOYER_PATH =
  process.env.DEPLOYER_KEYPAIR || path.join(DEFAULT_KEY_DIR, "devnet-deployer.json");
const LABEL = process.env.BUFFER_LABEL || "radar-buffer-fresh";

function deriveKp(base, label) {
  const seed = crypto.createHash("sha256").update(Buffer.concat([base.secretKey, Buffer.from(label)])).digest();
  return Keypair.fromSeed(seed);
}

function loadKp(p, label) {
  if (!fs.existsSync(p)) {
    throw new Error(`${label} keypair not found at ${p}. Set corresponding env variable or SOLANA_KEY_DIR.`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

const conn = new Connection(RPC, "confirmed");
const authority = loadKp(AUTHORITY_PATH, "Authority");
const deployer = loadKp(DEPLOYER_PATH, "Deployer");
const bufferKp = deriveKp(deployer, LABEL);
const BUFFER = bufferKp.publicKey;

const buf = await conn.getAccountInfo(BUFFER);
if (!buf) { console.log(`[close-buffer] buffer ${BUFFER.toBase58()} (${LABEL}) not found — nothing to do`); process.exit(0); }
if (buf.owner.toBase58() !== BPF_LOADER.toBase58()) throw new Error(`buffer owner is ${buf.owner.toBase58()}`);
if (buf.data.readUInt32LE(0) !== 1) throw new Error(`buffer discriminant is ${buf.data.readUInt32LE(0)}, expected 1 (Buffer)`);
console.log(`[close-buffer] buffer ${BUFFER.toBase58()}: len=${buf.data.length} lamports=${buf.lamports}`);

const closeIx = new TransactionInstruction({
  programId: BPF_LOADER,
  keys: [
    { pubkey: BUFFER, isSigner: false, isWritable: true },
    { pubkey: deployer.publicKey, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
  ],
  data: Buffer.from([5, 0, 0, 0]),
});
const bh = await conn.getLatestBlockhash("confirmed");
const tx = new Transaction();
tx.add(closeIx);
tx.recentBlockhash = bh.blockhash;
tx.feePayer = deployer.publicKey;
tx.sign(deployer, authority);
const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
const st = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
if (st.value.err) throw new Error(`Close failed: ${JSON.stringify(st.value.err)} sig=${sig}`);
console.log(`[close-buffer] sig=${sig}`);
console.log(`[close-buffer] Deployer balance: ${((await conn.getBalance(deployer.publicKey)) / 1e9).toFixed(6)} SOL`);
const after = await conn.getAccountInfo(BUFFER);
console.log(`[close-buffer] buffer after: ${after ? `exists lamports=${after.lamports}` : "gone"}`);
