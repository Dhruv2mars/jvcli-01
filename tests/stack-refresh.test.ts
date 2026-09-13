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

  test("clone and child capture dirty source writes via pre-flush", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const p = createLayer(repo, "P");
      writeWs(repo, p.id, "dirty.txt", "dirty-not-checkpointed\n");

      const k = runCliJson(repo, ["layer", "child", p.id, "--name", "K"]);
      expect(k.code).toBe(0);
      expect(readFileSync(join(layerWorkspace(repo, k.json.layer as string), "dirty.txt"), "utf8")).toBe(
        "dirty-not-checkpointed\n"
      );

      writeWs(repo, p.id, "dirty2.txt", "second-dirty\n");
      const c = runCliJson(repo, ["layer", "clone", p.id, "--name", "C"]);
      expect(c.code).toBe(0);
      expect(readFileSync(join(layerWorkspace(repo, c.json.layer as string), "dirty2.txt"), "utf8")).toBe("second-dirty\n");

      // Explicit checkpoint pin still wins over the flush.
      const hist = runCliJson(repo, ["history", "--layer", p.id]);
      expect(hist.code).toBe(0);
      const firstCp = (hist.json.checkpoints as Array<any>)[0].id as string;
      const pinned = runCliJson(repo, ["layer", "clone", p.id, "--name", "PIN", "--checkpoint", firstCp]);
      expect(pinned.code).toBe(0);
      expect(() =>
        readFileSync(join(layerWorkspace(repo, pinned.json.layer as string), "dirty.txt"), "utf8")
      ).toThrow();
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("workspace autodetect via .jvcli-layer marker", () => {
  test("status and publish resolve the layer from cwd without --layer", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const p = createLayer(repo, "AUTO");
      const ws = layerWorkspace(repo, p.id);
      expect(readFileSync(join(ws, ".jvcli-layer"), "utf8").trim()).toBe(p.id);
      const st = runCliJson(ws, ["status"]);
      expect(st.code).toBe(0);
      expect(st.json.layer.id).toBe(p.id);
      writeWs(repo, p.id, "auto.txt", "from-workspace\n");
      const pub = runCliJson(ws, ["publish"]);
      expect(pub.code).toBe(0);
      expect(pub.json.seq).toBe(2);
    } finally {
      rmTemp(t.base);
    }
  });

  test("close removes the marker and open restores it", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const p = createLayer(repo, "MARK");
      const ws = layerWorkspace(repo, p.id);
      expect(runCliJson(repo, ["layer", "close", p.id]).code).toBe(0);
      expect(() => readFileSync(join(ws, ".jvcli-layer"), "utf8")).toThrow();
      expect(runCliJson(repo, ["layer", "open", p.id]).code).toBe(0);
      expect(readFileSync(join(ws, ".jvcli-layer"), "utf8").trim()).toBe(p.id);
    } finally {
      rmTemp(t.base);
    }
  });
});


describe("stack operation-id resume", () => {
  test("repeating a finalized stack op-id returns the same destination", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "RA");
      const b = createLayer(repo, "RB");
      writeWs(repo, a.id, "aa.txt", "from-a\n");
      writeWs(repo, b.id, "bb.txt", "from-b\n");
      const op = "1".repeat(32);
      const first = runCliJson(repo, ["stack", a.id, b.id, "--into", "combo", "--operation-id", op]);
      expect(first.code).toBe(0);
      const dest = first.json.dest as string;
      const second = runCliJson(repo, ["stack", a.id, b.id, "--into", "combo", "--operation-id", op]);
      expect(second.code).toBe(0);
      expect(second.json.dest).toBe(dest);
      const list = runCliJson(repo, ["layer", "list"]);
      expect((list.json.layers as Array<any>).filter((l) => l.name === "combo")).toHaveLength(1);
      const c = createLayer(repo, "RC");
      writeWs(repo, c.id, "cc.txt", "from-c\n");
      const mismatch = runCliJson(repo, ["stack", a.id, c.id, "--into", "combo", "--operation-id", op]);
      expect(mismatch.code).not.toBe(0);
      expect(mismatch.json.error.code).toBe("E_IO");
    } finally {
      rmTemp(t.base);
    }
  });
});
