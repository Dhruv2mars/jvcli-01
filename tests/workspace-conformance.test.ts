import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashTree } from "../src/core/tree-stage.ts";
import type { FileView, LayerId, ObjectId } from "../src/core/types.ts";
import type { FlushOut, View, WorkspaceBackend } from "../src/core/workspace/backend.ts";
import { FsBackend } from "../src/core/workspace/fs.ts";
import { MemoryBackend } from "../src/core/workspace/memory.ts";

const LAYER = "11".repeat(16) as LayerId;
const ROOT = "aa".repeat(32) as ObjectId;
const enc = new TextEncoder();

const fv = (s: string, executable = false): FileView => ({ bytes: enc.encode(s), executable });

function base(): View {
  return {
    files: new Map<string, FileView>([
      ["a.txt", fv("A")],
      ["deep/nested/b.bin", fv("B", true)],
    ]),
    symlinks: new Map<string, string>([
      ["link.txt", "a.txt"],
      ["deep/uplink", "a.txt"],
    ]),
  };
}

const sortedPaths = (v: View): readonly string[] => [...new Set([...v.files.keys(), ...v.symlinks.keys()])].sort();

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

async function assertMatches(be: WorkspaceBackend, want: View): Promise<void> {
  expect(await be.enumerateView(LAYER)).toEqual(sortedPaths(want));
  for (const [p, wv] of want.files) {
    const gv = await be.readView(LAYER, p);
    expect(gv).not.toBeNull();
    expect(bytesEqual(gv!.bytes, wv.bytes)).toBe(true);
    expect(gv!.executable).toBe(wv.executable);
  }
  for (const p of want.symlinks.keys()) {
    expect(await be.readView(LAYER, p)).toBeNull();
  }
}

function runConformance(make: () => WorkspaceBackend): void {
  test("round-trips empty, nested, exec-bit and symlink views", async () => {
    const be = make();
    await be.createWorkspace(LAYER, ROOT, base());
    const flush = await be.flushWorkspace(LAYER);
    expect(flush.dirty).toBe(false);
    expect(hashTree(flush.files, flush.symlinks)).toBe(hashTree(base().files, base().symlinks));
    await assertMatches(be, base());
  });

  test("coalesces N writes into one flush", async () => {
    const be = make();
    await be.createWorkspace(LAYER, ROOT, {
      files: new Map<string, FileView>([["a.txt", fv("A")]]),
      symlinks: new Map<string, string>(),
    });
    await be.recordWrite(LAYER, "b.txt", fv("B"));
    await be.recordWrite(LAYER, "c.txt", fv("C", true));
    await be.recordWrite(LAYER, "a.txt", fv("A2"));
    const flush = await be.flushWorkspace(LAYER);
    expect(flush.dirty).toBe(true);
    await assertMatches(be, {
      files: new Map<string, FileView>([
        ["a.txt", fv("A2")],
        ["b.txt", fv("B")],
        ["c.txt", fv("C", true)],
      ]),
      symlinks: new Map<string, string>(),
    });
    const again = await be.flushWorkspace(LAYER);
    expect(again.dirty).toBe(false);
  });

  test("writes, deletes and renames land after flush", async () => {
    const be = make();
    await be.createWorkspace(LAYER, ROOT, base());
    await be.recordWrite(LAYER, "new.txt", fv("N"));
    await be.recordDelete(LAYER, "a.txt");
    await be.recordRename(LAYER, "link.txt", "renamed-link.txt");
    await be.recordRename(LAYER, "deep/nested/b.bin", "deep/b.bin");
    const flush = await be.flushWorkspace(LAYER);
    expect(flush.dirty).toBe(true);
    const want: View = {
      files: new Map<string, FileView>([
        ["deep/b.bin", fv("B", true)],
        ["new.txt", fv("N")],
      ]),
      symlinks: new Map<string, string>([
        ["deep/uplink", "a.txt"],
        ["renamed-link.txt", "a.txt"],
      ]),
    };
    expect(hashTree(flush.files, flush.symlinks)).toBe(hashTree(want.files, want.symlinks));
    await assertMatches(be, want);
  });

  test("targeted re-read touches only the listed paths", async () => {
    const be = make();
    await be.createWorkspace(LAYER, ROOT, {
      files: new Map<string, FileView>([
        ["a.txt", fv("A")],
        ["b.txt", fv("B")],
        ["c.txt", fv("C")],
      ]),
      symlinks: new Map<string, string>(),
    });
    await be.flushWorkspace(LAYER);
    await be.recordWrite(LAYER, "a.txt", fv("A2"));
    await be.recordDelete(LAYER, "b.txt");
    const flush = await be.flushWorkspace(LAYER);
    expect(flush.dirty).toBe(true);
    await assertMatches(be, {
      files: new Map<string, FileView>([
        ["a.txt", fv("A2")],
        ["c.txt", fv("C")],
      ]),
      symlinks: new Map<string, string>(),
    });
  });

  test("destroys and recovers from checkpoint root", async () => {
    const be = make();
    await be.createWorkspace(LAYER, ROOT, base());
    await be.recordWrite(LAYER, "extra.txt", fv("E"));
    const flushed = await be.flushWorkspace(LAYER);
    await be.destroyWorkspace(LAYER);
    expect(await be.enumerateView(LAYER)).toEqual([]);
    expect(await be.readView(LAYER, "a.txt")).toBeNull();
    await be.recoverWorkspace(LAYER, ROOT, { files: flushed.files, symlinks: flushed.symlinks });
    await assertMatches(be, { files: new Map(flushed.files), symlinks: new Map(flushed.symlinks) });
    const after = await be.flushWorkspace(LAYER);
    expect(hashTree(after.files, after.symlinks)).toBe(hashTree(flushed.files, flushed.symlinks));
  });
}

