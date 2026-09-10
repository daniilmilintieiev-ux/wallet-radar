import { extractSwap, MAJOR_MINTS } from "./analyzer.js";
import { Store } from "./store.js";
import { EnhancedTx, MintRiskInfo, MintRiskMap } from "./types.js";

export { MintRiskInfo, MintRiskMap };

export function parseDasAssetResponse(data: unknown): MintRiskInfo | null {
  if (!data || typeof data !== "object") return null;
  const res = (data as Record<string, unknown>).result as Record<string, unknown> | undefined;
  if (!res || typeof res !== "object") return null;
  const mint = typeof res.id === "string" ? res.id : "";
  if (!mint) return null;

  const tokenInfo = res.token_info as Record<string, unknown> | undefined;
  let mintAuthority: string | null = null;
  let freezeAuthority: string | null = null;

  if (tokenInfo && typeof tokenInfo === "object") {
    mintAuthority =
      typeof tokenInfo.mint_authority === "string" && tokenInfo.mint_authority.length > 0
        ? tokenInfo.mint_authority
        : null;
    freezeAuthority =
      typeof tokenInfo.freeze_authority === "string" && tokenInfo.freeze_authority.length > 0
        ? tokenInfo.freeze_authority
        : null;
  } else {
    const authorities = Array.isArray(res.authorities) ? res.authorities : [];
    for (const auth of authorities) {
      if (auth && typeof auth === "object") {
        const scopes = Array.isArray((auth as any).scopes) ? (auth as any).scopes : [];
        const addr = typeof (auth as any).address === "string" ? (auth as any).address : "";
        if (addr) {
          if (scopes.includes("mint") || scopes.includes("full")) mintAuthority = addr;
          if (scopes.includes("freeze") || scopes.includes("full")) freezeAuthority = addr;
        }
      }
    }
  }

  return { mint, mintAuthority, freezeAuthority };
}

export function parseRpcAccountInfoResponse(mint: string, data: unknown): MintRiskInfo | null {
  if (!data || typeof data !== "object") return null;
  const res = (data as Record<string, unknown>).result as Record<string, unknown> | undefined;
  if (!res || typeof res !== "object") return null;
  const val = res.value as Record<string, unknown> | undefined;
  if (!val || typeof val !== "object") return null;
  const dataObj = val.data as Record<string, unknown> | undefined;
  if (!dataObj || typeof dataObj !== "object") return null;
  const parsed = dataObj.parsed as Record<string, unknown> | undefined;
  if (!parsed || typeof parsed !== "object") return null;
  const info = parsed.info as Record<string, unknown> | undefined;
  if (!info || typeof info !== "object") return null;

  const mintAuthority =
    typeof info.mintAuthority === "string" && info.mintAuthority.length > 0
      ? info.mintAuthority
      : null;
  const freezeAuthority =
    typeof info.freezeAuthority === "string" && info.freezeAuthority.length > 0
      ? info.freezeAuthority
      : null;

  return { mint, mintAuthority, freezeAuthority };
}

export function collectCandidateMints(txs: EnhancedTx[]): string[] {
  const mints = new Set<string>();
  for (const tx of txs) {
    const s = extractSwap(tx);
    if (s) {
      if (s.tokenIn.mint && !MAJOR_MINTS.includes(s.tokenIn.mint)) {
        mints.add(s.tokenIn.mint);
      }
      if (s.tokenOut.mint && !MAJOR_MINTS.includes(s.tokenOut.mint)) {
        mints.add(s.tokenOut.mint);
      }
    }
  }
  return Array.from(mints);
}

export interface FetchMintOptions {
  apiKey?: string;
  rpcUrl?: string;
  store?: Store;
  nowSec?: number;
  ttlSec?: number;
  fetchFn?: typeof fetch;
}

export async function fetchMintMetadata(
  mint: string,
  opts: FetchMintOptions = {},
): Promise<MintRiskInfo | null> {
  if (MAJOR_MINTS.includes(mint)) {
    return { mint, mintAuthority: null, freezeAuthority: null };
  }

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (opts.store) {
    const cached = opts.store.getMintMetadata(mint, nowSec);
    if (cached) return cached;
  }

  const apiKey = opts.apiKey ?? process.env.HELIUS_API_KEY;
  const rpcUrl =
    opts.rpcUrl ??
    (process.env.SOLANA_RPC_URL ||
      (apiKey ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}` : undefined));

  if (!rpcUrl) {
    return null;
  }

  const fetchFn = opts.fetchFn ?? fetch;
  let info: MintRiskInfo | null = null;

  // 1. Try Helius DAS getAsset
  try {
    const dasRes = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "getAsset",
        method: "getAsset",
        params: { id: mint },
      }),
    });
    if (dasRes.ok) {
      const dasData = await dasRes.json();
      info = parseDasAssetResponse(dasData);
    }
  } catch {
    // DAS call failed, attempt fallback
  }

  // 2. Fallback to standard Solana RPC getAccountInfo
  if (!info) {
    try {
      const rpcRes = await fetchFn(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "getAccountInfo",
          method: "getAccountInfo",
          params: [mint, { encoding: "jsonParsed" }],
        }),
      });
      if (rpcRes.ok) {
        const rpcData = await rpcRes.json();
        info = parseRpcAccountInfoResponse(mint, rpcData);
      }
    } catch {
      // Both failed
    }
  }

  if (info && opts.store) {
    opts.store.saveMintMetadata(info, nowSec, opts.ttlSec);
  }

  return info;
}

export interface FetchSwapMintRiskOptions extends FetchMintOptions {
  fetchMintFn?: (mint: string) => Promise<MintRiskInfo | null>;
}

export async function fetchSwapMintRisk(
  txs: EnhancedTx[],
  opts: FetchSwapMintRiskOptions = {},
): Promise<MintRiskMap> {
  const mints = collectCandidateMints(txs);
  if (mints.length === 0) return {};

  const fetchMint = opts.fetchMintFn ?? ((m: string) => fetchMintMetadata(m, opts));
  const out: MintRiskMap = {};

  await Promise.all(
    mints.map(async (mint) => {
      try {
        const info = await fetchMint(mint);
        if (info) {
          out[mint] = info;
        }
      } catch {
        // Skip on error without crashing
      }
    }),
  );

  return out;
}
