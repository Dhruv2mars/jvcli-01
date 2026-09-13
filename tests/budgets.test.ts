import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const budgets = JSON.parse(readFileSync(join(ROOT, "benchmarks", "budgets.json"), "utf8"));

describe("performance budgets", () => {
  test("budgets.json carries real measured baselines, not placeholders", () => {
    for (const key of ["baselines5", "baselines100"] as const) {
      const b = budgets[key];
      expect(b.publishP50Ms).toBeGreaterThan(0);
      expect(b.verifyMs).toBeGreaterThan(0);
      expect(b.statusMs).toBeGreaterThan(0);
      expect(b.bytesPerLayer).toBeGreaterThan(0);
      expect(b.objects).toBeGreaterThan(0);
    }
    expect(budgets.regression.threshold).toBe(1.2);
  });
});
