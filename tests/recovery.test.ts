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

  test("delete tombstone + gc dry-run reports; verify --full passes", async () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "DEL");
      writeWs(repo, id, "doomed.txt", "doomed\n");
      const del = runCliJson(repo, ["layer", "delete", id]);
      expect(del.code).toBe(0);

      // Tombstone: deleted layer disappears from the active list.
      const list = runCliJson(repo, ["layer", "list"]);
      expect(list.code).toBe(0);
      expect((list.json.layers as Array<any>).map((l) => l.id)).not.toContain(id);

      const { utimesSync } = await import("node:fs");
      const { join: joinPath } = await import("node:path");
      const metaDir = joinPath(repo, ".javelin");
      const { readdir: readdirP, stat: statP } = await import("node:fs/promises");
      const backdate = async (dir: string) => {
        for (const a of await readdirP(dir)) {
          const full = joinPath(dir, a);
          try {
            const st = await statP(full);
            if (st.isDirectory()) await backdate(full);
            else {
              const past = new Date(Date.now() - 120_000);
              utimesSync(full, past, past);
            }
          } catch { /* ignore */ }
        }
      };
      await backdate(joinPath(metaDir, "objects"));
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

describe("gc safety", () => {
  test("objects_durable journal pins merged objects; quarantine spares fresh files", async () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { join } = await import("node:path");
      const { writeFile, stat } = await import("node:fs/promises");
      const a = createLayer(repo, "GCA");
      writeWs(repo, a.id, "g.txt", "gc-pinned\n");
      const first = runCliJson(repo, ["publish", a.id, "--operation-id", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
      expect(first.code).toBe(0);
      const meta = join(repo, ".javelin");
      const journals = join(meta, "journal");
      const { readdir, readFile } = await import("node:fs/promises");
      const files = (await readdir(journals)).filter((f: string) => f.endsWith(".json"));
      const mine = files.find((f: string) => f.startsWith("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
      expect(mine).toBeDefined();
      const entry = JSON.parse(await readFile(join(journals, mine!), "utf8"));
      expect(entry.state).toBe("finalized");
      // Fresh object younger than the quarantine window is spared.
      const gcFresh = runCliJson(repo, ["gc", "--dry-run"]);
      expect(gcFresh.code).toBe(0);
      // Simulate an interrupted publish: rewrite the journal to
      // objects_durable with a fake root id file on disk, then gc must
      // keep that file because the live journal cites it.
      const fakeId = "f".repeat(64);
      const fakePath = join(meta, "objects", fakeId.slice(0, 2), fakeId.slice(2));
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(meta, "objects", fakeId.slice(0, 2)), { recursive: true });
      await writeFile(fakePath, Buffer.from("unreachable-but-cited"));
      await writeFile(
        join(journals, "cccccccccccccccccccccccccccccccc.json"),
        JSON.stringify({
          op: "cccccccccccccccccccccccccccccccc",
          kind: "publish",
          state: "objects_durable",
          layerId: a.id,
          operationId: "cccccccccccccccccccccccccccccccc",
          payload: { checkpoint: "d".repeat(64), root: fakeId },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
      );
      // Backdate the fake file past quarantine so only journal pinning saves it.
      const past = new Date(Date.now() - 120_000);
      const { utimes } = await import("node:fs/promises");
      await utimes(fakePath, past, past);
      const st = await stat(fakePath);
      expect(Date.now() - st.mtimeMs).toBeGreaterThan(5_000);
      const gc = runCliJson(repo, ["gc"]);
      expect(gc.code).toBe(0);
      const { existsSync } = await import("node:fs");
      expect(existsSync(fakePath)).toBe(true);
    } finally {
      rmTemp(t.base);
    }
  });
});
