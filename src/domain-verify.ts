import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeTree } from "./core/cbor.js";
import { decodeCheckpoint, decodeContextManifest, decodeWorldVersion, decodePublication, decodeRefresh, decodeStack } from "./core/objects.js";
import { unwrapObject } from "./core/cbor.js";
import { appendJournal, listJournals, loadRefs, readJournal, updateJournal, type JournalEntry } from "./core/refs.js";
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
        if (w.publicationId !== null) {
          const pb = await checkObject(w.publicationId, 7);
          if (pb !== null) await checkPublicationBody(pb, w, id, checkObject, issues);
        }
        for (const c of w.contextIds) await checkObject(c, 6);
        if (full) await checkTree(repo, w.rootId, issues);
      } catch (e) {
        issues.push({ kind: "bad-world", detail: `${id}: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }
  for (const layer of Object.values(refs.layers)) {
    if (layer.state === "deleted") continue;
    let cursor: string | null = layer.checkpoint;
    const seenChain = new Set<string>();
    while (cursor !== null) {
      if (seenChain.has(cursor)) {
        issues.push({ kind: "checkpoint-cycle", detail: `${layer.id}: ${cursor}` });
        break;
      }
      seenChain.add(cursor);
      const bytes = await checkObject(cursor, 4);
      if (bytes === null) break;
      try {
        const cp = decodeCheckpoint(bytes);
        if (cp.layerId !== layer.id) issues.push({ kind: "layer-mismatch", detail: layer.id });
        await checkObject(cp.anchorId, 3);
        await checkObject(cp.rootId, 2);
        const prevCpBytes = cp.prevId !== null ? await checkObject(cp.prevId, 4) : null;
        if (cp.recordId !== null) {
          const rb = await checkObject(cp.recordId);
          if (rb !== null) await checkRecordBody(rb, layer.id, cp, prevCpBytes, issues);
        }
        for (const c of cp.contextIds) await checkObject(c, 6);
        if (full && cursor === layer.checkpoint) await checkTree(repo, cp.rootId, issues);
        cursor = cp.prevId;
      } catch (e) {
        issues.push({ kind: "bad-checkpoint", detail: `${layer.id}: ${e instanceof Error ? e.message : String(e)}` });
        break;
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

async function checkPublicationBody(
  raw: Uint8Array,
  w: { rootId: string; seq: number; prevId: string | null; contextIds: ReadonlyArray<string> },
  worldId: string,
  checkObject: (id: string, expected?: number) => Promise<Uint8Array | null>,
  issues: Array<VerifyIssue>
): Promise<void> {
  try {
    const p = decodePublication(raw);
    if (p.rootId !== w.rootId) issues.push({ kind: "publication-root-mismatch", detail: worldId });
    if (p.seq !== w.seq) issues.push({ kind: "publication-seq-mismatch", detail: worldId });
    if (p.priorId !== w.prevId) {
      issues.push({ kind: "publication-prior-mismatch", detail: `${worldId}: publication-prior-mismatch` });
    }
    if (JSON.stringify([...p.contextIds].sort()) !== JSON.stringify([...w.contextIds].sort())) {
      issues.push({ kind: "publication-context-mismatch", detail: worldId });
    }
    await checkObject(p.checkpointId, 4);
  } catch (e) {
    issues.push({ kind: "bad-publication", detail: `${worldId}: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function checkRecordBody(
  raw: Uint8Array,
  layerId: string,
  cp: { rootId: string; anchorId: string; prevId: string | null },
  prevCheckpointBytes: Uint8Array | null,
  issues: Array<VerifyIssue>
): Promise<void> {
  try {
    const { type } = unwrapObject(raw);
    if (type === 8) {
      const r = decodeRefresh(raw);
      if (r.layerId !== layerId) issues.push({ kind: "record-layer-mismatch", detail: layerId });
      if (r.rootId !== cp.rootId) issues.push({ kind: "refresh-root-mismatch", detail: layerId });
      if (cp.prevId === null || r.prevCheckpointId !== cp.prevId) {
        issues.push({ kind: "refresh-prev-mismatch", detail: layerId });
      } else if (prevCheckpointBytes !== null && decodeCheckpoint(prevCheckpointBytes).anchorId !== r.prevAnchorId) {
        issues.push({ kind: "refresh-anchor-mismatch", detail: `${layerId}: refresh-anchor-mismatch` });
      }
    } else if (type === 9) {
      const s = decodeStack(raw);
      if (s.destLayerId !== layerId) issues.push({ kind: "record-layer-mismatch", detail: layerId });
      if (s.rootId !== cp.rootId) issues.push({ kind: "stack-root-mismatch", detail: layerId });
    } else {
      issues.push({ kind: "bad-record-type", detail: `${layerId}: type ${type}` });
    }
  } catch (e) {
    issues.push({ kind: "bad-record", detail: `${layerId}: ${e instanceof Error ? e.message : String(e)}` });
  }
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
  const fault = (process.env.JVCLI_FAULT ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const gcOp = fault.find((f) => f.startsWith("gc:") && f.includes("="))?.split("=")[1]?.toLowerCase();
  const opId = gcOp !== undefined && gcOp !== "" ? gcOp : undefined;
  if (opId !== undefined) {
    const preread = await readJournal(repo.metaDir, opId);
    if (preread !== null && preread.kind === "gc") {
      if (preread.state === "finalized" || preread.state === "accepted") return preread.payload as GcResult;
    } else if (preread !== null && preread.kind !== "gc") {
      throw fail(CODES.io, "operation id belongs to another op", { operationId: opId });
    } else if (preread === null) {
      await appendJournal(repo.metaDir, {
        op: opId,
        kind: "gc",
        state: "prepared",
        operationId: opId,
        payload: { dryRun },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await crashIfGcFault("gc:after-prepared", opId);
    }
  }
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
  for (const entry of await pruneJournals(repo.metaDir, dryRun)) {
    if (entry.state === "finalized" || entry.state === "accepted" || entry.state === "conflict") continue;
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
  const cutoff = Date.now() - 5_000;
  try {
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
  const staleTmp = await findStaleTmp(repo.metaDir, cutoff);
  const eligible = unreach.filter((id) => !quarantine.has(id));
  if (opId !== undefined) {
    await updateJournal(repo.metaDir, opId, { state: "objects_durable", payload: { candidates: eligible, dryRun } });
    await crashIfGcFault("gc:after-mark", opId);
    const reread = await readJournal(repo.metaDir, opId);
    if (reread !== null && reread.kind === "gc" && (reread.state === "finalized" || reread.state === "accepted")) {
      return reread.payload as GcResult;
    }
    const snap = await loadRefs(repo.metaDir);
    if (JSON.stringify(Object.keys(snap.worldsBySeq).sort()) !== JSON.stringify(Object.keys(refs.worldsBySeq).sort()) || snap.currentWorld !== refs.currentWorld) {
      throw fail(CODES.busy, "world advanced during gc; retry the gc", { operationId: opId, retryable: true });
    }
  }
  let removed = 0;
  if (!dryRun) {
    for (const id of eligible) {
      await rm(join(repo.metaDir, "objects", id.slice(0, 2), id.slice(2)), { force: true });
      removed++;
    }
    for (const path of staleTmp) await rm(path, { force: true });
    if (opId !== undefined) {
      await updateJournal(repo.metaDir, opId, { state: "accepted", payload: { reachable: reachable.size, total: all.length, removed, dryRun } });
      await crashIfGcFault("gc:after-sweep", opId);
    }
  } else {
    removed = eligible.length;
  }
  const result = { reachable: reachable.size, total: all.length, removed, dryRun };
  if (opId !== undefined) {
    await updateJournal(repo.metaDir, opId, { state: "finalized", payload: result });
  }
  return result;
}

function gcFaultEnabled(name: string): boolean {
  return (process.env.JVCLI_FAULT ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(name);
}

async function crashIfGcFault(name: string, operationId: string): Promise<void> {
  if (gcFaultEnabled(name)) {
    throw fail(CODES.interrupted, `fault injected at ${name}`, { operationId, retryable: true, hint: "retry the gc" });
  }
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

const TMP_LEAF_PATTERN = /\.tmp-\d+-\d+$/;

// writeJsonAtomic leaks `<name>.tmp-<pid>-<ts>` next to the target and the
// object store spills `obj-*` into <meta>/tmp on crash; sweep both with the
// same grace period as quarantine.
async function findStaleTmp(metaDir: string, cutoff: number): Promise<ReadonlyArray<string>> {
  const out: Array<string> = [];
  const sweep: ReadonlyArray<{ dir: string; match: (name: string) => boolean }> = [
    { dir: metaDir, match: (name) => TMP_LEAF_PATTERN.test(name) },
    { dir: join(metaDir, "tmp"), match: (name) => name.startsWith("obj-") }
  ];
  for (const { dir, match } of sweep) {
    let names: ReadonlyArray<string>;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!match(name)) continue;
      const full = join(dir, name);
      try {
        const st = await stat(full);
        if (st.isFile() && st.mtimeMs < cutoff) out.push(full);
      } catch {
        // racing writer owns it; leave it alone
      }
    }
  }
  return out;
}

// Recovery anchors (prepared, objects_durable, world_created, stale-retry)
// are never pruned; settled journals are dropped only past the retention
// window and outside the newest KEEP entries.
const JOURNAL_PRUNE_STATES = new Set(["finalized", "accepted", "conflict"]);
const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const JOURNAL_KEEP = 100;

async function pruneJournals(metaDir: string, dryRun: boolean): Promise<ReadonlyArray<JournalEntry>> {
  const all = await listJournals(metaDir);
  const newestFirst = all
    .filter((j) => JOURNAL_PRUNE_STATES.has(j.state))
    .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.operationId < b.operationId ? -1 : 1) : a.updatedAt < b.updatedAt ? 1 : -1));
  const cutoff = Date.now() - JOURNAL_RETENTION_MS;
  const doomed = newestFirst.filter((j, i) => i >= JOURNAL_KEEP && Date.parse(j.updatedAt) < cutoff);
  if (!dryRun) {
    for (const j of doomed) await rm(join(metaDir, "journal", `${j.operationId}.json`), { force: true });
  }
  if (doomed.length === 0) return all;
  const doomedIds = new Set(doomed.map((j) => j.operationId));
  return all.filter((j) => !doomedIds.has(j.operationId));
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
