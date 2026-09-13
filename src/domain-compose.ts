import { join } from "node:path";
import { encodeBlob, encodeTree, objectId, unwrapObject } from "./core/cbor.js";
import { newId16 } from "./core/ids.js";
import {
  decodeCheckpoint,
  decodeWorldVersion,
  encodePublication,
  encodeStack,
  encodeCheckpoint as encodeCheckpointObj,
  structuralCompatible
} from "./core/objects.js";
import { decodeTree } from "./core/cbor.js";
import { appendJournal, loadRefs, readJournal, resolveLayerRef, saveRefs, updateJournal } from "./core/refs.js";
import { CODES, fail, type LayerState } from "./core/types.js";
import { buildTreeFromFiles } from "./core/objects.js";
import { collectLayerContexts, layerContextStatus } from "./domain-context.js";
import { flushLayer, materializeFromRoot } from "./domain-layers.js";
import { layerWorkspaceDir } from "./core/repo.js";
import { currentWorldId, flattenRoot, openRepo, type Repo } from "./core/repo.js";

export interface PublishOptions {
  readonly allowMissingContext: boolean;
  readonly operationId: string | undefined;
  readonly actor: string | undefined;
}

export interface PublishResult {
  readonly seq: number;
  readonly worldId: string;
  readonly status: "published" | "conflict" | "recovered";
  readonly conflicts?: ReadonlyArray<{ path: string; kind: string }>;
  readonly operationId: string;
}

async function executableMap(repo: Repo, rootId: string): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const visit = async (id: string, prefix: string): Promise<void> => {
    const bytes = await repo.store.readChecked(id, 2);
    const entries = decodeTree(bytes);
    for (const e of entries) {
      const p = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.kind === "file") out.set(p, e.executable);
      else if (e.kind === "dir") await visit(e.target, p);
    }
  };
  await visit(rootId, "");
  return out;
}

async function materializeMerged(repo: Repo, ws: string, merged: { files: Map<string, string>; symlinks: Map<string, string> }): Promise<string> {
  const files = new Map<string, { bytes: Uint8Array; executable: boolean }>();
  for (const [p, blob] of merged.files) {
    const raw = await repo.store.readChecked(blob, 1);
    const { payload } = unwrapObject(raw);
    if (payload.tag !== "bytes") throw fail(CODES.corruptObject, "bad blob");
    files.set(p, { bytes: payload.value, executable: false });
  }
  const pending = new Map<string, Uint8Array>();
  const pb = (content: Uint8Array): string => {
    const bytes = encodeBlob(content);
    pending.set(objectId(bytes), bytes);
    return objectId(bytes);
  };
  const pt = (entries: ReadonlyArray<{ name: string; kind: "file" | "dir" | "symlink"; target: string; executable: boolean }>): string => {
    const bytes = encodeTree(entries);
    pending.set(objectId(bytes), bytes);
    return objectId(bytes);
  };
  const { rootId } = buildTreeFromFiles(files, merged.symlinks, { putBlob: pb, putTree: pt });
  for (const bytes of pending.values()) await repo.store.put(bytes);
  const { clearWorkspace } = await import("./core/scan.js");
  const { materializeTree } = await import("./core/scan.js");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(ws, { recursive: true });
  await clearWorkspace(ws);
  await materializeTree(ws, files, merged.symlinks);
  return rootId;
}

