import { describe, test, expect } from "bun:test";
import { decodeTree, encodeBlob, encodeTree, objectId } from "../src/core/cbor.ts";
import {
  buildTreeFromFiles,
  decodeCheckpoint,
  decodeContextManifest,
  decodeContextObject,
  decodePublication,
  decodeRefresh,
  decodeStack,
  decodeWorldVersion,
  diffTrees,
  encodeCheckpoint,
  encodeContextManifest,
  encodeContextObject,
  encodePublication,
  encodeRefresh,
  encodeStack,
  encodeWorldVersion,
  flattenTree,
  structuralCompatible,
  type TreeBuilder,
} from "../src/core/objects.ts";

const REPO = "00".repeat(16);
const LAYER = "11".repeat(16);
const SESSION = "22".repeat(16);
const OP = "33".repeat(16);
const A = "aa".repeat(32);
const B = "bb".repeat(32);
const C = "cc".repeat(32);
const D = "dd".repeat(32);

const enc = new TextEncoder();
const file = (s: string, executable = false) => ({ bytes: enc.encode(s), executable });
type View = { files: Map<string, string>; symlinks: Map<string, string> };
const view = (files: Record<string, string> = {}, symlinks: Record<string, string> = {}): View => ({
  files: new Map(Object.entries(files)),
  symlinks: new Map(Object.entries(symlinks)),
});

function memBuilder(): TreeBuilder & { trees: Map<string, Uint8Array> } {
  const trees = new Map<string, Uint8Array>();
  return {
    trees,
    putBlob: (content: Uint8Array) => objectId(encodeBlob(content)),
    putTree: (entries) => {
      const bytes = encodeTree(entries);
      const id = objectId(bytes);
      trees.set(id, bytes);
      return id;
    },
  };
}

const getTree =
  (trees: Map<string, Uint8Array>) =>
  (id: string): ReadonlyArray<{ name: string; kind: "file" | "dir" | "symlink"; target: string }> =>
    decodeTree(trees.get(id) ?? (() => { throw new Error(`missing tree ${id}`); })()).map((e) => ({
      name: e.name,
      kind: e.kind,
      target: e.target,
    }));

describe("buildTreeFromFiles", () => {
  test("same files give the same root regardless of insertion order", () => {
    const left = memBuilder();
    const right = memBuilder();
    const mk = (order: string[]) => new Map(order.map((p) => [p, file(p)] as const));
    const r1 = buildTreeFromFiles(mk(["a.txt", "sub/b.txt", "c.txt"]), new Map(), left);
    const r2 = buildTreeFromFiles(mk(["c.txt", "a.txt", "sub/b.txt"]), new Map(), right);
    expect(r1.rootId).toBe(r2.rootId);
    expect(r1.blobIds).toHaveLength(3);
  });

  test("executable bit and symlinks change the root", () => {
    const plain = memBuilder();
    const exec = memBuilder();
    const link = memBuilder();
    const rPlain = buildTreeFromFiles(new Map([["a", file("x")]]), new Map(), plain);
    const rExec = buildTreeFromFiles(new Map([["a", file("x", true)]]), new Map(), exec);
    const rLink = buildTreeFromFiles(new Map(), new Map([["a", "target"]]), link);
    expect(rExec.rootId).not.toBe(rPlain.rootId);
    expect(rLink.rootId).not.toBe(rPlain.rootId);
  });

  test("a path cannot be both file and symlink", () => {
    const put = memBuilder();
    expect(() =>
      buildTreeFromFiles(new Map([["p", file("x")]]), new Map([["p", "t"]]), put),
    ).toThrow();
  });
});

describe("flattenTree", () => {
  test("flatten round-trips files, exec bits (via tree), symlinks and nesting", () => {
    const put = memBuilder();
    const files = new Map([
      ["a.txt", file("A")],
      ["sub/b.txt", file("B", true)],
    ]);
    const symlinks = new Map([["link", "a.txt"]]);
    const { rootId } = buildTreeFromFiles(files, symlinks, put);
    const flat = flattenTree(rootId, getTree(put.trees));
    expect([...flat.files.keys()].sort()).toEqual(["a.txt", "sub/b.txt"]);
    expect([...flat.symlinks.entries()]).toEqual([["link", "a.txt"]]);
    const again = buildTreeFromFiles(
      new Map([...flat.files.entries()].map(([p, id]) => [p, { bytes: enc.encode("blob?"), executable: false }] as const)),
      flat.symlinks,
      memBuilder(),
    );
    expect(again.rootId).toBeString();
    const treeMap = new Map<string, string>();
    for (const [p, id] of flat.files) treeMap.set(p, id);
    const rebuilt = buildTreeFromFiles(files, symlinks, memBuilder());
    expect(rebuilt.rootId).toBe(rootId);
    expect(treeMap.size).toBe(2);
  });

  test("empty tree flattens to empty views", () => {
    const put = memBuilder();
    const { rootId } = buildTreeFromFiles(new Map(), new Map(), put);
    const flat = flattenTree(rootId, getTree(put.trees));
    expect(flat.files.size).toBe(0);
    expect(flat.symlinks.size).toBe(0);
  });
});

