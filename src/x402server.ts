import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { detectAnomalies, computeRiskScore } from "./analyzer.js";
import { updateBaseline } from "./baseline.js";
import { digestAnomalies } from "./digest.js";
import { fetchWalletTransactions } from "./collector.js";
import { fetchSwapPrices } from "./pricing.js";
import { fetchSwapMintRisk } from "./mint.js";
import { Store } from "./store.js";
import { getVersion, loadEnv } from "./mcp-server.js";
import { Baseline, EnhancedTx, SettledPayment, USDC_MINT } from "./types.js";
import { commitScan, ZKOracleClient, ScanLedgerRecord } from "./oracle/index.js";
import { computeVerdict } from "./htmlreport.js";
import { handleBlinkHttpRequest } from "./blink/index.js";
import { handleDashboardHttpRequest } from "./dashboard.js";
import { recordHeliusCost } from "./economics.js";
import { isValidBase58, validateConfig } from "./config.js";
import { buildTrustProof } from "./trust-proof.js";

/** Pricing in USDC per endpoint matching AgenticTrade manifest. */
export const X402_PRICING: Record<string, number> = {
  "/scan": 0.005,
  "/analyze": 0.001,
  "/selftest": 0.0,
};

export interface PaymentProof {
  signature: string;
  payer: string;
}

export interface PaymentRequirement {
  endpoint: string;
  recipient: string;
  minAmount: number;
  maxAgeSec?: number;
  mint?: string;
}

export interface PaymentVerificationResult {
  valid: boolean;
  error?: string;
  amount?: number;
  payer?: string;
  recipient?: string;
}

export type PaymentVerifier = (
  proof: PaymentProof,
  requirement: PaymentRequirement,
) => Promise<PaymentVerificationResult>;

export interface X402ServerOptions {
  port?: number;
  host?: string;
  store?: Store;
  dbPath?: string;
  recipient?: string;
  rpcUrl?: string;
  maxAgeSec?: number;
  paymentVerifier?: PaymentVerifier;
  scanHandler?: (wallet: string) => Promise<unknown>;
  analyzeHandler?: (wallet: string, txs: EnhancedTx[] | string) => Promise<unknown>;
  selftestHandler?: () => Promise<unknown>;
  oracleClient?: ZKOracleClient;
  commitScanFn?: typeof commitScan;
  enableOracle?: boolean;
}

function getRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (process.env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  }
  return "https://api.mainnet-beta.solana.com";
}

const OUTBOUND_FETCH_TIMEOUT_MS = 10_000;