export async function publishLayer(repo: Repo, selector: string, opts: PublishOptions): Promise<PublishResult> {
  const refs0 = await loadRefs(repo.metaDir);
  const ref0 = resolveLayerRef(refs0, selector);
  if (ref0.state !== "active") throw fail(CODES.layerState, `layer is ${ref0.state}`, { layerId: ref0.id });
  const operationId = (opts.operationId ?? newId16()).toLowerCase();
  const existing = await readJournal(repo.metaDir, operationId);
  if (existing !== null) {
    if (existing.kind !== "publish") throw fail(CODES.io, "operation id belongs to another op", { operationId });
    if (existing.state === "finalized" || existing.state === "accepted") {
      const wid = (existing.payload as { worldId: string }).worldId;
      const wbytes = await repo.store.readChecked(wid, 3);
      return { seq: decodeWorldVersion(wbytes).seq, worldId: wid, status: "recovered", operationId };
    }
  } else {
    await appendJournal(repo.metaDir, {
      op: operationId,
      kind: "publish",
      state: "prepared",
      layerId: ref0.id,
      operationId,
      payload: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
  const cpId = await flushLayer(repo, ref0.id);
  const refs = await loadRefs(repo.metaDir);
  const ref = refs.layers[ref0.id]!;
  const cp = decodeCheckpoint(await repo.store.readChecked(cpId, 4));
  const priorId = await currentWorldId(repo);
  const prior = decodeWorldVersion(await repo.store.readChecked(priorId, 3));
  const ctx = await layerContextStatus(repo, ref.id);
  if (ctx.missing && !opts.allowMissingContext) {
    throw fail(CODES.missingContext, "agent context missing or incomplete; re-run with --allow-missing-context to override", {
      layerId: ref.id,
      operationId,
      hint: "jvcli context status --layer <id>"
    });
  }
  const anchorFlat = await flattenRoot(repo.store, decodeWorldVersion(await repo.store.readChecked(cp.anchorId, 3)).rootId);
  const priorFlat = await flattenRoot(repo.store, prior.rootId);
  const layerFlat = await flattenRoot(repo.store, cp.rootId);
  const verdict = structuralCompatible(anchorFlat, priorFlat, layerFlat);
  if (!verdict.ok) {
    await updateJournal(repo.metaDir, operationId, { state: "conflict", payload: { conflicts: verdict.conflicts } });
    return { seq: prior.seq, worldId: priorId, status: "conflict", conflicts: verdict.conflicts, operationId };
  }
  const merged = verdict.merged;
  const resultRoot = await materializeMerged(repo, layerWorkspaceDir(repo, ref.id), { files: new Map(merged.files), symlinks: new Map(merged.symlinks) });
  void resultRoot;
  const pending = new Map<string, Uint8Array>();
  const files = new Map<string, { bytes: Uint8Array; executable: boolean }>();
  for (const [p, blob] of merged.files) {
    const raw = await repo.store.readChecked(blob, 1);
    const { payload } = unwrapObject(raw);
    if (payload.tag !== "bytes") throw fail(CODES.corruptObject, "bad blob");
    files.set(p, { bytes: payload.value, executable: false });
  }
  const pb = (content: Uint8Array): string => {
    const bytes = encodeBlob(content);
    pending.set(objectId(bytes), bytes);
    return objectId(bytes);
  };
  const pt = (entries: ReadonlyArray<{ name: string; kind: "file" | "dir" | "symlink"; target: string; executable: boolean }>): string => {
    const bytes = encodeTree(entries);
    pending.set(objectId(bytes), bytes);
    return objectId(bytes);
  };
  const built = buildTreeFromFiles(files, merged.symlinks, { putBlob: pb, putTree: pt });
  for (const bytes of pending.values()) await repo.store.put(bytes);
  const finalRoot = built.rootId;
  await updateJournal(repo.metaDir, operationId, { state: "objects_durable", payload: { checkpoint: cpId, root: finalRoot } });
  const contextIds = await collectLayerContexts(repo, [ref.id]);
  const pubBytes = encodePublication({
    layerId: ref.id,
    checkpointId: cpId,
    anchorId: cp.anchorId,
    priorId,
    rootId: finalRoot,
    seq: prior.seq + 1,
    contextIds,
    actor: opts.actor ?? null,
    override: ctx.missing && opts.allowMissingContext,
    operationId
  });
  const pubId = await repo.store.put(pubBytes);
  const worldBytes = (await import("./core/objects.js")).encodeWorldVersion({
    repoId: repo.repoId,
    seq: prior.seq + 1,
    rootId: finalRoot,
    prevId: priorId,
    publicationId: pubId,
    contextIds
  });
  const worldId = await repo.store.put(worldBytes);
  const snapshot = await loadRefs(repo.metaDir);
  const cur2 = await loadRefs(repo.metaDir);
  const still = cur2.layers[ref.id]!;
  if (still.checkpoint !== cpId || still.state !== "active") {
    throw fail(CODES.busy, "layer changed during publish; retry", { layerId: ref.id, operationId, retryable: true });
  }
  const currentNow = cur2.currentWorld;
  if (currentNow !== priorId) {
    const freshPrior = decodeWorldVersion(await repo.store.readChecked(currentNow, 3));
    const freshFlat = await flattenRoot(repo.store, freshPrior.rootId);
    const re = structuralCompatible(anchorFlat, freshFlat, layerFlat);
    if (!re.ok) {
      await updateJournal(repo.metaDir, operationId, { state: "conflict", payload: { conflicts: re.conflicts } });
      return { seq: freshPrior.seq, worldId: currentNow, status: "conflict", conflicts: re.conflicts, operationId };
    }
    await updateJournal(repo.metaDir, operationId, { state: "conflict", payload: { retry: true } });
    throw fail(CODES.stale, "world advanced during publish; retry", { layerId: ref.id, operationId, retryable: true });
  }
  const next = structuredClone(snapshot);
  const worlds = { ...next.worldsBySeq, [String(prior.seq + 1)]: worldId };
  const layers = { ...next.layers, [ref.id]: { ...still, state: "published" as LayerState, workspace: still.workspace } };
  const swapped: typeof next = { currentWorld: worldId, worldsBySeq: worlds, layers };
  const { casRefs } = await import("./core/refs.js");
  const ok = await casRefs(repo.metaDir, snapshot, swapped);
  if (!ok) throw fail(CODES.busy, "concurrent publish; retry", { layerId: ref.id, operationId, retryable: true });
  await updateJournal(repo.metaDir, operationId, { state: "accepted", payload: { worldId } });
  await updateJournal(repo.metaDir, operationId, { state: "finalized", payload: { worldId } });
  return { seq: prior.seq + 1, worldId, status: "published", operationId };
}

export interface StackResult {
  readonly destId: string;
  readonly workspace: string;
  readonly operationId: string;
  readonly order: ReadonlyArray<string>;
}

export async function stackLayers(repo: Repo, selectors: ReadonlyArray<string>, name: string | undefined, operationId?: string): Promise<StackResult> {
  if (selectors.length < 2) throw fail(CODES.invalidPath, "stack needs at least two layers");
  const opId = (operationId ?? newId16()).toLowerCase();
  const refs0 = await loadRefs(repo.metaDir);
  const sources = selectors.map((s) => resolveLayerRef(refs0, s));
  for (const s of sources) {
    if (s.state !== "active") throw fail(CODES.layerState, `layer ${s.id} is ${s.state}`, { layerId: s.id });
  }
  if (name !== undefined) {
    const clash = Object.values(refs0.layers).some((l) => l.name === name && l.state !== "deleted");
    if (clash) throw fail(CODES.io, `layer name taken: ${name}`);
  }
  const cpIds: Array<string> = [];
  for (const s of sources) cpIds.push(await flushLayer(repo, s.id));
  const refs = await loadRefs(repo.metaDir);
  const live = sources.map((s) => refs.layers[s.id]!);
  const cur = await currentWorldId(repo);
  const curW = decodeWorldVersion(await repo.store.readChecked(cur, 3));
  const curFlat = await flattenRoot(repo.store, curW.rootId);
  const contribs: Array<{ layerId: string; cpId: string; anchorId: string; flat: { files: Map<string, string>; symlinks: Map<string, string> } }> = [];
  for (let i = 0; i < live.length; i++) {
    const cp = decodeCheckpoint(await repo.store.readChecked(cpIds[i]!, 4));
    const anchorFlat = await flattenRoot(repo.store, decodeWorldVersion(await repo.store.readChecked(cp.anchorId, 3)).rootId);
    const layerFlat = await flattenRoot(repo.store, cp.rootId);
    const norm = structuralCompatible(anchorFlat, curFlat, layerFlat);
    if (!norm.ok) {
      throw fail(CODES.conflict, `cannot normalize layer ${live[i]!.id} onto current world`, {
        layerId: live[i]!.id,
        operationId: opId,
        paths: norm.conflicts.map((c) => c.path)
      });
    }
    contribs.push({ layerId: live[i]!.id, cpId: cpIds[i]!, anchorId: cp.anchorId, flat: { files: new Map(norm.merged.files), symlinks: new Map(norm.merged.symlinks) } });
  }
  const order = orderSources(contribs.map((c) => ({ layerId: c.layerId, anchorId: c.anchorId, cpId: c.cpId })));
  let acc = { files: new Map(curFlat.files), symlinks: new Map(curFlat.symlinks) };
  for (const lid of order) {
    const c = contribs.find((x) => x.layerId === lid)!;
    const v = structuralCompatible(curFlat, acc, c.flat);
    if (!v.ok) {
      throw fail(CODES.conflict, "stack conflicts", { operationId: opId, paths: v.conflicts.map((x) => x.path), hint: "resolve in source layers and retry" });
    }
    acc = { files: new Map(v.merged.files), symlinks: new Map(v.merged.symlinks) };
  }
  await appendJournal(repo.metaDir, {
    op: opId,
    kind: "stack",
    state: "prepared",
    operationId: opId,
    payload: { sources: live.map((s) => s.id) },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const files = new Map<string, { bytes: Uint8Array; executable: boolean }>();
  for (const [p, blob] of acc.files) {
    const raw = await repo.store.readChecked(blob, 1);
    const { payload } = unwrapObject(raw);
    if (payload.tag !== "bytes") throw fail(CODES.corruptObject, "bad blob");
    files.set(p, { bytes: payload.value, executable: false });
  }
  const pending = new Map<string, Uint8Array>();
  const pb = (content: Uint8Array): string => {
    const bytes = encodeBlob(content);
    pending.set(objectId(bytes), bytes);
    return objectId(bytes);
  };
  const pt = (entries: ReadonlyArray<{ name: string; kind: "file" | "dir" | "symlink"; target: string; executable: boolean }>): string => {
    const bytes = encodeTree(entries);
    pending.set(objectId(bytes), bytes);
    return objectId(bytes);
  };
  const built = buildTreeFromFiles(files, acc.symlinks, { putBlob: pb, putTree: pt });
  for (const bytes of pending.values()) await repo.store.put(bytes);
  const destId = newId16();
  const contextIds = await collectLayerContexts(repo, live.map((s) => s.id));
  const stackBytes = encodeStack({
    sources: contribs.map((c) => ({ layerId: c.layerId, checkpointId: c.cpId, rootId: decodeCheckpointSync(c.cpId, repo) })),
    anchorId: cur,
    destLayerId: destId,
    rootId: built.rootId,
    order,
    contextIds,
    operationId: opId
  });
  void stackBytes;
  const stackId = await repo.store.put(
    encodeStack({
      sources: await Promise.all(
        contribs.map(async (c) => ({
          layerId: c.layerId,
          checkpointId: c.cpId,
          rootId: decodeCheckpoint(await repo.store.readChecked(c.cpId, 4)).rootId
        }))
      ),
      anchorId: cur,
      destLayerId: destId,
      rootId: built.rootId,
      order,
      contextIds,
      operationId: opId
    })
  );
  const destCp = encodeCheckpointObj({ layerId: destId, originKind: 1, originId: cur, anchorId: cur, rootId: built.rootId, prevId: null, recordId: stackId, contextIds });
  const destCpId = await repo.store.put(destCp);
  const snapshot = await loadRefs(repo.metaDir);
  for (const s of live) {
    const curRef = snapshot.layers[s.id];
    if (curRef === undefined || curRef.state !== "active") throw fail(CODES.busy, "source changed during stack; retry", { operationId: opId, retryable: true });
  }
  const next = structuredClone(snapshot);
  const ws = join(repo.metaDir, "layers", destId, "workspace");
  next.layers[destId] = { id: destId, name: name ?? null, originKind: 1, originId: cur, checkpoint: destCpId, state: "active", agent: null, sessions: {}, workspace: ws };
  for (const s of live) {
    const r = next.layers[s.id]!;
    next.layers[s.id] = { ...r, state: "consumed" as LayerState };
  }
  const { casRefs: cas } = await import("./core/refs.js");
  const ok = await cas(repo.metaDir, snapshot, next);
  if (!ok) throw fail(CODES.busy, "concurrent stack; retry", { operationId: opId, retryable: true });
  await updateJournal(repo.metaDir, opId, { state: "finalized", payload: { dest: destId } });
  await materializeFromRoot(repo, ws, built.rootId);
  return { destId, workspace: ws, operationId: opId, order };
}

function decodeCheckpointSync(_cpId: string, _repo: Repo): string {
  return _cpId;
}

function orderSources(sources: ReadonlyArray<{ layerId: string; anchorId: string; cpId: string }>): ReadonlyArray<string> {
  return [...sources].sort((a, b) => (a.layerId < b.layerId ? -1 : a.layerId > b.layerId ? 1 : 0)).map((s) => s.layerId);
}

export { openRepo };
