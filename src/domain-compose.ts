import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { newId16 } from "./core/ids.js";
import {
  buildTreeFromFiles,
  decodeCheckpoint,
  decodeWorldVersion,
  encodePublication,
  encodeStack,
  encodeWorldVersion,
  encodeCheckpoint as encodeCheckpointObj,
  structuralCompatible
} from "./core/objects.js";
import { appendJournal, casRefs, loadRefs, readJournal, resolveLayerRef, updateJournal } from "./core/refs.js";
import { CODES, fail, type LayerState } from "./core/types.js";
import { collectLayerContexts, layerContextStatus } from "./domain-context.js";
import { flushLayer, materializeFromRoot } from "./domain-layers.js";
import { layerWorkspaceDir } from "./core/repo.js";
import { currentWorldId, flattenRoot, type Repo } from "./core/repo.js";
import { clearWorkspace, materializeTree } from "./core/scan.js";
import { hydrate, readFlat, stageFiles, TreeStager } from "./core/tree-stage.js";

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

async function materializeMerged(repo: Repo, ws: string, merged: { files: Map<string, string>; symlinks: Map<string, string> }, exec: ReadonlyMap<string, boolean>): Promise<string> {
  const files = new Map<string, { bytes: Uint8Array; executable: boolean }>();
  const flat = { files: new Map([...merged.files].map(([path, blobId]) => [path, { blobId, executable: exec.get(path) ?? false }] as const)), symlinks: merged.symlinks };
  const hydrated = await hydrate(repo.store, flat);
  for (const [path, view] of hydrated) files.set(path, view);
  const rootId = await stageFiles(repo.store, files, merged.symlinks);
  await mkdir(ws, { recursive: true });
  await clearWorkspace(ws);
  await materializeTree(ws, files, merged.symlinks);
  return rootId;
}

async function adoptJournalCheckpoint(repo: Repo, layerId: string, checkpoint: string): Promise<string> {
  const cp = decodeCheckpoint(await repo.store.readChecked(checkpoint, 4));
  if (cp.layerId !== layerId) throw fail(CODES.corruptObject, "journal checkpoint belongs to another layer", { layerId });
  const refs = await loadRefs(repo.metaDir);
  const ref = refs.layers[layerId];
  if (ref === undefined) throw fail(CODES.layerNotFound, "no such layer", { layerId });
  if (ref.checkpoint === checkpoint) return checkpoint;
  if (ref.state !== "active") throw fail(CODES.busy, "layer changed during publish; retry", { layerId, retryable: true });
  const next = structuredClone(refs);
  next.layers[layerId] = { ...ref, checkpoint };
  const { casRefs } = await import("./core/refs.js");
  const swapped = await casRefs(repo.metaDir, refs, next);
  if (!swapped) throw fail(CODES.busy, "layer changed during publish; retry", { layerId, retryable: true });
  await materializeFromRoot(repo, layerWorkspaceDir(repo, layerId), cp.rootId, layerId);
  return checkpoint;
}

