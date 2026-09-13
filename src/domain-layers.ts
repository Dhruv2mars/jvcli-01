import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { newId16 } from "./core/ids.js";
import {
  buildTreeFromFiles,
  decodeCheckpoint,
  decodeWorldVersion,
  diffTrees,
  encodeCheckpoint,
  encodeRefresh,
  structuralCompatible,
  type Conflict
} from "./core/objects.js";
import { hashTree, hydrate, readFlat, TreeStager } from "./core/tree-stage.js";
import { normalizePath } from "./core/paths.js";
import { appendJournal, loadRefs, readJournal, resolveLayerRef, saveRefs, updateJournal, type LayerRef } from "./core/refs.js";
import { clearWorkspace, materializeTree, scanDirectory } from "./core/scan.js";
import { CODES, fail, type LayerState } from "./core/types.js";
import { currentWorldId, flattenRoot, layerWorkspaceDir, openRepo, resolveWorldSelector, type Repo } from "./core/repo.js";

export interface LayerInfo {
  readonly id: string;
  readonly name: string | null;
  readonly state: LayerState;
  readonly checkpoint: string;
  readonly anchorSeq: number;
  readonly anchorId: string;
  readonly rootId: string;
  readonly workspace: string | null;
  readonly agent: string | null;
  readonly dirty: boolean;
  readonly pendingCheckpoint: boolean;
  readonly stale: boolean;
  readonly currentSeq: number;
}

async function layerRoot(repo: Repo, ref: LayerRef): Promise<{ rootId: string; anchorId: string; anchorSeq: number }> {
  const cpBytes = await repo.store.readChecked(ref.checkpoint, 4);
  const cp = decodeCheckpoint(cpBytes);
  const anchorBytes = await repo.store.readChecked(cp.anchorId, 3);
  const anchor = decodeWorldVersion(anchorBytes);
  return { rootId: cp.rootId, anchorId: cp.anchorId, anchorSeq: anchor.seq };
}

async function currentSeqOf(repo: Repo): Promise<{ seq: number; id: string }> {
  const id = await currentWorldId(repo);
  const bytes = await repo.store.readChecked(id, 3);
  return { seq: decodeWorldVersion(bytes).seq, id };
}

export function putBlobSync(_repo: Repo, _content: Uint8Array): string {
  throw new Error("putBlobSync is removed; use TreeStager from core/tree-stage.js");
}

export async function checkpointLayer(repo: Repo, layerId: string, recordId: string | null, contextIds: ReadonlyArray<string>): Promise<string> {
  const refs = await loadRefs(repo.metaDir);
  const ref = refs.layers[layerId];
  if (ref === undefined) throw fail(CODES.layerNotFound, `no such layer`, { layerId });
  if (ref.state !== "active" && ref.state !== "closed") throw fail(CODES.layerState, `layer is ${ref.state}`, { layerId });
  const ws = layerWorkspaceDir(repo, layerId);
  const scan = await scanDirectory(ws);
  const stager = new TreeStager();
  const { rootId } = buildTreeFromFiles(scan.files, scan.symlinks, stager);
  await stager.flush(repo.store);
  const prevBytes = await repo.store.readChecked(ref.checkpoint, 4);
  const prev = decodeCheckpoint(prevBytes);
  const mergedCtx = [...new Set([...prev.contextIds, ...contextIds])].sort();
  const cpBytes = encodeCheckpoint({
    layerId,
    originKind: prev.originKind,
    originId: prev.originId,
    anchorId: prev.anchorId,
    rootId,
    prevId: ref.checkpoint,
    recordId,
    contextIds: mergedCtx
  });
  const cpId = await repo.store.put(cpBytes);
  const next = structuredClone(refs);
  next.layers[layerId] = { ...ref, checkpoint: cpId };
  await saveRefs(repo.metaDir, next);
  return cpId;
}

export interface CreateLayerOptions {
  readonly name: string | undefined;
  readonly from: string | undefined;
}

