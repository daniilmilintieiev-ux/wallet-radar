# `radar trust <wallet> | --watchlist` — Specification

**Status: v1 — verdict + watchlist shortlist production-ready; network (RPC/Jupiter) is best-effort; fully covered by tests (70/70).**

## Purpose

Wallet Radar answers "what changed in this wallet." `radar trust` answers the essential pre-trade question an autonomous agent asks: **"Can I trust this counterparty right now?"** — a pre-flight firewall check for x402 payments and any agent-to-agent transactions. The agent receives a single deterministic verdict and can act upon it without an LLM in the critical path.

## Verdict Formula

```
verdict = f(behavioral risk, payment capacity)
```

1. **Behavioral Risk**: Risk score (0-100) evaluated across the time window (default: 7 days):
   - If wallet is in watchlist: anomalies retrieved from persistent store across the window.
   - If not: one-shot evaluation (history → in-memory baseline → anomaly detector; same semantics as `scan`).
2. **Payment Capacity**: USD-denominated liquidity: `USDC + USDT` (1:1 parity) + `SOL × Jupiter spot price`.
   - Stablecoins are computed precisely even if external price feeds are unavailable.
   - SOL without an active price feed is omitted from liquidity (`solPriced: false`), preserving deterministic verdict stability without crashing.
3. **Verdict Matrix**:
   | Verdict | Condition |
   | --- | --- |
   | `safe` | `riskScore <= maxRisk` AND `liquidityUsd >= minLiquidityUsd` |
   | `hold` | Data available, but at least one risk or liquidity threshold failed |
   | `unknown` | Insufficient data (no history to score risk, or RPC balance query failed) |

Default thresholds: `maxRisk = 30`, `minLiquidityUsd = 50`. Configurable via flags:
`--max-risk N`, `--min-liquidity N`, `--window-days N`, `--json`.

## Core Philosophy

- **Deterministic, Zero LLM in the Verdict Path**: Any agent or process can independently reproduce the exact same verdict from identical inputs (risk score + on-chain balances + thresholds).
- **Structured Evidence**: JSON output contains exact numerical fields (`riskScore`, `balances`, `liquidityUsd`, `reasons[]`) — human traders and AI agents consume identical schemas.
- **Conservative on Uncertainty**: Missing data yields `unknown`, never `safe`. A false `safe` (losing capital to an exploit) is far more dangerous than a false `hold`.
- **Best-Effort Network Resilience**: External price feed degradation does not fail the verification: stablecoin balances remain exact, and SOL is marked `solPriced: false`.

## Output Format

```json
{
  "wallet": "…",
  "verdict": "hold",
  "riskScore": 75,
  "anomalyCount": 3,
  "anomalies": [ … ],
  "balances": { "sol": 0.041, "usdc": 0, "usdt": 12.4 },
  "solPriced": true,
  "liquidityUsd": 16.5,
  "reasons": [
    "risk score 75 > max 30",
    "liquidity $16.50 < min $50.00"
  ],
  "windowDays": 7,
  "generatedAt": 1756900000
}
```

Human-readable CLI string (stdout without `--json`):
`wallet-radar: <wallet> — HOLD — risk 75/100, liquidity $16.50 (risk 75 > 30; liquidity $16.50 < $50.00)`

## Data Sources & Fallbacks

| Data | Primary Source | Fallback |
| --- | --- | --- |
| History / Anomalies | Helius Enhanced Transactions + Store | One-shot (`scan` mode) |
| SOL Balance | JSON-RPC `getBalance` (`RADAR_RPC_URL` or Helius RPC) | `unknown` |
| USDC / USDT Balances | JSON-RPC `getTokenAccountsByOwner` (jsonParsed, uiAmount) | `unknown` |
| SOL Price | Jupiter Price API (keyless lite-api) | `solPriced: false` |

## Multi-Wallet: `radar trust --watchlist` → Ranked Shortlist (v1)

`trust --watchlist` runs the pre-flight verification across the **entire watchlist** and outputs a deterministic, ranked shortlist — answering the agent's question: *"Which of these wallets can I safely interact with right now, and in what order?"*

```text
wallet-radar: trust shortlist — 3 wallet(s): 1 safe, 1 hold, 1 unknown
SAFE (ranked by risk, then liquidity):
  1. <walletA> — risk 8/100, liquidity $1,204.55
HOLD:
  1. <walletB> — risk 75/100, liquidity $16.50 (risk score 75 > max 30; ...)
UNKNOWN:
  1. <walletC> — risk n/a, liquidity n/a (balance data unavailable)
```

- Ranking is pure and deterministic over per-wallet results (`buildShortlist`): primary sort by verdict (`safe` → `hold` → `unknown`), secondary sort by `riskScore` ascending, tertiary sort by `liquidity` descending.
- `--json` provides `{ shortlist, results }`: `shortlist` provides ranked groupings; `results` provides full per-wallet evidence.
- Error isolation: failure querying one wallet isolates cleanly into `unknown` with reason `check failed: …` without failing the batch.
- Sequential execution ensures predictable latency for pre-flight screening without overwhelming RPC rate limits.

## Known Boundaries

- Liquidity considers SOL + 2 major stablecoins (USDC/USDT); non-standard assets are excluded (conservative underestimation of capacity).
- Risk scoring bounds history to the defined evaluation window (default: 7 days).
- In one-shot execution, baseline is derived within the window.
- Balances are queried in real time without caching (3 RPC queries + 1 price query per wallet).
