// Budget regression check for jvcli v1 benchmark output.
// Usage:
//   bun benchmarks/run.ts --layers 5 --files 5 > /tmp/bench.json && \
//     bun benchmarks/check.ts "$(cat /tmp/bench.json)"
//   bun benchmarks/run.ts --layers 5 --files 5 | bun benchmarks/check.ts
// Compares the bench JSON line against the same-workload baseline in
// benchmarks/budgets.json and exits 0 when publish p50 is within the
// configured threshold, 1 on regression, 2 on usage errors.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const BUDGETS_PATH = join(HERE, "budgets.json");

export interface BenchResult {
  layers: number;
  filesPerLayer: number;
  publishP50Ms: number;
  publishP95Ms?: number;
  verifyMs?: number;
  statusMs?: number;
  bytesPerLayer?: number;
  objects?: number;
}

export interface CheckVerdict {
  ok: boolean;
  workload: string;
  baseline: number;
  actual: number;
  limit: number;
  threshold: number;
  reason: string;
}

interface BudgetsFile {
  regression: { metric: string; threshold: number; rule: string };
  [key: string]: unknown;
}

export function loadBudgets(path: string = BUDGETS_PATH): BudgetsFile {
  return JSON.parse(readFileSync(path, "utf8")) as BudgetsFile;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Finds the baseline entry whose workload matches this result exactly.
// budgets.json pairs workload<N> { layers, filesPerLayer } with
// baselines<N> { publishP50Ms, ... }.
export function findBaseline(
  budgets: BudgetsFile,
  result: BenchResult
): { workload: string; baseline: number; threshold: number } | null {
  const threshold = asNumber(isRecord(budgets["regression"]) ? budgets["regression"]["threshold"] : null);
  if (threshold === null) return null;
  for (const key of Object.keys(budgets)) {
    const m = /^workload(\d+)$/.exec(key);
    if (m === null) continue;
    const workload = budgets[key];
    if (!isRecord(workload)) continue;
    if (workload["layers"] !== result.layers || workload["filesPerLayer"] !== result.filesPerLayer) continue;
    const baselines = budgets[`baselines${m[1]}`];
    if (!isRecord(baselines)) continue;
    const baseline = asNumber(baselines["publishP50Ms"]);
    if (baseline === null) continue;
    return { workload: key, baseline, threshold };
  }
  return null;
}

export function checkResult(result: BenchResult, budgets: BudgetsFile): CheckVerdict {
  const actual = asNumber(result.publishP50Ms);
  if (actual === null || !Number.isInteger(result.layers) || !Number.isInteger(result.filesPerLayer)) {
    throw new Error("bench result must carry numeric layers, filesPerLayer, and publishP50Ms");
  }
  const match = findBaseline(budgets, result);
  if (match === null) {
    throw new Error(
      `no baseline in budgets.json for workload layers=${result.layers} files=${result.filesPerLayer}`
    );
  }
  const limit = match.baseline * match.threshold;
  const ok = actual <= limit;
  return {
    ok,
    workload: match.workload,
    baseline: match.baseline,
    actual,
    limit,
    threshold: match.threshold,
    reason: ok
      ? `publish p50 ${actual}ms within ${match.threshold}x of ${match.workload} baseline ${match.baseline}ms (limit ${limit.toFixed(1)}ms)`
      : `publish p50 ${actual}ms exceeds ${match.threshold}x of ${match.workload} baseline ${match.baseline}ms (limit ${limit.toFixed(1)}ms)`
  };
}

async function readInput(argv: ReadonlyArray<string>): Promise<string> {
  const direct = argv[2];
  if (direct !== undefined && direct !== "-") return direct;
  if (process.stdin.isTTY) {
    throw new Error("usage: bun benchmarks/check.ts '<bench-json-line>' (or pipe bench stdout to stdin)");
  }
  return readFileSync(0, "utf8");
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readInput(process.argv);
  } catch (err) {
    console.error(`budgets check: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  let result: BenchResult;
  try {
    result = JSON.parse(raw.trim().split("\n").filter(Boolean).pop() ?? "") as BenchResult;
  } catch {
    console.error("budgets check: could not parse bench JSON line");
    process.exit(2);
  }
  let verdict: CheckVerdict;
  try {
    verdict = checkResult(result, loadBudgets());
  } catch (err) {
    console.error(`budgets check: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  console.error(`budgets check ${verdict.ok ? "PASS" : "FAIL"}: ${verdict.reason}`);
  process.exit(verdict.ok ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
