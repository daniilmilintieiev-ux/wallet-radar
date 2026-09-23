// Extend P4's ProgramData account via the BPF loader's ExtendProgram
// instruction (discriminator 6, v4.3.0-rc.0). Needed because the Phase A ELF
// (215944 B) exceeds the current ProgramData capacity (215013 B ELF max).
// additional_bytes = 10240 satisfies SIMD-0431's 10 KiB minimum whether or
// not the feature gate is active on devnet.
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_DATA = new PublicKey(process.env.PROGRAM_DATA || "EmiU4LFiep9gqonS8ema6MFYeFjUXDYAp47ACzpoEAvY");
const PROGRAM = new PublicKey(process.env.PROGRAM || "wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV");
const ADDITIONAL_BYTES = Number(process.env.ADDITIONAL_BYTES || "10240");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

const DEFAULT_KEY_DIR = process.env.SOLANA_KEY_DIR || path.join(process.cwd(), "keys");
const DEPLOYER_PATH =
  process.env.DEPLOYER_KEYPAIR ||
  path.join(DEFAULT_KEY_DIR, "devnet-deployer.json");
if (!fs.existsSync(DEPLOYER_PATH)) {
  console.error(`Deployer keypair not found at ${DEPLOYER_PATH}. Set DEPLOYER_KEYPAIR or SOLANA_KEY_DIR.`);
  process.exit(1);
}
const conn = new Connection(RPC, "confirmed");
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(DEPLOYER_PATH, "utf8"))),
);

const before = await conn.getAccountInfo(PROGRAM_DATA);
const beforeLen = before.data.length;
const elfMaxBefore = beforeLen - 45;
console.log(`[extend] ProgramData BEFORE: ${beforeLen} bytes (ELF max ${elfMaxBefore})`);

// bincode fixint: the enum discriminant is a fixed 4-byte LE (same as the
// Upgrade=u32le(3) that reup-p2.mjs sends successfully).
const data = Buffer.alloc(8);
data.writeUInt32LE(6, 0); // UpgradeableLoaderInstruction::ExtendProgram
data.writeUInt32LE(ADDITIONAL_BYTES >>> 0, 4);

const ix = new TransactionInstruction({
  programId: BPF_LOADER,
  keys: [
    { pubkey: PROGRAM_DATA, isSigner: false, isWritable: true },
    { pubkey: PROGRAM, isSigner: false, isWritable: true },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
  ],
  data,
});

const tx = new Transaction();
tx.add(ix);
tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
tx.feePayer = deployer.publicKey;
tx.sign(deployer);

const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
console.log(`[extend] sig=${sig}`);
const dl = Date.now() + 90000;
while (Date.now() < dl) {
  const st = (await conn.getSignatureStatuses([sig])).value[0];
  if (st) {
    if (st.err) {
      const logs = (await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 }))?.meta?.logMessages || [];
      throw new Error(`extend failed: ${JSON.stringify(st.err)}\n${logs.join("\n")}`);
    }
    if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") break;
  }
  await new Promise((r) => setTimeout(r, 1500));
}
const after = await conn.getAccountInfo(PROGRAM_DATA);
console.log(`[extend] ProgramData AFTER:  ${after.data.length} bytes (ELF max ${after.data.length - 45})`);
console.log(`[extend] done`);
