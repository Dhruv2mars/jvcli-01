import { createCheckpointEngine } from "./core/checkpoint.js";
import { CODES, fail } from "./core/types.js";
import type { Repo } from "./core/repo.js";
import { layerStatus, listLayers } from "./domain-layers.js";

export const WATCH_DEFAULT_INTERVAL_MS = 2000;
export const WATCH_MIN_INTERVAL_MS = 250;
export const WATCH_MAX_INTERVAL_MS = 60000;

export function parseWatchInterval(raw: string | null): number {
  if (raw === null) return WATCH_DEFAULT_INTERVAL_MS;
  if (raw === "") throw fail(CODES.invalidPath, "watch --interval needs a value");
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < WATCH_MIN_INTERVAL_MS || n > WATCH_MAX_INTERVAL_MS) {
    throw fail(CODES.invalidPath, `invalid --interval ${raw}: expected integer ${WATCH_MIN_INTERVAL_MS}..${WATCH_MAX_INTERVAL_MS} ms`);
  }
  return n;
}

export interface CheckpointSingleResult {
  readonly layerId: string;
  readonly checkpoint: string;
  readonly created: boolean;
}

export interface CheckpointBatchItem {
  readonly layer: string;
  readonly checkpoint: string;
  readonly created: boolean;
}

export async function checkpointSingleLayer(repo: Repo, selector: string): Promise<CheckpointSingleResult> {
  const st = await layerStatus(repo, selector);
  if (!st.dirty && !st.pendingCheckpoint) {
    return { layerId: st.id, checkpoint: st.checkpoint, created: false };
  }
  const engine = createCheckpointEngine();
  engine.request({ layerId: st.id, recordId: null, contextIds: [] });
  const outcomes = await engine.drain(repo);
  const first = outcomes[0];
  if (first === undefined) {
    const again = await layerStatus(repo, st.id).catch(() => st);
    return { layerId: st.id, checkpoint: again.checkpoint, created: false };
  }
  return { layerId: st.id, checkpoint: first.checkpoint, created: first.created };
}

export async function checkpointAllLayers(repo: Repo): Promise<ReadonlyArray<CheckpointBatchItem>> {
  const layers = await listLayers(repo);
  const active = layers.filter((l) => l.state === "active");
  const dirty = active.filter((l) => l.dirty || l.pendingCheckpoint);
  if (dirty.length === 0) {
    return active
      .map((l): CheckpointBatchItem => ({ layer: l.id, checkpoint: l.checkpoint, created: false }))
      .sort((a, b) => (a.layer < b.layer ? -1 : a.layer > b.layer ? 1 : 0));
  }
  const engine = createCheckpointEngine();
  for (const l of dirty) {
    engine.request({ layerId: l.id, recordId: null, contextIds: [] });
  }
  const outcomes = await engine.drain(repo);
  const out: Array<CheckpointBatchItem> = [];
  for (let i = 0; i < dirty.length; i++) {
    const id = dirty[i]!.id;
    const oc = outcomes[i];
    if (oc === undefined) {
      out.push({ layer: id, checkpoint: dirty[i]!.checkpoint, created: false });
    } else {
      out.push({ layer: id, checkpoint: oc.checkpoint, created: oc.created });
    }
  }
  for (const l of active) {
    if (dirty.some((d) => d.id === l.id)) continue;
    out.push({ layer: l.id, checkpoint: l.checkpoint, created: false });
  }
  out.sort((a, b) => (a.layer < b.layer ? -1 : a.layer > b.layer ? 1 : 0));
  return out;
}

export interface WatchCycle {
  readonly checked: number;
  readonly dirty: number;
  readonly checkpointed: number;
  readonly checkpoints: ReadonlyArray<CheckpointBatchItem>;
}

export async function runWatchCycle(repo: Repo, selector: string | null): Promise<WatchCycle> {
  if (selector !== null) {
    const st = await layerStatus(repo, selector);
    if (st.state !== "active") {
      return { checked: 1, dirty: 0, checkpointed: 0, checkpoints: [] };
    }
    if (!st.dirty && !st.pendingCheckpoint) {
      return { checked: 1, dirty: 0, checkpointed: 0, checkpoints: [] };
    }
    const engine = createCheckpointEngine();
    engine.request({ layerId: st.id, recordId: null, contextIds: [] });
    const outcomes = await engine.drain(repo);
    const items: Array<CheckpointBatchItem> = [];
    for (const oc of outcomes) {
      items.push({ layer: st.id, checkpoint: oc.checkpoint, created: oc.created });
    }
    const checkpointed = items.filter((c) => c.created).length;
    return { checked: 1, dirty: 1, checkpointed, checkpoints: items };
  }
  const layers = await listLayers(repo);
  const active = layers.filter((l) => l.state === "active");
  const dirty = active.filter((l) => l.dirty || l.pendingCheckpoint);
  if (dirty.length === 0) {
    return { checked: active.length, dirty: 0, checkpointed: 0, checkpoints: [] };
  }
  const engine = createCheckpointEngine();
  for (const l of dirty) {
    engine.request({ layerId: l.id, recordId: null, contextIds: [] });
  }
  const outcomes = await engine.drain(repo);
  const items: Array<CheckpointBatchItem> = [];
  for (let i = 0; i < dirty.length; i++) {
    const oc = outcomes[i];
    if (oc === undefined) continue;
    items.push({ layer: dirty[i]!.id, checkpoint: oc.checkpoint, created: oc.created });
  }
  items.sort((a, b) => (a.layer < b.layer ? -1 : a.layer > b.layer ? 1 : 0));
  const checkpointed = items.filter((c) => c.created).length;
  return { checked: active.length, dirty: dirty.length, checkpointed, checkpoints: items };
}
