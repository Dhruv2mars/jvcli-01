import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { decodeTree } from "./core/cbor.js";
import { decodeCheckpoint, decodeContextManifest, decodeWorldVersion, decodePublication, decodeRefresh, decodeStack } from "./core/objects.js";
import { unwrapObject } from "./core/cbor.js";
import { listJournals, loadRefs } from "./core/refs.js";
import { CODES, fail } from "./core/types.js";
import { flattenRoot, openRepo } from "./core/repo.js";

export interface VerifyIssue {
  readonly kind: string;
  readonly detail: string;
}

export async function verifyRepo(root: string, full: boolean): Promise<{ worlds: number; layers: number; objects: number; issues: ReadonlyArray<VerifyIssue> }> {
  const repo = await openRepo(root);
  const issues: Array<VerifyIssue> = [];
  const refs = await loadRefs(repo.metaDir);
  let objects = 0;
  const seen = new Set<string>();
  const checkObject = async (id: string, expected?: number): Promise<Uint8Array | null> => {
    try {
      const bytes = await repo.store.readChecked(id, expected);
      objects++;
      seen.add(id);
      return bytes;
    } catch (e) {
      issues.push({ kind: "missing-object", detail: `${id}: ${e instanceof Error ? e.message : String(e)}` });
      return null;
    }
  };
  if (refs.currentWorld === "") {
    issues.push({ kind: "no-world", detail: "no current world" });
  } else {
    await checkObject(refs.currentWorld, 3);
  }
  for (const [seq, id] of Object.entries(refs.worldsBySeq)) {
    const bytes = await checkObject(id, 3);
    if (bytes !== null) {
      try {
        const w = decodeWorldVersion(bytes);
        if (String(w.seq) !== seq) issues.push({ kind: "seq-mismatch", detail: `${id} seq ${w.seq} != ${seq}` });
        await checkObject(w.rootId, 2);
        if (w.prevId !== null) await checkObject(w.prevId, 3);
        if (w.publicationId !== null) await checkObject(w.publicationId, 7);
        for (const c of w.contextIds) await checkObject(c, 6);
        if (full) await checkTree(repo, w.rootId, issues);
      } catch (e) {
        issues.push({ kind: "bad-world", detail: `${id}: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }
  for (const layer of Object.values(refs.layers)) {
    if (layer.state === "deleted") continue;
    const bytes = await checkObject(layer.checkpoint, 4);
    if (bytes !== null) {
      try {
        const cp = decodeCheckpoint(bytes);
        if (cp.layerId !== layer.id) issues.push({ kind: "layer-mismatch", detail: layer.id });
        await checkObject(cp.anchorId, 3);
        await checkObject(cp.rootId, 2);
        if (cp.prevId !== null) await checkObject(cp.prevId, 4);
        if (cp.recordId !== null) {
          await checkObject(cp.recordId);
        }
        for (const c of cp.contextIds) await checkObject(c, 6);
        if (full) await checkTree(repo, cp.rootId, issues);
      } catch (e) {
        issues.push({ kind: "bad-checkpoint", detail: `${layer.id}: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    for (const [sid, mid] of Object.entries(layer.sessions)) {
      const mb = await checkObject(mid, 6);
      if (mb !== null) {
        try {
          const m = decodeContextManifest(mb);
          for (const oid of m.objectIds) await checkObject(oid, 5);
        } catch (e) {
          issues.push({ kind: "bad-manifest", detail: `${sid}: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
    }
    if (layer.workspace !== null && layer.state === "active") {
      try {
        await stat(layer.workspace);
      } catch {
        issues.push({ kind: "workspace", detail: `missing workspace for ${layer.id}` });
      }
    }
  }
  if (issues.length > 0) throw fail(CODES.corruptObject, `verify failed: ${issues[0]!.detail}`, { paths: issues.map((i) => i.detail).slice(0, 10) });
  return { worlds: Object.keys(refs.worldsBySeq).length, layers: Object.values(refs.layers).filter((l) => l.state !== "deleted").length, objects, issues };
}

async function checkTree(repo: { store: { readChecked: (id: string, t?: number) => Promise<Uint8Array> } }, rootId: string, issues: Array<VerifyIssue>): Promise<void> {
  const visit = async (id: string, stack: ReadonlyArray<string>): Promise<void> => {
    if (stack.includes(id)) {
      issues.push({ kind: "cycle", detail: id });
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await repo.store.readChecked(id, 2);
    } catch (e) {
      issues.push({ kind: "missing-tree", detail: id });
      return;
    }
    let entries: ReadonlyArray<{ name: string; kind: string; target: string }>;
    try {
      entries = decodeTree(bytes);
    } catch (e) {
      issues.push({ kind: "bad-tree", detail: id });
      return;
    }
    for (const e of entries) {
      if (e.kind === "file") {
        try {
          const raw = await repo.store.readChecked(e.target, 1);
          const { payload } = unwrapObject(raw);
          if (payload.tag !== "bytes") issues.push({ kind: "bad-blob", detail: e.target });
        } catch {
          issues.push({ kind: "missing-blob", detail: e.target });
        }
      } else if (e.kind === "dir") {
        await visit(e.target, [...stack, id]);
      }
    }
  };
  await visit(rootId, []);
}

export interface GcResult {
  readonly reachable: number;
  readonly total: number;
  readonly removed: number;
  readonly dryRun: boolean;
}

export async function gcRepo(root: string, dryRun: boolean): Promise<GcResult> {
  const repo = await openRepo(root);
  const refs = await loadRefs(repo.metaDir);
  const reachable = new Set<string>();
  const queue: Array<{ id: string; type?: number }> = [];
  if (refs.currentWorld !== "") queue.push({ id: refs.currentWorld, type: 3 });
  for (const id of Object.values(refs.worldsBySeq)) queue.push({ id, type: 3 });
  for (const l of Object.values(refs.layers)) {
    if (l.state === "deleted") continue;
    queue.push({ id: l.checkpoint, type: 4 });
    for (const mid of Object.values(l.sessions)) queue.push({ id: mid, type: 6 });
  }
  for (const entry of await listJournals(repo.metaDir)) {
    if (entry.state === "finalized" || entry.state === "conflict") continue;
    collectJournalRoots(entry, queue);
  }
  while (queue.length > 0) {
    const item = queue.pop()!;
    if (reachable.has(item.id)) continue;
    reachable.add(item.id);
    let bytes: Uint8Array;
    try {
      bytes = await repo.store.read(item.id);
    } catch {
      continue;
    }
    const { type } = unwrapObject(bytes);
    try {
      if (type === 3) {
        const w = decodeWorldVersion(bytes);
        queue.push({ id: w.rootId, type: 2 });
        if (w.prevId !== null) queue.push({ id: w.prevId, type: 3 });
        if (w.publicationId !== null) queue.push({ id: w.publicationId, type: 7 });
        for (const c of w.contextIds) queue.push({ id: c, type: 6 });
      } else if (type === 4) {
        const cp = decodeCheckpoint(bytes);
        queue.push({ id: cp.anchorId, type: 3 });
        queue.push({ id: cp.rootId, type: 2 });
        if (cp.prevId !== null) queue.push({ id: cp.prevId, type: 4 });
        if (cp.recordId !== null) queue.push({ id: cp.recordId });
        for (const c of cp.contextIds) queue.push({ id: c, type: 6 });
      } else if (type === 2) {
        const entries = decodeTree(bytes);
        for (const e of entries) {
          if (e.kind === "file") queue.push({ id: e.target, type: 1 });
          else if (e.kind === "dir") queue.push({ id: e.target, type: 2 });
        }
      } else if (type === 6) {
        const m = decodeContextManifest(bytes);
        for (const o of m.objectIds) queue.push({ id: o, type: 5 });
      } else if (type === 7) {
        const p = decodePublication(bytes);
        queue.push({ id: p.checkpointId, type: 4 });
        queue.push({ id: p.anchorId, type: 3 });
        queue.push({ id: p.priorId, type: 3 });
        queue.push({ id: p.rootId, type: 2 });
        for (const c of p.contextIds) queue.push({ id: c, type: 6 });
      } else if (type === 8) {
        const r = decodeRefresh(bytes);
        queue.push({ id: r.prevCheckpointId, type: 4 });
        queue.push({ id: r.prevAnchorId, type: 3 });
        queue.push({ id: r.adoptedId, type: 3 });
        queue.push({ id: r.rootId, type: 2 });
      } else if (type === 9) {
        const s = decodeStack(bytes);
        for (const src of s.sources) {
          queue.push({ id: src.checkpointId, type: 4 });
          queue.push({ id: src.rootId, type: 2 });
        }
        queue.push({ id: s.anchorId, type: 3 });
        queue.push({ id: s.rootId, type: 2 });
        for (const c of s.contextIds) queue.push({ id: c, type: 6 });
      }
    } catch {
      // unreadable body still counts as reachable
    }
  }
  const all = await listObjects(repo);
  const unreach = all.filter((id) => !reachable.has(id));
  const quarantine = new Set<string>();
  try {
    const cutoff = Date.now() - 5_000;
    const { statSync } = await import("node:fs");
    for (const id of unreach) {
      try {
        const st = statSync(join(repo.metaDir, "objects", id.slice(0, 2), id.slice(2)));
        if (st.mtimeMs >= cutoff) quarantine.add(id);
      } catch {
        // vanished between list and stat; treat as removed
      }
    }
  } catch {
    // stat unavailable; no quarantine
  }
  const eligible = unreach.filter((id) => !quarantine.has(id));
  let removed = 0;
  if (!dryRun) {
    for (const id of eligible) {
      await rm(join(repo.metaDir, "objects", id.slice(0, 2), id.slice(2)), { force: true });
      removed++;
    }
  } else {
    removed = eligible.length;
  }
  return { reachable: reachable.size, total: all.length, removed, dryRun };
}

function collectJournalRoots(entry: { payload: unknown }, queue: Array<{ id: string; type?: number }>): void {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) ids.add(value);
    else if (Array.isArray(value)) for (const v of value) walk(v);
    else if (value !== null && typeof value === "object") for (const v of Object.values(value as Record<string, unknown>)) walk(v);
  };
  walk(entry.payload);
  for (const id of ids) queue.push({ id });
}

async function listObjects(repo: { metaDir: string }): Promise<ReadonlyArray<string>> {
  const out: Array<string> = [];
  const top = join(repo.metaDir, "objects");
  let dirs: Array<{ name: string }> = [];
  try {
    dirs = await readdir(top, { withFileTypes: true }).then((es) => es.filter((e) => e.isDirectory()));
  } catch {
    return [];
  }
  for (const d of dirs) {
    const files = await readdir(join(top, d.name));
    for (const f of files) out.push(`${d.name}${f}`);
  }
  return out;
}
