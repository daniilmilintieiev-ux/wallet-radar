// Reclaims the rent of the superseded v1 program's ProgramData account via the
// BPF upgradeable loader `Close` instruction (agave v4.3.0-rc.0, lib.rs:717):
//   accounts: [programdata(w), recipient(w), authority(signer), program(w)]
// The ProgramData's upgrade_authority must match the signer (account 2), and the
// program account (account 3) must be a loader-owned Program pointing at this
// ProgramData. After close, the lamports move to the recipient and the loader
// stores a CLOSED tombstone for the program key in the program cache.
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const AUTHORITY_PATH = process.env.AUTHORITY_KEYPAIR || "E:/JOB/earn/solana-keys/radar-hook-program-keypair.json";
const DEPLOYER_PATH = process.env.DEPLOYER_KEYPAIR || "E:/JOB/earn/solana-keys/devnet-deployer.json";
const PROGRAM_DATA = new PublicKey(process.env.CLOSE_PROGRAM_DATA || "GFD5PTTLvJCEkL4qvvEjBCDH38hcjNtGe9Tf219LrVoH");
const PROGRAM = new PublicKey(process.env.CLOSE_PROGRAM || "ASXvQYqhWYz82YFcqHUdcWDNotqt9atTJYp3xDHiV8Qz");

const conn = new Connection(RPC, "confirmed");
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(AUTHORITY_PATH, "utf8"))));
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(DEPLOYER_PATH, "utf8"))));

// ---- Pre-flight: verify ProgramData state + upgrade authority ----
const pd = await conn.getAccountInfo(PROGRAM_DATA);
if (!pd) throw new Error("ProgramData not found");
if (pd.owner.toBase58() !== BPF_LOADER.toBase58()) throw new Error(`ProgramData owner is ${pd.owner.toBase58()}`);
const disc = pd.data.readUInt32LE(0);
if (disc !== 3) throw new Error(`ProgramData discriminant is ${disc}, expected 3 (ProgramData)`);
const slot = pd.data.readBigUInt64LE(4);
const optTag = pd.data[12];
if (optTag !== 1) throw new Error(`upgrade authority Option tag is ${optTag}, expected 1 (Some)`);
const pdAuthority = new PublicKey(pd.data.subarray(13, 45));
console.log(`[close] ProgramData ${PROGRAM_DATA.toBase58()}: len=${pd.data.length} slot=${slot} lamports=${pd.lamports}`);
console.log(`[close] upgrade authority: ${pdAuthority.toBase58()}`);
if (!pdAuthority.equals(authority.publicKey)) throw new Error("ProgramData upgrade authority != our authority keypair");

const prog = await conn.getAccountInfo(PROGRAM);
if (!prog) throw new Error("Program account not found");
if (prog.owner.toBase58() !== BPF_LOADER.toBase58()) throw new Error(`Program owner is ${prog.owner.toBase58()}`);
const progDisc = prog.data.readUInt32LE(0);
if (progDisc !== 2) throw new Error(`Program discriminant is ${progDisc}, expected 2 (Program)`);
const linkedData = new PublicKey(prog.data.subarray(4, 36));
if (!linkedData.equals(PROGRAM_DATA)) throw new Error(`Program links to ${linkedData.toBase58()}, not our target`);

const clock = await conn.getSlot();
if (slot === BigInt(clock)) throw new Error("ProgramData slot == current slot (close would be rejected)");

// ---- Close: [programdata(w), recipient(w), authority(signer), program(w)] ----
const closeIx = new TransactionInstruction({
  programId: BPF_LOADER,
  keys: [
    { pubkey: PROGRAM_DATA, isSigner: false, isWritable: true },
    { pubkey: deployer.publicKey, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    { pubkey: PROGRAM, isSigner: false, isWritable: true },
  ],
  data: Buffer.from([5, 0, 0, 0]), // UpgradeableLoaderInstruction::Close (fixint u32 LE)
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
console.log(`[close] sig=${sig}`);
console.log(`[close] Deployer new balance: ${((await conn.getBalance(deployer.publicKey)) / 1e9).toFixed(6)} SOL`);
const pdAfter = await conn.getAccountInfo(PROGRAM_DATA);
console.log(`[close] ProgramData after: ${pdAfter ? `exists len=${pdAfter.data.length} lamports=${pdAfter.lamports}` : "gone"}`);
