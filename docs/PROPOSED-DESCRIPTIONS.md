# Proposed tool/endpoint descriptions: `radar_gate_copy` / `POST /gate-copy`

Proposed text only — `src/` is intentionally left unmodified (out of scope for
stage 9D, a documentation-only pass). This file exists so the exact wording
can be reviewed and applied to `src/http-server.ts:52`'s `description` field
(and the matching MCP tool description) in a future, separate code change.

## Why a change is proposed

Stage 9B (audit) found that the current description overstates what
`toolGateCopy` actually checks:

> "Pre-trade copy-trading firewall: gates a proposed copy-trade, swap, or
> payment before execution. Evaluates behavioral risk, token mint
> freeze/mint authority honeypots, and pre-trade simulation with tiered
> limits. Returns an immediate ALLOW, THROTTLE, or BLOCK verdict."
> — `src/http-server.ts:52`

Verified by reading the code (not by running it):

- The base risk score that decides `hold`/`unknown` (`http-server.ts:443-464`)
  comes from `runTrustCheck` → `detectAnomalies(wallet, evalTxs, baseline,
  undefined, prices)` (`src/trust.ts:329`) — **`mintRisk` is never passed**,
  so `TOXIC_MINT` (freeze authority, mint authority, holder concentration)
  never fires on this path, regardless of the wallet's actual mint risk.
- A *separate*, narrower check only runs when both `copyAmountUsd > 0` and a
  valid `mint` are supplied in the request (`http-server.ts:467-472`):
  `fetchMintMetadata` is called under a silent `try/catch` (failure →
  `mintRisk = null`, `:472`), and the result feeds `simulatePayment`
  (`src/simulate.ts:323-328`), which checks **only** `freezeAuthority` and
  `top10Pct >= 80`. **`mintAuthority` is never checked anywhere in this path**
  — `simulate.ts` has no reference to it at all.
- So "mint authority honeypots" in the current description is not accurate
  for either path: the base risk score never checks any mint-risk field, and
  the narrower simulation-time check explicitly omits `mintAuthority`.

## Proposed `description` text

For `src/http-server.ts:52` (`POST /gate-copy`, `radar_gate_copy`):

```
Pre-trade copy-trading firewall: gates a proposed copy-trade, swap, or
payment before execution. Evaluates behavioral risk against the wallet's
history. When both an amount and a specific token mint are supplied,
additionally checks that mint's freeze authority and top-10-holder
concentration (not mint authority) before allowing execution. Returns an
immediate ALLOW, THROTTLE, or BLOCK verdict.
```

If the MCP tool description (`src/mcp.ts`, `radar_gate_copy` entry) carries
separate prose rather than reusing this same string, apply the same wording
there for consistency.

## Out of scope for this proposal

- Whether `TOXIC_MINT`/mint-authority checking *should* also run on the base
  `runTrustCheck` path, or whether `simulate.ts` *should* also check
  `mintAuthority` — those are code-behavior decisions, not documentation
  fixes, and are left for a separate change.
