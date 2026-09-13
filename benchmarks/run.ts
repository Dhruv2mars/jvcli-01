// Benchmark harness for jvcli v1.
// Usage: bun benchmarks/run.ts [--layers N] [--files F] [--reps R]
// Builds a temp repo, creates N layers with disjoint writes, publishes
// half of them, runs verify --full, and prints one JSON line on stdout:
// { layers, filesPerLayer, publishP50Ms, publishP95Ms, verifyMs,
//   statusMs, bytesPerLayer, objects }.
// Progress and diagnostics go to stderr so stdout stays parseable.
// Timing uses wall clock milliseconds. bytesPerLayer is the average file
// bytes written per layer. objects is the verify --full object count.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = resolve(HERE, "..");
const CLI = join(REPO_ROOT, "dist", "cli-entry.js");

function argValue(argv: ReadonlyArray<string>, name: string, fallback: number): number {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const raw = argv[i + 1];
  if (raw === undefined) throw new Error(`missing value for ${name}`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`bad value for ${name}: ${raw}`);
  return n;
}

async function cli(cwd: string, args: ReadonlyArray<string>): Promise<string> {
  const { stdout } = await execFileAsync("node", [CLI, ...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function cliJson<T>(cwd: string, args: ReadonlyArray<string>): Promise<T> {
  const out = await cli(cwd, [...args, "--json"]);
  return JSON.parse(out) as T;
}

function percentile(sorted: ReadonlyArray<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[i]!);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const layers = argValue(argv, "--layers", 5);
  const filesPerLayer = argValue(argv, "--files", 5);
  const reps = argValue(argv, "--reps", 1);

  const dir = await mkdtemp(join(tmpdir(), "jvcli-bench-"));
  console.error(`bench repo: ${dir}`);
  let totalBytes = 0;
  try {
    await cli(process.cwd(), ["init", dir]);
    interface LayerCreate {
      layer: string;
      workspace: string;
    }
    const ids: Array<string> = [];
    for (let i = 0; i < layers; i++) {
      const created = await cliJson<LayerCreate>(dir, ["layer", "create", "--name", `bench-${i}`]);
      ids.push(created.layer);
      for (let j = 0; j < filesPerLayer; j++) {
        const name = `bench-${i}-file-${j}.txt`;
        const body = `benchmark layer ${i} file ${j}\n`.repeat(32);
        const bytes = new TextEncoder().encode(body);
        totalBytes += bytes.byteLength;
        await mkdir(created.workspace, { recursive: true });
        await writeFile(join(created.workspace, name), bytes);
      }
    }

    const toPublish = Math.floor(layers / 2);
    const publishSamples: Array<number> = [];
    for (let r = 0; r < Math.max(1, reps); r++) {
      const t0 = performance.now();
      for (let i = 0; i < toPublish; i++) {
        await cli(dir, ["publish", ids[i]!, "--allow-missing-context", "--json"]);
      }
      publishSamples.push(performance.now() - t0);
      if (r === 0) {
        // First rep publishes; later reps re-run the no-op tail for stability.
      }
    }
    publishSamples.sort((a, b) => a - b);

    const t1 = performance.now();
    interface VerifyOut {
      objects: number;
    }
    const verified = await cliJson<VerifyOut>(dir, ["verify", "--full"]);
    const verifyMs = Math.round(performance.now() - t1);

    const t2 = performance.now();
    await cli(dir, ["status", "--json"]);
    const statusMs = Math.round(performance.now() - t2);

    const result = {
      layers,
      filesPerLayer,
      publishP50Ms: percentile(publishSamples, 50),
      publishP95Ms: percentile(publishSamples, 95),
      verifyMs,
      statusMs,
      bytesPerLayer: Math.round(totalBytes / layers),
      objects: verified.objects
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
