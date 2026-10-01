Translation of the Russian original ground-truth/PROTOCOL.md. The Russian text is authoritative and was fixed before data collection began (see git history). In case of any difference, the original prevails.

# Independent Dataset Labeling Protocol (Ground-Truth Protocol)

## 1. Protocol Purpose
This protocol defines strict, objective rules for labeling Solana on-chain addresses for detection quality evaluation by external auditors.
Labeling is performed strictly independently of the Wallet Radar codebase, internal rules, thresholds, and verdicts.

---

## 2. Class Definitions

A wallet's class is determined exclusively by the actual **ON-CHAIN OUTCOME** (`outcome`) occurring after the cutoff date (`cutoff_date`), rather than by appearance, history, or heuristics:

### 2.1. DANGEROUS
* **Definition:** Subsequent operations or smart contracts of the wallet led to confirmed loss of user/counterparty funds due to toxic mechanics:
  - inability to sell token (honeypot, malicious transfer restriction);
  - unauthorized withdrawal of liquidity by creator (rugpull / liquidity drain);
  - smart contract exploit, oracle manipulation, or private key theft (wallet drainer).
* **Strict Rule:** Using the presence of `freezeAuthority` as the sole evidence of class `DANGEROUS` is prohibited (legitimate stablecoins USDC and USDT have it active). For `DANGEROUS`, a recorded fact of toxic outcome confirmed by an external independent source is mandatory.
* **Time Constraint:** The outcome date (`event_date`) must be strictly later than the cutoff date (`cutoff_date`), that is `event_date > cutoff_date`.

### 2.2. SAFE
* **Definition:** Presence of explicit positive independent evidence:
  - public verified label of a protocol, exchange, or infrastructure service;
  - confirmed validator account in the Solana consensus registry (`getVoteAccounts`);
  - documented institutional custodial activity without security incidents.
* **Strict Rule:** Absence of red flags is NOT considered evidence of safety. A regular wallet without positive external evidence cannot be assigned to `SAFE`.
* **Hard Negatives:** Class `SAFE` mandatorily includes wallets actively interacting with tokens that have `freezeAuthority` (USDC, USDT), to test the system for resilience against false positives.

### 2.3. UNCERTAIN
* **Definition:** Evidence is insufficient for unambiguous assignment to `SAFE` or `DANGEROUS`, or pieces of evidence contradict each other:
  - arbitrage and MEV bots (sandwich bots): cause slippage losses to retail traders, but act strictly within smart contract rules without key compromise;
  - accounts with conflicting legal or technical assessments (e.g. incidents contested in court as "protocol as designed");
  - wallets with isolated transactions and no further history, where neither safety nor malice can be proven.

---

## 3. Prohibited Practices
1. **Prohibition of Mingling with Wallet Radar:** Using verdicts (`VERIFIED_SAFE`, `LOW_TRUST_WARMING`, `BLOCKED`), rule terms (`TOXIC_MINT`, `DORMANT_ACTIVE`, `ACTIVITY_BURST`, etc.), or subjective assumptions as a label source is prohibited.
2. **Zero Lookahead Bias:** All features available to the system at decision time must be strictly bounded by `cutoff_date`. The fact of the outcome `event_date` lies in the future relative to `cutoff_date`.
3. **Prohibition of Unconfirmed Records:** A record without `source_url`, `event_date`, or `checked_at` is deemed legally and technically invalid.

---

## 4. Catalog of Verified Data Sources

Availability of each source was verified via direct request:

### Source 1: Solana RPC (Helius Mainnet Node)
* **Type:** `onchain_fact`
* **Purpose:** Retrieving on-chain accounts, signature history (`getSignaturesForAddress`), transaction parsing (`getTransaction`).
* **Verification Status:** 🟢 **AVAILABLE** (HTTP 200, slot 451575686).

### Source 2: Solana Foundation Public RPC (`https://api.mainnet-beta.solana.com`)
* **Type:** `onchain_fact`
* **Purpose:** Independent on-chain validation of slots and balances.
* **Verification Status:** 🟢 **AVAILABLE** (HTTP 200, slot 451575685).

### Source 3: Solana Validator Registry (`getVoteAccounts`)
* **Type:** `onchain_fact` / `public_label`
* **Purpose:** Identification of active Solana consensus validators, voting accounts, and their stake.
* **Verification Status:** 🟢 **AVAILABLE** (HTTP 200, 675 current validators).

### Source 4: DeFiLlama Hacks Database (`https://api.llama.fi/hacks`)
* **Type:** `third_party_database`
* **Purpose:** Verification of incident dates, hacked protocol names, and exploit techniques.
* **Verification Status:** 🟢 **AVAILABLE** (HTTP 200, 1289 incidents, 54 incidents in the Solana ecosystem).

### Source 5: Public Auditor and Regulator Reports (CertiK, Solana Foundation, US DOJ, OtterSec)
* **Type:** `public_incident_report`
* **Purpose:** Documented post-mortems and court records with confirmed perpetrator addresses.
* **Verification Status:** 🟢 **AVAILABLE** (public web reports available for reading and cross-verification).

### Source 6: Solscan API (`https://api.solscan.io`)
* **Verification Status:** 🔴 **NOT VERIFIED / UNAVAILABLE** (Cloudflare / WAF blocks direct API requests without enterprise authorization). For labeling, the direct Solscan API **IS NOT USED**; the public web interface `solscan.io/account/...` is used exclusively as an explorer link.

### Source 7: Jupiter Token List API (`https://tokens.jup.ag/tokens`)
* **Verification Status:** 🔴 **NOT VERIFIED / UNAVAILABLE** (DNS resolution failure / network timeout). **NOT USED** in labeling.

---

## 5. Labeling Schema (`labels.jsonl`) and Verification Rules

Each line in `ground-truth/labels.jsonl` is a serialized JSON object of the following structure:

```json
{
  "address": "4vdC3J...",
  "label": "DANGEROUS",
  "source_url": "https://...",
  "cutoff_date": "2026-09-23T00:00:00.000Z",
  "event_date": "2026-09-24T12:00:00.000Z",
  "evidence_quote": "wallet drained 15000 SOL from treasury",
  "origin_source": "CertiK Incident Report #123",
  "checked_at": "2026-09-29T10:00:00.000Z"
}
```

### Field Requirements:
1. `address`: valid base58 Solana address. Account must be System-owned (`11111111111111111111111111111111`) and `executable == false` for classes asserting that the entity is a wallet.
2. `label`: one of `SAFE`, `DANGEROUS`, `UNCERTAIN`.
3. `source_url`: public source URL. Must return HTTP 200 without JS rendering and contain the exact address substring.
4. `cutoff_date` / `event_date`: for class `DANGEROUS`, `event_date > cutoff_date` is mandatory.
5. `evidence_quote`: verbatim quote from the `source_url` page text (up to 15 words) confirming toxic outcome. Must be found in the HTTP response body unaltered.
6. No overlap with `archive/exp1/large-wallets.json` and no duplicates within the labeled set.
7. Any record lacking `PASS` status from the `ground-truth/tools/verify-labels.mjs` tool **IS NOT CONSIDERED A VALID LABEL**.
