import { describe, test, expect } from "bun:test";
import { objectId, unwrapObject } from "../src/core/cbor.ts";
import { encodeBlob, encodeTree } from "../src/core/cbor.ts";
import {
  decodeCheckpoint,
  decodeContextManifest,
  decodeContextObject,
  decodePublication,
  decodeRefresh,
  decodeStack,
  decodeWorldVersion,
  encodeCheckpoint,
  encodeContextManifest,
  encodeContextObject,
  encodePublication,
  encodeRefresh,
  encodeStack,
  encodeWorldVersion,
} from "../src/core/objects.ts";
import vectorsDoc from "./fixtures/golden-vectors.json";

interface Vector {
  name: string;
  type: number;
  bytesHex: string;
  id: string;
}

const doc = vectorsDoc as { version: number; vectors: Vector[] };
const byName = new Map(doc.vectors.map((v) => [v.name, v]));
const bytesOf = (name: string): Uint8Array => {
  const v = byName.get(name);
  if (!v) throw new Error(`missing vector ${name}`);
  return Uint8Array.from(Buffer.from(v.bytesHex, "hex"));
};

const REPO = "00".repeat(16);
const LAYER = "11".repeat(16);
const LAYER_B = "55".repeat(16);
const DEST = "66".repeat(16);
const SESSION = "22".repeat(16);
const OP = "33".repeat(16);
const A = "aa".repeat(32);
const B = "bb".repeat(32);
const C = "cc".repeat(32);
const D = "dd".repeat(32);

function recomputed(name: string): Uint8Array {
  switch (name) {
    case "empty-blob":
      return encodeBlob(new Uint8Array(0));
    case "hello-blob":
      return encodeBlob(new TextEncoder().encode("hello"));
    case "empty-tree":
      return encodeTree([]);
    case "one-file-tree": {
      const helloBlobId = objectId(encodeBlob(new TextEncoder().encode("hello")));
      return encodeTree([{ name: "hello.txt", kind: "file", target: helloBlobId, executable: false }]);
    }
    case "world-sample":
      return encodeWorldVersion({ repoId: REPO, seq: 7, rootId: A, prevId: B, publicationId: null, contextIds: [C, D] });
    case "checkpoint-sample":
      return encodeCheckpoint({ layerId: LAYER, originKind: 1, originId: A, anchorId: B, rootId: C, prevId: D, recordId: null, contextIds: [A] });
    case "context-object-sample":
      return encodeContextObject({ format: "md", kind: "note", ordinal: 3, bytes: new TextEncoder().encode("ctx-bytes") });
    case "context-manifest-sample":
      return encodeContextManifest({ repoId: REPO, layerId: LAYER, sessionId: SESSION, parentSessionId: null, objectIds: [A, B], completeness: 2, gaps: [{ first: 0, last: 4 }, { first: 10, last: 12 }] });
    case "publication-sample":
      return encodePublication({ layerId: LAYER, checkpointId: A, anchorId: B, priorId: C, rootId: D, seq: 9, contextIds: [A], actor: "agent-1", override: false, operationId: OP });
    case "refresh-sample":
      return encodeRefresh({ layerId: LAYER, prevCheckpointId: A, prevAnchorId: B, adoptedId: C, rootId: D, operationId: OP });
    case "stack-sample":
      return encodeStack({
        sources: [
          { layerId: LAYER, checkpointId: A, rootId: B },
          { layerId: LAYER_B, checkpointId: C, rootId: D },
        ],
        anchorId: A,
        destLayerId: DEST,
        rootId: B,
        order: [LAYER, LAYER_B],
        contextIds: [C],
        operationId: OP,
      });
    default:
      throw new Error(`no recomputation for ${name}`);
  }
}

