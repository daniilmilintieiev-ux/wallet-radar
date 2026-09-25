#!/usr/bin/env node
// Wallet Radar — "gate before you copy" agent.
// A copy-trading agent screens its TARGET wallet through the live Wallet Radar
// trust-gate (A2A) BEFORE it copies. It applies its own policy (verdict + risk
// tolerance + liquidity floor) and decides COPY / HOLD / REVIEW.
//
// Modes:
//   a2a   (default) — free pre-flight gate via POST /a2a on the 7690 surface.
//   --x402          — pay-per-call path: show the 402 payment requirement (4020).
//   --pay           — (with RADAR_PAYER_KEYPAIR + funded USDC) pay the gate via
//                     x402 and run the paid call. Uses @solana/web3.js.
//
// Usage:
//   node demo/copy-gate.mjs [target ...] [--max-risk N] [--min-liquidity N]
//   node demo/copy-gate.mjs --x402 [target ...]
//   RADAR_PAYER_KEYPAIR=<base58> node demo/copy-gate.mjs --pay [target ...]

const BASE = process.env.RADAR_BASE_URL ?? "https://radar.cbellory.xyz";
const X402_BASE = process.env.RADAR_X402_URL ?? "https://pay.cbellory.xyz";

// Default copy-book: a historically high-risk whale (HOLD) + active validator/counterparty (COPY).
const DEFAULT_TARGETS = [
  "8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j",
  "scs1NCSTafrUX6RBx113B9YDCepo1QdEzU8WwEkf25i",
];

function parseArgs(argv) {
  const args = { targets: [], maxRisk: undefined, minLiquidity: undefined, mode: "a2a", pay: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--x402") args.mode = "x402";
    else if (a === "--pay") { args.pay = true; args.mode = "x402"; }
    else if (a === "--max-risk") args.maxRisk = Number(argv[++i]);
    else if (a === "--min-liquidity") args.minLiquidity = Number(argv[++i]);
    else if (!a.startsWith("--")) args.targets.push(a);
  }
  return args;
}

