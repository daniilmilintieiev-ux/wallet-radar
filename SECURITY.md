# Security

Wallet Radar is a deterministic Solana wallet trust-gate. This page describes
how to report a vulnerability, our disclosure process, and how we handle data.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
vulnerability you have not yet had a chance to coordinate on.

- **Preferred:** open a private report via
  [GitHub Security Advisories](https://github.com/daniilmilintieiev-ux/wallet-radar/security/advisories/new).
- **Alternative:** email the maintainer at `@cbell` (Telegram) or
  `daniilmilintieiev-ux` (GitHub).

When reporting, please include:

- A short description of the issue and its impact.
- The affected component (CLI, MCP server, HTTP service, x402 service, baseline,
  pricing).
- Reproduction steps, a proof-of-concept, or the affected code path.
- The version or commit where you observed it (if known).

## Disclosure process

1. **Acknowledge** — we aim to confirm receipt within **48 hours**.
2. **Triage & fix** — we work on a fix and share a rough timeline; for a
   security-relevant issue we target a patch within a reasonable window
   (typically a few days for early-access).
3. **Coordinate release** — we let you know before a fix is released and, when
   it makes sense, credit you in the changelog/advisory (opt-out anytime).

We keep vulnerability reports and any PoC material private until a fix is
available, unless you prefer otherwise.

## Supported versions

| Version | Supported |
| ------- | --------- |
| `0.1.x` (latest `main`) | Yes |

We support the latest published `0.1.x` release on the `main` branch. We do
not actively backport fixes to older, unreferenced commits.

## Data handling & privacy

Wallet Radar is designed to be read-only and custody-free:

- **Read-only on-chain access.** All wallet data is fetched from public Solana
  data via the Helius Enhanced Transactions API (read-only). Wallet Radar does
  **not** hold your private key, does **not** take custody of funds, and does
  **not** sign or submit transactions on your behalf.
- **No custody of x402 payments.** In the x402 pay-per-call service, payment
  verification is read-only: it reads the submitted transaction and the
  recipient's USDC token-account balance before/after. The operator wallet is a
  passive receiver; the service never approves or moves a customer's funds.
- **Local cache.** Scan results and baselines are cached in a local SQLite
  database (Node's built-in `node:sqlite`) on the host running the service.
  This is operational state, not a data store shared across customers.
- **What we collect.** To run a check we need a Solana wallet address (a public
  on-chain identifier) and, for live checks, your Helius API key (kept in the
  service environment and used only to fetch that wallet's public history).
- **What we do not do.** We do not sell or share wallet data, and we do not use
  an LLM in the verdict path — the `safe`/`hold`/`unknown` decision and risk
  score are deterministic and recomputable from the same evidence.

## Threat-model notes

- The verdict path (risk score + liquidity → verdict) is deterministic and
  unit-tested; there is no LLM and no network call that can silently change the
  decision.
- The LLM digest (optional) is a presentation layer only: on any failure or
  timeout it degrades to a deterministic template and never blocks or alters the
  verdict.
- Price normalization falls back to major-only sizing when the price feed is
  unavailable, so a single dependency outage does not fail a scan.

If you spot something in the code that does not match the above, please report
it privately.
