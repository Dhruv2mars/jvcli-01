import { describe, test, expect } from "bun:test";
import { createLayer, mkTempRepo, rmTemp, runCliJson, writeWs } from "./e2e-helpers";

describe("agent context gating", () => {
  test("begin/append/end then publish succeeds without override", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "CTX");

      const begin = runCliJson(repo, ["context", "begin", "--layer", id]);
      expect(begin.code).toBe(0);
      const session = begin.json.sessionId as string;
      expect(typeof session).toBe("string");

      const append = runCliJson(repo, [
        "context", "append",
        "--layer", id,
        "--session", session,
        "--kind", "note",
        "--text", "did the work"
      ]);
      expect(append.code).toBe(0);

      const end = runCliJson(repo, ["context", "end", "--layer", id, "--session", session]);
      expect(end.code).toBe(0);

      const status = runCliJson(repo, ["context", "status", "--layer", id]);
      expect(status.code).toBe(0);
      expect(status.json.missing).toBe(false);

      writeWs(repo, id, "new.txt", "edit\n");
      const pub = runCliJson(repo, ["publish", id]);
      expect(pub.code).toBe(0);
      expect(pub.json.seq).toBe(2);
    } finally {
      rmTemp(t.base);
    }
  });

  test("begin without end => publish fails E_MISSING_CONTEXT, override succeeds", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "CTX2");

      const begin = runCliJson(repo, ["context", "begin", "--layer", id]);
      expect(begin.code).toBe(0);

      writeWs(repo, id, "x.txt", "x\n");

      const denied = runCliJson(repo, ["publish", id]);
      expect(denied.code).not.toBe(0);
      expect(denied.json).not.toBeNull();
      expect(denied.json.ok).toBe(false);
      expect(denied.json.error.code).toBe("E_MISSING_CONTEXT");

      const allowed = runCliJson(repo, ["publish", id, "--allow-missing-context"]);
      expect(allowed.code).toBe(0);
      expect(allowed.json.seq).toBe(2);
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("context ordinal discipline", () => {
  test("explicit ordinal gap marks completeness 3 with gap ranges; publish still gates", async () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "GAP");
      const begin = runCliJson(repo, ["context", "begin", "--layer", id]);
      expect(begin.code).toBe(0);
      const session = begin.json.sessionId as string;
      const { openRepo } = await import("../src/core/repo.ts");
      const { sessionAppend, sessionEnd } = await import("../src/domain-context.ts");
      const { decodeContextManifest } = await import("../src/core/objects.ts");
      const repoObj = await openRepo(repo);
      const enc = new TextEncoder();
      await sessionAppend(repoObj, id, session, [
        { kind: "note", bytes: enc.encode("zero"), ordinal: 0, format: undefined }
      ]);
      await sessionAppend(repoObj, id, session, [
        { kind: "note", bytes: enc.encode("two"), ordinal: 2, format: undefined }
      ]);
      const mid = await sessionEnd(repoObj, id, session, "complete");
      const m = decodeContextManifest(await repoObj.store.readChecked(mid, 6));
      expect(m.completeness).toBe(3);
      expect(m.gaps).toEqual([{ first: 1, last: 1 }]);
      const status = runCliJson(repo, ["context", "status", "--layer", id]);
      expect(status.json.missing).toBe(true);
      expect(runCliJson(repo, ["publish", id]).json.error.code).toBe("E_MISSING_CONTEXT");
      expect(runCliJson(repo, ["publish", id, "--allow-missing-context"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });

  test("sealed session rejects appends; duplicate ordinals rejected", async () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "SEAL");
      const begin = runCliJson(repo, ["context", "begin", "--layer", id]);
      const session = begin.json.sessionId as string;
      const { openRepo } = await import("../src/core/repo.ts");
      const { sessionAppend, sessionEnd } = await import("../src/domain-context.ts");
      const repoObj = await openRepo(repo);
      const enc = new TextEncoder();
      await sessionAppend(repoObj, id, session, [{ kind: "note", bytes: enc.encode("a"), ordinal: undefined, format: undefined }]);
      await sessionEnd(repoObj, id, session, "complete");
      let sealed = "";
      try {
        await sessionAppend(repoObj, id, session, [{ kind: "note", bytes: enc.encode("b"), ordinal: undefined, format: undefined }]);
      } catch (e) {
        sealed = (e as Error).message;
      }
      expect(sealed).toContain("sealed");
      const begin2 = runCliJson(repo, ["context", "begin", "--layer", id]);
      const s2 = begin2.json.sessionId as string;
      await sessionAppend(repoObj, id, s2, [{ kind: "note", bytes: enc.encode("x"), ordinal: 0, format: undefined }]);
      let dup = "";
      try {
        await sessionAppend(repoObj, id, s2, [{ kind: "note", bytes: enc.encode("y"), ordinal: 0, format: undefined }]);
      } catch (e) {
        dup = (e as Error).message;
      }
      expect(dup).toContain("duplicate ordinal");
    } finally {
      rmTemp(t.base);
    }
  });
});
