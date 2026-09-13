import { mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODES, fail, type LayerState } from "./types.js";

export interface RepoMeta {
  readonly repoId: string;
  readonly formatVersion: 1;
  readonly createdAt: string;
}

export interface Refs {
  readonly currentWorld: string;
  readonly worldsBySeq: Record<string, string>;
  readonly layers: Record<string, LayerRef>;
}

export interface LayerRef {
  readonly id: string;
  readonly name: string | null;
  readonly originKind: 1 | 2;
  readonly originId: string;
  readonly checkpoint: string;
  readonly state: LayerState;
  readonly agent: string | null;
  readonly sessions: Record<string, string>;
  readonly workspace: string | null;
  readonly deletedAt?: string;
  readonly deleteOp?: string;
}

export interface JournalEntry {
  readonly op: string;
  readonly kind: "checkpoint" | "publish" | "stack" | "refresh" | "delete-layer" | "gc";
  readonly state: string;
  readonly layerId?: string;
  readonly operationId: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return fallback;
    throw e;
  }
}

export async function writeJsonAtomic(path: string, value: unknown, syncDir = true): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  const fh = await open(tmp, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  if (syncDir) {
    try {
      const dh = await open(dirname(path), "r");
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // directory sync not supported everywhere; object bytes already synced
    }
  }
}

export function emptyRefs(): Refs {
  return { currentWorld: "", worldsBySeq: {}, layers: {} };
}

export async function loadRefs(metaDir: string): Promise<Refs> {
  return readJson<Refs>(join(metaDir, "refs.json"), emptyRefs());
}

export async function saveRefs(metaDir: string, refs: Refs): Promise<void> {
  await writeJsonAtomic(join(metaDir, "refs.json"), refs);
}

export async function casRefs(metaDir: string, expect: Refs, next: Refs): Promise<boolean> {
  const cur = await loadRefs(metaDir);
  if (JSON.stringify(cur) !== JSON.stringify(expect)) return false;
  await saveRefs(metaDir, next);
  return true;
}

export function refsTransaction(metaDir: string, fn: (refs: Refs) => Refs): () => Promise<boolean> {
  return async () => {
    const cur = await loadRefs(metaDir);
    const snapshot = JSON.parse(JSON.stringify(cur)) as Refs;
    const next = fn(cur);
    return casRefs(metaDir, snapshot, next);
  };
}

export function resolveLayerRef(refs: Refs, selector: string): LayerRef {
  const sel = selector.toLowerCase();
  if (refs.layers[selector] !== undefined) return refs.layers[selector]!;
  if (refs.layers[sel] !== undefined) return refs.layers[sel]!;
  const byName = Object.values(refs.layers).filter((l) => l.name !== null && l.name === selector && l.state !== "deleted");
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw fail(CODES.ambiguousLayer, `ambiguous layer name: ${selector}`);
  const byPrefix = Object.values(refs.layers).filter((l) => l.id.startsWith(sel) && l.state !== "deleted");
  if (byPrefix.length === 1) return byPrefix[0]!;
  throw fail(CODES.layerNotFound, `no such layer: ${selector}`);
}

export async function appendJournal(metaDir: string, entry: JournalEntry): Promise<void> {
  const dir = join(metaDir, "journal");
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(join(dir, `${entry.operationId}.json`), entry, false);
}

export async function readJournal(metaDir: string, operationId: string): Promise<JournalEntry | null> {
  try {
    const raw = await readFile(join(metaDir, "journal", `${operationId}.json`), "utf8");
    return JSON.parse(raw) as JournalEntry;
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
}

export async function listJournals(metaDir: string): Promise<ReadonlyArray<JournalEntry>> {
  const dir = join(metaDir, "journal");
  let files: Array<string> = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return [];
    throw e;
  }
  const out: Array<JournalEntry> = [];
  for (const f of files) {
    try {
      const raw = await readFile(join(dir, f), "utf8");
      out.push(JSON.parse(raw) as JournalEntry);
    } catch {
      // unreadable journal entry pins GC conservatively via the caller
    }
  }
  return out;
}

export async function updateJournal(metaDir: string, operationId: string, patch: Partial<JournalEntry>): Promise<void> {
  const cur = await readJournal(metaDir, operationId);
  if (cur === null) throw fail(CODES.interrupted, `unknown operation ${operationId}`, { operationId, retryable: true });
  await writeJsonAtomic(
    join(metaDir, "journal", `${operationId}.json`),
    { ...cur, ...patch, updatedAt: new Date().toISOString() },
    false
  );
}