// A2A JSON-RPC message/send → the pre-flight trust gate (free, 7690).
async function gateA2A(wallet, { maxRisk, minLiquidity }) {
  const body = {
    jsonrpc: "2.0",
    id: "1",
    method: "message/send",
    params: { message: { role: "user", parts: [{ kind: "text", text: `Screen wallet ${wallet}` }] } },
    ...(maxRisk !== undefined ? { maxRisk } : {}),
    ...(minLiquidity !== undefined ? { minLiquidityUsd: minLiquidity } : {}),
  };
  const res = await fetch(`${BASE}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`A2A HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(`A2A error: ${json.error.message}`);
  const parts = json.result?.parts ?? [];
  const data = parts.find((p) => p.kind === "data")?.data;
  if (!data) throw new Error("A2A response had no structured data part");
  return data;
}

// x402 pay-per-call path (4020). Without payment → 402 requirement.
async function gateX402(wallet, { pay }) {
  const headers = { "content-type": "application/json" };
  if (pay) {
    const proof = await payX402();
    headers["x-payment-signature"] = proof.signature;
    headers["x-payment-payer"] = proof.payer;
  }
  const res = await fetch(`${X402_BASE}/scan`, {
    method: "POST",
    headers,
    body: JSON.stringify({ wallet }),
  });
  return { status: res.status, json: await res.json() };
}

// The agent's copy/hold policy, applied on top of the gate verdict.
function decide(result, { maxRisk = 30, minLiquidity = 0 }) {
  const verdict = result.verdict;
  const risk = result.riskScore ?? 0;
  const liq = result.liquidityUsd ?? 0;
  const reasons = [];
  if (verdict !== "safe") reasons.push(`gate verdict = ${verdict}`);
  if (risk > maxRisk) reasons.push(`risk ${risk} > max ${maxRisk}`);
  if (liq < minLiquidity) reasons.push(`liquidity $${liq.toFixed(0)} < floor $${minLiquidity}`);
  if (reasons.length) return { action: "HOLD", reasons };
  return { action: "COPY", reasons: [] };
}

function fmtResult(r) {
  const top = (r.anomalies ?? []).slice(0, 3).map((a) => `${a.type}(${a.severity})`).join(", ");
  return `verdict=${r.verdict} risk=${r.riskScore}/100 liquidity=$${(r.liquidityUsd ?? 0).toFixed(0)} anomalies=${r.anomalyCount ?? 0}${top ? ` [${top}]` : ""}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = args.targets.length ? args.targets : DEFAULT_TARGETS;
  const label = args.pay ? "x402 PAY (pay-per-call)" : args.mode === "x402" ? "x402 402-flow (pay-per-call)" : "a2a pre-flight (free)";
  console.log(`\nWallet Radar — gate-before-you-copy agent  [${label}]`);
  console.log(`policy: copy only if verdict=safe AND risk<=${args.maxRisk ?? 30} AND liquidity>=$${args.minLiquidity ?? 0}\n`);

  for (let i = 0; i < targets.length; i++) {
    const w = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] target ${w}\n`);
    try {
      if (args.mode === "a2a") {
        const r = await gateA2A(w, { maxRisk: args.maxRisk, minLiquidity: args.minLiquidity });
        const d = decide(r, { maxRisk: args.maxRisk ?? 30, minLiquidity: args.minLiquidity ?? 0 });
        console.log(`    gate: ${fmtResult(r)}`);
        console.log(`    decision: ${d.action}${d.reasons.length ? ` — ${d.reasons.join("; ")}` : " — target cleared the trust-gate"}\n`);
      } else {
        const { status, json } = await gateX402(w, { pay: args.pay });
        if (status === 402) {
          const x = json.x402 ?? {};
          console.log(`    gate: PAY-PER-CALL — HTTP 402, pay ${x.amount} ${x.units} to ${x.recipient}`);
          console.log(`    decision: HOLD (unpaid) — the gate is pay-per-call; ${args.pay ? "payment failed" : "pass --pay with a funded wallet to complete"}\n`);
        } else {
          const r = json;
          const d = decide(r, { maxRisk: args.maxRisk ?? 30, minLiquidity: args.minLiquidity ?? 0 });
          console.log(`    gate: ${fmtResult(r)}`);
          console.log(`    decision: ${d.action}${d.reasons.length ? ` — ${d.reasons.join("; ")}` : ""}\n`);
        }
      }
    } catch (e) {
      console.log(`    ERROR: ${e.message}\n`);
    }
  }
}

// --- x402 real payment (only loaded when --pay) -------------------------------
// Transfers 0.005 USDC (6 decimals = 5000 units) from the payer's USDC ATA to
// the gate's recipient ATA, then returns the tx signature for the X-Payment-*
// headers. The gate verifies the transfer on-chain (getTransaction + balance delta).
async function payX402() {
  if (!process.env.RADAR_PAYER_KEYPAIR) {
    throw new Error("RADAR_PAYER_KEYPAIR env (base58 secret key) is required for --pay");
  }
  const { Connection, Keypair, PublicKey } = await import("@solana/web3.js");
  const { getAssociatedTokenAddressSync, transferChecked } = await import("@solana/spl-token");
  const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const RECIPIENT = new PublicKey("F6wWPy4c3fXTJDqU19Nax8FhQumeMcsSVpD2YwxLpBNR");
  const rpc = process.env.SOLANA_RPC_URL
    ?? (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com");

  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.RADAR_PAYER_KEYPAIR)));
  const sourceAta = getAssociatedTokenAddressSync(USDC_MINT, payer.publicKey);
  const destAta = getAssociatedTokenAddressSync(USDC_MINT, RECIPIENT);
  const conn = new Connection(rpc, "confirmed");
  // 0.005 USDC (6 decimals = 5000 units) from the payer's ATA to the gate's recipient ATA.
  const signature = await transferChecked(conn, payer, sourceAta, USDC_MINT, destAta, payer.publicKey, 5000n, 6, undefined, { commitment: "confirmed" });
  return { signature, payer: payer.publicKey.toBase58() };
}

main().catch((e) => { console.error(e); process.exit(1); });
