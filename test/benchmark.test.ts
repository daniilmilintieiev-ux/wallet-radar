import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runBenchmark, EVAL_SET, EVAL_VERSION } from "../src/benchmark.js";

describe("Benchmark", () => {
  it("runs all eval cases", () => {
    const result = runBenchmark();
    assert.equal(result.total, EVAL_SET.length);
    assert.ok(result.results.length === EVAL_SET.length);
  });

  it("reports accuracy between 0 and 1", () => {
    const result = runBenchmark();
    assert.ok(result.accuracy >= 0 && result.accuracy <= 1);
  });

  it("reports precision between 0 and 1", () => {
    const result = runBenchmark();
    assert.ok(result.precision >= 0 && result.precision <= 1);
  });

  it("reports recall between 0 and 1", () => {
    const result = runBenchmark();
    assert.ok(result.recall >= 0 && result.recall <= 1);
  });

  it("true + false positives = all predicted risky", () => {
    const result = runBenchmark();
    const predictedRisky = result.truePositives + result.falsePositives;
    const actualRisky = result.results.filter((r) => r.actual === "risky").length;
    assert.equal(predictedRisky, actualRisky);
  });

  it("true + false negatives = all actually risky", () => {
    const result = runBenchmark();
    const actualRiskyCount = EVAL_SET.filter((c) => c.expected === "risky").length;
    assert.equal(result.truePositives + result.falseNegatives, actualRiskyCount);
  });

  it("is deterministic: two runs give same results", () => {
    const r1 = runBenchmark();
    const r2 = runBenchmark();
    assert.equal(r1.accuracy, r2.accuracy);
    assert.equal(r1.precision, r2.precision);
    assert.equal(r1.recall, r2.recall);
    for (let i = 0; i < r1.results.length; i++) {
      assert.equal(r1.results[i].riskScore, r2.results[i].riskScore);
      assert.equal(r1.results[i].correct, r2.results[i].correct);
    }
  });

  it("reports eval version", () => {
    const result = runBenchmark();
    assert.equal(result.version, EVAL_VERSION);
  });

  it("each result has a caseId matching the eval set", () => {
    const result = runBenchmark();
    const evalIds = new Set(EVAL_SET.map((c) => c.id));
    for (const r of result.results) {
      assert.ok(evalIds.has(r.caseId), `Unknown caseId: ${r.caseId}`);
    }
  });

  it("achieves reasonable accuracy (> 50%)", () => {
    const result = runBenchmark();
    assert.ok(result.accuracy > 0.5, `Accuracy ${result.accuracy} is too low`);
  });
});
