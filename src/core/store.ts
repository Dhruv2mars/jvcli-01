import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeTop, encodeCbor, objectId, unwrapObject } from "./cbor.js";
import { CODES, fail } from "./types.js";

export class ObjectStore {
  constructor(readonly dir: string) {}

  pathFor(id: string): string {
    return join(this.dir, id.slice(0, 2), id.slice(2));
  }

  async has(id: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(id));
      return true;
    } catch {
      return false;
    }
  }

  async read(id: string): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.pathFor(id));
    } catch {
      throw fail(CODES.corruptObject, `missing object ${id}`, { hint: "run jvcli verify" });
    }
    const computed = objectId(bytes);
    if (computed !== id.toLowerCase()) throw fail(CODES.corruptObject, `object hash mismatch ${id}`);
    return bytes;
  }

  async readChecked(id: string, expectedType?: number): Promise<Uint8Array> {
    const bytes = await this.read(id);
    if (expectedType !== undefined) {
      const { type } = unwrapObject(bytes);
      if (type !== expectedType) throw fail(CODES.corruptObject, `object ${id} is not type ${expectedType}`);
    }
    return bytes;
  }

  async put(bytes: Uint8Array): Promise<string> {
    const id = objectId(bytes);
    const final = this.pathFor(id);
    try {
      await readFile(final);
      const existing = await readFile(final);
      if (Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) !== 0) {
        throw fail(CODES.corruptObject, `object collision ${id}`);
      }
      return id;
    } catch (e) {
      if (e instanceof Error && (e as { code?: string }).code !== "ENOENT" && !(e instanceof Object.getPrototypeOf(fail("x", "y")).constructor)) {
        // fallthrough check below handles JvError; ENOENT means write it
      }
      if (e !== undefined && typeof e === "object" && "code" in (e as object)) {
        const c = (e as { code?: string }).code;
        if (c !== undefined && c !== "ENOENT" && c.startsWith("E_")) throw e;
      }
    }
    const tmp = join(this.dir, "..", "tmp", `obj-${id}-${process.pid}-${Date.now()}`);
    await mkdir(dirname(tmp), { recursive: true });
    await mkdir(dirname(final), { recursive: true });
    await writeFile(tmp, bytes);
    const fh = await import("node:fs/promises").then((m) => m.open(tmp, "r"));
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, final);
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") throw e;
      try {
        const existing = await readFile(final);
        if (Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) !== 0) {
          throw fail(CODES.corruptObject, `object collision ${id}`);
        }
        await rm(tmp, { force: true });
        return id;
      } catch {
        throw e;
      }
    }
    return id;
  }

  async verifyOne(id: string): Promise<void> {
    await this.read(id);
    decodeTop(await this.read(id));
  }
}

export { decodeTop, encodeCbor };
