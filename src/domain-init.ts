import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { encodeBlob, encodeTree, objectId } from "./core/cbor.js";
import { buildTreeFromFiles } from "./core/objects.js";
import { JV_DIR, REPO_FILE, STORE_DIR } from "./core/paths.js";
import { emptyRefs, saveRefs, type Refs } from "./core/refs.js";
import { writeJsonAtomic } from "./core/refs.js";
import { ObjectStore } from "./core/store.js";
import { encodeWorldVersion } from "./core/objects.js";
import { CODES, fail } from "./core/types.js";
import { newId16 } from "./core/ids.js";
import { scanDirectory } from "./core/scan.js";

export interface InitResult {
  readonly root: string;
  readonly repoId: string;
  readonly worldId: string;
  readonly warnings: ReadonlyArray<string>;
  readonly files: number;
}

export async function initRepository(target: string): Promise<InitResult> {
  const root = resolve(target);
  try {
    const st = await stat(root);
    if (!st.isDirectory()) throw fail(CODES.io, `not a directory: ${root}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(root, { recursive: true });
    } else if (typeof e === "object" && e !== null && "_tag" in e) {
      throw e;
    } else if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
  const metaDir = join(root, JV_DIR);
  try {
    await readFile(join(metaDir, REPO_FILE), "utf8");
    throw fail(CODES.io, `already a jvcli repository: ${root}`, { hint: "run jvcli status" });
  } catch (e) {
    if (typeof e === "object" && e !== null && "_tag" in e) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const repoId = newId16();
  const store = new ObjectStore(join(metaDir, STORE_DIR));
  await mkdir(join(metaDir, STORE_DIR), { recursive: true });
  await mkdir(join(metaDir, "layers"), { recursive: true });
  await mkdir(join(metaDir, "journal"), { recursive: true });
  await mkdir(join(metaDir, "tmp"), { recursive: true });
  const scan = await scanDirectory(root);
  const pending = new Map<string, Uint8Array>();
  const putBlob = (content: Uint8Array): string => {
    const bytes = encodeBlob(content);
    pending.set(objectId(bytes), bytes);
    return objectId(bytes);
  };
  const putTree = (entries: ReadonlyArray<{ name: string; kind: "file" | "dir" | "symlink"; target: string; executable: boolean }>): string => {
    const bytes = encodeTree(entries);
    pending.set(objectId(bytes), bytes);
    return objectId(bytes);
  };
  const { rootId } = buildTreeFromFiles(scan.files, scan.symlinks, { putBlob, putTree });
  for (const bytes of pending.values()) await store.put(bytes);
  const worldBytes = encodeWorldVersion({ repoId, seq: 1, rootId, prevId: null, publicationId: null, contextIds: [] });
  const worldId = await store.put(worldBytes);
  const refs: Refs = { ...emptyRefs(), currentWorld: worldId, worldsBySeq: { "1": worldId } };
  await writeJsonAtomic(join(metaDir, REPO_FILE), { repoId, formatVersion: 1, createdAt: new Date().toISOString() });
  await saveRefs(metaDir, refs);
  return { root, repoId, worldId, warnings: scan.warnings, files: scan.files.size + scan.symlinks.size };
}
