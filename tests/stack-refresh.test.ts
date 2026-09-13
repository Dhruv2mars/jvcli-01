import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLayer,
  layerWorkspace,
  mkTempRepo,
  rmTemp,
  runCliJson,
  writeWs
} from "./e2e-helpers";

describe("stack + refresh + conflict flows", () => {
  test("second disjoint publish auto-merges without manual refresh", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "A");
      const b = createLayer(repo, "B");
      writeWs(repo, a.id, "aa.txt", "from-a\n");
      writeWs(repo, b.id, "bb.txt", "from-b\n");

      const p1 = runCliJson(repo, ["publish", a.id]);
      expect(p1.code).toBe(0);
      expect(p1.json.seq).toBe(2);

      // No manual refresh of B: publish must auto-merge and become v3.
      const p2 = runCliJson(repo, ["publish", b.id]);
      expect(p2.code).toBe(0);
      expect(p2.json.seq).toBe(3);

      const diff = runCliJson(repo, ["diff", "v2", "v3"]);
      expect(diff.code).toBe(0);
      expect((diff.json.changes as Array<any>).map((c) => c.path)).toContain("bb.txt");
    } finally {
      rmTemp(t.base);
    }
  });

  test("overlapping publish exits nonzero with E_CONFLICT naming the path; refresh reports conflict", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "A");
      const b = createLayer(repo, "B");
      writeWs(repo, a.id, "a.txt", "from-a\n");
      writeWs(repo, b.id, "a.txt", "from-b\n");

      const p1 = runCliJson(repo, ["publish", a.id]);
      expect(p1.code).toBe(0);

      const p2 = runCliJson(repo, ["publish", b.id]);
      expect(p2.code).not.toBe(0);
      expect(p2.json).not.toBeNull();
      expect(p2.json.ok).toBe(false);
      expect(p2.json.error.code).toBe("E_CONFLICT");
      expect(JSON.stringify(p2.json.error.paths ?? p2.json.error.message)).toContain("a.txt");
      // Human-readable stderr names the path too.
      const p2h = runCliJson(repo, ["publish", b.id]);
      expect(p2h.code).not.toBe(0);
      expect(`${p2h.stdout}${p2h.stderr}`).toContain("a.txt");

      const ref = runCliJson(repo, ["layer", "refresh", b.id]);
      expect(ref.code).not.toBe(0);
      expect(ref.json).not.toBeNull();
      expect(ref.json.error.code).toBe("E_CONFLICT");
      expect(JSON.stringify(ref.json.error.paths ?? ref.json.error.message)).toContain("a.txt");
    } finally {
      rmTemp(t.base);
    }
  });

  test("stack of two disjoint active layers consumes sources and exposes dest workspace with both files", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "SA");
      const b = createLayer(repo, "SB");
      writeWs(repo, a.id, "aa.txt", "from-a\n");
      writeWs(repo, b.id, "bb.txt", "from-b\n");

      const s = runCliJson(repo, ["stack", a.id, b.id, "--into", "combined"]);
      expect(s.code).toBe(0);
      expect(s.json.ok).toBe(true);
      expect(typeof s.json.dest).toBe("string");
      const dest = s.json.dest as string;

      // Sources are consumed.
      const list = runCliJson(repo, ["layer", "list"]);
      expect(list.code).toBe(0);
      const byId = new Map((list.json.layers as Array<any>).map((l) => [l.id, l]));
      expect(byId.get(a.id)?.state).toBe("consumed");
      expect(byId.get(b.id)?.state).toBe("consumed");

      // Dest workspace exposes both contributed files.
      const ws = layerWorkspace(repo, dest);
      expect(readFileSync(join(ws, "aa.txt"), "utf8")).toBe("from-a\n");
      expect(readFileSync(join(ws, "bb.txt"), "utf8")).toBe("from-b\n");
    } finally {
      rmTemp(t.base);
    }
  });
});
