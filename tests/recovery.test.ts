import { describe, test, expect } from "bun:test";
import { createLayer, mkTempRepo, rmTemp, runCli, runCliJson, writeWs } from "./e2e-helpers";

describe("recovery / gc / verify flows", () => {
  test("publish with explicit --operation-id twice => same world, one new version", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "OPA");
      writeWs(repo, a.id, "d.txt", "data\n");
      const op = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

      const first = runCliJson(repo, ["publish", a.id, "--operation-id", op]);
      expect(first.code).toBe(0);
      expect(first.json.ok).toBe(true);
      expect(first.json.seq).toBe(2);
      const world = first.json.world as string;

      // Retry the same operation-id from another active layer: journal
      // recovery returns the same world without appending a version.
      const b = createLayer(repo, "OPB");
      writeWs(repo, b.id, "other.txt", "other\n");
      const second = runCliJson(repo, ["publish", b.id, "--operation-id", op]);
      expect(second.code).toBe(0);
      expect(second.json.world).toBe(world);

      const hist = runCliJson(repo, ["history", "--world"]);
      expect(hist.code).toBe(0);
      expect(hist.json.worlds).toHaveLength(2);
      expect(hist.json.worlds.map((w: any) => w.seq)).toEqual([1, 2]);
    } finally {
      rmTemp(t.base);
    }
  });

  test("stale disjoint publish auto-merges; overlapping stale publish conflicts", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "A");
      const b = createLayer(repo, "B");
      writeWs(repo, a.id, "aa.txt", "from-a\n");
      writeWs(repo, b.id, "bb.txt", "from-b\n");

      expect(runCliJson(repo, ["publish", a.id]).code).toBe(0);
      // B is stale (anchored at v1) but disjoint: auto-merge => v3.
      const merged = runCliJson(repo, ["publish", b.id]);
      expect(merged.code).toBe(0);
      expect(merged.json.seq).toBe(3);
    } finally {
      rmTemp(t.base);
    }

    const t2 = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t2.repo;
      const a = createLayer(repo, "A");
      const b = createLayer(repo, "B");
      writeWs(repo, a.id, "a.txt", "from-a\n");
      writeWs(repo, b.id, "a.txt", "from-b\n");

      expect(runCliJson(repo, ["publish", a.id]).code).toBe(0);
      const conflict = runCliJson(repo, ["publish", b.id]);
      expect(conflict.code).not.toBe(0);
      expect(conflict.json.error.code).toBe("E_CONFLICT");
      expect(JSON.stringify(conflict.json.error.paths ?? conflict.json.error.message)).toContain("a.txt");
    } finally {
      rmTemp(t2.base);
    }
  });

  test("delete tombstone + gc dry-run reports; verify --full passes", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "DEL");
      const del = runCliJson(repo, ["layer", "delete", id]);
      expect(del.code).toBe(0);

      // Tombstone: deleted layer disappears from the active list.
      const list = runCliJson(repo, ["layer", "list"]);
      expect(list.code).toBe(0);
      expect((list.json.layers as Array<any>).map((l) => l.id)).not.toContain(id);

      const gc = runCliJson(repo, ["gc", "--dry-run"]);
      expect(gc.code).toBe(0);
      expect(gc.json.ok).toBe(true);
      expect(gc.json.dryRun).toBe(true);
      expect(gc.json.removed).toBeGreaterThanOrEqual(1);

      const verify = runCli(repo, ["verify", "--full"]);
      expect(verify.code).toBe(0);
      expect(verify.stdout).toContain("verified");
    } finally {
      rmTemp(t.base);
    }
  });
});
