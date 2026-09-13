import { describe, test, expect } from "bun:test";
import { createLayer, mkTempRepo, rmTemp, runCli, runCliJson, writeWs } from "./e2e-helpers";

describe("publish flow", () => {
  test("init, edit layer, publish => v2; diff/history/verify", () => {
    const t = mkTempRepo({ "a.txt": "hello\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "P1");
      writeWs(repo, id, "b.txt", "world\n");

      const pub = runCliJson(repo, ["publish", id]);
      expect(pub.code).toBe(0);
      expect(pub.json).not.toBeNull();
      expect(pub.json.ok).toBe(true);
      expect(pub.json.seq).toBe(2);
      expect(typeof pub.json.world).toBe("string");

      const diff = runCliJson(repo, ["diff", "v1", "v2"]);
      expect(diff.code).toBe(0);
      expect(diff.json).not.toBeNull();
      const changes = diff.json.changes as Array<{ path: string }>;
      expect(changes.map((c) => c.path)).toContain("b.txt");
      // Human-readable diff also names the file.
      expect(diff.stdout).toContain("b.txt");

      const hist = runCliJson(repo, ["history", "--world"]);
      expect(hist.code).toBe(0);
      expect(hist.json.ok).toBe(true);
      expect(hist.json.worlds).toHaveLength(2);
      expect(hist.json.worlds.map((w: any) => w.seq)).toEqual([1, 2]);

      const verify = runCli(repo, ["verify"]);
      expect(verify.code).toBe(0);
      expect(verify.stdout).toContain("verified");
    } finally {
      rmTemp(t.base);
    }
  });
});
