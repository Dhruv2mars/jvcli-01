import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { unwrapObject } from "./core/cbor.js";
import {
  decodeCheckpoint,
  decodeContextManifest,
  decodePublication,
  decodeRefresh,
  decodeStack,
  decodeWorldVersion
} from "./core/objects.js";
import { loadRefs, resolveLayerRef, type JournalEntry } from "./core/refs.js";
import { openRepo } from "./core/repo.js";
import { CODES, fail } from "./core/types.js";

export type TimelineKind = "world" | "publish" | "checkpoint" | "refresh" | "stack" | "context" | "journal";

export interface TimelineRow {
  readonly t: { readonly seq: number | null; readonly at: string | null };
  readonly kind: TimelineKind;
  readonly id: string;
  readonly layer: string | null;
  readonly operation: string | null;
  readonly detail: Record<string, unknown>;
}

export interface TimelineOptions {
  readonly layer?: string | null;
  readonly kind?: string | null;
  readonly limit?: number | null;
}

const KINDS: ReadonlyArray<TimelineKind> = ["world", "publish", "checkpoint", "refresh", "stack", "context", "journal"];

function isTimelineKind(v: string): v is TimelineKind {
  return (KINDS as ReadonlyArray<string>).includes(v);
}

function bucketOf(kind: TimelineKind): number {
  switch (kind) {
    case "world":
      return 0;
    case "publish":
      return 1;
    case "checkpoint":
      return 2;
    case "refresh":
      return 3;
    case "stack":
      return 3;
    case "context":
      return 4;
    case "journal":
      return 5;
  }
}

