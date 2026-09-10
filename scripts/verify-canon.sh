#!/usr/bin/env bash
# verify-canon.sh — re-run the demo's canonical detection on LIVE Helius data and report
# PASS / DRIFT. Proves the demo's numbers are reproducible from immutable on-chain data.
#
#   export HELIUS_API_KEY=***   (Helius Enhanced Transactions, read-only)
#   npm run build
#   ./scripts/verify-canon.sh
set -euo pipefail

WALLET="8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j"
SINCE="2026-03-11T07:36:15Z"   # last active before the 173-day dormancy
UNTIL="2026-08-31T08:00:00Z"   # end of the awakening window

[[ -n "${HELIUS_API_KEY:-}" ]] || { echo "HELIUS_API_KEY is not set"; exit 1; }
[[ -f dist/src/cli.js ]]       || { echo "run 'npm run build' first"; exit 1; }

out="$(node dist/src/cli.js replay "$WALLET" --since "$SINCE" --until "$UNTIL")"
echo "$out"
echo "----------------------------------------------------------"

risk="$(grep -oE 'risk [0-9]+/100' <<<"$out" | grep -oE '[0-9]+' | head -1 || true)"
anom="$(grep -oE '[0-9]+ anomalies?' <<<"$out" | grep -oE '[0-9]+' | head -1 || true)"
hist="$(grep -oE 'history:.*[0-9]+ txs' <<<"$out" | grep -oE '[0-9]+' | head -1 || true)"

echo "history tx : ${hist:-?}     (canon 1307)"
echo "risk       : ${risk:-?}/100 (canon 100)"
echo "anomalies  : ${anom:-?}     (canon 8)"

if [[ "${risk:-}" == "100" && "${anom:-}" == "8" ]]; then
  echo "VERDICT      : PASS — canonical detection reproduced from live data"
else
  echo "VERDICT      : DRIFT — inspect the output above"
fi