describe("diffTrees", () => {
  test("add / modify / delete / unchanged", () => {
    const changes = diffTrees(view({ same: A, mod: B, del: C }), view({ same: A, mod: D, add: B }));
    expect(changes).toEqual([
      { path: "add", kind: "add", oldBlob: null, newBlob: B },
      { path: "del", kind: "delete", oldBlob: C, newBlob: null },
      { path: "mod", kind: "modify", oldBlob: B, newBlob: D },
    ]);
  });

  test("file<->symlink is a type-change", () => {
    expect(diffTrees(view({ p: A }), view({}, { p: "t" }))).toEqual([
      { path: "p", kind: "type-change", oldBlob: A, newBlob: null },
    ]);
    expect(diffTrees(view({}, { p: "t" }), view({ p: A }))).toEqual([
      { path: "p", kind: "type-change", oldBlob: null, newBlob: A },
    ]);
  });

  test("symlink retarget is a metadata-only modify", () => {
    expect(diffTrees(view({}, { p: "t1" }), view({}, { p: "t2" }))).toEqual([
      { path: "p", kind: "modify", oldBlob: null, newBlob: null },
    ]);
    expect(diffTrees(view({}, { p: "t" }), view({}, { p: "t" }))).toEqual([]);
  });

  test("identical views diff to empty", () => {
    expect(diffTrees(view({ a: A }), view({ a: A }))).toEqual([]);
  });
});

