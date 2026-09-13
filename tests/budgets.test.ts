import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const budgets = JSON.parse(readFileSync(join(ROOT, "benchmarks", "budgets.json"), "utf8"));

describe("performance budgets", () => {
  test("budgets.json carries real measured baselines, not placeholders", () => {
    expect(budgets.baselines5.publishP50Ms).toBeGreaterThan(0);
    expect(budgets.baselines5.verifyMs).toBeGreaterThan(0);
    expect(budgets.baselines5.statusMs).toBeGreaterThan(0);
    expect(budgets.baselines100.publishP50Ms).toBeGreaterThan(0);
    expect(budgets.regression.threshold).toBe(1.2);
  });
});