async function treeMatchesMerge(
  repo: Repo,
  rootId: string,
  merged: { files: Map<string, string>; symlinks: Map<string, string> }
): Promise<boolean> {
  try {
    const flat = await flattenRoot(repo.store, rootId);
    if (flat.files.size !== merged.files.size || flat.symlinks.size !== merged.symlinks.size) return false;
    for (const [path, blob] of merged.files) {
      if (flat.files.get(path) !== blob) return false;
    }
    for (const [path, target] of merged.symlinks) {
      if (flat.symlinks.get(path) !== target) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function faultPoint(name: string): boolean {
  const raw = (process.env.JVCLI_FAULT ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return raw.includes(name);
}

async function crashIf(name: string): Promise<never | void> {
  if (faultPoint(name)) {
    throw fail(CODES.interrupted, `fault injected at ${name}`, { retryable: true, hint: "retry the operation" });
  }
}

export async function publishLayer(repo: Repo, selector: string, opts: PublishOptions): Promise<PublishResult> {
  const refs0 = await loadRefs(repo.metaDir);
  const ref0 = resolveLayerRef(refs0, selector);
  const operationId = (opts.operationId ?? newId16()).toLowerCase();
  const existing = await readJournal(repo.metaDir, operationId);
  if (existing !== null) {
    if (existing.kind !== "publish") throw fail(CODES.io, "operation id belongs to another op", { operationId });
    if (existing.layerId !== undefined && existing.layerId !== ref0.id) {
      throw fail(CODES.io, `operation id ${operationId} belongs to layer ${existing.layerId}`, { layerId: ref0.id, operationId });
    }
    if (existing.state === "finalized" || existing.state === "accepted") {
      const wid = (existing.payload as { worldId: string }).worldId;
      const wbytes = await repo.store.readChecked(wid, 3);
      return { seq: decodeWorldVersion(wbytes).seq, worldId: wid, status: "recovered", operationId };
    }
  } else {
    if (ref0.state !== "active") throw fail(CODES.layerState, `layer is ${ref0.state}`, { layerId: ref0.id });
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
  const journaled = existing !== null && existing.kind === "publish"
    ? (existing.payload as { checkpoint?: string; root?: string; worldId?: string })
    : null;
  const cpId = journaled?.checkpoint !== undefined && journaled.checkpoint !== ""
    ? await adoptJournalCheckpoint(repo, ref0.id, journaled.checkpoint)
    : await flushLayer(repo, ref0.id);
  const refs = await loadRefs(repo.metaDir);
  const ref = refs.layers[ref0.id]!;
  const cp = decodeCheckpoint(await repo.store.readChecked(cpId, 4));
  const journaledRoot = journaled?.root !== undefined && journaled.root !== "" ? journaled.root : null;
  const priorId = await currentWorldId(repo);
  const prior = decodeWorldVersion(await repo.store.readChecked(priorId, 3));
  const ctx = await layerContextStatus(repo, ref.id);
  if (ctx.missing && !opts.allowMissingContext) {
    throw fail(CODES.missingContext, "agent context missing or incomplete; re-run with --allow-missing-context to override", {
      layerId: ref.id,
      operationId,
      retryable: true,
      hint: "jvcli context status --layer <id>"
    });
  }
  const anchorRoot = decodeWorldVersion(await repo.store.readChecked(cp.anchorId, 3)).rootId;
  const [anchorFlat, priorFlat, layerFlat, anchorExec, priorExec, layerExec] = await Promise.all([
    flattenRoot(repo.store, anchorRoot),
    flattenRoot(repo.store, prior.rootId),
    flattenRoot(repo.store, cp.rootId),
    readFlat(repo.store, anchorRoot),
    readFlat(repo.store, prior.rootId),
    readFlat(repo.store, cp.rootId)
  ]);
  const toExecView = (blobs: { files: Map<string, string>; symlinks: Map<string, string> }, exec: { files: ReadonlyMap<string, { blobId: string; executable: boolean }> }): { files: Map<string, { blob: string; executable: boolean }>; symlinks: Map<string, string> } => ({
    files: new Map([...blobs.files].map(([p, b]) => [p, { blob: b, executable: exec.files.get(p)?.executable ?? false }] as const)),
    symlinks: blobs.symlinks
  });
  const anchorView = toExecView(anchorFlat, anchorExec);
  const priorView = toExecView(priorFlat, priorExec);
  const layerView = toExecView(layerFlat, layerExec);
  const execOf = (path: string): boolean => {
    const anchorBlob = anchorFlat.files.get(path) ?? null;
    const layerBlob = layerFlat.files.get(path) ?? null;
    if (layerBlob !== null && layerBlob !== anchorBlob) return layerExec.files.get(path)?.executable ?? false;
    return anchorExec.files.get(path)?.executable ?? layerExec.files.get(path)?.executable ?? false;
  };
  const verdict = structuralCompatible(anchorView, priorView, layerView);
  if (!verdict.ok) {
    await updateJournal(repo.metaDir, operationId, { state: "conflict", payload: { conflicts: verdict.conflicts } });
    return { seq: prior.seq, worldId: priorId, status: "conflict", conflicts: verdict.conflicts, operationId };
  }
  const merged = verdict.merged;
  const exec = new Map([...merged.files.keys()].map((path) => [path, execOf(path)] as const));
  let finalRoot = journaledRoot;
  let needsMaterialize = true;
  if (finalRoot !== null) {
    const sameCheckpoint = journaled?.checkpoint === cpId;
    const samePrior = (journaled as { prior?: string } | null) !== null
      && (journaled as unknown as { prior?: string }).prior === priorId;
    const matchesMerge = await treeMatchesMerge(repo, finalRoot, merged);
    if (!sameCheckpoint || !samePrior || !matchesMerge) {
      finalRoot = null;
    } else {
      needsMaterialize = false;
    }
  }
  if (finalRoot === null) {
    finalRoot = await materializeMerged(repo, layerWorkspaceDir(repo, ref.id), { files: new Map(merged.files), symlinks: new Map(merged.symlinks) }, exec);
    await updateJournal(repo.metaDir, operationId, { state: "objects_durable", payload: { checkpoint: cpId, prior: priorId, root: finalRoot } });
  } else if (needsMaterialize) {
    await materializeMerged(repo, layerWorkspaceDir(repo, ref.id), { files: new Map(merged.files), symlinks: new Map(merged.symlinks) }, exec);
  }
  await crashIf("publish:after-merge-durable");
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
  const worldBytes = encodeWorldVersion({
    repoId: repo.repoId,
    seq: prior.seq + 1,
    rootId: finalRoot,
    prevId: priorId,
    publicationId: pubId,
    contextIds
  });
  const worldId = await repo.store.put(worldBytes);
  await updateJournal(repo.metaDir, operationId, { state: "world_created", payload: { checkpoint: cpId, prior: priorId, root: finalRoot, publication: pubId, world: worldId } });
  await crashIf("publish:after-world-created");
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
    await updateJournal(repo.metaDir, operationId, { state: "stale-retry", payload: { checkpoint: cpId, prior: currentNow } });
    throw fail(CODES.stale, "world advanced during publish; retry", { layerId: ref.id, operationId, retryable: true });
  }
  const next = structuredClone(snapshot);
  const worlds = { ...next.worldsBySeq, [String(prior.seq + 1)]: worldId };
  const layers = { ...next.layers, [ref.id]: { ...still, state: "published" as LayerState, workspace: still.workspace } };
  const swapped: typeof next = { currentWorld: worldId, worldsBySeq: worlds, layers };
  const ok = await casRefs(repo.metaDir, snapshot, swapped);
  if (!ok) throw fail(CODES.busy, "concurrent publish; retry", { layerId: ref.id, operationId, retryable: true });
  await updateJournal(repo.metaDir, operationId, { state: "accepted", payload: { worldId } });
  await crashIf("publish:after-accepted");
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
  const stacked = await readJournal(repo.metaDir, opId);
  const refs0 = await loadRefs(repo.metaDir);
  const sources = selectors.map((s) => resolveLayerRef(refs0, s));
  if (stacked !== null) {
    if (stacked.kind !== "stack") throw fail(CODES.io, "operation id belongs to another op", { operationId: opId });
    if (stacked.state === "finalized") {
      const prior = stacked.payload as { dest: string; sources?: ReadonlyArray<string>; into?: string | null; order?: ReadonlyArray<string> };
      const sameSources = prior.sources !== undefined
        && prior.sources.length === sources.length
        && sources.every((s) => prior.sources!.includes(s.id));
      const sameInto = (prior.into ?? null) === (name ?? null);
      if (!sameSources || !sameInto) {
        throw fail(CODES.io, `operation id ${opId} belongs to a different stack`, { operationId: opId });
      }
      const destRef = (await loadRefs(repo.metaDir)).layers[prior.dest];
      if (destRef === undefined) throw fail(CODES.corruptObject, `stack destination missing: ${prior.dest}`, { operationId: opId });
      return { destId: prior.dest, workspace: destRef.workspace ?? layerWorkspaceDir(repo, prior.dest), operationId: opId, order: prior.order ?? [] };
    }
  }
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
  const curExec = await readFlat(repo.store, curW.rootId);
  const contribs: Array<{ layerId: string; cpId: string; anchorId: string; flat: { files: Map<string, string>; symlinks: Map<string, string> }; exec: Map<string, boolean> }> = [];
  const toExecView = (blobs: { files: Map<string, string>; symlinks: Map<string, string> }, exec: { files: ReadonlyMap<string, { blobId: string; executable: boolean }> }): { files: Map<string, { blob: string; executable: boolean }>; symlinks: Map<string, string> } => ({
    files: new Map([...blobs.files].map(([p, b]) => [p, { blob: b, executable: exec.files.get(p)?.executable ?? false }] as const)),
    symlinks: blobs.symlinks
  });
  const curView = toExecView(curFlat, curExec);
  for (let i = 0; i < live.length; i++) {
    const cp = decodeCheckpoint(await repo.store.readChecked(cpIds[i]!, 4));
    const anchorRoot = decodeWorldVersion(await repo.store.readChecked(cp.anchorId, 3)).rootId;
    const [anchorFlat, layerFlat, anchorExecFlat, layerExecFlat] = await Promise.all([
      flattenRoot(repo.store, anchorRoot),
      flattenRoot(repo.store, cp.rootId),
      readFlat(repo.store, anchorRoot),
      readFlat(repo.store, cp.rootId)
    ]);
    const norm = structuralCompatible(toExecView(anchorFlat, anchorExecFlat), curView, toExecView(layerFlat, layerExecFlat));
    if (!norm.ok) {
      throw fail(CODES.conflict, `cannot normalize layer ${live[i]!.id} onto current world`, {
        layerId: live[i]!.id,
        operationId: opId,
        paths: norm.conflicts.map((c) => c.path)
      });
    }
    const exec = new Map<string, boolean>();
    for (const path of norm.merged.files.keys()) {
      const anchorBlob = anchorFlat.files.get(path) ?? null;
      const layerBlob = layerFlat.files.get(path) ?? null;
      if (layerBlob !== null && layerBlob !== anchorBlob) exec.set(path, layerExecFlat.files.get(path)?.executable ?? false);
      else exec.set(path, anchorExecFlat.files.get(path)?.executable ?? layerExecFlat.files.get(path)?.executable ?? false);
    }
    contribs.push({ layerId: live[i]!.id, cpId: cpIds[i]!, anchorId: cp.anchorId, flat: { files: new Map(norm.merged.files), symlinks: new Map(norm.merged.symlinks) }, exec });
  }
  const order = orderSources(contribs.map((c) => ({ layerId: c.layerId, anchorId: c.anchorId, cpId: c.cpId })));
  let acc = { files: new Map(curFlat.files), symlinks: new Map(curFlat.symlinks) };
  const toContribView = (c: { flat: { files: Map<string, string>; symlinks: Map<string, string> }; exec: Map<string, boolean> }): { files: Map<string, { blob: string; executable: boolean }>; symlinks: Map<string, string> } => ({
    files: new Map([...c.flat.files].map(([p, b]) => [p, { blob: b, executable: c.exec.get(p) ?? false }] as const)),
    symlinks: c.flat.symlinks
  });
  const accExec = new Map<string, boolean>([...curExec.files].map(([path, ref]) => [path, ref.executable] as const));
  for (const lid of order) {
    const c = contribs.find((x) => x.layerId === lid)!;
    const accView = { files: new Map([...acc.files].map(([p, b]) => [p, { blob: b, executable: accExec.get(p) ?? false }] as const)), symlinks: acc.symlinks };
    const v = structuralCompatible(curView, accView, toContribView(c));
    if (!v.ok) {
      throw fail(CODES.conflict, "stack conflicts", { operationId: opId, paths: v.conflicts.map((x) => x.path), hint: "resolve in source layers and retry" });
    }
    for (const [path, blob] of v.merged.files) {
      const before = acc.files.get(path) ?? null;
      if (blob !== before) accExec.set(path, c.exec.get(path) ?? accExec.get(path) ?? false);
    }
    for (const path of [...acc.files.keys()]) {
      if (!v.merged.files.has(path)) accExec.delete(path);
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
  const flat = { files: new Map([...acc.files].map(([path, blobId]) => [path, { blobId, executable: accExec.get(path) ?? false }] as const)), symlinks: acc.symlinks };
  const hydrated = await hydrate(repo.store, flat);
  const files = new Map<string, { bytes: Uint8Array; executable: boolean }>(hydrated);
  const stager = new TreeStager();
  const built = buildTreeFromFiles(files, acc.symlinks, stager);
  await stager.flush(repo.store);
  const builtRoot = built.rootId;
  const destId = newId16();
  const contextIds = await collectLayerContexts(repo, live.map((s) => s.id));
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
      rootId: builtRoot,
      order,
      contextIds,
      operationId: opId
    })
  );
  const destCp = encodeCheckpointObj({ layerId: destId, originKind: 1, originId: cur, anchorId: cur, rootId: builtRoot, prevId: null, recordId: stackId, contextIds });
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
  const ok = await casRefs(repo.metaDir, snapshot, next);
  if (!ok) throw fail(CODES.busy, "concurrent stack; retry", { operationId: opId, retryable: true });
  await updateJournal(repo.metaDir, opId, { state: "finalized", payload: { dest: destId, order, sources: live.map((s) => s.id), into: name ?? null } });
  await materializeFromRoot(repo, ws, builtRoot, destId);
  return { destId, workspace: ws, operationId: opId, order };
}

function orderSources(sources: ReadonlyArray<{ layerId: string; anchorId: string; cpId: string }>): ReadonlyArray<string> {
  return [...sources].sort((a, b) => (a.layerId < b.layerId ? -1 : a.layerId > b.layerId ? 1 : 0)).map((s) => s.layerId);
}