describe("structuralCompatible", () => {
  test("disjoint adds merge cleanly", () => {
    const r = structuralCompatible(view({ a: A }), view({ a: A, l: B }), view({ a: A, r: C }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.merged.files.entries()].sort()).toEqual([
        ["a", A],
        ["l", B],
        ["r", C],
      ]);
    }
  });

  test("same content on both sides merges cleanly", () => {
    const r = structuralCompatible(view({ a: A }), view({ a: B }), view({ a: B }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.merged.files.get("a")).toBe(B);
  });

  test("deleting on both sides merges cleanly", () => {
    expect(structuralCompatible(view({ a: A }), view(), view()).ok).toBe(true);
  });

  test("both-write to different blobs conflicts", () => {
    const r = structuralCompatible(view({ a: A }), view({ a: B }), view({ a: C }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts).toEqual([{ path: "a", kind: "both-write" }]);
  });

  test("delete-modify conflicts either way round", () => {
    const r1 = structuralCompatible(view({ a: A }), view(), view({ a: B }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.conflicts).toEqual([{ path: "a", kind: "delete-modify" }]);
    const r2 = structuralCompatible(view({ a: A }), view({ a: B }), view());
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.conflicts).toEqual([{ path: "a", kind: "delete-modify" }]);
  });

  test("file-vs-symlink at one path is a type-clash", () => {
    const r = structuralCompatible(view(), view({ p: A }), view({}, { p: "t" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts).toEqual([{ path: "p", kind: "type-clash" }]);
  });

  test("file under a path the other side also created is an ancestor clash", () => {
    const r = structuralCompatible(view(), view({ a: A }), view({ "a/b": B }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts.some((c) => c.kind === "ancestor-clash")).toBe(true);
  });
});

describe("object encode/decode round-trips", () => {
  test("world sorts context ids", () => {
    const bytes = encodeWorldVersion({ repoId: REPO, seq: 7, rootId: A, prevId: B, publicationId: null, contextIds: [D, C] });
    const back = decodeWorldVersion(bytes);
    expect(back).toEqual({ repoId: REPO, seq: 7, rootId: A, prevId: B, publicationId: null, contextIds: [C, D] });
    const minimal = encodeWorldVersion({ repoId: REPO, seq: 0, rootId: A, prevId: null, publicationId: null, contextIds: [] });
    expect(decodeWorldVersion(minimal).prevId).toBeNull();
  });

  test("checkpoint round-trips origin union", () => {
    for (const kind of [1, 2] as const) {
      const bytes = encodeCheckpoint({ layerId: LAYER, originKind: kind, originId: A, anchorId: B, rootId: C, prevId: D, recordId: null, contextIds: [A] });
      const back = decodeCheckpoint(bytes);
      expect(back.originKind).toBe(kind);
      expect(back.originId).toBe(A);
      expect(back.recordId).toBeNull();
    }
  });

  test("context object preserves raw bytes", () => {
    const raw = enc.encode("ctx-bytes");
    const back = decodeContextObject(encodeContextObject({ format: "md", kind: "note", ordinal: 3, bytes: raw }));
    expect(back.format).toBe("md");
    expect(back.kind).toBe("note");
    expect(back.ordinal).toBe(3);
    expect(Buffer.from(back.bytes).toString()).toBe("ctx-bytes");
  });

  test("context manifest preserves ids, completeness and gaps", () => {
    const input = {
      repoId: REPO,
      layerId: LAYER,
      sessionId: SESSION,
      parentSessionId: null as string | null,
      objectIds: [A, B],
      completeness: 2 as const,
      gaps: [
        { first: 0, last: 4 },
        { first: 10, last: 12 },
      ],
    };
    expect(decodeContextManifest(encodeContextManifest(input))).toEqual({ ...input, objectIds: [A, B] });
    const withParent = decodeContextManifest(
      encodeContextManifest({ ...input, parentSessionId: SESSION }),
    );
    expect(withParent.parentSessionId).toBe(SESSION);
  });

  test("publication handles optional actor and override flag", () => {
    const full = decodePublication(
      encodePublication({ layerId: LAYER, checkpointId: A, anchorId: B, priorId: C, rootId: D, seq: 9, contextIds: [A], actor: "agent-1", override: false, operationId: OP }),
    );
    expect(full.actor).toBe("agent-1");
    expect(full.override).toBe(false);
    const bare = decodePublication(
      encodePublication({ layerId: LAYER, checkpointId: A, anchorId: B, priorId: C, rootId: D, seq: 0, contextIds: [], actor: null, override: true, operationId: OP }),
    );
    expect(bare.actor).toBeNull();
    expect(bare.override).toBe(true);
  });

  test("refresh and stack round-trip", () => {
    expect(
      decodeRefresh(encodeRefresh({ layerId: LAYER, prevCheckpointId: A, prevAnchorId: B, adoptedId: C, rootId: D, operationId: OP })),
    ).toEqual({ layerId: LAYER, prevCheckpointId: A, prevAnchorId: B, adoptedId: C, rootId: D, operationId: OP });
    const stack = decodeStack(
      encodeStack({
        sources: [
          { layerId: "55".repeat(16), checkpointId: C, rootId: D },
          { layerId: LAYER, checkpointId: A, rootId: B },
        ],
        anchorId: A,
        destLayerId: "66".repeat(16),
        rootId: B,
        order: [LAYER, "55".repeat(16)],
        contextIds: [C],
        operationId: OP,
      }),
    );
    expect(stack.sources.map((s) => s.layerId)).toEqual([LAYER, "55".repeat(16)]);
    expect(stack.destLayerId).toBe("66".repeat(16));
    expect(stack.order).toEqual([LAYER, "55".repeat(16)]);
  });

  test("decoders reject the wrong object type", () => {
    const world = encodeWorldVersion({ repoId: REPO, seq: 0, rootId: A, prevId: null, publicationId: null, contextIds: [] });
    expect(() => decodeCheckpoint(world)).toThrow();
    expect(() => decodeRefresh(world)).toThrow();
    expect(() => decodeStack(world)).toThrow();
    expect(() => decodeContextObject(world)).toThrow();
    expect(() => decodeContextManifest(world)).toThrow();
    expect(() => decodePublication(world)).toThrow();
    expect(() => decodeWorldVersion(encodeBlob(Uint8Array.of(1)))).toThrow();
  });
});


describe("chmod-only visibility", () => {
  test("same blob with different exec bit reports metadata-change", () => {
    const A = "a".repeat(64);
    const base = { files: new Map([["f.txt", { blob: A, executable: false }]]), symlinks: new Map<string, string>() };
    const next = { files: new Map([["f.txt", { blob: A, executable: true }]]), symlinks: new Map<string, string>() };
    expect(diffTrees(base, next)).toEqual([{ path: "f.txt", kind: "metadata-change", oldBlob: A, newBlob: A }]);
    expect(diffTrees(next, base)).toEqual([{ path: "f.txt", kind: "metadata-change", oldBlob: A, newBlob: A }]);
    expect(diffTrees(base, base)).toEqual([]);
  });

  test("chmod versus content change on the other side is a conflict", () => {
    const A = "a".repeat(64);
    const B = "b".repeat(64);
    const base = { files: new Map([["f.txt", { blob: A, executable: false }]]), symlinks: new Map<string, string>() };
    const chmod = { files: new Map([["f.txt", { blob: A, executable: true }]]), symlinks: new Map<string, string>() };
    const modify = { files: new Map([["f.txt", B, ]]) as unknown as Map<string, string>, symlinks: new Map<string, string>() };
    const v = structuralCompatible(base, chmod, modify);
    expect(v.ok).toBe(false);
  });
});

describe("resolveLayerRef prefix ambiguity", () => {
  test("shared prefix reports E_AMBIGUOUS_LAYER, unknown reports E_LAYER_NOT_FOUND", async () => {
    const { resolveLayerRef } = await import("../src/core/refs.ts");
    const { CODES } = await import("../src/core/types.ts");
    void CODES;
    const base = { currentWorld: "w", worldsBySeq: {}, layers: {} as Record<string, any> };
    const mk = (id: string) => ({ id, name: null, originKind: 1 as const, originId: "w", checkpoint: "c", state: "active" as const, agent: null, sessions: {}, workspace: null });
    const refs = { ...base, layers: { abc123: mk("abc123"), abc456: mk("abc456") } };
    let code = "";
    try {
      resolveLayerRef(refs, "abc");
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("E_AMBIGUOUS_LAYER");
    let code2 = "";
    try {
      resolveLayerRef(refs, "zzz");
    } catch (e) {
      code2 = (e as { code?: string }).code ?? "";
    }
    expect(code2).toBe("E_LAYER_NOT_FOUND");
  });
});
