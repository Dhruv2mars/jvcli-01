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