export async function createLayer(repo: Repo, opts: CreateLayerOptions): Promise<{ ref: LayerRef; workspace: string }> {
  const refs = await loadRefs(repo.metaDir);
  if (opts.name !== undefined) {
    const clash = Object.values(refs.layers).some((l) => l.name === opts.name && l.state !== "deleted");
    if (clash) throw fail(CODES.io, `layer name taken: ${opts.name}`);
  }
  let originKind: 1 | 2;
  let originId: string;
  let anchorId: string;
  let rootId: string;
  if (opts.from === undefined) {
    originKind = 1;
    originId = await currentWorldId(repo);
    anchorId = originId;
    const wbytes = await repo.store.readChecked(anchorId, 3);
    rootId = decodeWorldVersion(wbytes).rootId;
  } else {
    const bySeq = refs.worldsBySeq[opts.from];
    if (bySeq !== undefined) {
      originKind = 1;
      originId = bySeq;
      anchorId = bySeq;
      rootId = decodeWorldVersion(await repo.store.readChecked(bySeq, 3)).rootId;
    } else {
      let found: { layerId: string; cpId: string } | null = null;
      for (const l of Object.values(refs.layers)) {
        if (l.id === opts.from) {
          found = { layerId: l.id, cpId: l.checkpoint };
          break;
        }
      }
      if (found === null) {
        try {
          const wid = await resolveWorldSelector(repo, opts.from);
          originKind = 1;
          originId = wid;
          anchorId = wid;
          rootId = decodeWorldVersion(await repo.store.readChecked(wid, 3)).rootId;
        } catch {
          throw fail(CODES.invalidPath, `bad --from: ${opts.from}`);
        }
      } else {
        originKind = 2;
        originId = found.cpId;
        const cp = decodeCheckpoint(await repo.store.readChecked(found.cpId, 4));
        anchorId = cp.anchorId;
        rootId = cp.rootId;
      }
    }
  }
  const id = newId16();
  const cpBytes = encodeCheckpoint({ layerId: id, originKind, originId, anchorId, rootId, prevId: null, recordId: null, contextIds: [] });
  const cpId = await repo.store.put(cpBytes);
  const ws = layerWorkspaceDir(repo, id);
  const ref: LayerRef = {
    id,
    name: opts.name ?? null,
    originKind,
    originId,
    checkpoint: cpId,
    state: "active",
    agent: null,
    sessions: {},
    workspace: ws
  };
  const next = structuredClone(refs);
  next.layers[id] = ref;
  await saveRefs(repo.metaDir, next);
  await materializeFromRoot(repo, ws, rootId);
  return { ref, workspace: ws };
}

export async function materializeFromRoot(repo: Repo, ws: string, rootId: string): Promise<void> {
  const flat = await readFlat(repo.store, rootId);
  const files = await hydrate(repo.store, flat);
  await mkdir(ws, { recursive: true });
  await clearWorkspace(ws);
  await materializeTree(ws, files, flat.symlinks);
}

export async function openLayer(repo: Repo, selector: string): Promise<{ ref: LayerRef; workspace: string }> {
  const refs = await loadRefs(repo.metaDir);
  const ref = resolveLayerRef(refs, selector);
  if (ref.state === "deleted" || ref.state === "consumed" || ref.state === "published") {
    throw fail(CODES.layerState, `layer is ${ref.state}`, { layerId: ref.id, hint: "clone it to continue" });
  }
  const ws = layerWorkspaceDir(repo, ref.id);
  if (ref.state === "closed") {
    const next = structuredClone(refs);
    next.layers[ref.id] = { ...ref, state: "active", workspace: ws };
    await saveRefs(repo.metaDir, next);
    await materializeFromRoot(repo, ws, decodeCheckpoint(await repo.store.readChecked(ref.checkpoint, 4)).rootId);
    return { ref: { ...ref, state: "active", workspace: ws }, workspace: ws };
  }
  await mkdir(ws, { recursive: true });
  return { ref, workspace: ws };
}

export async function closeLayer(repo: Repo, selector: string): Promise<LayerRef> {
  await flushLayer(repo, selector);
  const refs = await loadRefs(repo.metaDir);
  const ref = resolveLayerRef(refs, selector);
  if (ref.state !== "active") throw fail(CODES.layerState, `layer is ${ref.state}`, { layerId: ref.id });
  const next = structuredClone(refs);
  next.layers[ref.id] = { ...ref, state: "closed", workspace: null };
  await saveRefs(repo.metaDir, next);
  return next.layers[ref.id]!;
}

export async function flushLayer(repo: Repo, selector: string): Promise<string> {
  const refs = await loadRefs(repo.metaDir);
  const ref = resolveLayerRef(refs, selector);
  if (ref.state !== "active") return ref.checkpoint;
  const before = await repo.store.readChecked(ref.checkpoint, 4);
  const prev = decodeCheckpoint(before);
  const ws = layerWorkspaceDir(repo, ref.id);
  const scan = await scanDirectory(ws);
  const stager = new TreeStager();
  const { rootId } = buildTreeFromFiles(scan.files, scan.symlinks, stager);
  if (rootId === prev.rootId) return ref.checkpoint;
  await stager.flush(repo.store);
  const cpBytes = encodeCheckpoint({
    layerId: ref.id,
    originKind: prev.originKind,
    originId: prev.originId,
    anchorId: prev.anchorId,
    rootId,
    prevId: ref.checkpoint,
    recordId: null,
    contextIds: prev.contextIds
  });
  const cpId = await repo.store.put(cpBytes);
  const next = structuredClone(refs);
  next.layers[ref.id] = { ...ref, checkpoint: cpId };
  await saveRefs(repo.metaDir, next);
  return cpId;
}

