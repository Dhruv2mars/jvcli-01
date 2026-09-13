import { hexToBytes } from "@noble/hashes/utils.js";
import {
  arr,
  at,
  b,
  bool,
  decodeStateRef,
  encodeTree,
  expectArray,
  expectBool,
  expectBytes32,
  expectText,
  expectUint,
  nul,
  optBytes,
  optBytesOut,
  sortedEntries,
  stateRef,
  t,
  u,
  unwrapObject,
  wrapObject,
  type CborValue
} from "./cbor.js";
import { normalizePath } from "./paths.js";
import { CODES, fail, type Files, type Symlinks, type TreeEntryInput } from "./types.js";

function toHex(v: Uint8Array): string {
  return [...v].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function h32(hex: string): Uint8Array {
  return hexToBytes(hex);
}

function h16(hex: string): Uint8Array {
  return hexToBytes(hex);
}

export interface TreeBuilder {
  putBlob: (content: Uint8Array) => string;
  putTree: (entries: ReadonlyArray<TreeEntryInput>) => string;
}

export function emptyTreeId(put: (bytes: Uint8Array) => string): string {
  return put(encodeTree([]));
}

export function buildTreeFromFiles(
  files: Files,
  symlinks: Symlinks,
  put: TreeBuilder
): { rootId: string; blobIds: ReadonlyArray<string> } {
  for (const p of [...files.keys(), ...symlinks.keys()]) normalizePath(p);
  const byDir = new Map<string, Array<TreeEntryInput>>();
  const blobIds: Array<string> = [];
  const ensure = (dir: string): Array<TreeEntryInput> => {
    let list = byDir.get(dir);
    if (list === undefined) {
      list = [];
      byDir.set(dir, list);
    }
    return list;
  };
  ensure("");
  const mkdirs = (dir: string): void => {
    if (dir === "") return;
    const parts = dir.split("/");
    let cur = "";
    for (const part of parts) {
      const parent = cur;
      cur = cur === "" ? part : `${cur}/${part}`;
      ensure(cur);
      const list = ensure(parent);
      if (!list.some((e) => e.name === part && e.kind === "dir")) {
        list.push({ name: part, kind: "dir", target: "", executable: false });
      }
    }
  };
  for (const [path, view] of files) {
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    mkdirs(dir);
    const blobId = put.putBlob(view.bytes);
    blobIds.push(blobId);
    ensure(dir).push({ name, kind: "file", target: blobId, executable: view.executable });
  }
  for (const [path, target] of symlinks) {
    if (files.has(path)) throw fail(CODES.invalidPath, `path is both file and link: ${path}`);
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    mkdirs(dir);
    ensure(dir).push({ name, kind: "symlink", target, executable: false });
  }
  const memo = new Map<string, string>();
  const build = (dir: string, stack: ReadonlyArray<string>): string => {
    if (stack.includes(dir)) throw fail(CODES.corruptObject, "tree cycle");
    const hit = memo.get(dir);
    if (hit !== undefined) return hit;
    const list = sortedEntries(ensure(dir));
    const resolved: Array<TreeEntryInput> = [];
    for (const e of list) {
      if (e.kind === "dir") {
        const child = dir === "" ? e.name : `${dir}/${e.name}`;
        const id = build(child, [...stack, dir]);
        resolved.push({ name: e.name, kind: "dir", target: id, executable: false });
      } else {
        resolved.push(e);
      }
    }
    const id = put.putTree(resolved);
    memo.set(dir, id);
    return id;
  };
  const rootId = build("", []);
  return { rootId, blobIds };
}

export function flattenTree(
  rootId: string,
  getTree: (id: string) => ReadonlyArray<{ name: string; kind: "file" | "dir" | "symlink"; target: string }>
): { files: Map<string, string>; symlinks: Map<string, string> } {
  const files = new Map<string, string>();
  const symlinks = new Map<string, string>();
  const visit = (id: string, prefix: string, stack: ReadonlyArray<string>): void => {
    if (stack.includes(id)) throw fail(CODES.corruptObject, "tree cycle");
    const entries = getTree(id);
    for (const e of entries) {
      const path = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.kind === "file") files.set(path, e.target);
      else if (e.kind === "symlink") symlinks.set(path, e.target);
      else visit(e.target, path, [...stack, id]);
    }
  };
  visit(rootId, "", []);
  return { files, symlinks };
}

