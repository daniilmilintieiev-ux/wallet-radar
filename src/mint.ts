import { extractSwap, MAJOR_MINTS } from "./analyzer.js";
import { Store } from "./store.js";
import { isValidBase58 } from "./config.js";
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

function toSupplyString(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && isFinite(v)) return String(v);
  return null;
}

export function parseDasAssetSupply(data: unknown): { supply: string | null; decimals: number | null } {
  const res = (data as Record<string, unknown> | null)?.result as Record<string, unknown> | undefined;
  const tokenInfo = res?.token_info as Record<string, unknown> | undefined;
  if (!tokenInfo || typeof tokenInfo !== "object") return { supply: null, decimals: null };
  return { supply: toSupplyString(tokenInfo.supply), decimals: numOrNull(tokenInfo.decimals) };
}

export function parseRpcMintSupply(data: unknown): { supply: string | null; decimals: number | null } {
  const res = (data as Record<string, unknown> | null)?.result as Record<string, unknown> | undefined;
  const val = res?.value as Record<string, unknown> | undefined;
  const dataObj = val?.data as Record<string, unknown> | undefined;
  const parsed = dataObj?.parsed as Record<string, unknown> | undefined;
  const info = parsed?.info as Record<string, unknown> | undefined;
  if (!info || typeof info !== "object") return { supply: null, decimals: null };
  return { supply: toSupplyString(info.supply), decimals: numOrNull(info.decimals) };
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

/**
 * Program/wallet addresses that hold token accounts which are NOT real holders:
 * AMM pool vaults and the incinerator. `getTokenLargestAccounts` lists their
 * token accounts among the largest, so without filtering a token whose liquidity
 * sits in DEX pools looks far more concentrated than it actually is (audit 3.2).
 * All IDs verified against mainnet on 2026-09-23 (program accounts / burn wallet).
 */
export const KNOWN_AMM_OWNERS: ReadonlySet<string> = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4 pool vaults
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM pool vaults
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool vaults
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM pool vaults
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // pump.fun AMM vaults
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun bonding curves
  "1nc1nerator11111111111111111111111111111111", // incinerator (burned tokens)
]);

/**
 * Pure: top-10 holder concentration as a % of total supply (0-100), computed from a
 * `getTokenLargestAccounts` result. `null` when the supply is unknown/invalid.
 * When `systemHolders` is provided, those token-account addresses (AMM pool vaults,
 * incinerator — see KNOWN_AMM_OWNERS) are excluded BEFORE taking the top 10.
 */
export function computeTop10Pct(
  supplyBaseUnits: string,
  decimals: number,
  accounts: Array<{ address?: string; amount?: string; uiAmount?: number | null }>,
  systemHolders?: Set<string>,
): number | null {
  const scale = Math.pow(10, decimals);
  const totalSupply = Number(supplyBaseUnits) / scale;
  if (!isFinite(totalSupply) || totalSupply <= 0) return null;
  const holders = systemHolders
    ? (accounts ?? []).filter((a) => !a.address || !systemHolders.has(a.address))
    : accounts ?? [];
  const sumTop10 = holders.slice(0, 10).reduce((sum, a) => {
    const ui = typeof a.uiAmount === "number" && isFinite(a.uiAmount) ? a.uiAmount : null;
    const fromAmount = a.amount != null ? Number(a.amount) / scale : NaN;
    const v = ui != null ? ui : isFinite(fromAmount) ? fromAmount : 0;
    return sum + (v > 0 ? v : 0);
  }, 0);
  const pct = (sumTop10 / totalSupply) * 100;
  if (!isFinite(pct)) return null;
  return Math.max(0, Math.min(100, Math.round(pct * 100) / 100));
}

/**
 * Resolve the real holder of each token account (AMM pool vaults, incinerator,
 * wallets) via one `getMultipleAccounts` (jsonParsed) call: for token accounts the
 * top-level `owner` is always the SPL Token program, the actual holder is
 * `data.parsed.info.owner`. Returns the set of account addresses whose holder is a
 * known system account (AMM pool / incinerator), or `null` if the RPC call failed
 * (caller then falls back to the unfiltered concentration).
 */
