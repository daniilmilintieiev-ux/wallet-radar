import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  signAttestation,
  verifyAttestation,
  serializeScanRecord,
  deserializeScanRecord,
  type ScanLedgerRecord,
} from "../src/oracle/index.js";

// SECAUDIT step 5(д): oracle memo anchor encoding and what the attestation signature covers.
// No network. The Memo-program UTF-8 requirement is from the SPL Memo program's documented
// behaviour (НЕ ПРОВЕРЕНО on-chain in this audit: no network allowed).

function signedRecord(topRules: string[] = ["LARGE_SWAP"]) {
  const oracle = Keypair.generate();
  const rec: ScanLedgerRecord = {
    wallet: Keypair.generate().publicKey.toBase58(),
    riskScore: 40,
    verdict: "SUSPICIOUS",
    timestamp: 1_790_000_000,
    topRules,
    txSignatures: [],
  };
  return { oracle, rec: { ...rec, ...signAttestation(rec, oracle) } as ScanLedgerRecord };
}

describe("secaudit oracle: what holds", () => {
  test("changing wallet, risk, verdict or timestamp invalidates the attestation; a different oracle key is refused", () => {
    const { oracle, rec } = signedRecord();
    const key = oracle.publicKey.toBase58();
    assert.equal(verifyAttestation(rec, key), true);
    assert.equal(verifyAttestation({ ...rec, riskScore: 5 }, key), false);
    assert.equal(verifyAttestation({ ...rec, verdict: "SAFE" }, key), false);
    assert.equal(verifyAttestation({ ...rec, timestamp: rec.timestamp + 1 }, key), false);
    assert.equal(verifyAttestation({ ...rec, wallet: Keypair.generate().publicKey.toBase58() }, key), false);
    assert.equal(verifyAttestation(rec, Keypair.generate().publicKey.toBase58()), false);
    assert.equal(verifyAttestation({ ...rec, signature: undefined }, key), false);
  });

  test("garbage, truncated and oversized-length memo payloads never produce a verified record", () => {
    const { oracle, rec } = signedRecord();
    const good = serializeScanRecord(rec);
    const key = oracle.publicKey.toBase58();
    const cases: Buffer[] = [
      Buffer.alloc(0),
      Buffer.from("RS01"),
      good.subarray(0, 47),
      good.subarray(0, good.length - 1), // trailer cut short: signature dropped
      Buffer.concat([good.subarray(0, 46), Buffer.from([0xff, 0xff]), good.subarray(48)]), // payload length lies
      Buffer.from("{not json"),
    ];
    for (const buf of cases) {
      let verified = false;
      try {
        verified = verifyAttestation(deserializeScanRecord(buf), key);
      } catch {
        // rejecting with an error is fine: the reader wraps this in try/catch
      }
      assert.equal(verified, false);
    }
  });
});

describe("secaudit oracle: KNOWN GAPS (see docs/KNOWN-ISSUES.md)", () => {
  test("memo data (RADAR_ORACLE: + RS01 record + signature trailer) is valid UTF-8", { todo: "Medium: binary memo is not valid UTF-8, the SPL Memo program accepts UTF-8 only (not verified on-chain)" }, () => {
    const { rec } = signedRecord();
    const memo = Buffer.concat([Buffer.from("RADAR_ORACLE:"), serializeScanRecord(rec)]);
    new TextDecoder("utf-8", { fatal: true }).decode(memo);
  });

  test("the attestation signature covers topRules (a replayed signed record cannot carry different rules)", { todo: "Medium: topRules/txSignatures are outside the signed digest" }, () => {
    const { oracle, rec } = signedRecord(["LARGE_SWAP"]);
    const tampered = { ...rec, topRules: [`x" onfocus="alert(1)`] };
    assert.equal(verifyAttestation(tampered, oracle.publicKey.toBase58()), false);
  });

  test("deserialize normalises a non-array topRules payload instead of passing a string through", { todo: "Low: payload.topRules || [] accepts any truthy JSON" }, () => {
    const { rec } = signedRecord();
    const buf = serializeScanRecord(rec);
    const payload = Buffer.from(JSON.stringify({ topRules: "not-an-array", txSignatures: [] }));
    const hdr = Buffer.from(buf.subarray(0, 48));
    hdr.writeUInt16LE(payload.length, 46);
    const out = deserializeScanRecord(Buffer.concat([hdr, payload]));
    assert.ok(Array.isArray(out.topRules));
  });
});