export async function verifySolanaPaymentRpc(
  proof: PaymentProof,
  requirement: PaymentRequirement,
  rpcUrl: string = getRpcUrl(),
): Promise<PaymentVerificationResult> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "x402-verify",
        method: "getTransaction",
        params: [
          proof.signature,
          {
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
      signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { valid: false, error: `RPC HTTP error ${res.status}: ${res.statusText}` };
    }
    const json = (await res.json()) as any;
    if (json.error) {
      return { valid: false, error: `RPC error: ${json.error.message || JSON.stringify(json.error)}` };
    }
    const tx = json.result;
    if (!tx) {
      return { valid: false, error: "Transaction not found on-chain" };
    }
    if (tx.meta?.err) {
      return { valid: false, error: "Transaction failed on-chain" };
    }

    if (tx.blockTime && requirement.maxAgeSec) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec - tx.blockTime > requirement.maxAgeSec) {
        return {
          valid: false,
          error: `Transaction too old (${nowSec - tx.blockTime}s ago, max allowed ${requirement.maxAgeSec}s)`,
        };
      }
    }

    let transferred = 0;
    const targetMint = requirement.mint ?? USDC_MINT;
    const preTokenBalances = (tx.meta?.preTokenBalances || []) as any[];
    const postTokenBalances = (tx.meta?.postTokenBalances || []) as any[];

    // 1. Balance delta inspection for recipient
    for (const post of postTokenBalances) {
      if (post.owner === requirement.recipient && (!post.mint || post.mint === targetMint)) {
        const pre = preTokenBalances.find((b: any) => b.accountIndex === post.accountIndex);
        const preAmount = Number(pre?.uiTokenAmount?.uiAmount || 0);
        const postAmount = Number(post?.uiTokenAmount?.uiAmount || 0);
        const delta = postAmount - preAmount;
        if (delta > 0) transferred += delta;
      }
    }

    // 2. Parsed instructions fallback
    if (transferred === 0) {
      const inspectInstructions = (insts: any[]) => {
        for (const inst of insts) {
          const parsed = inst.parsed;
          if (parsed && (parsed.type === "transfer" || parsed.type === "transferChecked")) {
            const info = parsed.info;
            if (info) {
              const amount = Number(info.tokenAmount?.uiAmount ?? (info.amount ? Number(info.amount) / 1e6 : 0));
              if (info.destination === requirement.recipient || info.owner === requirement.recipient) {
                transferred += amount;
              }
            }
          }
        }
      };

      if (Array.isArray(tx.transaction?.message?.instructions)) {
        inspectInstructions(tx.transaction.message.instructions);
      }
      if (Array.isArray(tx.meta?.innerInstructions)) {
        for (const inner of tx.meta.innerInstructions) {
          if (Array.isArray(inner.instructions)) inspectInstructions(inner.instructions);
        }
      }
    }

    // Round to 6 decimal places (micro-USDC precision) to prevent floating point representation artifacts
    transferred = Math.round(transferred * 1e6) / 1e6;

    if (transferred < requirement.minAmount) {
      return {
        valid: false,
        error: `Insufficient payment: found ${transferred} USDC, required ${requirement.minAmount} USDC`,
        amount: transferred,
      };
    }

    return {
      valid: true,
      amount: transferred,
      payer: proof.payer,
      recipient: requirement.recipient,
    };
  } catch (err) {
    return { valid: false, error: `Verification exception: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function extractPaymentProof(req: http.IncomingMessage, body?: any): PaymentProof | null {
  const sigHeader = req.headers["x-payment-signature"];
  const payerHeader = req.headers["x-payment-payer"];
  if (typeof sigHeader === "string" && typeof payerHeader === "string" && sigHeader.trim() && payerHeader.trim()) {
    return { signature: sigHeader.trim(), payer: payerHeader.trim() };
  }

  const xPayHeader = req.headers["x-payment"];
  if (typeof xPayHeader === "string" && xPayHeader.trim()) {
    const trimmed = xPayHeader.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.signature && parsed.payer) {
          return { signature: String(parsed.signature).trim(), payer: String(parsed.payer).trim() };
        }
      } catch {}
    } else if (trimmed.includes(":")) {
      const [s, p] = trimmed.split(":");
      if (s && p) return { signature: s.trim(), payer: p.trim() };
    }
  }

  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("x402 ")) {
    const token = authHeader.slice(5).trim();
    if (token.includes(":")) {
      const [s, p] = token.split(":");
      if (s && p) return { signature: s.trim(), payer: p.trim() };
    }
  }

  if (body && typeof body === "object" && body.payment) {
    const { signature, payer } = body.payment;
    if (signature && payer) {
      return { signature: String(signature).trim(), payer: String(payer).trim() };
    }
  }

  return null;
}

export function send402(
  res: http.ServerResponse,
  endpoint: string,
  requiredAmount: number,
  recipient: string,
  detail?: string,
): void {
  res.writeHead(402, {
    "Content-Type": "application/json",
    "X-Payment-Required": "true",
    "X-Payment-Amount": String(requiredAmount),
    "X-Payment-Currency": "USDC",
    "X-Payment-Recipient": recipient,
  });
  res.end(
    JSON.stringify(
      {
        error: "Payment Required",
        ...(detail ? { detail } : {}),
        message: detail
          ? `Payment error for ${endpoint}: ${detail}`
          : `Payment of ${requiredAmount} USDC required for ${endpoint}. Recipient: ${recipient}`,
        x402: {
          version: "1.0",
          network: "solana",
          token: "USDC",
          mint: USDC_MINT,
          recipient,
          amount: requiredAmount,
          units: "USDC",
          proofFormat: {
            headers: {
              "X-Payment-Signature": "<tx_signature>",
              "X-Payment-Payer": "<payer_wallet_address>",
            },
            authHeader: "Authorization: x402 <signature>:<payer>",
            jsonHeader: "X-Payment: {\"signature\":\"...\",\"payer\":\"...\"}",
          },
        },
      },
      null,
      2,
    ),
  );
}

class PayloadTooLargeError extends Error {
  status = 413;
  constructor() {
    super("Payload Too Large");
  }
}

function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      data += chunk.toString();
      if (data.length > maxBytes) {
        rejected = true;
        reject(new PayloadTooLargeError());
        req.resume();
      }
    });
    req.on("end", () => {
      if (!rejected) resolve(data);
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

export function createX402Server(options: X402ServerOptions = {}): http.Server {
  const recipient =
    options.recipient ??
    process.env.RADAR_X402_RECIPIENT ??
    "11111111111111111111111111111111";

  const inFlightPayments = new Set<string>();

  const store =
    options.store ??
    (() => {
      const dbPath = options.dbPath ?? process.env.RADAR_DB ?? path.join(homedir(), ".wallet-radar", "radar.db");
      mkdirSync(path.dirname(dbPath), { recursive: true });
      return new Store(dbPath);
    })();

  const verifier: PaymentVerifier =
    options.paymentVerifier ??
    ((proof, req) => verifySolanaPaymentRpc(proof, req, options.rpcUrl));

  const defaultSelftestHandler = async () => {
    const wallet = "DemoWallet11111111111111111111111111111111";
    const txs: EnhancedTx[] = [
      { signature: "sigA", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
      { signature: "sigB", timestamp: 1_700_000_120, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
    ];
    const anomalies = detectAnomalies(wallet, txs, null);
    return { ok: true, riskScore: computeRiskScore(anomalies), anomalies, digest: digestAnomalies(anomalies) };
  };

  const defaultScanHandler = async (wallet: string) => {
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) {
      throw new Error("HELIUS_API_KEY is not configured on server");
    }
    const txs = await fetchWalletTransactions(apiKey, wallet);
    const prices = await fetchSwapPrices(txs);
    const mintRisk = await fetchSwapMintRisk(txs, { apiKey });
    const baseline: Baseline = updateBaseline(wallet, null, txs, Date.now() / 1000, prices);
    const anomalies = detectAnomalies(wallet, txs, null, undefined, prices, mintRisk);
    const riskScore = computeRiskScore(anomalies);
    const verdict = computeVerdict(riskScore);
    const txSignatures = txs.map((t) => t.signature).filter(Boolean).slice(0, 10);
    return {
      wallet,
      txCount: txs.length,
      lastSeenAt: baseline.lastSeenAt,
      pnl: baseline.pnl ?? null,
      pricesAvailable: prices !== null,
      priceCount: prices ? Object.keys(prices).length : 0,
      prices,
      riskScore,
      verdict,
      anomalies,
      digest: digestAnomalies(anomalies),
      txSignatures,
    };
  };

  const defaultAnalyzeHandler = async (wallet: string, txs: EnhancedTx[] | string) => {
    let parsed: EnhancedTx[];
    if (typeof txs === "string") {
      parsed = JSON.parse(txs);
    } else if (Array.isArray(txs)) {
      parsed = txs;
    } else {
      throw new Error("Invalid txs: expected a JSON array of transaction objects");
    }
    const anomalies = detectAnomalies(wallet, parsed, null);
    return {
      wallet,
      txCount: parsed.length,
      riskScore: computeRiskScore(anomalies),
      anomalies,
      digest: digestAnomalies(anomalies),
    };
  };

  const scanHandler = options.scanHandler ?? defaultScanHandler;
  const analyzeHandler = options.analyzeHandler ?? defaultAnalyzeHandler;
  const selftestHandler = options.selftestHandler ?? defaultSelftestHandler;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
      const pathname = url.pathname;
      const method = req.method?.toUpperCase() ?? "GET";

      // 0. Solana Actions / Blinks routes (/actions.json, /api/actions/...)
      if (pathname === "/actions.json" || pathname.startsWith("/api/actions")) {
        const handled = await handleBlinkHttpRequest(req, res, {
          recipient,
          rpcUrl: options.rpcUrl,
        });
        if (handled) return;
      }

      // 0.5 Web dashboard and ZK scan ledger (/dashboard, /api/ledger)
      if (pathname === "/dashboard" || pathname === "/api/ledger") {
        const handled = await handleDashboardHttpRequest(req, res, {
          store,
          rpcUrl: options.rpcUrl,
          oracleClient: options.oracleClient,
        });
        if (handled) return;
      }

      if (pathname === "/" || pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            {
              ok: true,
              status: "ok",
              service: "wallet-radar-x402",
              version: getVersion(),
              recipient,
              pricing: X402_PRICING,
              endpoints: {
                "/selftest": { method: "GET", priceUsdc: 0.0, description: "Free smoke test / health check" },
                "/scan": { method: "POST", priceUsdc: 0.005, description: "Live wallet scan with Helius & Jupiter" },
                "/analyze": { method: "POST", priceUsdc: 0.001, description: "Offline anomaly analysis over tx fixture" },
                "/dashboard": { method: "GET", priceUsdc: 0.0, description: "Web dashboard for ZK scan ledger" },
                "/api/ledger": { method: "GET", priceUsdc: 0.0, description: "JSON API for on-chain scan attestations" },
                "/trust-proof": { method: "GET", priceUsdc: 0.0, description: "Independently verifiable attestation bundle" },
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      if (pathname === "/trust-proof") {
        if (method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return;
        }
        const wallet = url.searchParams.get("wallet");
        if (!wallet) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "wallet query parameter is required (Solana base58 address)." }));
          return;
        }
        if (!isValidBase58(wallet)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "wallet query parameter must be a Solana base58 address." }));
          return;
        }
        const proof = await buildTrustProof(wallet, {
          oracleClient: options.oracleClient,
          rpcUrl: options.rpcUrl,
          store,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(proof, null, 2));
        return;
      }

      if (pathname === "/selftest") {
        if (method !== "GET" && method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return;
        }
        const result = await selftestHandler();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result, null, 2));
        return;
      }

      if (pathname === "/scan" || pathname === "/analyze") {
        if (method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return;
        }

        const requiredPrice = X402_PRICING[pathname];

        let body: Record<string, unknown> | null = null;
        try {
          const raw = await readBody(req);
          if (raw.trim()) {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "body must be a JSON object" }));
              return;
            }
            body = parsed;
          }
        } catch (err: unknown) {
          if (err instanceof PayloadTooLargeError || (err as { status?: number }).status === 413) {
            res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
            res.end(JSON.stringify({ error: "Payload Too Large" }));
            return;
          }
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }

        // 1. Extract payment proof
        const proof = extractPaymentProof(req, body);
        if (!proof) {
          send402(res, pathname, requiredPrice, recipient);
          return;
        }

        // Reject dry-run / mock payment bypass on paid routes
        if (req.headers["x-payment-dry-run"] === "true") {
          send402(res, pathname, requiredPrice, recipient, "Dry-run payments not allowed on paid routes");
          return;
        }

        // 2. Check replay in settled ledger and in-flight payments
        if (inFlightPayments.has(proof.signature) || store.hasSettledPayment(proof.signature)) {
          send402(res, pathname, requiredPrice, recipient, "Payment signature already settled (replay rejected)");
          return;
        }

        inFlightPayments.add(proof.signature);
        try {
          // 3. Verify payment
          const verResult = await verifier(proof, {
            endpoint: pathname,
            recipient,
            minAmount: requiredPrice,
            maxAgeSec: options.maxAgeSec,
            mint: USDC_MINT,
          });

          if (!verResult.valid) {
            send402(res, pathname, requiredPrice, recipient, verResult.error || "Payment verification failed");
            return;
          }

          // 3.5. Validate endpoint params BEFORE settling, so a validly-paid
          // request that is missing its parameters 400s without marking the
          // signature settled
          if (pathname === "/scan") {
            if (typeof body?.wallet !== "string" || !isValidBase58(body.wallet)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "body.wallet must be a Solana base58 address" }));
              return;
            }
          } else if (pathname === "/analyze") {
            const wallet = body?.wallet;
            if (!wallet || typeof wallet !== "string" || wallet.length > 64) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing required parameters: wallet and txs" }));
              return;
            }
            if (!body?.txs || (!Array.isArray(body.txs) && typeof body.txs !== "string")) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing required parameters: wallet and txs" }));
              return;
            }
            if (Array.isArray(body.txs) && body.txs.length > 1000) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "body.txs: at most 1000 transactions allowed" }));
              return;
            }
          }
          if (!body) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing JSON body" }));
            return;
          }

          // 4. Settle signature in store
          const settled = store.recordSettledPayment({
            signature: proof.signature,
            payer: proof.payer,
            recipient,
            amount: verResult.amount ?? requiredPrice,
            endpoint: pathname,
            wallet: typeof body.wallet === "string" ? body.wallet : undefined,
          });
          if (!settled) {
            send402(res, pathname, requiredPrice, recipient, "Payment signature already settled (replay rejected)");
            return;
          }

          // 5. Execute endpoint handler
          if (pathname === "/scan") {
            const rawScanRes = (await scanHandler(body.wallet as string)) as Record<string, any>;
            recordHeliusCost(store, "/scan");
            const scanRes = typeof rawScanRes === "object" && rawScanRes !== null ? { ...rawScanRes } : rawScanRes;

            if (scanRes && typeof scanRes === "object") {
              const riskScore = typeof scanRes.riskScore === "number" ? scanRes.riskScore : 0;
              const verdict =
                typeof scanRes.verdict === "string" ? scanRes.verdict : computeVerdict(riskScore);
              scanRes.verdict = verdict;

              const isOracleEnabled =
                options.enableOracle ??
                (process.env.RADAR_ORACLE === "1" || options.oracleClient !== undefined);

              if (isOracleEnabled) {
                try {
                  const anomalies = Array.isArray(scanRes.anomalies) ? scanRes.anomalies : [];
                  const topRules = Array.from(
                    new Set(anomalies.map((a: any) => a.type || a.rule).filter(Boolean)),
                  );
                  const txSignatures = Array.isArray(scanRes.txSignatures)
                    ? scanRes.txSignatures
                    : Array.isArray(scanRes.txs)
                    ? scanRes.txs.map((t: any) => t.signature).filter(Boolean).slice(0, 10)
                    : [];

                  const commitFn = options.commitScanFn ?? commitScan;
                  const commitRes = await commitFn(
                    {
                      wallet: body.wallet as string,
                      riskScore,
                      verdict,
                      timestamp: Math.floor(Date.now() / 1000),
                      topRules,
                      txSignatures,
                    },
                    { client: options.oracleClient, rpcUrl: options.rpcUrl },
                  );

                  if (commitRes.signature) {
                    scanRes.onchainLedgerSig = commitRes.signature;
                  }
                  scanRes.oracle = commitRes;
                } catch (err) {
                  if (process.env.RADAR_DEBUG === "1") {
                    console.error("[x402] oracle commitScan failed:", err);
                  }
                }
              }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(scanRes, null, 2));
            return;
          }

          if (pathname === "/analyze") {
            const analyzeRes = await analyzeHandler(body.wallet as string, body.txs as EnhancedTx[] | string);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(analyzeRes, null, 2));
            return;
          }
        } finally {
          inFlightPayments.delete(proof.signature);
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    } catch (err: unknown) {
      if (err instanceof PayloadTooLargeError || (err as { status?: number }).status === 413) {
        res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ error: "Payload Too Large" }));
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  return server;
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  loadEnv();

  if (args.includes("--version") || args.includes("-v")) {
    console.log(getVersion());
    process.exit(0);
  }

  if (args.includes("--health")) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          status: "ok",
          name: "wallet-radar-x402",
          version: getVersion(),
          pricing: X402_PRICING,
          recipient: process.env.RADAR_X402_RECIPIENT ?? null,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  validateConfig(process.env, {
    paywall: Boolean(process.env.RADAR_PAYWALL === "1" || process.env.RADAR_X402_PAYWALL === "1"),
  });

  let port = Number(process.env.RADAR_X402_PORT || process.env.PORT || 4020);
  let host = process.env.HOST || "0.0.0.0";
  let recipient = process.env.RADAR_X402_RECIPIENT;

  const portIdx = args.indexOf("--port");
  if (portIdx >= 0 && portIdx + 1 < args.length) {
    port = Number(args[portIdx + 1]);
  }

  const hostIdx = args.indexOf("--host");
  if (hostIdx >= 0 && hostIdx + 1 < args.length) {
    host = args[hostIdx + 1];
  }

  const recipientIdx = args.indexOf("--recipient");
  if (recipientIdx >= 0 && recipientIdx + 1 < args.length) {
    recipient = args[recipientIdx + 1];
  }

  const server = createX402Server({ recipient });
  server.listen(port, host, () => {
    console.log(`wallet-radar x402 server running at http://${host}:${port}`);
    console.log(`Recipient wallet: ${recipient ?? "unconfigured (set RADAR_X402_RECIPIENT)"}`);
    console.log(`Endpoints: POST /scan (0.005 USDC), POST /analyze (0.001 USDC), GET /selftest (Free)`);
  });
}

const isDirectRun = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);

if (isDirectRun) {
  runCli().catch((err) => {
    console.error("x402 server error:", err);
    process.exit(1);
  });
}
