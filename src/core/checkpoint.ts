import { appendJournal, listJournals, updateJournal } from "./refs.js";
import { CODES, fail } from "./types.js";
import type { Repo } from "./repo.js";

export interface CheckpointRequest {
  readonly layerId: string;
  readonly recordId: string | null;
  readonly contextIds: ReadonlyArray<string>;
}

export interface CheckpointOutcome {
  readonly checkpoint: string;
  readonly created: boolean;
}

export interface CheckpointEngine {
  request(req: CheckpointRequest): void;
  drain(repo: Repo): Promise<ReadonlyArray<CheckpointOutcome>>;
  readonly pending: number;
}

interface PendingEntry {
  req: CheckpointRequest;
  key: string;
}

const coalesceKey = (req: CheckpointRequest): string =>
  `${req.layerId}\0${req.recordId ?? ""}\0${[...req.contextIds].sort().join(",")}`;

export function createCheckpointEngine(): CheckpointEngine {
  const queue = new Map<string, PendingEntry>();
  const MAX_PENDING = 1024;
  return {
    request(req: CheckpointRequest): void {
      const key = coalesceKey(req);
      const hit = queue.get(key);
      if (hit !== undefined) {
        const merged = [...new Set([...queue.get(key)!.req.contextIds, ...req.contextIds])].sort();
        queue.set(key, { req: { ...hit.req, contextIds: merged }, key });
        return;
      }
      if (queue.size >= MAX_PENDING) {
        const oldest = queue.keys().next().value as string;
        queue.delete(oldest);
      }
      queue.set(key, { req, key });
    },
    async drain(repo: Repo): Promise<ReadonlyArray<CheckpointOutcome>> {
      const batch = [...queue.values()];
      queue.clear();
      const out: Array<CheckpointOutcome> = [];
      for (const { req } of batch) {
        const opId = `ckpt-${req.layerId.slice(0, 8)}-${Date.now().toString(36)}`;
        await appendJournal(repo.metaDir, {
          op: opId,
          kind: "checkpoint",
          state: "prepared",
          layerId: req.layerId,
          operationId: opId,
          payload: { recordId: req.recordId, contextIds: req.contextIds },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        try {
          const { checkpointLayer } = await import("../domain-layers.js");
          const before = await currentCheckpoint(repo, req.layerId);
          const cp = await checkpointLayer(repo, req.layerId, req.recordId, req.contextIds);
          await updateJournal(repo.metaDir, opId, { state: "finalized", payload: { checkpoint: cp } });
          out.push({ checkpoint: cp, created: cp !== before });
        } catch (e) {
          if ((e as { code?: string }).code === "ENOENT") throw e;
          await updateJournal(repo.metaDir, opId, {
            state: "conflict",
            payload: { error: e instanceof Error ? e.message : String(e) }
          }).catch(() => {});
          throw e;
        }
      }
      return out;
    },
    get pending(): number {
      return queue.size;
    }
  };
}

async function currentCheckpoint(repo: Repo, layerId: string): Promise<string> {
  const { loadRefs } = await import("./refs.js");
  const refs = await loadRefs(repo.metaDir);
  const ref = refs.layers[layerId];
  if (ref === undefined) throw fail(CODES.layerNotFound, "no such layer", { layerId });
  return ref.checkpoint;
}

export async function liveCheckpointOps(repo: Repo): Promise<number> {
  let n = 0;
  for (const e of await listJournals(repo.metaDir)) {
    if (e.kind === "checkpoint" && e.state !== "finalized" && e.state !== "conflict") n++;
  }
  return n;
}
