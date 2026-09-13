import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLayer, mkTempRepo, rmTemp, runCli, runCliJson, writeWs } from "./e2e-helpers";
import {
  decodeCheckpoint,
  decodeRefresh,
  decodeWorldVersion,
  encodeCheckpoint,
  encodeRefresh,
  encodeWorldVersion
} from "../src/core/objects.js";
import { ObjectStore } from "../src/core/store.js";
import { loadRefs, saveRefs } from "../src/core/refs.js";

const metaOf = (repo: string): string => join(repo, ".javelin");

describe("verify record-body conservation (6a/6b)", () => {
  test("healthy repo verifies; publication pointing at the prior publication is flagged (6a)", async () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "PUBA");
      writeWs(repo, a.id, "one.txt", "one\n");
      expect(runCliJson(repo, ["publish", a.id]).code).toBe(0);
      const b = createLayer(repo, "PUBB");
      writeWs(repo, b.id, "two.txt", "two\n");
      expect(runCliJson(repo, ["publish", b.id]).code).toBe(0);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);

      const meta = metaOf(repo);
      const store = new ObjectStore(join(meta, "objects"));
      const refs = await loadRefs(meta);
      const seqs = Object.keys(refs.worldsBySeq).map(Number);
      const newestSeq = Math.max(...seqs);
      const newestId = refs.worldsBySeq[String(newestSeq)]!;
      const w = decodeWorldVersion(await store.read(newestId));
      const olderPub = decodeWorldVersion(await store.read(refs.worldsBySeq[String(newestSeq - 1)]!)).publicationId;
      expect(w.publicationId).not.toBeNull();
      expect(olderPub).not.toBeNull();
      expect(olderPub).not.toBe(w.publicationId);
      const tamperedId = await store.put(
        encodeWorldVersion({
          repoId: w.repoId,
          seq: w.seq,
          rootId: w.rootId,
          prevId: w.prevId,
          publicationId: olderPub!,
          contextIds: w.contextIds
        })
      );
      await saveRefs(meta, {
        ...refs,
        worldsBySeq: { ...refs.worldsBySeq, [String(newestSeq)]: tamperedId }
      });

      const v = runCliJson(repo, ["verify"]);
      expect(v.code).not.toBe(0);
      expect(v.json.error.code).toBe("E_CORRUPT_OBJECT");
      expect(JSON.stringify(v.json.error.paths)).toContain("publication-prior-mismatch");
    } finally {
      rmTemp(t.base);
    }
  });

  test("healthy repo verifies; refresh record with a stale prevAnchorId is flagged (6b)", async () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "REFA");
      const b = createLayer(repo, "REFB");
      writeWs(repo, b.id, "rb.txt", "b\n");
      expect(runCliJson(repo, ["publish", b.id]).code).toBe(0);
      const ref = runCliJson(repo, ["layer", "refresh", a.id]);
      expect(ref.code).toBe(0);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);

      const meta = metaOf(repo);
      const store = new ObjectStore(join(meta, "objects"));
      const refs = await loadRefs(meta);
      const cpId = refs.layers[a.id]!.checkpoint;
      const cp = decodeCheckpoint(await store.read(cpId));
      expect(cp.recordId).not.toBeNull();
      const r = decodeRefresh(await store.read(cp.recordId!));
      const currentWorld = refs.worldsBySeq[String(Math.max(...Object.keys(refs.worldsBySeq).map(Number)))]!;
      expect(currentWorld).not.toBe(r.prevAnchorId);
      const r2 = await store.put(encodeRefresh({ ...r, prevAnchorId: currentWorld }));
      const cp2 = await store.put(encodeCheckpoint({ ...cp, recordId: r2 }));
      await saveRefs(meta, {
        ...refs,
        layers: { ...refs.layers, [a.id]: { ...refs.layers[a.id]!, checkpoint: cp2 } }
      });

      const v = runCliJson(repo, ["verify"]);
      expect(v.code).not.toBe(0);
      expect(v.json.error.code).toBe("E_CORRUPT_OBJECT");
      expect(JSON.stringify(v.json.error.paths)).toContain("refresh-anchor-mismatch");
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("gc conservation (6d/6e)", () => {
  test("gc sweeps stale tmp leftovers but spares fresh ones (6d)", () => {
    const t = mkTempRepo();
    try {
      const repo = t.repo;
      const meta = metaOf(repo);
      const staleRefsTmp = join(meta, "refs.json.tmp-424242-1000");
      const staleObjTmp = join(meta, "tmp", "obj-11111111111111111111111111111111-424242-1000");
      const freshRefsTmp = join(meta, "refs.json.tmp-424242-2000");
      const freshObjTmp = join(meta, "tmp", "obj-22222222222222222222222222222222-424242-2000");
      for (const p of [staleRefsTmp, staleObjTmp, freshRefsTmp, freshObjTmp]) writeFileSync(p, "{}");
      const past = new Date(Date.now() - 60_000);
      utimesSync(staleRefsTmp, past, past);
      utimesSync(staleObjTmp, past, past);

      const gc = runCliJson(repo, ["gc"]);
      expect(gc.code).toBe(0);
      expect(gc.json.ok).toBe(true);

      expect(existsSync(staleRefsTmp)).toBe(false);
      expect(existsSync(staleObjTmp)).toBe(false);
      expect(existsSync(freshRefsTmp)).toBe(true);
      expect(existsSync(freshObjTmp)).toBe(true);
    } finally {
      rmTemp(t.base);
    }
  });

  test("gc prunes settled journals past 7d beyond the newest 100 and never touches live states (6e)", () => {
    const t = mkTempRepo();
    try {
      const repo = t.repo;
      const journalDir = join(metaOf(repo), "journal");
      const prefix = "aaaaaa";
      const opid = (i: number): string => `${prefix}${i.toString(16).padStart(26, "0")}`;
      const write = (operationId: string, state: string, updatedAt: string): void => {
        writeFileSync(
          join(journalDir, `${operationId}.json`),
          JSON.stringify({ op: operationId, kind: "publish", state, layerId: null, operationId, payload: {}, createdAt: updatedAt, updatedAt })
        );
      };
      const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
      // 108 old finalized journals + 1 old conflict = 109 prunable entries:
      // exactly the 10 oldest finalized fall outside keep-newest-100.
      for (let i = 0; i < 108; i++) write(opid(i), "finalized", new Date(old + i * 60_000).toISOString());
      // Settled but inside the newest 100, and live states of every protected kind.
      write(`${prefix}${"b".repeat(26)}`, "accepted", new Date(Date.now() - 60_000).toISOString());
      write(`${prefix}${"c".repeat(26)}`, "conflict", new Date(old + 107.5 * 60_000).toISOString());
      write(`${prefix}${"d".repeat(26)}`, "prepared", new Date(old).toISOString());
      write(`${prefix}${"e".repeat(26)}`, "objects_durable", new Date(old).toISOString());
      write(`${prefix}${"f".repeat(26)}`, "world_created", new Date(old).toISOString());
      write(`${prefix}${"9".repeat(26)}`, "stale-retry", new Date(old).toISOString());

      const gc = runCliJson(repo, ["gc"]);
      expect(gc.code).toBe(0);
      expect(gc.json.ok).toBe(true);

      const remaining = readdirSync(journalDir).filter((f) => f.startsWith(prefix));
      expect(remaining).toHaveLength(104);
      for (let i = 0; i < 10; i++) expect(existsSync(join(journalDir, `${opid(i)}.json`))).toBe(false);
      for (let i = 10; i < 108; i++) expect(existsSync(join(journalDir, `${opid(i)}.json`))).toBe(true);
      for (const s of ["b", "c", "d", "e", "f", "9"]) {
        expect(existsSync(join(journalDir, `${prefix}${s.repeat(26)}.json`))).toBe(true);
      }
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("diagnostics redaction (8)", () => {
  test("bundle emits ids and counts only, never payload bytes or workspace paths", () => {
    const canaryBytes = "JV-CANARY-BYTES-8f3a91c7";
    const canaryCtx = "JV-CANARY-CONTEXT-5be02d44";
    const t = mkTempRepo({ "base.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "DIAG");
      const begin = runCliJson(repo, ["context", "begin", "--layer", a.id]);
      expect(begin.code).toBe(0);
      const sid = begin.json.sessionId as string;
      expect(
        runCliJson(repo, ["context", "append", "--layer", a.id, "--session", sid, "--kind", "note", "--text", canaryCtx]).code
      ).toBe(0);
      expect(runCliJson(repo, ["context", "end", "--layer", a.id, "--session", sid]).code).toBe(0);
      writeWs(repo, a.id, "secret.txt", `${canaryBytes}\n`);
      expect(runCliJson(repo, ["publish", a.id]).code).toBe(0);

      const bundle = runCliJson(repo, ["diagnostics", "bundle"]);
      expect(bundle.code).toBe(0);
      expect(bundle.json.ok).toBe(true);
      expect(bundle.json.world.seq).toBe(2);
      expect(typeof bundle.json.repo).toBe("string");
      expect(bundle.stdout).not.toContain(canaryBytes);
      expect(bundle.stdout).not.toContain(canaryCtx);
      expect(bundle.stdout).not.toContain(t.base);
    } finally {
      rmTemp(t.base);
    }
  });
});
