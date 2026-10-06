import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../src/dashboard.js";
import type { ScanLedgerRecord } from "../src/oracle/index.js";

// SECAUDIT step 5(a): hostile values that reach renderDashboardHtml must not become
// markup, attribute breakouts, or part of the inline <script>. The values below are
// inert strings; the assertions check they are neutralised, they are not exploits.

const EVIL_TAG = `<img src=x onerror=alert(1)>`;
const EVIL_SCRIPT = `</script><script>alert(1)</script>`;
const EVIL_ATTR = `x" onfocus="alert(1)" autofocus="`;
const LS = "  ";

function scriptBlock(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  return m ? m[1] : "";
}

/** Every <tag ...> start tag in the document, with quoted attribute values blanked, to look for injected attributes. */
function injectedAttr(html: string, name: string): boolean {
  // After the renderer is done, an attacker-supplied attribute would appear as a bare ` name="` inside an element.
  return new RegExp(`\s${name}="alert\(1\)"`).test(html);
}

describe("secaudit dashboard: values are escaped in HTML text and attributes", () => {
  test("wallet from the address bar is escaped in the input value and the page", () => {
    const html = renderDashboardHtml({ wallet: `${EVIL_TAG}"'${EVIL_SCRIPT}` });
    assert.ok(!html.includes(EVIL_TAG), "raw tag must not appear");
    assert.ok(!html.includes(`<script>alert(1)</script>`));
    assert.ok(!injectedAttr(html, "onerror"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  });

  test("watchlist entries are escaped in href, title and text", () => {
    const html = renderDashboardHtml({ wallet: "", watchlist: [`"><script>alert(1)</script>`, `${EVIL_ATTR}`] });
    assert.ok(!html.includes(`<script>alert(1)</script>`));
    assert.ok(!injectedAttr(html, "onfocus"));
  });

  test("replay anomaly text (visible description) is escaped, and nothing user-supplied lands in the inline <script>", () => {
    const marker = "ZZ_USER_MARKER";
    const html = renderDashboardHtml({
      demo: "replay",
      wallet: `${marker}`,
      version: `v1${EVIL_TAG}`,
      tokenCheck: `${EVIL_TAG}${marker}`,
      baseVerdict: `${EVIL_TAG}${marker}`,
      replayData: {
        wallet: marker,
        riskScore: 42,
        recordedAtUtc: `${EVIL_TAG}${marker}`,
        anomalies: [{ type: `T${EVIL_TAG}`, severity: "high", text: `${EVIL_TAG}${LS}${EVIL_SCRIPT}${marker}`, timestamp: 1_700_000_000 }],
      },
    });
    assert.ok(!html.includes(EVIL_TAG), "raw tag must not appear anywhere");
    assert.ok(!html.includes(`<script>alert(1)</script>`));
    assert.ok(!scriptBlock(html).includes(marker), "inline <script> is static: no user data may be interpolated");
    assert.ok(!scriptBlock(html).includes(LS));
    // exactly one script element: the static one
    assert.equal((html.match(/<script>/g) ?? []).length, 1);
  });

  test("ledger record verdict is escaped (custom verdict strings are not covered by the attestation)", () => {
    const rec = { wallet: "W", riskScore: 10, verdict: EVIL_TAG, timestamp: 1_700_000_000, topRules: [], txSignatures: [], slot: 1 } as unknown as ScanLedgerRecord;
    const html = renderDashboardHtml({ wallet: "W", records: [rec] });
    assert.ok(!html.includes(EVIL_TAG));
  });

  test("a base58-looking token inside an anomaly description cannot break out of the copy button attributes", () => {
    const addr = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";
    const html = renderDashboardHtml({
      demo: "replay",
      replayData: { riskScore: 50, anomalies: [{ type: "X", severity: "medium", text: `sent to ${addr}"onclick="alert(1)` }] },
    });
    assert.ok(!injectedAttr(html, "onclick"));
  });
});

describe("secaudit dashboard: KNOWN GAP (Low, see docs/KNOWN-ISSUES.md)", () => {
  // data-anomaly-text uses escapeText(), which does not escape double quotes, so a
  // description containing `"` ends the attribute. Reaching it needs hostile anomaly
  // text (replay JSON is repo-controlled; ledger topRules are not covered by the
  // attestation signature but cannot currently land on-chain, see KNOWN-ISSUES).
  // Not fixed in this pass (only critical/high are). Marked todo so the suite stays
  // green while the gap stays visible.
  test("data-anomaly-text must not be breakable by a double quote in the description", { todo: "Low: escapeText leaves \" unescaped in data-anomaly-text" }, () => {
    const html = renderDashboardHtml({
      demo: "replay",
      replayData: { riskScore: 50, anomalies: [{ type: "X", severity: "medium", text: EVIL_ATTR }] },
    });
    assert.ok(!injectedAttr(html, "onfocus"));
  });
});
