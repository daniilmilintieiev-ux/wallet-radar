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

## Key material (oracle payer)

When `RADAR_ORACLE=1` is enabled, the service pays the tx fees for on-chain
attestation commits from a dedicated **payer** wallet. How the payer secret is
provided changes its exposure:

| Method | Configuration | When to use |
|--------|---------------|-------------|
| Keypair **file** (JSON array of 64 bytes, `solana-keygen` format) | `RADAR_ORACLE_KEYPAIR=/path/to/payer.json` | **Recommended.** The secret lives on disk with file permissions and never appears in the process environment, shell history, or `systemctl` output. |
| Base58 secret in env | `RADAR_ORACLE_PAYER=<base58>` | **Prototype convenience.** The secret is readable from the process environment (`/proc/<pid>/environ` on Linux) and is inherited by child processes. |
| KMS / HSM-backed signer | — | **Production.** The raw 64 bytes never exist on the host; a signer service produces signatures on demand. It plugs in where `loadPayerFromEnv()` returns the keypair. |

Notes:

- Use a **low-balance dedicated payer** — attestation fees are a few hundred
  lamports per commit. Never a wallet that also holds other value.
- The payer only signs the attestation commits; it is never the x402 payment
  recipient.
- `RADAR_ORACLE_KEYPAIR` takes precedence over `RADAR_ORACLE_PAYER`; an
  unreadable or malformed file falls back to the env var with a warning.

## x402 payment replay protection

Paid endpoints (`POST /scan`, `POST /analyze`) accept x402 USDC payments. A
payment signature may be redeemed exactly once. Two layers enforce this:

1. **In-process (fast path).** `inFlightPayments` — an in-memory `Set` of
   signatures currently being verified/settled. Stops two *concurrent*
   requests in the same process from settling the same signature.
2. **Durable (source of truth).** The SQLite `settled_payments` table has
   `signature TEXT PRIMARY KEY`. Every verified payment is recorded there
   atomically before the endpoint is served, and every incoming payment is
   checked against it first. This survives restarts.

**Known window (prototype trade-off).** The in-memory entry is added *before*
verification; the durable row is written *after* verification. If the process
crashes between those two points, the payment is confirmed on-chain but absent
from the database, and after a restart the same signature could be redeemed
again (the endpoint runs a second time for the same payment). Impact is
bounded: it requires a crash inside that window **and** a client deliberately
re-presenting the same payment signature. Production mitigation: write a
`pending` row before verification and reconcile `pending` rows against the
chain after restart (or verify only after a durable pre-record).

## HTTP service hardening

- **Authentication (opt-in).** `RADAR_API_TOKEN`, when set, requires
  `Authorization: Bearer <token>` (or an `x-api-token` header) on the mutating
  endpoints (`POST /watch`, `/unwatch`, `/poll`, `/defense/:wallet/clear`);
  comparison is timing-safe. Read endpoints stay open. When watch mode is
  enabled without a token, `validateConfig` warns at startup.
- **CORS.** Open by default (`Access-Control-Allow-Origin: *` — responses
  contain data about wallets the caller chose). `RADAR_CORS_ORIGINS` restricts
  which browser origins may read responses cross-origin.
- **Rate limiting.** Per-IP limit (`RADAR_RATE_LIMIT_PER_MIN`, default
  120/min); `/health` and `/metrics` are exempt.
- **Input validation.** Wallet parameters are strict-base58-validated at every
  API surface (the `0/O/I/l` lookalikes are rejected); JSON bodies are capped
  at ~1 MB (413 above that); Helius responses are runtime-validated (zod,
  permissive) — malformed items degrade with a warning instead of being cast
  blindly into the pipeline.

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
