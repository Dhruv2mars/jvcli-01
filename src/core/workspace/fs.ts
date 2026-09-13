import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { layerWorkspaceDir, type Repo } from "../repo.js";
import { IGNORE_FILE, JV_DIR, normalizePath } from "../paths.js";
import { clearWorkspace, LAYER_MARKER, materializeTree, removeLayerMarker, scanDirectory, writeLayerMarker } from "../scan.js";
import { hashTree } from "../tree-stage.js";
import type { FileView, LayerId, ObjectId } from "../types.js";
import type { FlushOut, View, WorkspaceBackend } from "./backend.js";
import { modeIsExecutable } from "./exec.js";

type Fingerprint = string;

interface State {
  readonly ws: string;
  paths: ReadonlyMap<string, Fingerprint>;
  view: { readonly files: ReadonlyMap<string, FileView>; readonly symlinks: ReadonlyMap<string, string> } | null;
  baselineHash: string | null;
}

async function probeTree(root: string): Promise<ReadonlyMap<string, Fingerprint>> {
  const out = new Map<string, Fingerprint>();
  const visit = async (dir: string, prefix: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (rel === JV_DIR || rel === IGNORE_FILE || rel === LAYER_MARKER) continue;
      if (entry.isDirectory()) {
        await visit(join(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const st = await lstat(join(dir, entry.name));
      out.set(rel, `${st.mtimeMs}:${st.size}`);
    }
  };
  await visit(root, "");
  return out;
}

function probeEqual(a: ReadonlyMap<string, Fingerprint>, b: ReadonlyMap<string, Fingerprint>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export class FsBackend implements WorkspaceBackend {
  readonly #state = new Map<string, State>();

  constructor(private readonly resolve: (layerId: string) => string) {}

  #stateOf(layer: LayerId, ws: string): State {
    const hit = this.#state.get(layer);
    if (hit !== undefined) return hit;
    const fresh: State = { ws, paths: new Map(), view: null, baselineHash: null };
    this.#state.set(layer, fresh);
    return fresh;
  }

  async #materialize(layer: LayerId, base: View): Promise<void> {
    const ws = this.resolve(layer);
    await mkdir(ws, { recursive: true });
    await clearWorkspace(ws);
    await materializeTree(ws, base.files, base.symlinks);
    await writeLayerMarker(ws, layer);
    const st = this.#stateOf(layer, ws);
    st.paths = await probeTree(ws);
    st.view = { files: new Map(base.files), symlinks: new Map(base.symlinks) };
    st.baselineHash = hashTree(base.files, base.symlinks);
  }

  createWorkspace(layer: LayerId, _root: ObjectId, base: View): Promise<void> {
    return this.#materialize(layer, base);
  }

  recoverWorkspace(layer: LayerId, _root: ObjectId, base: View): Promise<void> {
    return this.#materialize(layer, base);
  }

  async openWorkspace(layer: LayerId, _root: ObjectId): Promise<void> {
    const ws = this.resolve(layer);
    await mkdir(ws, { recursive: true });
    await writeLayerMarker(ws, layer);
    const st = this.#stateOf(layer, ws);
    st.paths = await probeTree(ws);
    st.view = null;
    st.baselineHash = null;
  }

  async closeWorkspace(layer: LayerId): Promise<void> {
    const ws = this.#state.get(layer)?.ws ?? this.resolve(layer);
    await removeLayerMarker(ws);
    this.#state.delete(layer);
  }

  async destroyWorkspace(layer: LayerId): Promise<void> {
    const ws = this.#state.get(layer)?.ws ?? this.resolve(layer);
    await rm(ws, { recursive: true, force: true });
    this.#state.delete(layer);
  }

  async readView(layer: LayerId, path: string): Promise<FileView | null> {
    const p = normalizePath(path);
    const ws = this.#state.get(layer)?.ws ?? this.resolve(layer);
    const abs = join(ws, ...p.split("/"));
    let st;
    try {
      st = await lstat(abs);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const bytes = await readFile(abs);
    return { bytes, executable: modeIsExecutable(st.mode) };
  }

  async enumerateView(layer: LayerId): Promise<readonly string[]> {
    const ws = this.#state.get(layer)?.ws ?? this.resolve(layer);
    const probe = await probeTree(ws);
    return [...probe.keys()].sort();
  }

  async #bump(layer: LayerId, ws: string): Promise<void> {
    this.#stateOf(layer, ws).view = null;
  }

  async recordWrite(layer: LayerId, path: string, v: FileView | null): Promise<void> {
    const p = normalizePath(path);
    const ws = this.#state.get(layer)?.ws ?? this.resolve(layer);
    const abs = join(ws, ...p.split("/"));
    if (v === null) {
      await rm(abs, { force: true });
    } else {
      await mkdir(dirname(abs), { recursive: true });
      await rm(abs, { force: true });
      await writeFile(abs, v.bytes, { mode: v.executable ? 0o755 : 0o644 });
    }
    await this.#bump(layer, ws);
  }

  async recordDelete(layer: LayerId, path: string): Promise<void> {
    await this.recordWrite(layer, path, null);
  }

  async recordRename(layer: LayerId, from: string, to: string): Promise<void> {
    const f = normalizePath(from);
    const t = normalizePath(to);
    const ws = this.#state.get(layer)?.ws ?? this.resolve(layer);
    const fromAbs = join(ws, ...f.split("/"));
    const toAbs = join(ws, ...t.split("/"));
    await mkdir(dirname(toAbs), { recursive: true });
    await rename(fromAbs, toAbs);
    await this.#bump(layer, ws);
  }

  async flushWorkspace(layer: LayerId): Promise<FlushOut> {
    const ws = this.#state.get(layer)?.ws ?? this.resolve(layer);
    const st = this.#stateOf(layer, ws);
    const probe = await probeTree(ws);
    if (st.view !== null && st.baselineHash !== null && probeEqual(st.paths, probe)) {
      return { files: st.view.files, symlinks: st.view.symlinks, dirty: false };
    }
    const scan = await scanDirectory(ws);
    const files: ReadonlyMap<string, FileView> = new Map(scan.files);
    const symlinks = new Map(scan.symlinks);
    const hash = hashTree(files, symlinks);
    const dirty = st.baselineHash !== null && hash !== st.baselineHash;
    st.paths = probe;
    st.view = { files, symlinks };
    st.baselineHash = hash;
    return { files, symlinks, dirty };
  }
}

export function fsBackendFor(repo: Repo, override?: (layerId: string) => string): FsBackend {
  return new FsBackend(override ?? ((layerId) => layerWorkspaceDir(repo, layerId)));
}