export type ChangeKind = "add" | "modify" | "delete" | "type-change" | "metadata-change";

export interface PathChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly oldBlob: string | null;
  readonly newBlob: string | null;
}

export function diffTrees(
  base: { files: ReadonlyMap<string, string>; symlinks: ReadonlyMap<string, string> },
  next: { files: ReadonlyMap<string, string>; symlinks: ReadonlyMap<string, string> }
): ReadonlyArray<PathChange> {
  const out: Array<PathChange> = [];
  const paths = new Set<string>([...base.files.keys(), ...next.files.keys(), ...base.symlinks.keys(), ...next.symlinks.keys()]);
  for (const path of [...paths].sort()) {
    const bF = base.files.get(path) ?? null;
    const nF = next.files.get(path) ?? null;
    const bL = base.symlinks.get(path) ?? null;
    const nL = next.symlinks.get(path) ?? null;
    if (bF !== null && nF !== null) {
      if (bF !== nF) out.push({ path, kind: "modify", oldBlob: bF, newBlob: nF });
    } else if (bL !== null && nL !== null) {
      if (bL !== nL) out.push({ path, kind: "modify", oldBlob: null, newBlob: null });
    } else if (bF !== null || bL !== null) {
      if (nF !== null || nL !== null) {
        out.push({ path, kind: "type-change", oldBlob: bF, newBlob: nF });
      } else {
        out.push({ path, kind: "delete", oldBlob: bF, newBlob: null });
      }
    } else {
      out.push({ path, kind: "add", oldBlob: null, newBlob: nF });
    }
  }
  return out;
}

export interface Conflict {
  readonly path: string;
  readonly kind: "both-write" | "delete-modify" | "type-clash" | "ancestor-clash";
}