describe("workspace conformance: fs", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jv-ws-fs-"));
  });
  afterAll(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
  });
  runConformance(() => new FsBackend((layer) => join(dir, `ws-${layer}`)));

  test("external disk mutation between flushes is picked up", async () => {
    const be = new FsBackend((layer) => join(dir, `ext-${layer}`));
    await be.createWorkspace(LAYER, ROOT, {
      files: new Map<string, FileView>([["watched.txt", fv("v1")]]),
      symlinks: new Map<string, string>(),
    });
    expect((await be.flushWorkspace(LAYER)).dirty).toBe(false);
    const ws = join(dir, `ext-${LAYER}`);
    await writeFile(join(ws, "watched.txt"), enc.encode("v2-longer"));
    await writeFile(join(ws, "added.txt"), enc.encode("new"));
    const second = await be.flushWorkspace(LAYER);
    expect(second.dirty).toBe(true);
    const rv = await be.readView(LAYER, "watched.txt");
    expect(rv).not.toBeNull();
    expect(bytesEqual(rv!.bytes, enc.encode("v2-longer"))).toBe(true);
    expect(await be.enumerateView(LAYER)).toEqual(["added.txt", "watched.txt"]);
  });
});

describe("workspace conformance: memory", () => {
  runConformance(() => new MemoryBackend());
});

describe("workspace conformance: cross-backend", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jv-ws-x-"));
  });
  afterAll(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
  });

  async function sharedScenario(
    make: () => WorkspaceBackend
  ): Promise<{ flush: FlushOut; paths: readonly string[]; reads: Map<string, FileView | null> }> {
    const be = make();
    await be.createWorkspace(LAYER, ROOT, base());
    await be.recordWrite(LAYER, "delta/x.txt", fv("X"));
    await be.recordWrite(LAYER, "a.txt", fv("A2"));
    await be.recordDelete(LAYER, "deep/uplink");
    await be.recordRename(LAYER, "link.txt", "moved-link.txt");
    const flush = await be.flushWorkspace(LAYER);
    const paths = await be.enumerateView(LAYER);
    const reads = new Map<string, FileView | null>();
    for (const p of paths) reads.set(p, await be.readView(LAYER, p));
    return { flush, paths, reads };
  }

  test("fs and memory agree on hashTree, enumerate sets and byte-equal readView", async () => {
    const [fsRes, memRes] = await Promise.all([
      sharedScenario(() => new FsBackend((layer) => join(dir, `ws-${layer}`))),
      sharedScenario(() => new MemoryBackend()),
    ]);
    expect(hashTree(fsRes.flush.files, fsRes.flush.symlinks)).toBe(hashTree(memRes.flush.files, memRes.flush.symlinks));
    expect([...fsRes.paths]).toEqual([...memRes.paths]);
    expect([...fsRes.reads.keys()]).toEqual([...memRes.reads.keys()]);
    for (const [p, rv] of fsRes.reads) {
      const mv = memRes.reads.get(p) ?? null;
      expect(rv === null).toBe(mv === null);
      if (rv !== null && mv !== null) {
        expect(bytesEqual(rv.bytes, mv.bytes)).toBe(true);
        expect(rv.executable).toBe(mv.executable);
      }
    }
  });
});
