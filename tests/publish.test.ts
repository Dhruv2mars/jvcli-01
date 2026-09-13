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

describe("publish/stack flag parsing", () => {
  test("publish --operation-id value is not mistaken for the layer", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "FL");
      writeWs(repo, id, "f.txt", "work\n");
      const op = "0".repeat(31) + "1";
      const r = runCliJson(repo, ["publish", "--operation-id", op, id]);
      expect(r.code).toBe(0);
      expect(r.json.operation).toBe(op);
      expect(r.json.seq).toBe(2);
    } finally {
      rmTemp(t.base);
    }
  });

  test("stack --into value is not mistaken for a source layer", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "SA");
      const b = createLayer(repo, "SB");
      writeWs(repo, a.id, "aa.txt", "from-a\n");
      writeWs(repo, b.id, "bb.txt", "from-b\n");
      const r = runCliJson(repo, ["stack", a.id, b.id, "--into", "combined"]);
      expect(r.code).toBe(0);
      expect(typeof r.json.dest).toBe("string");
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("show blob bytes", () => {
  test("blob output is raw bytes with no trailing newline", async () => {
    const { spawnSync } = await import("node:child_process");
    const { CLI_PATH } = await import("./e2e-helpers.ts");
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "BB");
      writeWs(repo, id, "hi.txt", "hi\n");
      const pub = runCliJson(repo, ["publish", id]);
      expect(pub.code).toBe(0);
      const diff = runCliJson(repo, ["diff", "v1", "v2"]);
      const blob = (diff.json.changes as Array<any>)[0].newBlob as string;
      const r = spawnSync("node", [CLI_PATH, "show", blob], { cwd: repo, encoding: "buffer" });
      expect(r.status).toBe(0);
      expect(Buffer.from(r.stdout as Buffer).toString("hex")).toBe("68690a");
    } finally {
      rmTemp(t.base);
    }
  });
});
