# Live-data verification

The demo video is a **replay** of a real on-chain event, not a mock:

> Wallet `8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j` was dormant for **173 days**
> (last active 2026-03-11), then reactivated on **2026-08-21 → 2026-08-31** — five large
> swaps (up to ~5.7× its median) on a **new venue** (OKX DEX Router) and a **new program**.
> Verdict: **RISK 100/100, 8 anomalies.**

Solana mainnet is immutable, so this window is fixed: re-running the detector on live Helius
data reproduces the same verdict.

## Reproduce

```bash
export HELIUS_API_KEY=***            # Helius Enhanced Transactions (read-only)
npm run build

node dist/src/cli.js replay 8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j \
  --since 2026-03-11T07:36:15Z --until 2026-08-31T08:00:00Z
```

or, one-liner (prints a PASS/DRIFT verdict):

```bash
./scripts/verify-canon.sh
```

## Result — re-run on 2026-09-10

| Metric              | Demo (canon) | Live replay (2026-09-10) | Match   |
|---------------------|--------------|--------------------------|---------|
| history txs         | 1307         | **1307**                 | exact   |
| venues              | 12           | **12**                   | exact   |
| risk                | 100/100      | **100/100**              | exact   |
| anomalies           | 8            | **8**                    | exact   |
| burst swaps         | 2,344 / 2,448 / 2,534 / 2,534 / 3,996 (USD) | **same** | exact   |
| DORMANT_ACTIVE      | ~173 days    | **~173 days**            | exact   |
| NEW_VENUE           | OKX_DEX_ROUTER | **OKX_DEX_ROUTER**     | exact   |
| NEW_PROTOCOL        | proVF4p…     | **proVF4p…**             | exact   |
| baseline median (USD)| ~$699        | **~$765**                | drift   |

**Anomalies (identical set):** `DORMANT_ACTIVE` · `NEW_VENUE` · `LARGE_SWAP` ×5 · `NEW_PROTOCOL`.

### The one drift — baseline median (price, not data)
`LARGE_SWAP` compares in **USD**, priced live from the Jupiter Price API. SOL has moved ~+10%
since the demo was cut, so the *baseline* median now reads ~$765 (was ~$699). The five burst
swaps are the same on-chain amounts (unchanged); only the ×-multiplier of the largest shifts
(5.7× → ~5.2×). The verdict is unaffected: `LARGE_SWAP` is a **ratio** rule and every burst swap
is still ≥ 3× the median, so all five fire and RISK stays 100.

### Current state of the wallet
The wallet has **remained active** after the burst (latest tx 2026-09-09). The 24/7 radar keeps
watching it; the demo isolates the awakening window (`--until 2026-08-31`). Re-running `radar scan
<wallet>` today reports its current window — the detection is live, not just a replay.