export async function layerStatus(repo: Repo, selector: string): Promise<LayerInfo> {
  const refs = await loadRefs(repo.metaDir);
  const ref = resolveLayerRef(refs, selector);
  const { rootId, anchorId, anchorSeq } = await layerRoot(repo, ref);
  const cur = await currentSeqOf(repo);
  let dirty = false;
  let pendingCheckpoint = false;
  if (ref.state === "active" && ref.workspace !== null) {
    try {
      const scan = await scanDirectory(ref.workspace);
      const live = hashTree(scan.files, scan.symlinks);
      dirty = live !== rootId;
      pendingCheckpoint = dirty;
    } catch {
      pendingCheckpoint = true;
    }
  }
  return {
    id: ref.id,
    name: ref.name,
    state: ref.state,
    checkpoint: ref.checkpoint,
    anchorSeq,
    anchorId,
    rootId,
    workspace: ref.workspace,
    agent: ref.agent,
    dirty,
    pendingCheckpoint,
    stale: anchorId !== cur.id,
    currentSeq: cur.seq
  };
}

export async function listLayers(repo: Repo): Promise<ReadonlyArray<LayerInfo>> {
  const refs = await loadRefs(repo.metaDir);
  const out: Array<LayerInfo> = [];
  for (const l of Object.values(refs.layers)) {
    if (l.state === "deleted") continue;
    out.push(await layerStatus(repo, l.id));
  }
  return out;
}

export async function cloneLayer(repo: Repo, selector: string, name?: string, checkpoint?: string): Promise<{ ref: LayerRef; workspace: string }> {
  const refs = await loadRefs(repo.metaDir);
  const src = resolveLayerRef(refs, selector);
  if (name !== undefined) {
    const clash = Object.values(refs.layers).some((l) => l.name === name && l.state !== "deleted");
    if (clash) throw fail(CODES.io, `layer name taken: ${name}`);
  }
  const cpId = checkpoint === undefined && src.state === "active" ? await flushLayer(repo, src.id) : (checkpoint ?? src.checkpoint);
  const cp = decodeCheckpoint(await repo.store.readChecked(cpId, 4));
  if (cp.layerId !== src.id) throw fail(CODES.invalidPath, "checkpoint belongs to another layer");
  const id = newId16();
  const fresh = encodeCheckpoint({
    layerId: id,
    originKind: 2,
    originId: cpId,
    anchorId: cp.anchorId,
    rootId: cp.rootId,
    prevId: null,
    recordId: null,
    contextIds: []
  });
  const freshId = await repo.store.put(fresh);
  const ws = layerWorkspaceDir(repo, id);
  const ref: LayerRef = { id, name: name ?? null, originKind: 2, originId: cpId, checkpoint: freshId, state: "active", agent: null, sessions: {}, workspace: ws };
  const next = structuredClone(refs);
  next.layers[id] = ref;
  await saveRefs(repo.metaDir, next);
  await materializeFromRoot(repo, ws, cp.rootId);
  return { ref, workspace: ws };
}

export async function childLayer(repo: Repo, selector: string, name?: string, checkpoint?: string): Promise<{ ref: LayerRef; workspace: string }> {
  return cloneLayer(repo, selector, name, checkpoint);
}

export async function renameLayer(repo: Repo, selector: string, name: string): Promise<LayerRef> {
  const refs = await loadRefs(repo.metaDir);
  const ref = resolveLayerRef(refs, selector);
  if (ref.state === "deleted") throw fail(CODES.layerState, "layer is deleted", { layerId: ref.id });
  const clash = Object.values(refs.layers).some((l) => l.name === name && l.id !== ref.id && l.state !== "deleted");
  if (clash) throw fail(CODES.io, `layer name taken: ${name}`);
  const next = structuredClone(refs);
  next.layers[ref.id] = { ...ref, name };
  await saveRefs(repo.metaDir, next);
  return next.layers[ref.id]!;
}

