# Solana Actions & Blinks (`src/blink`)

This module defines and serves **Solana Actions & Blinks** for Wallet Radar, enabling one-tap wallet safety scans directly from Twitter/X, Discord, Telegram, Phantom, Solflare, and Dialect.

## Overview

A **Blink** (Blockchain Link) turns any Solana Action into an unfurled interactive UI card. Anyone can paste a Wallet Radar Blink link anywhere on the web, click **"Scan Wallet"**, sign a 0.005 USDC payment transaction in their wallet, and initiate an instant behavioral risk scan.

### Key Capabilities

1. **One-Tap Scan Execution**:
   - Accepts any Solana wallet address as an input parameter or pre-populates target addresses.
   - Embeds a transaction with both an audit attestation memo (`RadarScan:<target>:x402:0.005`) and an SPL Token micropayment (0.005 USDC) to the operator.
2. **Standard Actions Discovery (`/actions.json`)**:
   - Maps URL patterns (e.g. `/scan/*`) to Action API endpoints conforming to the official Solana Actions specification.
3. **Full Cross-Wallet Compatibility**:
   - CORS headers (`ACTIONS_CORS_HEADERS`) enabled on all routes.
   - Deep-linking support for **Phantom**, **Solflare**, and **Dialect**.

---

## Action Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/actions.json` | `GET`, `OPTIONS` | Discovery rules mapping web URLs to Action endpoints |
| `/api/actions/radar-scan` | `GET`, `OPTIONS` | Returns `ActionGetResponse` metadata (title, icon, parameters) |
| `/api/actions/radar-scan?wallet=<addr>` | `GET` | Returns targeted Action metadata for a specific wallet address |
| `/api/actions/radar-scan` | `POST` | Assembles signable transaction for connected user account |

---

## The Blink Manifest (`actions.json`)

Hosted at the root domain (`https://pay.cbellory.xyz/actions.json`):

```json
{
  "rules": [
    {
      "pathPattern": "/scan/*",
      "apiPath": "/api/actions/radar-scan?wallet=*"
    },
    {
      "pathPattern": "/api/actions/**",
      "apiPath": "/api/actions/**"
    }
  ]
}
```

---

## Wallet Registration & Deep Links

### 1. Dialect Blinks (`dial.to`)

Dialect unrolls the Action metadata into an interactive widget:

```
https://dial.to/?action=solana-action:https://pay.cbellory.xyz/api/actions/radar-scan
```

Or for a specific target wallet:
```
https://dial.to/?action=solana-action:https://pay.cbellory.xyz/api/actions/radar-scan?wallet=8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j
```

### 2. Phantom Wallet Registration

Phantom detects Blinks natively in experimental mode (Twitter/X and web) and through in-app browser universal links:

```
https://phantom.app/ul/browse/https%3A%2F%2Fpay.cbellory.xyz%2Fapi%2Factions%2Fradar-scan?ref=wallet-radar
```

Or via direct protocol scheme:
```
solana-action:https://pay.cbellory.xyz/api/actions/radar-scan
```

### 3. Solflare Wallet Registration

Solflare supports Solana Actions directly inside its mobile app and browser extension:

```
https://solflare.com/ul/v1/browse/https%3A%2F%2Fpay.cbellory.xyz%2Fapi%2Factions%2Fradar-scan
```

### 4. Official Dialect Registry Submission

To list Wallet Radar on the global [dial.to](https://dial.to) directory:
- **Repository**: [dialectlabs/blinks-registry](https://github.com/dialectlabs/blinks-registry)
- **Metadata**:
  - Name: `Wallet Radar`
  - Host: `pay.cbellory.xyz`
  - Action URL: `https://pay.cbellory.xyz/api/actions/radar-scan`
  - Tags: `Security`, `DeFi`, `Trading`, `Audit`

---

## Programmatic Usage

```typescript
import {
  buildActionsJson,
  buildRadarScanActionGet,
  buildRadarScanActionPost,
  buildBlinkUrl,
  getBlinkRegistrationManifest,
} from "./src/blink/index.js";

// 1. Generate discovery actions.json
const actionsJson = buildActionsJson();

// 2. Generate ActionGetResponse metadata
const actionMetadata = buildRadarScanActionGet({
  targetWallet: "8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j",
  priceUsdc: 0.005,
});

// 3. Prepare signable transaction for a connected wallet
const postResponse = await buildRadarScanActionPost(
  userAccountPubkey,
  targetWalletPubkey,
  {
    recipient: recipientPubkey,
    priceUsdc: 0.005,
  }
);
// postResponse.transaction contains base64 wire transaction for signing

// 4. Generate wallet deep-links
const phantomLink = buildBlinkUrl("https://pay.cbellory.xyz/api/actions/radar-scan", { provider: "phantom" });
const dialectLink = buildBlinkUrl("https://pay.cbellory.xyz/api/actions/radar-scan", { provider: "dialect" });
```
