import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyRecord, SYSTEM_PROGRAM_ID } from "./verify-labels.mjs";

// All network I/O is mocked via opts.fetchPage/opts.fetchRpc -- these tests
// make no real HTTP/RPC calls (CLAUDE.md: no network dependency for reportable checks).

const ADDRESS = "TestWa11etAddress1111111111111111111111111";
const SOURCE_URL = `https://example.com/wallet/${ADDRESS}`;
const QUOTE = "wallet drained treasury funds after exploit";

function baseRecord(overrides = {}) {
  return {
    address: ADDRESS,
    class: "DANGEROUS",
    source_url: SOURCE_URL,
    cutoff_date: "2026-01-01T00:00:00.000Z",
    event_date: "2026-02-01T00:00:00.000Z",
    evidence_quote: QUOTE,
    origin_source: "Test Source",
    checked_at: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

function pageWithAddressAndQuoteInBody() {
  return async () => ({
    status: 200,
    text: `<html><body>Incident report for wallet ${ADDRESS}. Summary: "${QUOTE}". See also <a href="${SOURCE_URL}">source</a>.</body></html>`,
  });
}

function pageWithAddressOnlyInUrl() {
  return async () => ({
    status: 200,
    // The address appears ONLY inside the anchor href (= source_url itself); once
    // that literal URL is stripped, the body has no other occurrence of it.
    text: `<html><body>Generic report page. <a href="${SOURCE_URL}">source</a></body></html>`,
  });
}

function pageWithAddressButNoQuote() {
  return async () => ({
    status: 200,
    text: `<html><body>Report: wallet ${ADDRESS} exists. <a href="${SOURCE_URL}">source</a></body></html>`,
  });
}

function goodRpc() {
  return async () => ({ ok: true, status: 200, value: { owner: SYSTEM_PROGRAM_ID, executable: false } });
}

function defaultOpts(overrides = {}) {
  return {
    fetchPage: pageWithAddressAndQuoteInBody(),
    fetchRpc: goodRpc(),
    exp1Addresses: new Set(),
    seenAddresses: new Set(),
    ...overrides,
  };
}

test("positive fixture: a fully valid record PASSes", async () => {
  const res = await verifyRecord(baseRecord(), defaultOpts());
  assert.equal(res.pass, true, `expected PASS, got errors: ${JSON.stringify(res.errors)}`);
  assert.deepEqual(res.errors, []);
});

test("negative: missing class field -> FAIL", async () => {
  const record = baseRecord();
  delete record.class;
  const res = await verifyRecord(record, defaultOpts());
  assert.equal(res.pass, false);
  assert.ok(res.errors.some((e) => e.includes("Missing or invalid class field")));
});

test("negative: invalid class value -> FAIL", async () => {
  const res = await verifyRecord(baseRecord({ class: "MAYBE" }), defaultOpts());
  assert.equal(res.pass, false);
  assert.ok(res.errors.some((e) => e.includes('Invalid class "MAYBE"')));
});

test("negative: event_date <= cutoff_date -> FAIL (lookahead violation)", async () => {
  const res = await verifyRecord(
    baseRecord({ cutoff_date: "2026-02-01T00:00:00.000Z", event_date: "2026-01-01T00:00:00.000Z" }),
    defaultOpts(),
  );
  assert.equal(res.pass, false);
  assert.ok(res.errors.some((e) => e.includes("Lookahead violation")));
});

test("negative: missing evidence_quote -> FAIL", async () => {
  const record = baseRecord();
  delete record.evidence_quote;
  const res = await verifyRecord(record, defaultOpts());
  assert.equal(res.pass, false);
  assert.ok(res.errors.some((e) => e.includes("evidence_quote is required")));
});

test("negative: evidence_quote over 15 words -> FAIL", async () => {
  const longQuote = Array.from({ length: 16 }, (_, i) => `word${i}`).join(" ");
  const res = await verifyRecord(baseRecord({ evidence_quote: longQuote }), defaultOpts());
  assert.equal(res.pass, false);
  assert.ok(res.errors.some((e) => e.includes("exceeds 15 words limit")));
});

test("negative: evidence_quote not found on page -> FAIL", async () => {
  const res = await verifyRecord(baseRecord(), defaultOpts({ fetchPage: pageWithAddressButNoQuote() }));
  assert.equal(res.pass, false);
  assert.ok(res.errors.some((e) => e.includes("not found verbatim in raw HTTP response")));
});

test("negative: address only present inside source_url, not in body -> FAIL", async () => {
  const res = await verifyRecord(baseRecord(), defaultOpts({ fetchPage: pageWithAddressOnlyInUrl() }));
  assert.equal(res.pass, false);
  assert.ok(res.errors.some((e) => e.includes("only found inside source_url itself")));
});

test("negative: source_url returns HTTP 404 -> FAIL", async () => {
  const res = await verifyRecord(
    baseRecord(),
    defaultOpts({ fetchPage: async () => ({ status: 404, text: null }) }),
  );
  assert.equal(res.pass, false);
  assert.ok(res.errors.some((e) => e.includes("HTTP 404")));
});

test("negative: executable account (program, not a wallet) -> FAIL", async () => {
  const res = await verifyRecord(
    baseRecord(),
    defaultOpts({ fetchRpc: async () => ({ ok: true, status: 200, value: { owner: SYSTEM_PROGRAM_ID, executable: true } }) }),
  );
  assert.equal(res.pass, false);
  assert.ok(res.errors.some((e) => e.includes("executable")));
});

test("negative: account owner is not the System Program -> FAIL", async () => {
  const res = await verifyRecord(
    baseRecord(),
    defaultOpts({
      fetchRpc: async () => ({ ok: true, status: 200, value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false } }),
    }),
  );
  assert.equal(res.pass, false);
  assert.ok(res.errors.some((e) => e.includes("Account owner is")));
});

test("negative: null account (does not exist on-chain) -> FAIL", async () => {
  const res = await verifyRecord(
    baseRecord(),
    defaultOpts({ fetchRpc: async () => ({ ok: true, status: 200, value: null }) }),
  );
  assert.equal(res.pass, false);
  assert.ok(res.errors.some((e) => e.includes("does not exist on-chain")));
});

test("negative: duplicate address within the dataset -> FAIL on second occurrence", async () => {
  const seenAddresses = new Set();
  const first = await verifyRecord(baseRecord(), defaultOpts({ seenAddresses }));
  assert.equal(first.pass, true);
  const second = await verifyRecord(baseRecord(), defaultOpts({ seenAddresses }));
  assert.equal(second.pass, false);
  assert.ok(second.errors.some((e) => e.includes("Duplicate address")));
});

test("negative: address overlaps archive/exp1/large-wallets.json -> FAIL (contamination)", async () => {
  const res = await verifyRecord(baseRecord(), defaultOpts({ exp1Addresses: new Set([ADDRESS]) }));
  assert.equal(res.pass, false);
  assert.ok(res.errors.some((e) => e.includes("Contamination")));
});