function ancestors(path: string): ReadonlyArray<string> {
  const parts = path.split("/");
  const out: Array<string> = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

export function structuralCompatible(
  base: { files: ReadonlyMap<string, string>; symlinks: ReadonlyMap<string, string> },
  left: { files: ReadonlyMap<string, string>; symlinks: ReadonlyMap<string, string> },
  right: { files: ReadonlyMap<string, string>; symlinks: ReadonlyMap<string, string> }
):
  | { ok: true; merged: { files: Map<string, string>; symlinks: Map<string, string> } }
  | { ok: false; conflicts: ReadonlyArray<Conflict> } {
  const leftChanges = new Map(diffTrees(base, left).map((c) => [c.path, c] as const));
  const rightChanges = new Map(diffTrees(base, right).map((c) => [c.path, c] as const));
  const conflicts: Array<Conflict> = [];
  const paths = new Set<string>([...leftChanges.keys(), ...rightChanges.keys()]);
  for (const path of paths) {
    const l = leftChanges.get(path) ?? null;
    const r = rightChanges.get(path) ?? null;
    if (l === null || r === null) continue;
    const lVal = left.files.get(path) ?? left.symlinks.get(path) ?? null;
    const rVal = right.files.get(path) ?? right.symlinks.get(path) ?? null;
    if (lVal !== null && rVal !== null && lVal === rVal && l.kind === r.kind) continue;
    if (l.kind === "delete" && r.kind === "delete") continue;
    if (l.kind === "modify" && r.kind === "modify") {
      conflicts.push({ path, kind: "both-write" });
    } else if (l.kind === "delete" || r.kind === "delete") {
      conflicts.push({ path, kind: "delete-modify" });
    } else {
      conflicts.push({ path, kind: "type-clash" });
    }
  }
  for (const path of paths) {
    for (const a of ancestors(path)) {
      if ((leftChanges.has(a) || rightChanges.has(a)) && (leftChanges.has(path) || rightChanges.has(path))) {
        if (!conflicts.some((c) => c.path === path)) conflicts.push({ path, kind: "ancestor-clash" });
      }
    }
  }
  if (conflicts.length > 0) {
    conflicts.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    return { ok: false, conflicts };
  }
  const mergedFiles = new Map<string, string>(base.files);
  const mergedLinks = new Map<string, string>(base.symlinks);
  const apply = (
    changes: ReadonlyMap<string, PathChange>,
    view: { files: ReadonlyMap<string, string>; symlinks: ReadonlyMap<string, string> }
  ): void => {
    for (const [path] of changes) {
      const f = view.files.get(path);
      const s = view.symlinks.get(path);
      if (f !== undefined) {
        mergedFiles.set(path, f);
        mergedLinks.delete(path);
      } else if (s !== undefined) {
        mergedLinks.set(path, s);
        mergedFiles.delete(path);
      } else {
        mergedFiles.delete(path);
        mergedLinks.delete(path);
      }
    }
  };
  apply(leftChanges, left);
  apply(rightChanges, right);
  return { ok: true, merged: { files: mergedFiles, symlinks: mergedLinks } };
}

export function encodeWorldVersion(input: {
  repoId: string;
  seq: number;
  rootId: string;
  prevId: string | null;
  publicationId: string | null;
  contextIds: ReadonlyArray<string>;
}): Uint8Array {
  const sorted = [...input.contextIds].sort();
  return wrapObject(
    3,
    arr([b(h16(input.repoId)), u(input.seq), b(h32(input.rootId)), optBytes(input.prevId), optBytes(input.publicationId), arr(sorted.map((c) => b(h32(c))))])
  );
}

export function decodeWorldVersion(bytes: Uint8Array): {
  repoId: string;
  seq: number;
  rootId: string;
  prevId: string | null;
  publicationId: string | null;
  contextIds: ReadonlyArray<string>;
} {
  const { type, payload } = unwrapObject(bytes);
  if (type !== 3) throw fail(CODES.corruptObject, "not a world version");
    const __items = expectArray(payload, 6);
  const repo = at(__items, 0);
  const seq = at(__items, 1);
  const root = at(__items, 2);
  const prev = at(__items, 3);
  const pub = at(__items, 4);
  const ctx = at(__items, 5);
  if (repo.tag !== "bytes" || repo.value.length !== 16) throw fail(CODES.corruptObject, "bad repo");
  if (ctx.tag !== "array") throw fail(CODES.corruptObject, "bad ctx");
  return {
    repoId: toHex(repo.value),
    seq: expectUint(seq),
    rootId: expectBytes32(root),
    prevId: optBytesOut(prev),
    publicationId: optBytesOut(pub),
    contextIds: ctx.value.map((v) => {
      if (v.tag !== "bytes" || v.value.length !== 32) throw fail(CODES.corruptObject, "bad ctx id");
      return toHex(v.value);
    })
  };
}

export function encodeCheckpoint(input: {
  layerId: string;
  originKind: 1 | 2;
  originId: string;
  anchorId: string;
  rootId: string;
  prevId: string | null;
  recordId: string | null;
  contextIds: ReadonlyArray<string>;
}): Uint8Array {
  const sorted = [...input.contextIds].sort();
  return wrapObject(
    4,
    arr([
      b(h16(input.layerId)),
      stateRef(input.originKind, input.originId),
      b(h32(input.anchorId)),
      b(h32(input.rootId)),
      optBytes(input.prevId),
      optBytes(input.recordId),
      arr(sorted.map((c) => b(h32(c))))
    ])
  );
}

export function decodeCheckpoint(bytes: Uint8Array): {
  layerId: string;
  originKind: 1 | 2;
  originId: string;
  anchorId: string;
  rootId: string;
  prevId: string | null;
  recordId: string | null;
  contextIds: ReadonlyArray<string>;
} {
  const { type, payload } = unwrapObject(bytes);
  if (type !== 4) throw fail(CODES.corruptObject, "not a checkpoint");
    const __items = expectArray(payload, 7);
  const layer = at(__items, 0);
  const origin = at(__items, 1);
  const anchor = at(__items, 2);
  const root = at(__items, 3);
  const prev = at(__items, 4);
  const rec = at(__items, 5);
  const ctx = at(__items, 6);
  if (layer.tag !== "bytes" || layer.value.length !== 16) throw fail(CODES.corruptObject, "bad layer");
  const o = decodeStateRef(origin);
  if (ctx.tag !== "array") throw fail(CODES.corruptObject, "bad ctx");
  return {
    layerId: toHex(layer.value),
    originKind: o.kind,
    originId: o.id,
    anchorId: expectBytes32(anchor),
    rootId: expectBytes32(root),
    prevId: optBytesOut(prev),
    recordId: optBytesOut(rec),
    contextIds: ctx.value.map((v) => {
      if (v.tag !== "bytes" || v.value.length !== 32) throw fail(CODES.corruptObject, "bad ctx id");
      return toHex(v.value);
    })
  };
}

export function encodeContextObject(input: { format: string; kind: string; ordinal: number; bytes: Uint8Array }): Uint8Array {
  return wrapObject(5, arr([t(input.format), t(input.kind), u(input.ordinal), b(input.bytes)]));
}

export function decodeContextObject(bytes: Uint8Array): { format: string; kind: string; ordinal: number; bytes: Uint8Array } {
  const { type, payload } = unwrapObject(bytes);
  if (type !== 5) throw fail(CODES.corruptObject, "not context object");
    const __items = expectArray(payload, 4);
  const f = at(__items, 0);
  const k = at(__items, 1);
  const o = at(__items, 2);
  const by = at(__items, 3);
  if (by.tag !== "bytes") throw fail(CODES.corruptObject, "bad bytes");
  return { format: expectText(f), kind: expectText(k), ordinal: expectUint(o), bytes: by.value };
}

export function encodeContextManifest(input: {
  repoId: string;
  layerId: string;
  sessionId: string;
  parentSessionId: string | null;
  objectIds: ReadonlyArray<string>;
  completeness: 0 | 1 | 2 | 3;
  gaps: ReadonlyArray<{ first: number; last: number }>;
}): Uint8Array {
  return wrapObject(
    6,
    arr([
      b(h16(input.repoId)),
      b(h16(input.layerId)),
      b(h16(input.sessionId)),
      input.parentSessionId === null ? nul() : b(h16(input.parentSessionId)),
      arr(input.objectIds.map((o) => b(h32(o)))),
      u(input.completeness),
      arr(input.gaps.map((g) => arr([u(g.first), u(g.last)])))
    ])
  );
}

export function decodeContextManifest(bytes: Uint8Array): {
  repoId: string;
  layerId: string;
  sessionId: string;
  parentSessionId: string | null;
  objectIds: ReadonlyArray<string>;
  completeness: number;
  gaps: ReadonlyArray<{ first: number; last: number }>;
} {
  const { type, payload } = unwrapObject(bytes);
  if (type !== 6) throw fail(CODES.corruptObject, "not manifest");
    const __items = expectArray(payload, 7);
  const repo = at(__items, 0);
  const layer = at(__items, 1);
  const sess = at(__items, 2);
  const parent = at(__items, 3);
  const objs = at(__items, 4);
  const comp = at(__items, 5);
  const gaps = at(__items, 6);
  if (repo.tag !== "bytes" || repo.value.length !== 16) throw fail(CODES.corruptObject, "bad repo");
  if (layer.tag !== "bytes" || layer.value.length !== 16) throw fail(CODES.corruptObject, "bad layer");
  if (sess.tag !== "bytes" || sess.value.length !== 16) throw fail(CODES.corruptObject, "bad session");
  let parentId: string | null = null;
  if (parent.tag === "bytes") {
    if (parent.value.length !== 16) throw fail(CODES.corruptObject, "bad parent");
    parentId = toHex(parent.value);
  } else if (parent.tag !== "null") {
    throw fail(CODES.corruptObject, "bad parent");
  }
  if (objs.tag !== "array") throw fail(CODES.corruptObject, "bad objs");
  if (gaps.tag !== "array") throw fail(CODES.corruptObject, "bad gaps");
  return {
    repoId: toHex(repo.value),
    layerId: toHex(layer.value),
    sessionId: toHex(sess.value),
    parentSessionId: parentId,
    objectIds: objs.value.map((v) => {
      if (v.tag !== "bytes" || v.value.length !== 32) throw fail(CODES.corruptObject, "bad obj");
      return toHex(v.value);
    }),
    completeness: expectUint(comp),
    gaps: gaps.value.map((g) => {
        const __items = expectArray(g, 2);
  const a2 = at(__items, 0);
  const c2 = at(__items, 1);
      return { first: expectUint(a2), last: expectUint(c2) };
    })
  };
}

export function encodePublication(input: {
  layerId: string;
  checkpointId: string;
  anchorId: string;
  priorId: string;
  rootId: string;
  seq: number;
  contextIds: ReadonlyArray<string>;
  actor: string | null;
  override: boolean;
  operationId: string;
}): Uint8Array {
  const sorted = [...input.contextIds].sort();
  return wrapObject(
    7,
    arr([
      b(h16(input.layerId)),
      b(h32(input.checkpointId)),
      b(h32(input.anchorId)),
      b(h32(input.priorId)),
      b(h32(input.rootId)),
      u(input.seq),
      arr(sorted.map((c) => b(h32(c)))),
      input.actor === null ? nul() : t(input.actor),
      bool(input.override),
      b(h16(input.operationId))
    ])
  );
}

export function decodePublication(bytes: Uint8Array): {
  layerId: string;
  checkpointId: string;
  anchorId: string;
  priorId: string;
  rootId: string;
  seq: number;
  contextIds: ReadonlyArray<string>;
  actor: string | null;
  override: boolean;
  operationId: string;
} {
  const { type, payload } = unwrapObject(bytes);
  if (type !== 7) throw fail(CODES.corruptObject, "not publication");
    const __items = expectArray(payload, 10);
  const layer = at(__items, 0);
  const cp = at(__items, 1);
  const anchor = at(__items, 2);
  const prior = at(__items, 3);
  const root = at(__items, 4);
  const seq = at(__items, 5);
  const ctx = at(__items, 6);
  const actor = at(__items, 7);
  const over = at(__items, 8);
  const op = at(__items, 9);
  if (layer.tag !== "bytes" || layer.value.length !== 16) throw fail(CODES.corruptObject, "bad layer");
  if (op.tag !== "bytes" || op.value.length !== 16) throw fail(CODES.corruptObject, "bad op");
  if (ctx.tag !== "array") throw fail(CODES.corruptObject, "bad ctx");
  let actorOut: string | null = null;
  if (actor.tag === "text") actorOut = actor.value;
  else if (actor.tag !== "null") throw fail(CODES.corruptObject, "bad actor");
  return {
    layerId: toHex(layer.value),
    checkpointId: expectBytes32(cp),
    anchorId: expectBytes32(anchor),
    priorId: expectBytes32(prior),
    rootId: expectBytes32(root),
    seq: expectUint(seq),
    contextIds: ctx.value.map((v) => {
      if (v.tag !== "bytes" || v.value.length !== 32) throw fail(CODES.corruptObject, "bad ctx id");
      return toHex(v.value);
    }),
    actor: actorOut,
    override: expectBool(over),
    operationId: toHex(op.value)
  };
}

export function encodeRefresh(input: {
  layerId: string;
  prevCheckpointId: string;
  prevAnchorId: string;
  adoptedId: string;
  rootId: string;
  operationId: string;
}): Uint8Array {
  return wrapObject(
    8,
    arr([b(h16(input.layerId)), b(h32(input.prevCheckpointId)), b(h32(input.prevAnchorId)), b(h32(input.adoptedId)), b(h32(input.rootId)), b(h16(input.operationId))])
  );
}

export function decodeRefresh(bytes: Uint8Array): {
  layerId: string;
  prevCheckpointId: string;
  prevAnchorId: string;
  adoptedId: string;
  rootId: string;
  operationId: string;
} {
  const { type, payload } = unwrapObject(bytes);
  if (type !== 8) throw fail(CODES.corruptObject, "not refresh");
    const __items = expectArray(payload, 6);
  const layer = at(__items, 0);
  const prev = at(__items, 1);
  const anchor = at(__items, 2);
  const adopted = at(__items, 3);
  const root = at(__items, 4);
  const op = at(__items, 5);
  if (layer.tag !== "bytes" || layer.value.length !== 16) throw fail(CODES.corruptObject, "bad layer");
  if (op.tag !== "bytes" || op.value.length !== 16) throw fail(CODES.corruptObject, "bad op");
  return {
    layerId: toHex(layer.value),
    prevCheckpointId: expectBytes32(prev),
    prevAnchorId: expectBytes32(anchor),
    adoptedId: expectBytes32(adopted),
    rootId: expectBytes32(root),
    operationId: toHex(op.value)
  };
}

export function encodeStack(input: {
  sources: ReadonlyArray<{ layerId: string; checkpointId: string; rootId: string }>;
  anchorId: string;
  destLayerId: string;
  rootId: string;
  order: ReadonlyArray<string>;
  contextIds: ReadonlyArray<string>;
  operationId: string;
}): Uint8Array {
  const sources = [...input.sources].sort((x, y) => (x.layerId < y.layerId ? -1 : x.layerId > y.layerId ? 1 : 0));
  const sortedCtx = [...input.contextIds].sort();
  return wrapObject(
    9,
    arr([
      arr(sources.map((s) => arr([b(h16(s.layerId)), b(h32(s.checkpointId)), b(h32(s.rootId))]))),
      b(h32(input.anchorId)),
      b(h16(input.destLayerId)),
      b(h32(input.rootId)),
      arr(input.order.map((o) => b(h16(o)))),
      arr(sortedCtx.map((c) => b(h32(c)))),
      b(h16(input.operationId))
    ])
  );
}

export function decodeStack(bytes: Uint8Array): {
  sources: ReadonlyArray<{ layerId: string; checkpointId: string; rootId: string }>;
  anchorId: string;
  destLayerId: string;
  rootId: string;
  order: ReadonlyArray<string>;
  contextIds: ReadonlyArray<string>;
  operationId: string;
} {
  const { type, payload } = unwrapObject(bytes);
  if (type !== 9) throw fail(CODES.corruptObject, "not stack");
    const __items = expectArray(payload, 7);
  const sources = at(__items, 0);
  const anchor = at(__items, 1);
  const dest = at(__items, 2);
  const root = at(__items, 3);
  const order = at(__items, 4);
  const ctx = at(__items, 5);
  const op = at(__items, 6);
  if (sources.tag !== "array") throw fail(CODES.corruptObject, "bad sources");
  if (order.tag !== "array") throw fail(CODES.corruptObject, "bad order");
  if (ctx.tag !== "array") throw fail(CODES.corruptObject, "bad ctx");
  if (dest.tag !== "bytes" || dest.value.length !== 16) throw fail(CODES.corruptObject, "bad dest");
  if (op.tag !== "bytes" || op.value.length !== 16) throw fail(CODES.corruptObject, "bad op");
  return {
    sources: sources.value.map((s) => {
        const __items = expectArray(s, 3);
  const l = at(__items, 0);
  const c2 = at(__items, 1);
  const r = at(__items, 2);
      if (l.tag !== "bytes" || l.value.length !== 16) throw fail(CODES.corruptObject, "bad source");
      return { layerId: toHex(l.value), checkpointId: expectBytes32(c2), rootId: expectBytes32(r) };
    }),
    anchorId: expectBytes32(anchor),
    destLayerId: toHex(dest.value),
    rootId: expectBytes32(root),
    order: order.value.map((o) => {
      if (o.tag !== "bytes" || o.value.length !== 16) throw fail(CODES.corruptObject, "bad order id");
      return toHex(o.value);
    }),
    contextIds: ctx.value.map((v) => {
      if (v.tag !== "bytes" || v.value.length !== 32) throw fail(CODES.corruptObject, "bad ctx id");
      return toHex(v.value);
    }),
    operationId: toHex(op.value)
  };
}