async function resolveSystemHolderAddresses(
  fetchFn: typeof fetch,
  rpcUrl: string,
  tokenAccountAddresses: string[],
): Promise<Set<string> | null> {
  if (tokenAccountAddresses.length === 0) return new Set();
  try {
    const res = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "getMultipleAccounts",
        method: "getMultipleAccounts",
        params: [tokenAccountAddresses, { encoding: "jsonParsed" }],
      }),
      signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const value = data?.result?.value;
    if (!Array.isArray(value)) return null;
    const system = new Set<string>();
    for (let i = 0; i < tokenAccountAddresses.length; i++) {
      const acct = value[i];
      if (!acct || typeof acct !== "object") continue;
      const info = acct?.data?.parsed?.info;
      const holder =
        info && typeof info === "object" && typeof info.owner === "string"
          ? info.owner
          : typeof acct.owner === "string"
            ? acct.owner
            : null;
      if (holder && KNOWN_AMM_OWNERS.has(holder)) system.add(tokenAccountAddresses[i]);
    }
    return system;
  } catch {
    return null;
  }
}

const OUTBOUND_FETCH_TIMEOUT_MS = 10_000;

async function fetchTop10Pct(
  fetchFn: typeof fetch,
  rpcUrl: string,
  mint: string,
  supplyBaseUnits: string,
  decimals: number,
): Promise<number | null> {
  if (!isValidBase58(mint)) return null;
  try {
    const res = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "getTokenLargestAccounts",
        method: "getTokenLargestAccounts",
        params: [mint],
      }),
      signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const value = data?.result?.value;
    if (!Array.isArray(value)) return null;
    // Filter AMM pool vaults / incinerator out of the holder list (audit 3.2):
    // their token accounts are not real holders. Degrades to the unfiltered
    // value if the owner-resolution call fails.
    const addresses = value
      .map((a: any) => (a && typeof a.address === "string" ? a.address : null))
      .filter((a: string | null): a is string => a != null);
    const systemHolders = await resolveSystemHolderAddresses(fetchFn, rpcUrl, addresses);
    return computeTop10Pct(supplyBaseUnits, decimals, value, systemHolders ?? undefined);
  } catch {
    return null;
  }
}

export function collectCandidateMints(txs: EnhancedTx[], wallet?: string): string[] {
  const mints = new Set<string>();
  for (const tx of txs) {
    const s = extractSwap(tx, wallet);
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
  if (!isValidBase58(mint)) {
    return null;
  }

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
  let top10Pct: number | null = null;

  // 1. Try Helius DAS getAsset (authorities + supply for top-holder concentration)
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
      signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS),
    });
    if (dasRes.ok) {
      const dasData = await dasRes.json();
      info = parseDasAssetResponse(dasData);
      if (info) {
        const sup = parseDasAssetSupply(dasData);
        if (sup.supply != null && sup.decimals != null) {
          top10Pct = await fetchTop10Pct(fetchFn, rpcUrl, mint, sup.supply, sup.decimals);
        }
      }
    }
  } catch {
    // DAS call failed, attempt fallback
  }

  // 2. Fallback to standard Solana RPC getAccountInfo (authorities + supply)
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
        signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS),
      });
      if (rpcRes.ok) {
        const rpcData = await rpcRes.json();
        info = parseRpcAccountInfoResponse(mint, rpcData);
        if (info) {
          const sup = parseRpcMintSupply(rpcData);
          if (sup.supply != null && sup.decimals != null) {
            top10Pct = await fetchTop10Pct(fetchFn, rpcUrl, mint, sup.supply, sup.decimals);
          }
        }
      }
    } catch {
      // Both failed
    }
  }

  if (info) {
    info.top10Pct = top10Pct;
  }

  if (info && opts.store) {
    opts.store.saveMintMetadata(info, nowSec, opts.ttlSec);
  }

  return info;
}

export interface FetchSwapMintRiskOptions extends FetchMintOptions {
  fetchMintFn?: (mint: string) => Promise<MintRiskInfo | null>;
  /** Wallet under analysis (for relayer txs whose feePayer is not the user). */
  wallet?: string;
}

export async function fetchSwapMintRisk(
  txs: EnhancedTx[],
  opts: FetchSwapMintRiskOptions = {},
): Promise<MintRiskMap> {
  const mints = collectCandidateMints(txs, opts.wallet);
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
