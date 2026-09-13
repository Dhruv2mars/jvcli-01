import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeCheckpoint, decodeWorldVersion, flattenTree } from "./objects.js";
import { decodeTree, encodeTree } from "./cbor.js";
import { LAYERS_DIR, STORE_DIR } from "./paths.js";
import { loadRefs } from "./refs.js";
import { ObjectStore } from "./store.js";
import { CODES, fail } from "./types.js";

export interface Repo {
  readonly root: string;
  readonly metaDir: string;
  readonly repoId: string;
  readonly store: ObjectStore;
}

export async function openRepo(root: string): Promise<Repo> {
  const metaDir = join(root, ".javelin");
  let raw: string;
  try {
    raw = await readFile(join(metaDir, "repo.json"), "utf8");
  } catch {
    throw fail(CODES.notRepository, `not a jvcli repository: ${root}`);
  }
  const meta = JSON.parse(raw) as { repoId: string };
  await mkdir(join(metaDir, STORE_DIR), { recursive: true });
  await mkdir(join(metaDir, LAYERS_DIR), { recursive: true });
  await mkdir(join(metaDir, "journal"), { recursive: true });
  await mkdir(join(metaDir, "tmp"), { recursive: true });
  return { root, metaDir, repoId: meta.repoId, store: new ObjectStore(join(metaDir, STORE_DIR)) };
}

export function layerWorkspaceDir(repo: Repo, layerId: string): string {
  return join(repo.metaDir, LAYERS_DIR, layerId, "workspace");
}

export function treeGetter(store: ObjectStore): (id: string) => Promise<{ files: Map<string, string>; symlinks: Map<string, string> }> {
  const treeCache = new Map<string, ReadonlyArray<{ name: string; kind: "file" | "dir" | "symlink"; target: string }>>();
  const getEntries = async (id: string) => {
    const hit = treeCache.get(id);
    if (hit !== undefined) return hit;
    const bytes = await store.readChecked(id, 2);
    const entries = decodeTree(bytes);
    treeCache.set(id, entries);
    return entries;
  };
  return async (id: string) => {
    const flat = await flattenAsync(id, getEntries);
    return flat;
  };
}

async function flattenAsync(
  rootId: string,
  getEntries: (id: string) => Promise<ReadonlyArray<{ name: string; kind: "file" | "dir" | "symlink"; target: string }>>
): Promise<{ files: Map<string, string>; symlinks: Map<string, string> }> {
  const files = new Map<string, string>();
  const symlinks = new Map<string, string>();
  const visit = async (id: string, prefix: string, stack: ReadonlyArray<string>): Promise<void> => {
    if (stack.includes(id)) throw fail(CODES.corruptObject, "tree cycle");
    const entries = await getEntries(id);
    for (const e of entries) {
      const path = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.kind === "file") files.set(path, e.target);
      else if (e.kind === "symlink") symlinks.set(path, e.target);
      else await visit(e.target, path, [...stack, id]);
    }
  };
  await visit(rootId, "", []);
  return { files, symlinks };
}

export async function flattenRoot(store: ObjectStore, rootId: string): Promise<{ files: Map<string, string>; symlinks: Map<string, string> }> {
  const get = treeGetter(store);
  return get(rootId);
}

export async function worldRootOf(store: ObjectStore, worldId: string): Promise<string> {
  const bytes = await store.readChecked(worldId, 3);
  return decodeWorldVersion(bytes).rootId;
}

export async function checkpointRootOf(store: ObjectStore, checkpointId: string): Promise<string> {
  const bytes = await store.readChecked(checkpointId, 4);
  return decodeCheckpoint(bytes).rootId;
}

export async function currentWorldId(repo: Repo): Promise<string> {
  const refs = await loadRefs(repo.metaDir);
  if (refs.currentWorld === "") throw fail(CODES.corruptObject, "no current world");
  return refs.currentWorld;
}

export async function listWorlds(repo: Repo): Promise<Array<{ seq: number; id: string; rootId: string }>> {
  const refs = await loadRefs(repo.metaDir);
  const out: Array<{ seq: number; id: string; rootId: string }> = [];
  for (const [seq, id] of Object.entries(refs.worldsBySeq)) {
    const bytes = await repo.store.readChecked(id, 3);
    out.push({ seq: Number(seq), id, rootId: decodeWorldVersion(bytes).rootId });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export async function resolveWorldSelector(repo: Repo, selector: string): Promise<string> {
  const refs = await loadRefs(repo.metaDir);
  if (/^[0-9]+$/.test(selector)) {
    const id = refs.worldsBySeq[selector];
    if (id === undefined) throw fail(CODES.invalidPath, `no such world version: ${selector}`);
    return id;
  }
  const sel = selector.toLowerCase();
  if (sel.length >= 8) {
    const hit = Object.values(refs.worldsBySeq).find((id) => id.startsWith(sel));
    if (hit !== undefined) return hit;
  }
  throw fail(CODES.invalidPath, `no such world version: ${selector}`);
}

export { encodeTree, flattenTree };
export type { Refs } from "./refs.js";
