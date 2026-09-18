import { EnhancedTx } from "./types.js";

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const BASE58_ADDR_REGEX = /^[A-Za-z0-9]{32,44}$/;
const BASE58_SIG_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const OUTBOUND_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch a wallet's recent enhanced transactions from the Helius Enhanced
 * Transactions API (read-only GET).
 *
 * https://docs.helius.dev/api/transactions-api
 */
export async function fetchWalletTransactions(
  apiKey: string,
  walletAddress: string,
  limit = 25,
  before?: string,
  after?: string,
): Promise<EnhancedTx[]> {
  if (!BASE58_ADDR_REGEX.test(walletAddress)) {
    throw new HttpError("Invalid Solana wallet address", 400);
  }
  if (before && !BASE58_SIG_REGEX.test(before)) {
    throw new HttpError("Invalid before signature parameter", 400);
  }
  if (after && !BASE58_SIG_REGEX.test(after)) {
    throw new HttpError("Invalid after signature parameter", 400);
  }

  const encodedAddress = encodeURIComponent(walletAddress);
  const url = new URL(
    `https://api.helius.xyz/v0/addresses/${encodedAddress}/transactions`,
  );
  url.searchParams.set("api-key", apiKey);
  url.searchParams.set("limit", String(limit));
  if (before) url.searchParams.set("before", before);
  if (after) url.searchParams.set("after", after);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new HttpError(`Helius fetch failed: ${response.status} ${response.statusText}`, response.status);
  }
  const data: unknown = await response.json();
  return Array.isArray(data) ? (data as EnhancedTx[]) : [];
}

export interface HistoryQuery {
  /** Unix seconds: only txs at/after this block time. */
  gteTime?: number;
  /** Unix seconds: only txs strictly before this block time. */
  ltTime?: number;
  /** Page size (max 100). Default 100. */
  limit?: number;
  /** Max pages to fetch (safety cap). Default 20. */
  maxPages?: number;
}

/**
 * Fetch a wallet's transaction history over an optional time range, paging
 * backwards with signature cursors (`before` = oldest signature of the
 * previous page). Returns txs in descending (newest-first) order.
 *
 * Verified against the live API (9/1): `before` accepts ONLY signatures
 * (a unix timestamp there -> 400), while `gte-time`/`lt-time` are
 * unix-seconds block-time filters.
 */
export async function fetchWalletHistory(
  apiKey: string,
  walletAddress: string,
  query: HistoryQuery = {},
): Promise<EnhancedTx[]> {
  if (!BASE58_ADDR_REGEX.test(walletAddress)) {
    throw new HttpError("Invalid Solana wallet address", 400);
  }

  const limit = Math.min(Math.max(1, query.limit ?? 100), 100);
  const maxPages = Math.max(1, query.maxPages ?? 20);
  const out: EnhancedTx[] = [];
  let cursor: string | undefined;
  const encodedAddress = encodeURIComponent(walletAddress);

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(
      `https://api.helius.xyz/v0/addresses/${encodedAddress}/transactions`,
    );
    url.searchParams.set("api-key", apiKey);
    url.searchParams.set("limit", String(limit));
    if (query.gteTime !== undefined) url.searchParams.set("gte-time", String(query.gteTime));
    if (query.ltTime !== undefined) url.searchParams.set("lt-time", String(query.ltTime));
    if (cursor) {
      if (!BASE58_SIG_REGEX.test(cursor)) {
        throw new HttpError("Invalid cursor signature", 400);
      }
      url.searchParams.set("before", cursor);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new HttpError(`Helius history fetch failed: ${response.status} ${response.statusText}`, response.status);
    }
    const data: unknown = await response.json();
    const batch: EnhancedTx[] = Array.isArray(data) ? data : [];
    out.push(...batch);
    if (batch.length < limit) break;
    cursor = batch[batch.length - 1].signature;
  }
  return out;
}