describe("golden vectors fixture", () => {
  test("covers every object type", () => {
    expect(doc.version).toBe(1);
    expect([...byName.keys()].sort()).toEqual(
      [
        "empty-blob",
        "hello-blob",
        "empty-tree",
        "one-file-tree",
        "world-sample",
        "checkpoint-sample",
        "context-object-sample",
        "context-manifest-sample",
        "publication-sample",
        "refresh-sample",
        "stack-sample",
      ].sort(),
    );
    const seen = new Map<number, string[]>();
    for (const v of doc.vectors) {
      const list = seen.get(v.type) ?? [];
      list.push(v.name);
      seen.set(v.type, list);
    }
    for (let t = 1; t <= 9; t++) expect(seen.has(t), `type ${t}`).toBe(true);
  });

  test("ids are well-formed and unique", () => {
    const ids = new Set<string>();
    for (const v of doc.vectors) {
      expect(v.id).toMatch(/^[0-9a-f]{64}$/);
      expect(v.bytesHex).toMatch(/^[0-9a-f]*$/);
      expect(ids.has(v.id)).toBe(false);
      ids.add(v.id);
    }
  });
});

describe("golden vectors recomputation", () => {
  for (const name of [...byName.keys()]) {
    test(`${name}: bytes and id reproduce exactly`, () => {
      const v = byName.get(name)!;
      const fresh = recomputed(name);
      expect(Buffer.from(fresh).toString("hex")).toBe(v.bytesHex);
      expect(objectId(fresh)).toBe(v.id);
      expect(objectId(bytesOf(name))).toBe(v.id);
      expect(unwrapObject(bytesOf(name)).type).toBe(v.type);
    });
  }

  test("blob vectors decode", () => {
    expect(unwrapObject(bytesOf("empty-blob")).type).toBe(1);
    expect(unwrapObject(bytesOf("hello-blob")).type).toBe(1);
  });

  test("tree vectors decode", () => {
    expect(unwrapObject(bytesOf("empty-tree")).type).toBe(2);
    expect(unwrapObject(bytesOf("one-file-tree")).type).toBe(2);
  });

  test("world vector decodes to the sampled fields", () => {
    expect(decodeWorldVersion(bytesOf("world-sample"))).toEqual({
      repoId: REPO,
      seq: 7,
      rootId: A,
      prevId: B,
      publicationId: null,
      contextIds: [C, D],
    });
  });

  test("checkpoint vector decodes", () => {
    const back = decodeCheckpoint(bytesOf("checkpoint-sample"));
    expect(back.layerId).toBe(LAYER);
    expect(back.originKind).toBe(1);
    expect(back.originId).toBe(A);
  });

  test("context object vector decodes", () => {
    const back = decodeContextObject(bytesOf("context-object-sample"));
    expect(back.format).toBe("md");
    expect(back.kind).toBe("note");
    expect(back.ordinal).toBe(3);
    expect(Buffer.from(back.bytes).toString()).toBe("ctx-bytes");
  });

  test("context manifest vector decodes", () => {
    const back = decodeContextManifest(bytesOf("context-manifest-sample"));
    expect(back.repoId).toBe(REPO);
    expect(back.sessionId).toBe(SESSION);
    expect(back.objectIds).toEqual([A, B]);
    expect(back.gaps).toEqual([
      { first: 0, last: 4 },
      { first: 10, last: 12 },
    ]);
  });

  test("publication vector decodes", () => {
    const back = decodePublication(bytesOf("publication-sample"));
    expect(back.actor).toBe("agent-1");
    expect(back.seq).toBe(9);
    expect(back.operationId).toBe(OP);
  });

  test("refresh vector decodes", () => {
    const back = decodeRefresh(bytesOf("refresh-sample"));
    expect(back.layerId).toBe(LAYER);
    expect(back.adoptedId).toBe(C);
  });

  test("stack vector decodes", () => {
    const back = decodeStack(bytesOf("stack-sample"));
    expect(back.sources).toHaveLength(2);
    expect(back.destLayerId).toBe(DEST);
    expect(back.operationId).toBe(OP);
  });
});
