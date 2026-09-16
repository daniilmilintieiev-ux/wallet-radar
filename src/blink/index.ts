import http from "node:http";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  ACTIONS_CORS_HEADERS,
  createPostResponse,
  ActionGetResponse,
  ActionPostResponse,
  ActionsJson,
} from "@solana/actions";
import { deriveAssociatedTokenAddress, buildSplTransferInstruction } from "../sdk/index.js";
import { USDC_MINT } from "../types.js";

export { ACTIONS_CORS_HEADERS };

export interface BlinkScanActionConfig {
  baseUrl?: string;
  endpointUrl?: string;
  iconUrl?: string;
  title?: string;
  description?: string;
  label?: string;
  priceUsdc?: number;
  recipient?: string;
  targetWallet?: string;
}

export interface BlinkScanPostOptions {
  recipient?: string;
  priceUsdc?: number;
  rpcUrl?: string;
  connection?: Connection;
  recentBlockhash?: string;
}

export interface BlinkRegistrationManifest {
  name: string;
  version: string;
  description: string;
  actionUrl: string;
  actionsJsonUrl: string;
  blinkUrl: string;
  pricing: {
    amount: number;
    token: string;
    mint: string;
    recipient: string;
  };
  actionsJson: ActionsJson;
  deepLinks: {
    dialect: string;
    phantom: string;
    solflare: string;
    protocol: string;
  };
}

export interface BlinkServerOptions {
  baseUrl?: string;
  recipient?: string;
  rpcUrl?: string;
  connection?: Connection;
  recentBlockhash?: string;
  priceUsdc?: number;
  iconUrl?: string;
}

/**
 * Builds the `actions.json` file content for Solana Actions discovery.
 */
export function buildActionsJson(config: Partial<BlinkScanActionConfig> = {}): ActionsJson {
  const apiPath = config.endpointUrl || "/api/actions/radar-scan";
  return {
    rules: [
      {
        pathPattern: "/scan/*",
        apiPath: `${apiPath}?wallet=*`,
      },
      {
        pathPattern: "/api/actions/**",
        apiPath: "/api/actions/**",
      },
    ],
  };
}

/**
 * Generates the ActionGetResponse payload for the Radar scan Action/Blink.
 */
export function buildRadarScanActionGet(
  config: Partial<BlinkScanActionConfig> = {},
): ActionGetResponse {
  const icon =
    config.iconUrl ||
    "https://raw.githubusercontent.com/daniilmilintieiev-ux/wallet-radar/main/docs/assets/radar-icon.png";
  const price = typeof config.priceUsdc === "number" ? config.priceUsdc : 0.005;
  const endpointUrl = config.endpointUrl || "/api/actions/radar-scan";

  if (config.targetWallet) {
    const target = config.targetWallet;
    const short = target.length > 8 ? `${target.slice(0, 4)}...${target.slice(-4)}` : target;
    return {
      type: "action",
      icon,
      title: config.title || `Wallet Radar: Scan ${short}`,
      description:
        config.description ||
        `Instant on-chain risk scan for ${target}. Evaluates behavioral anomalies, toxic mints, and counterparty safety (${price} USDC).`,
      label: config.label || `Scan for ${price} USDC`,
      links: {
        actions: [
          {
            type: "transaction",
            label: `Scan ${short} (${price} USDC)`,
            href: `${endpointUrl}?wallet=${encodeURIComponent(target)}`,
          },
        ],
      },
    };
  }

  return {
    type: "action",
    icon,
    title: config.title || "Wallet Radar: On-chain Risk Scan",
    description:
      config.description ||
      `Scan any Solana wallet for behavioral anomalies, toxic mints, and counterparty risk (${price} USDC per audit).`,
    label: config.label || "Scan Wallet",
    links: {
      actions: [
        {
          type: "transaction",
          label: "Scan Wallet",
          href: `${endpointUrl}?wallet={wallet}`,
          parameters: [
            {
              name: "wallet",
              label: "Solana Wallet Address to scan",
              required: true,
            },
          ],
        },
      ],
    },
  };
}

/** Backward compatibility alias */
export const buildRadarScanBlinkGet = buildRadarScanActionGet;

/**
 * Prepares the ActionPostResponse containing a signable transaction for Phantom/Solflare/Dialect.
 */