function collectHex64(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (/^[0-9a-f]{64}$/.test(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectHex64(v, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectHex64(v, out);
  }
}

interface CpInfo {
  readonly id: string;
  readonly layer: string;
  readonly root: string;
  readonly anchor: string;
  readonly anchorSeq: number | null;
  readonly prev: string | null;
  readonly record: string | null;
}

export async function timelineRepo(root: string, opts: TimelineOptions): Promise<{ rows: TimelineRow[] }> {
  const kindSel = opts.kind ?? null;
  if (kindSel !== null && !isTimelineKind(kindSel)) {
    throw fail(CODES.invalidPath, `bad --kind: ${kindSel}`);
  }
  const limitSel = opts.limit ?? null;
  if (limitSel !== null && (!Number.isSafeInteger(limitSel) || limitSel < 0)) {
    throw fail(CODES.invalidPath, "timeline --limit must be a non-negative integer");
  }

  const repo = await openRepo(root);
  const refs = await loadRefs(repo.metaDir);

  let layerId: string | null = null;
  const layerSel = opts.layer ?? null;
  if (layerSel !== null) {
    layerId = resolveLayerRef(refs, layerSel).id;
  }

  const seqEntries = Object.entries(refs.worldsBySeq);
  if (seqEntries.length === 0 || refs.currentWorld === "") {
    throw fail(CODES.corruptObject, "no worlds");
  }
  try {
    await repo.store.readChecked(refs.currentWorld, 3);
  } catch {
    throw fail(CODES.corruptObject, `unreadable current world ${refs.currentWorld}`);
  }

  const worldIdToSeq = new Map<string, number>();
  const worlds: Array<{ seq: number; id: string; prev: string | null; pub: string | null; contexts: number }> = [];
  for (const [seqStr, id] of seqEntries) {
    const seq = Number(seqStr);
    if (!Number.isSafeInteger(seq)) throw fail(CODES.corruptObject, `bad world seq ${seqStr}`);
    let w: { prevId: string | null; publicationId: string | null; contextIds: ReadonlyArray<string>; seq: number };
    try {
      w = decodeWorldVersion(await repo.store.readChecked(id, 3));
    } catch {
      throw fail(CODES.corruptObject, `unreadable world ${id}`);
    }
    worldIdToSeq.set(id, seq);
    worlds.push({ seq, id, prev: w.prevId, pub: w.publicationId, contexts: w.contextIds.length });
  }

  const idToSeq = new Map<string, number>();
  for (const [id, seq] of worldIdToSeq) idToSeq.set(id, seq);

  const unreadables: Array<{ id: string; layer: string | null; seq: number | null; origKind: string }> = [];

  const pubEntries: Array<{ pubId: string; worldSeq: number }> = [];
  for (const w of worlds) {
    if (w.pub !== null) {
      pubEntries.push({ pubId: w.pub, worldSeq: w.seq });
      if (!idToSeq.has(w.pub)) idToSeq.set(w.pub, w.seq);
    }
  }

  const cpById = new Map<string, CpInfo>();
  const cpList: Array<CpInfo> = [];
  for (const layer of Object.values(refs.layers)) {
    let cur: string | null = layer.checkpoint;
    const seenChain = new Set<string>();
    while (cur !== null) {
      if (cpById.has(cur) || seenChain.has(cur)) break;
      seenChain.add(cur);
      let cp: { layerId: string; anchorId: string; rootId: string; prevId: string | null; recordId: string | null };
      try {
        cp = decodeCheckpoint(await repo.store.readChecked(cur, 4));
      } catch {
        unreadables.push({ id: cur, layer: layer.id, seq: null, origKind: "checkpoint" });
        break;
      }
      const anchorSeq = worldIdToSeq.get(cp.anchorId) ?? null;
      const info: CpInfo = {
        id: cur,
        layer: cp.layerId,
        root: cp.rootId,
        anchor: cp.anchorId,
        anchorSeq,
        prev: cp.prevId,
        record: cp.recordId
      };
      cpById.set(cur, info);
      cpList.push(info);
      if (anchorSeq !== null && !idToSeq.has(cur)) idToSeq.set(cur, anchorSeq);
      cur = cp.prevId;
    }
  }

  const recRows: Array<TimelineRow> = [];
  for (const cp of cpList) {
    if (cp.record === null) continue;
    const recId = cp.record;
    let raw: Uint8Array;
    try {
      raw = await repo.store.read(recId);
    } catch {
      unreadables.push({ id: recId, layer: cp.layer, seq: cp.anchorSeq, origKind: "refresh" });
      continue;
    }
    let type: number;
    try {
      type = unwrapObject(raw).type;
    } catch {
      unreadables.push({ id: recId, layer: cp.layer, seq: cp.anchorSeq, origKind: "refresh" });
      continue;
    }
    try {
      if (type === 8) {
        const r = decodeRefresh(raw);
        recRows.push({
          t: { seq: cp.anchorSeq, at: null },
          kind: "refresh",
          id: recId,
          layer: r.layerId,
          operation: r.operationId,
          detail: { prevCheckpoint: r.prevCheckpointId, adopted: r.adoptedId, root: r.rootId }
        });
        if (cp.anchorSeq !== null && !idToSeq.has(recId)) idToSeq.set(recId, cp.anchorSeq);
      } else if (type === 9) {
        const s = decodeStack(raw);
        recRows.push({
          t: { seq: cp.anchorSeq, at: null },
          kind: "stack",
          id: recId,
          layer: s.destLayerId,
          operation: s.operationId,
          detail: { dest: s.destLayerId, anchor: s.anchorId, root: s.rootId, sources: s.sources.length, order: s.order }
        });
        if (cp.anchorSeq !== null && !idToSeq.has(recId)) idToSeq.set(recId, cp.anchorSeq);
      } else {
        unreadables.push({ id: recId, layer: cp.layer, seq: cp.anchorSeq, origKind: "refresh" });
      }
    } catch {
      unreadables.push({ id: recId, layer: cp.layer, seq: cp.anchorSeq, origKind: "refresh" });
    }
  }

  const ctxRows: Array<TimelineRow> = [];
  for (const layer of Object.values(refs.layers)) {
    const head = cpById.get(layer.checkpoint);
    const headSeq = head?.anchorSeq ?? null;
    for (const mid of Object.values(layer.sessions)) {
      try {
        const m = decodeContextManifest(await repo.store.readChecked(mid, 6));
        ctxRows.push({
          t: { seq: headSeq, at: null },
          kind: "context",
          id: mid,
          layer: layer.id,
          operation: null,
          detail: { session: m.sessionId, completeness: m.completeness, objects: m.objectIds.length }
        });
        if (headSeq !== null && !idToSeq.has(mid)) idToSeq.set(mid, headSeq);
      } catch {
        unreadables.push({ id: mid, layer: layer.id, seq: headSeq, origKind: "context" });
      }
    }
  }

  const rows: Array<TimelineRow> = [];
  for (const w of worlds) {
    rows.push({
      t: { seq: w.seq, at: null },
      kind: "world",
      id: w.id,
      layer: null,
      operation: null,
      detail: { seq: w.seq, id: w.id, prev: w.prev, publication: w.pub, contexts: w.contexts }
    });
  }
  for (const p of pubEntries) {
    try {
      const pub = decodePublication(await repo.store.readChecked(p.pubId, 7));
      rows.push({
        t: { seq: p.worldSeq, at: null },
        kind: "publish",
        id: p.pubId,
        layer: pub.layerId,
        operation: pub.operationId,
        detail: { seq: pub.seq, root: pub.rootId, checkpoint: pub.checkpointId }
      });
    } catch {
      unreadables.push({ id: p.pubId, layer: null, seq: p.worldSeq, origKind: "publish" });
    }
  }
  for (const cp of cpList) {
    rows.push({
      t: { seq: cp.anchorSeq, at: null },
      kind: "checkpoint",
      id: cp.id,
      layer: cp.layer,
      operation: null,
      detail: { layer: cp.layer, root: cp.root }
    });
  }
  for (const r of recRows) rows.push(r);
  for (const c of ctxRows) rows.push(c);

  const journalDir = join(repo.metaDir, "journal");
  let files: Array<string> = [];
  try {
    files = (await readdir(journalDir)).filter((f) => f.endsWith(".json"));
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
    files = [];
  }
  files.sort();
  for (const f of files) {
    const full = join(journalDir, f);
    let entry: JournalEntry;
    try {
      const raw = await readFile(full, "utf8");
      entry = JSON.parse(raw) as JournalEntry;
      if (typeof entry.operationId !== "string" || typeof entry.op !== "string") throw new Error("bad journal");
    } catch {
      const base = f.replace(/\.json$/, "");
      unreadables.push({ id: base, layer: null, seq: null, origKind: "journal" });
      continue;
    }
    const ids = new Set<string>();
    collectHex64(entry.payload, ids);
    let resolved: number | null = null;
    for (const id of ids) {
      const s = idToSeq.get(id);
      if (s !== undefined && (resolved === null || s > resolved)) resolved = s;
    }
    rows.push({
      t: resolved !== null ? { seq: resolved, at: null } : { seq: null, at: entry.updatedAt ?? null },
      kind: "journal",
      id: entry.operationId,
      layer: entry.layerId ?? null,
      operation: entry.operationId,
      detail: { op: entry.op, kind: entry.kind, state: entry.state }
    });
  }

  for (const u of unreadables) {
    rows.push({
      t: u.seq !== null ? { seq: u.seq, at: null } : { seq: null, at: null },
      kind: "journal",
      id: u.id,
      layer: u.layer,
      operation: null,
      detail: { op: u.id, kind: u.origKind, state: "unreadable" }
    });
  }

  let out = rows;
  if (layerId !== null) out = out.filter((r) => r.layer === layerId);
  if (kindSel !== null) out = out.filter((r) => r.kind === kindSel);

  out = [...out].sort((a, b) => {
    const as = a.t.seq;
    const bs = b.t.seq;
    if (as !== null && bs !== null) {
      if (as !== bs) return as - bs;
      const ab = bucketOf(a.kind);
      const bb = bucketOf(b.kind);
      if (ab !== bb) return ab - bb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    if (as !== null) return -1;
    if (bs !== null) return 1;
    const ab = bucketOf(a.kind);
    const bb = bucketOf(b.kind);
    if (ab !== bb) return ab - bb;
    const atA = a.t.at ?? "";
    const atB = b.t.at ?? "";
    if (atA !== atB) return atA < atB ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  if (limitSel !== null) out = out.slice(0, limitSel);
  return { rows: out };
}

export function formatTimelineHuman(rows: ReadonlyArray<TimelineRow>): string {
  const lines: Array<string> = [];
  for (const r of rows) {
    if (r.t.seq !== null) {
      const short = r.id.slice(0, 12);
      const layerShort = r.layer !== null ? ` ${r.layer.slice(0, 12)}` : "";
      let suffix = "";
      if (r.kind === "journal") {
        const d = r.detail as { kind?: unknown; state?: unknown };
        if (typeof d.kind === "string" && typeof d.state === "string") suffix = ` ${d.kind}=${d.state}`;
      } else if (r.kind === "context") {
        const d = r.detail as { session?: unknown };
        if (typeof d.session === "string") suffix = ` session=${d.session.slice(0, 12)}`;
      }
      lines.push(`v${r.t.seq} ${r.kind} ${short}${layerShort}${suffix}`);
    } else {
      const d = r.detail as { kind?: unknown; state?: unknown };
      const kindState = typeof d.kind === "string" && typeof d.state === "string" ? ` ${d.kind}=${d.state}` : "";
      lines.push(`pending ${r.kind} ${r.id}${kindState}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "no entries\n";
}
