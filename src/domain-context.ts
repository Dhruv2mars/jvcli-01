import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeContextManifest, decodeContextObject, encodeContextManifest, encodeContextObject } from "./core/objects.js";
import { encodeBlob, objectId } from "./core/cbor.js";
import { newId16 } from "./core/ids.js";
import { appendJournal, loadRefs, saveRefs, updateJournal } from "./core/refs.js";
import { CODES, fail } from "./core/types.js";
import { checkpointLayer } from "./domain-layers.js";
import { openRepo, type Repo } from "./core/repo.js";

export type Completeness = 0 | 1 | 2 | 3;

export interface SessionStart {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly format: string;
}

export async function sessionStart(repo: Repo, layerId: string, opts: { sessionId: string | undefined; parent: string | undefined; format: string | undefined; agent: string | undefined }): Promise<{ manifest: string; sessionId: string }> {
  const refs = await loadRefs(repo.metaDir);
  const ref = refs.layers[layerId];
  if (ref === undefined) throw fail(CODES.layerNotFound, "no such layer", { layerId });
  if (ref.state !== "active") throw fail(CODES.layerState, `layer is ${ref.state}`, { layerId });
  const sessionId = (opts.sessionId ?? newId16()).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(sessionId)) throw fail(CODES.invalidPath, `bad session id`);
  if (ref.agent !== null && opts.agent !== undefined && ref.agent !== opts.agent) {
    throw fail(CODES.agentClaimed, "layer already claimed by another agent", { layerId, hint: "create another layer" });
  }
  const format = opts.format ?? "jvcli.text.v1";
  const manifestBytes = encodeContextManifest({
    repoId: repo.repoId,
    layerId,
    sessionId,
    parentSessionId: opts.parent ?? null,
    objectIds: [],
    completeness: 0,
    gaps: []
  });
  const manifestId = await repo.store.put(manifestBytes);
  const next = structuredClone(refs);
  const live = next.layers[layerId]!;
  next.layers[layerId] = {
    ...live,
    agent: live.agent ?? opts.agent ?? sessionId,
    sessions: { ...live.sessions, [sessionId]: manifestId }
  };
  await saveRefs(repo.metaDir, next);
  return { manifest: manifestId, sessionId };
}

export async function sessionAppend(
  repo: Repo,
  layerId: string,
  sessionId: string,
  records: ReadonlyArray<{ kind: string; bytes: Uint8Array; ordinal?: number; format?: string }>
): Promise<{ manifest: string; objects: ReadonlyArray<string> }> {
  const refs = await loadRefs(repo.metaDir);
  const ref = refs.layers[layerId];
  if (ref === undefined) throw fail(CODES.layerNotFound, "no such layer", { layerId });
  const sid = sessionId.toLowerCase();
  const currentManifestId = ref.sessions[sid];
  if (currentManifestId === undefined) throw fail(CODES.invalidPath, `unknown session ${sessionId}`, { layerId });
  const cur = decodeContextManifest(await repo.store.readChecked(currentManifestId, 6));
  let nextOrdinal = cur.objectIds.length;
  try {
    const seen = new Set<number>();
    for (const oid of cur.objectIds) {
      const ob = decodeContextObject(await repo.store.readChecked(oid, 5));
      seen.add(ob.ordinal);
    }
    while (seen.has(nextOrdinal)) nextOrdinal++;
  } catch {
    // keep going
  }
  const objectIds: Array<string> = [];
  let ord = nextOrdinal;
  for (const r of records) {
    const ordinal = r.ordinal ?? ord++;
    const bytes = encodeContextObject({ format: r.format ?? "jvcli.text.v1", kind: r.kind, ordinal, bytes: r.bytes });
    const id = await repo.store.put(bytes);
    objectIds.push(id);
  }
  const gaps = findGaps([...cur.objectIds, ...objectIds], repo);
  void gaps;
  const manifestBytes = encodeContextManifest({
    repoId: cur.repoId,
    layerId,
    sessionId: sid,
    parentSessionId: cur.parentSessionId,
    objectIds: [...cur.objectIds, ...objectIds],
    completeness: cur.completeness as Completeness,
    gaps: cur.gaps
  });
  const manifestId = await repo.store.put(manifestBytes);
  const next = structuredClone(refs);
  next.layers[layerId] = { ...ref, sessions: { ...ref.sessions, [sid]: manifestId } };
  await saveRefs(repo.metaDir, next);
  return { manifest: manifestId, objects: objectIds };
}

async function findGaps(_ids: ReadonlyArray<string>, _repo: Repo): Promise<ReadonlyArray<{ first: number; last: number }>> {
  return [];
}

export async function sessionEnd(repo: Repo, layerId: string, sessionId: string, status: "complete" | "interrupted" = "complete"): Promise<string> {
  const refs = await loadRefs(repo.metaDir);
  const ref = refs.layers[layerId];
  if (ref === undefined) throw fail(CODES.layerNotFound, "no such layer", { layerId });
  const sid = sessionId.toLowerCase();
  const curId = ref.sessions[sid];
  if (curId === undefined) throw fail(CODES.invalidPath, `unknown session`, { layerId });
  const cur = decodeContextManifest(await repo.store.readChecked(curId, 6));
  const next = encodeContextManifest({
    repoId: cur.repoId,
    layerId,
    sessionId: sid,
    parentSessionId: cur.parentSessionId,
    objectIds: cur.objectIds,
    completeness: status === "complete" ? 1 : 2,
    gaps: cur.gaps
  });
  const nid = await repo.store.put(next);
  const refs2 = structuredClone(refs);
  refs2.layers[layerId] = { ...ref, sessions: { ...ref.sessions, [sid]: nid } };
  await saveRefs(repo.metaDir, refs2);
  await checkpointLayer(repo, layerId, null, [nid]);
  return nid;
}

export async function layerContextStatus(repo: Repo, layerId: string): Promise<{
  sessions: ReadonlyArray<{ session: string; manifest: string; completeness: number; objects: number; bytes: number }>;
  missing: boolean;
}> {
  const refs = await loadRefs(repo.metaDir);
  const ref = refs.layers[layerId];
  if (ref === undefined) throw fail(CODES.layerNotFound, "no such layer", { layerId });
  const sessions: Array<{ session: string; manifest: string; completeness: number; objects: number; bytes: number }> = [];
  let missing = false;
  for (const [sid, mid] of Object.entries(ref.sessions)) {
    const m = decodeContextManifest(await repo.store.readChecked(mid, 6));
    let bytes = 0;
    for (const oid of m.objectIds) {
      const ob = decodeContextObject(await repo.store.readChecked(oid, 5));
      bytes += ob.bytes.byteLength;
    }
    sessions.push({ session: sid, manifest: mid, completeness: m.completeness, objects: m.objectIds.length, bytes });
    if (m.completeness !== 1) missing = true;
  }
  if (ref.agent !== null && sessions.length === 0) missing = true;
  return { sessions, missing };
}

export async function collectLayerContexts(repo: Repo, layerIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
  const refs = await loadRefs(repo.metaDir);
  const out = new Set<string>();
  for (const lid of layerIds) {
    const ref = refs.layers[lid];
    if (ref === undefined) continue;
    for (const mid of Object.values(ref.sessions)) out.add(mid);
  }
  return [...out].sort();
}

export { openRepo };