export async function buildRadarScanActionPost(
  account: string,
  targetWallet: string,
  options: BlinkScanPostOptions = {},
): Promise<ActionPostResponse> {
  if (!account || typeof account !== "string") {
    throw new Error("Missing or invalid 'account' parameter");
  }
  if (!targetWallet || typeof targetWallet !== "string") {
    throw new Error("Missing or invalid 'targetWallet' parameter");
  }

  let userPubkey: PublicKey;
  try {
    userPubkey = new PublicKey(account);
  } catch {
    throw new Error(`Invalid account public key: ${account}`);
  }

  let targetPubkey: PublicKey;
  try {
    targetPubkey = new PublicKey(targetWallet);
  } catch {
    throw new Error(`Invalid target wallet public key: ${targetWallet}`);
  }

  const recipientStr =
    options.recipient || process.env.RADAR_X402_RECIPIENT || "11111111111111111111111111111111";
  let recipientPubkey: PublicKey;
  try {
    recipientPubkey = new PublicKey(recipientStr);
  } catch {
    recipientPubkey = new PublicKey("11111111111111111111111111111111");
  }

  const price = typeof options.priceUsdc === "number" ? options.priceUsdc : 0.005;
  const amountUnits = BigInt(Math.round(price * 1e6));

  const tx = new Transaction();

  // 1. Audit Request Memo Instruction
  const memoData = Buffer.from(`RadarScan:${targetPubkey.toBase58()}:x402:${price}`, "utf-8");
  tx.add(
    new TransactionInstruction({
      keys: [{ pubkey: userPubkey, isSigner: true, isWritable: false }],
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      data: memoData,
    }),
  );

  // 2. x402 USDC micropayment instruction
  if (amountUnits > 0n) {
    const mintPubkey = new PublicKey(USDC_MINT);
    const sourceAta = deriveAssociatedTokenAddress(userPubkey, mintPubkey);
    const destAta = deriveAssociatedTokenAddress(recipientPubkey, mintPubkey);
    tx.add(buildSplTransferInstruction(sourceAta, destAta, userPubkey, amountUnits));
  }

  tx.feePayer = userPubkey;

  // 3. Recent blockhash resolution
  if (options.recentBlockhash) {
    tx.recentBlockhash = options.recentBlockhash;
  } else if (options.connection) {
    const { blockhash } = await options.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
  } else {
    const rpcUrl = options.rpcUrl || process.env.SOLANA_RPC_URL;
    if (rpcUrl) {
      try {
        const conn = new Connection(rpcUrl, "confirmed");
        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
      } catch {
        tx.recentBlockhash = userPubkey.toBase58();
      }
    } else {
      tx.recentBlockhash = userPubkey.toBase58();
    }
  }

  const shortTarget = `${targetPubkey.toBase58().slice(0, 4)}...${targetPubkey.toBase58().slice(-4)}`;
  return await createPostResponse({
    fields: {
      type: "transaction",
      transaction: tx,
      message: `Radar audit initiated for ${shortTarget} (${price} USDC). Results commit to on-chain ZK ledger.`,
    },
  });
}

/** Backward compatibility alias */
export const buildRadarScanBlinkPost = buildRadarScanActionPost;

/**
 * Builds a Dialect, Phantom, or Solflare deep-link URL for a Solana Action.
 */
export function buildBlinkUrl(
  actionUrl: string,
  options: { provider?: "dialect" | "phantom" | "solflare"; cluster?: "mainnet" | "devnet" } = {},
): string {
  const provider = options.provider || "dialect";
  const clusterParam = options.cluster === "devnet" ? "&cluster=devnet" : "";
  const encodedAction = encodeURIComponent(`solana-action:${actionUrl}`);

  switch (provider) {
    case "dialect":
      return `https://dial.to/?action=${encodedAction}${clusterParam}`;
    case "phantom":
      return `https://phantom.app/ul/browse/${encodeURIComponent(actionUrl)}?ref=wallet-radar`;
    case "solflare":
      return `https://solflare.com/ul/v1/browse/${encodeURIComponent(actionUrl)}`;
  }
}

/**
 * Builds a provider-specific wallet deep link (Phantom, Solflare, Dialect).
 */
export function buildWalletDeepLink(
  provider: "phantom" | "solflare" | "dialect",
  actionUrl: string,
  cluster?: "mainnet" | "devnet",
): string {
  return buildBlinkUrl(actionUrl, { provider, cluster });
}

/**
 * Generates the full Blink registration manifest and deep links.
 */
