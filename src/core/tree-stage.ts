import { decodeTree, encodeBlob, encodeTree, objectId, unwrapObject } from "./cbor.js";
import { buildTreeFromFiles, type TreeBuilder } from "./objects.js";
import { CODES, fail, type Files, type Symlinks, type TreeEntryInput } from "./types.js";
import type { ObjectStore } from "./store.js";

export interface FileRef {
  readonly blobId: string;
  readonly executable: boolean;
}

export interface FlatTree {
  readonly files: ReadonlyMap<string, FileRef>;
  readonly symlinks: ReadonlyMap<string, string>;
}

export class TreeStager implements TreeBuilder {
  private readonly pending = new Map<string, Uint8Array>();

  putBlob(content: Uint8Array): string {
    const bytes = encodeBlob(content);
    const id = objectId(bytes);
    this.pending.set(id, bytes);
    return id;
  }

  putTree(entries: ReadonlyArray<TreeEntryInput>): string {
    const bytes = encodeTree(entries);
    const id = objectId(bytes);
    this.pending.set(id, bytes);
    return id;
  }

  async flush(store: ObjectStore): Promise<void> {
    for (const bytes of this.pending.values()) await store.put(bytes);
    this.pending.clear();
  }
}

export function hashTree(files: Files, symlinks: Symlinks): string {
  const stager = new TreeStager();
  return buildTreeFromFiles(files, symlinks, stager).rootId;
}

export async function stageFiles(store: ObjectStore, files: Files, symlinks: Symlinks): Promise<string> {
  const stager = new TreeStager();
  const { rootId } = buildTreeFromFiles(files, symlinks, stager);
  await stager.flush(store);
  return rootId;
}

export async function readFlat(store: ObjectStore, rootId: string): Promise<FlatTree> {
  const files = new Map<string, FileRef>();
  const symlinks = new Map<string, string>();
  const visit = async (id: string, prefix: string, stack: ReadonlyArray<string>): Promise<void> => {
    if (stack.includes(id)) throw fail(CODES.corruptObject, "tree cycle");
    const bytes = await store.readChecked(id, 2);
    const entries = decodeTree(bytes);
    for (const e of entries) {
      const path = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.kind === "file") files.set(path, { blobId: e.target, executable: e.executable });
      else if (e.kind === "symlink") symlinks.set(path, e.target);
      else await visit(e.target, path, [...stack, id]);
    }
  };
  await visit(rootId, "", []);
  return { files, symlinks };
}

export async function hydrate(store: ObjectStore, flat: FlatTree): Promise<Files> {
  const out = new Map<string, { bytes: Uint8Array; executable: boolean }>();
  for (const [path, ref] of flat.files) {
    const raw = await store.readChecked(ref.blobId, 1);
    const { payload } = unwrapObject(raw);
    if (payload.tag !== "bytes") throw fail(CODES.corruptObject, "bad blob");
    out.set(path, { bytes: payload.value, executable: ref.executable });
  }
  return out;
}

export function flatBlobIds(flat: FlatTree): { files: Map<string, string>; symlinks: Map<string, string> } {
  return {
    files: new Map([...flat.files].map(([path, ref]) => [path, ref.blobId] as const)),
    symlinks: new Map(flat.symlinks)
  };
}
