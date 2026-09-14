import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkResult, loadBudgets } from "../benchmarks/check.ts";

const ROOT = resolve(import.meta.dir, "..");
const budgets = JSON.parse(readFileSync(join(ROOT, "benchmarks", "budgets.json"), "utf8"));

describe("performance budgets", () => {
  test("budgets.json carries real measured baselines, not placeholders", () => {
    for (const key of ["baselines5", "baselines100", "baselines1000"] as const) {
      const b = budgets[key];
      expect(b.publishP50Ms).toBeGreaterThan(0);
      expect(b.verifyMs).toBeGreaterThan(0);
      expect(b.statusMs).toBeGreaterThan(0);
      expect(b.bytesPerLayer).toBeGreaterThan(0);
      expect(b.objects).toBeGreaterThan(0);
    }
    expect(budgets.regression.threshold).toBe(1.2);
  });

  test("check passes on at-baseline numbers", () => {
    const parsed = loadBudgets(join(ROOT, "benchmarks", "budgets.json"));
    const verdict = checkResult(
      { layers: 1000, filesPerLayer: 5, publishP50Ms: budgets.baselines1000.publishP50Ms },
      parsed
    );
    expect(verdict.ok).toBe(true);
  });

  test("synthetic regressed fixture makes the check fail", () => {
    const parsed = loadBudgets(join(ROOT, "benchmarks", "budgets.json"));
    const regressed = Math.ceil(budgets.baselines1000.publishP50Ms * budgets.regression.threshold) + 1;
    const verdict = checkResult({ layers: 1000, filesPerLayer: 5, publishP50Ms: regressed }, parsed);
    expect(verdict.ok).toBe(false);
  });

  test("check.ts exits nonzero on a synthetic regressed fixture", () => {
    const regressed = Math.ceil(budgets.baselines1000.publishP50Ms * budgets.regression.threshold) + 1;
    const proc = Bun.spawnSync(["bun", join(ROOT, "benchmarks", "check.ts"), JSON.stringify({
      layers: 1000,
      filesPerLayer: 5,
      publishP50Ms: regressed
    })], { cwd: ROOT });
    expect(proc.exitCode).toBe(1);
  });

  test("check.ts exits zero on at-baseline numbers", () => {
    const proc = Bun.spawnSync(["bun", join(ROOT, "benchmarks", "check.ts"), JSON.stringify({
      layers: 1000,
      filesPerLayer: 5,
      publishP50Ms: budgets.baselines1000.publishP50Ms
    })], { cwd: ROOT });
    expect(proc.exitCode).toBe(0);
  });
});