export function getBlinkRegistrationManifest(
  baseUrl: string = "https://wallet-radar.app",
  recipient: string = process.env.RADAR_X402_RECIPIENT || "11111111111111111111111111111111",
): BlinkRegistrationManifest {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const actionUrl = `${normalizedBase}/api/actions/radar-scan`;
  const actionsJsonUrl = `${normalizedBase}/actions.json`;

  return {
    name: "Wallet Radar",
    version: "0.1.0",
    description: "One-tap Solana wallet risk scan and on-chain ZK attestation via Blinks",
    actionUrl,
    actionsJsonUrl,
    blinkUrl: buildBlinkUrl(actionUrl, { provider: "dialect" }),
    pricing: {
      amount: 0.005,
      token: "USDC",
      mint: USDC_MINT,
      recipient,
    },
    actionsJson: buildActionsJson({ endpointUrl: actionUrl }),
    deepLinks: {
      dialect: buildBlinkUrl(actionUrl, { provider: "dialect" }),
      phantom: buildBlinkUrl(actionUrl, { provider: "phantom" }),
      solflare: buildBlinkUrl(actionUrl, { provider: "solflare" }),
      protocol: `solana-action:${actionUrl}`,
    },
  };
}

function readBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > maxBytes) {
        req.destroy();
        reject(new Error("Request payload too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Handles incoming HTTP requests for Solana Actions and Blinks (`actions.json` and `/api/actions/radar-scan`).
 * Returns `true` if the request was handled, `false` otherwise.
 */
export async function handleBlinkHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: BlinkServerOptions = {},
): Promise<boolean> {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase() || "GET";

  // Preflight OPTIONS handling for CORS
  if (method === "OPTIONS") {
    if (pathname === "/actions.json" || pathname.startsWith("/api/actions")) {
      res.writeHead(204, ACTIONS_CORS_HEADERS);
      res.end();
      return true;
    }
  }

  // 1. /actions.json (Actions discovery)
  if (pathname === "/actions.json") {
    if (method !== "GET") {
      res.writeHead(405, ACTIONS_CORS_HEADERS);
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return true;
    }
    const manifest = buildActionsJson({ endpointUrl: `${options.baseUrl || ""}/api/actions/radar-scan` });
    res.writeHead(200, ACTIONS_CORS_HEADERS);
    res.end(JSON.stringify(manifest, null, 2));
    return true;
  }

  // 2. /api/actions/radar-scan
  if (pathname === "/api/actions/radar-scan") {
    if (method === "GET") {
      const targetWallet = url.searchParams.get("wallet") || undefined;
      const actionMetadata = buildRadarScanActionGet({
        baseUrl: options.baseUrl,
        iconUrl: options.iconUrl,
        priceUsdc: options.priceUsdc,
        targetWallet,
      });
      res.writeHead(200, ACTIONS_CORS_HEADERS);
      res.end(JSON.stringify(actionMetadata, null, 2));
      return true;
    }

    if (method === "POST") {
      let body: any = null;
      try {
        const raw = await readBody(req);
        if (raw.trim()) {
          body = JSON.parse(raw);
        }
      } catch {
        res.writeHead(400, ACTIONS_CORS_HEADERS);
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return true;
      }

      const account = body?.account;
      if (!account || typeof account !== "string") {
        res.writeHead(400, ACTIONS_CORS_HEADERS);
        res.end(JSON.stringify({ error: "Missing required 'account' field in request body" }));
        return true;
      }

      const targetWallet = url.searchParams.get("wallet") || body?.data?.wallet || body?.wallet;
      if (!targetWallet || typeof targetWallet !== "string") {
        res.writeHead(400, ACTIONS_CORS_HEADERS);
        res.end(JSON.stringify({ error: "Missing required 'wallet' parameter (query or body)" }));
        return true;
      }

      try {
        const postRes = await buildRadarScanActionPost(account, targetWallet, {
          recipient: options.recipient,
          priceUsdc: options.priceUsdc,
          rpcUrl: options.rpcUrl,
          connection: options.connection,
          recentBlockhash: options.recentBlockhash,
        });
        res.writeHead(200, ACTIONS_CORS_HEADERS);
        res.end(JSON.stringify(postRes, null, 2));
        return true;
      } catch (err: any) {
        res.writeHead(400, ACTIONS_CORS_HEADERS);
        res.end(JSON.stringify({ error: err.message || String(err) }));
        return true;
      }
    }

    res.writeHead(405, ACTIONS_CORS_HEADERS);
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  return false;
}
