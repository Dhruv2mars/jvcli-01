import { mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { IGNORE_FILE, ignoreMatch, JV_DIR, normalizePath, parseIgnoreFile, type IgnoreRule } from "./paths.js";

export interface ScanResult {
  readonly files: Map<string, { bytes: Uint8Array; executable: boolean }>;
  readonly symlinks: Map<string, string>;
  readonly warnings: ReadonlyArray<string>;
  readonly rules: ReadonlyArray<IgnoreRule>;
}

async function executableBit(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    // eslint-disable-next-line no-bitwise
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export async function scanDirectory(root: string): Promise<ScanResult> {
  const files = new Map<string, { bytes: Uint8Array; executable: boolean }>();
  const symlinks = new Map<string, string>();
  const warnings: Array<string> = [];
  let rules: ReadonlyArray<IgnoreRule> = [];
  try {
    const raw = await readFile(join(root, IGNORE_FILE), "utf8");
    rules = parseIgnoreFile(raw);
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
  }
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (rel === JV_DIR || rel.startsWith(`${JV_DIR}/`) || rel === IGNORE_FILE || rel === LAYER_MARKER) continue;
      const isDir = entry.isDirectory();
      if (ignoreMatch(rules, rel, isDir)) continue;
      if (entry.isSymbolicLink()) {
        const target = await readlink(abs);
        const portable = target.replaceAll("\\", "/");
        if (portable.startsWith("/") || portable === ".." || portable.startsWith("../") || portable.includes("\0")) {
          warnings.push(`skipped unsafe symlink: ${rel}`);
          continue;
        }
        const resolved = resolve(dirname(abs), portable);
        const rel2 = relative(root, resolved);
        if (rel2 === ".." || rel2.startsWith(`..${sep}`) || resolve(root, rel2) !== resolved || rel2.startsWith("..")) {
          warnings.push(`skipped escaping symlink: ${rel}`);
          continue;
        }
        symlinks.set(rel, portable);
      } else if (isDir) {
        await visit(abs);
      } else if (entry.isFile()) {
        const bytes = await readFile(abs);
        files.set(rel, { bytes, executable: process.platform !== "win32" ? await executableBit(abs) : false });
      } else {
        warnings.push(`skipped special file: ${rel}`);
      }
    }
  };
  await visit(root);
  for (const p of [...files.keys(), ...symlinks.keys()]) normalizePath(p);
  return { files, symlinks, warnings, rules };
}

export const LAYER_MARKER = ".jvcli-layer";

export async function materializeTree(
  root: string,
  files: ReadonlyMap<string, { bytes: Uint8Array; executable: boolean }>,
  symlinks: ReadonlyMap<string, string>
): Promise<void> {
  for (const [path, view] of files) {
    const abs = join(root, ...path.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, view.bytes, { mode: view.executable ? 0o755 : 0o644 });
  }
  for (const [path, target] of symlinks) {
    const abs = join(root, ...path.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    try {
      await rm(abs, { force: true });
    } catch {
      // fresh path
    }
    await symlink(target, abs);
  }
}

export async function clearWorkspace(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === JV_DIR || entry.name === LAYER_MARKER) continue;
    await rm(join(root, entry.name), { recursive: true, force: true });
  }
}

export async function writeLayerMarker(workspace: string, layerId: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, LAYER_MARKER), `${layerId}\n`);
}

export async function removeLayerMarker(workspace: string): Promise<void> {
  await rm(join(workspace, LAYER_MARKER), { force: true });
}
