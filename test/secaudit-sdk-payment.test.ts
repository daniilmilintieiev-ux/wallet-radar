import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createRadarClient } from "../src/sdk/index.js";
import { MockZKOracleClient } from "../src/oracle/index.js";

// SECAUDIT-H1: the SDK client must not sign/send a payment just because a
// (possibly malicious or MITM'd) server's 402 response says so. It must cap the
// amount, pin the recipient when one is configured, and only pay USDC.

const WALLET = Keypair.generate().publicKey.toBase58();
const OPERATOR_RECIPIENT = Keypair.generate().publicKey.toBase58();
const ATTACKER = Keypair.generate().publicKey.toBase58();
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_MINT = Keypair.generate().publicKey.toBase58();

function mock402(terms: { amount: string; recipient: string; mint?: string; token?: string }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ error: "Payment Required", x402: { mint: terms.mint ?? USDC } }), {
      status: 402,
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Amount": terms.amount,
        "X-Payment-Currency": terms.token ?? "USDC",
        "X-Payment-Recipient": terms.recipient,
      },
    })) as unknown as typeof fetch;
}

describe("secaudit: SDK refuses hostile 402 payment terms", () => {
  async function expectRefusal(terms: Parameters<typeof mock402>[0], config: { recipient?: string; maxPaymentUsdc?: number } = {}) {
    let signerCalled = false;
    const client = createRadarClient({
      baseUrl: "http://127.0.0.1:1",
      oracleClient: new MockZKOracleClient(),
      fetchFn: mock402(terms),
      paymentSigner: async () => {
        signerCalled = true;
        return { signature: "sig", payer: "payer" };
      },
      ...config,
    });
    await assert.rejects(() => client.scan(WALLET), /refus|exceeds|not allowed|unexpected|invalid/i);
    assert.equal(signerCalled, false, "the payment signer must never be invoked for hostile terms");
  }

  test("amount far above the price is refused", async () => {
    await expectRefusal({ amount: "1000000", recipient: ATTACKER });
  });

  test("non-finite / negative amounts are refused", async () => {
    await expectRefusal({ amount: "NaN", recipient: ATTACKER });
    await expectRefusal({ amount: "-5", recipient: ATTACKER });
  });

  test("a recipient that differs from the configured one is refused", async () => {
    await expectRefusal({ amount: "0.005", recipient: ATTACKER }, { recipient: OPERATOR_RECIPIENT });
  });

  test("a non-USDC mint chosen by the server is refused", async () => {
    await expectRefusal({ amount: "0.005", recipient: OPERATOR_RECIPIENT, mint: OTHER_MINT }, { recipient: OPERATOR_RECIPIENT });
  });

  test("normal terms (price, pinned recipient, USDC) are still paid", async () => {
    let signerCalled = false;
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) {
        return (mock402({ amount: "0.005", recipient: OPERATOR_RECIPIENT }) as any)("http://x");
      }
      return new Response(JSON.stringify({ riskScore: 1, verdict: "SAFE", anomalies: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createRadarClient({
      baseUrl: "http://127.0.0.1:1",
      oracleClient: new MockZKOracleClient(),
      recipient: OPERATOR_RECIPIENT,
      fetchFn,
      paymentSigner: async () => {
        signerCalled = true;
        return { signature: "sig", payer: "payer" };
      },
    });
    const res = await client.scan(WALLET);
    assert.equal(signerCalled, true);
    assert.equal(res.verdict, "SAFE");
  });
});