export async function deleteLayer(repo: Repo, selector: string): Promise<void> {
  const refs = await loadRefs(repo.metaDir);
  const ref = resolveLayerRef(refs, selector);
  if (ref.state === "deleted") return;
  const opId = newId16();
  await appendJournal(repo.metaDir, {
    op: opId,
    kind: "delete-layer",
    state: "prepared",
    layerId: ref.id,
    operationId: opId,
    payload: { checkpoint: ref.checkpoint },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  if (ref.state === "active" && ref.workspace !== null) {
    await flushLayer(repo, ref.id);
  }
  const cur = await loadRefs(repo.metaDir);
  const live = cur.layers[ref.id];
  if (live === undefined || live.state === "deleted") {
    await updateJournal(repo.metaDir, opId, { state: "finalized" });
    return;
  }
  const next = structuredClone(cur);
  next.layers[ref.id] = { ...live, state: "deleted", workspace: null, deletedAt: new Date().toISOString(), deleteOp: opId };
  await saveRefs(repo.metaDir, next);
  await rm(layerWorkspaceDir(repo, ref.id), { recursive: true, force: true });
  await updateJournal(repo.metaDir, opId, { state: "finalized" });
}

export async function refreshLayer(repo: Repo, selector: string): Promise<{ checkpoint: string; adopted: number; conflicts: ReadonlyArray<Conflict> }> {
  const refs = await loadRefs(repo.metaDir);
  const ref = resolveLayerRef(refs, selector);
  if (ref.state !== "active") throw fail(CODES.layerState, `layer is ${ref.state}`, { layerId: ref.id });
  const cpId = await flushLayer(repo, ref.id);
  const after = await loadRefs(repo.metaDir);
  const live = after.layers[ref.id]!;
  const cp = decodeCheckpoint(await repo.store.readChecked(cpId, 4));
  const cur = await currentSeqOf(repo);
  if (cp.anchorId === cur.id) return { checkpoint: cpId, adopted: cur.seq, conflicts: [] };
  const opId = newId16();
  await appendJournal(repo.metaDir, {
    op: opId,
    kind: "refresh",
    state: "prepared",
    layerId: ref.id,
    operationId: opId,
    payload: { checkpoint: cpId, adopted: cur.id },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const anchorRoot = decodeWorldVersion(await repo.store.readChecked(cp.anchorId, 3)).rootId;
  const curRoot = decodeWorldVersion(await repo.store.readChecked(cur.id, 3)).rootId;
  const [anchorFlat, curFlat, layerFlat, anchorExec, curExec, layerExec] = await Promise.all([
    flattenRoot(repo.store, anchorRoot),
    flattenRoot(repo.store, curRoot),
    flattenRoot(repo.store, cp.rootId),
    readFlat(repo.store, anchorRoot),
    readFlat(repo.store, curRoot),
    readFlat(repo.store, cp.rootId)
  ]);
  const execOf = (path: string): boolean => {
    const anchor = anchorExec.files.get(path)?.executable;
    const curBit = curExec.files.get(path)?.executable;
    const layerBit = layerExec.files.get(path)?.executable;
    const anchorBlob = anchorFlat.files.get(path) ?? null;
    const curBlob = curFlat.files.get(path) ?? null;
    const layerBlob = layerFlat.files.get(path) ?? null;
    if (layerBlob !== null && layerBlob !== anchorBlob) return layerBit ?? false;
    if (curBlob !== null && curBlob !== anchorBlob) return curBit ?? false;
    return layerBit ?? curBit ?? anchor ?? false;
  };
  const verdict = structuralCompatible(anchorFlat, curFlat, layerFlat);
  if (!verdict.ok) {
    await updateJournal(repo.metaDir, opId, { state: "conflict", payload: { conflicts: verdict.conflicts } });
    return { checkpoint: cpId, adopted: cur.seq, conflicts: verdict.conflicts };
  }
  const merged = verdict.merged;
  const mergedFlatFiles = new Map<string, { blobId: string; executable: boolean }>();
  for (const [path, blobId] of merged.files) {
    mergedFlatFiles.set(path, { blobId, executable: execOf(path) });
  }
  const files = await hydrate(repo.store, { files: mergedFlatFiles, symlinks: merged.symlinks });
  const stager2 = new TreeStager();
  const { rootId } = buildTreeFromFiles(files, merged.symlinks, stager2);
  await stager2.flush(repo.store);
  const recBytes = encodeRefresh({ layerId: ref.id, prevCheckpointId: cpId, prevAnchorId: cp.anchorId, adoptedId: cur.id, rootId, operationId: opId });
  const recId = await repo.store.put(recBytes);
  const fresh = encodeCheckpoint({
    layerId: ref.id,
    originKind: cp.originKind,
    originId: cp.originId,
    anchorId: cur.id,
    rootId,
    prevId: cpId,
    recordId: recId,
    contextIds: cp.contextIds
  });
  const freshId = await repo.store.put(fresh);
  const latest = await loadRefs(repo.metaDir);
  const nl = structuredClone(latest);
  nl.layers[ref.id] = { ...live, checkpoint: freshId };
  await saveRefs(repo.metaDir, nl);
  await updateJournal(repo.metaDir, opId, { state: "finalized" });
  await materializeFromRoot(repo, layerWorkspaceDir(repo, ref.id), rootId);
  return { checkpoint: freshId, adopted: cur.seq, conflicts: [] };
}

export function formatConflict(c: Conflict): string {
  return `${c.path} (${c.kind})`;
}
