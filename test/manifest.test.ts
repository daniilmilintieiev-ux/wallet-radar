import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("AgenticTrade manifest: valid JSON with required schema keys", () => {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const manifestPath = path.join(rootDir, "agentictrade", "manifest.json");
  const pkgPath = path.join(rootDir, "package.json");

  assert.ok(fs.existsSync(manifestPath), "agentictrade/manifest.json should exist");
  assert.ok(fs.existsSync(pkgPath), "package.json should exist");

  const rawManifest = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(rawManifest);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  // Required top-level keys
  const requiredKeys = ["name", "version", "description", "tools", "transport", "config", "pricing"];
  for (const key of requiredKeys) {
    assert.ok(key in manifest, `manifest must include top-level key: ${key}`);
  }

  // Field values
  assert.equal(manifest.name, "wallet-radar");
  assert.equal(manifest.version, pkg.version);
  assert.equal(typeof manifest.description, "string");
  assert.ok(manifest.description.length > 0);
  assert.equal(manifest.transport, "stdio");

  // Tools array
  assert.ok(Array.isArray(manifest.tools));
  const toolNames = manifest.tools.map((t: { name: string; description: string }) => {
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.description, "string");
    assert.ok(t.description.length > 0);
    return t.name;
  });
  assert.ok(toolNames.includes("radar_scan"));
  assert.ok(toolNames.includes("radar_analyze"));
  assert.ok(toolNames.includes("radar_selftest"));

  // Config object (env vars)
  assert.equal(typeof manifest.config, "object");
  assert.ok("HELIUS_API_KEY" in manifest.config);
  assert.ok("RADAR_MAX_RISK" in manifest.config);
  assert.ok("WEBHOOK_URL" in manifest.config);
  assert.ok("RADAR_LLM_KEY" in manifest.config);

  // Pricing object
  assert.equal(typeof manifest.pricing, "object");
  assert.equal(manifest.pricing.currency, "USDC");
  assert.ok("radar_scan" in manifest.pricing);
  assert.ok("radar_analyze" in manifest.pricing);
});
