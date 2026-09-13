// Shared helpers for CLI end-to-end tests.
//
// All tests drive the real binary (`node dist/cli-entry.js`) as a child
// process with `cwd` set to an isolated temp repo, and parse `--json`
// output for assertions.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Absolute path to the built CLI entry. Always passed absolutely to `node`.
export const CLI_PATH = resolve(import.meta.dir, "../dist/cli-entry.js");

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliJsonResult extends CliResult {
  // Parsed stdout, or null when stdout is not JSON.
  readonly json: any;
}

/** Spawn `node <CLI_PATH> ...args` with cwd set to the repo dir. */
export function runCli(repoDir: string, args: ReadonlyArray<string>, env?: Record<string, string>): CliResult {
  const r = spawnSync("node", [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf8",
    env: { ...process.env, ...(env ?? {}) },
    maxBuffer: 64 * 1024 * 1024
  });
  if (r.error !== undefined) {
    return { code: 1, stdout: "", stderr: `spawn failed: ${(r.error as Error).message}` };
  }
  return {
    code: r.status ?? (r.signal !== null ? 1 : 0),
    stdout: typeof r.stdout === "string" ? r.stdout : String(r.stdout ?? ""),
    stderr: typeof r.stderr === "string" ? r.stderr : String(r.stderr ?? "")
  };
}

/** Like runCli but appends `--json` (unless already present) and parses stdout. */
export function runCliJson(repoDir: string, args: ReadonlyArray<string>, env?: Record<string, string>): CliJsonResult {
  const withJson = args.includes("--json") ? [...args] : [...args, "--json"];
  const r = runCli(repoDir, withJson, env);
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { ...r, json };
}

export interface TempRepo {
  readonly base: string;
  readonly repo: string;
}

/**
 * Create an isolated temp repo seeded with `seed` files, then `init` it.
 * Caller must remove `base` when done (see rmTemp).
 */
export function mkTempRepo(seed: Record<string, string> = { "a.txt": "hello\n" }): TempRepo {
  const base = mkdtempSync(join(tmpdir(), "jv-e2e-"));
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  for (const [rel, content] of Object.entries(seed)) {
    const full = join(repo, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const r = spawnSync("node", [CLI_PATH, "init", repo], { cwd: base, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error !== undefined || r.status !== 0) {
    const out = r.error !== undefined ? `spawn failed: ${(r.error as Error).message}` : `${r.stdout ?? ""}${r.stderr ?? ""}`;
    rmSync(base, { recursive: true, force: true });
    throw new Error(`jvcli init failed: ${out}`);
  }
  return { base, repo };
}

export function rmTemp(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

/** Workspace dir for a layer: <repo>/.javelin/layers/<id>/workspace. */
export function layerWorkspace(repo: string, layerId: string): string {
  return join(repo, ".javelin", "layers", layerId, "workspace");
}

export function writeWs(repo: string, layerId: string, rel: string, content: string): void {
  const full = join(layerWorkspace(repo, layerId), rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function readWs(repo: string, layerId: string, rel: string): string {
  return readFileSync(join(layerWorkspace(repo, layerId), rel), "utf8");
}

export function wsExists(repo: string, layerId: string, rel: string): boolean {
  return existsSync(join(layerWorkspace(repo, layerId), rel));
}

/** Create a repo-local symlink before init (used for scan symlink tests). */
export function seedSymlink(repo: string, rel: string, target: string): void {
  const full = join(repo, rel);
  mkdirSync(dirname(full), { recursive: true });
  symlinkSync(target, full);
}

/** Create a layer and return its id + workspace (asserts success via throw). */
export function createLayer(repo: string, name: string): { id: string; workspace: string } {
  const r = runCliJson(repo, ["layer", "create", "--name", name]);
  if (r.code !== 0 || r.json === null || typeof r.json.layer !== "string") {
    throw new Error(`layer create ${name} failed: code=${r.code} out=${r.stdout} err=${r.stderr}`);
  }
  return { id: r.json.layer as string, workspace: r.json.workspace as string };
}
