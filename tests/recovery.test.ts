import { describe, test, expect } from "bun:test";
import { createLayer, mkTempRepo, rmTemp, runCli, runCliJson, writeWs } from "./e2e-helpers";

describe("recovery / gc / verify flows", () => {
  test("stale disjoint publish auto-merges without manual refresh", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "A");
      const b = createLayer(repo, "B");
      writeWs(repo, a.id, "aa.txt", "from-a\n");
      writeWs(repo, b.id, "bb.txt", "from-b\n");

      expect(runCliJson(repo, ["publish", a.id]).code).toBe(0);
      const merged = runCliJson(repo, ["publish", b.id]);
      expect(merged.code).toBe(0);
      expect(merged.json.seq).toBe(3);
    } finally {
      rmTemp(t.base);
    }
  });

  test("overlapping stale publish conflicts with the path", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
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
      rmTemp(t.base);
    }
  });

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

describe("delete safety", () => {
  test("delete refuses while a live journal cites the layer", async () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "LIVE");
      const { join } = await import("node:path");
      const { writeFile } = await import("node:fs/promises");
      const op = "dddddddddddddddddddddddddddddddd";
      await writeFile(
        join(repo, ".javelin", "journal", `${op}.json`),
        JSON.stringify({
          op,
          kind: "publish",
          state: "objects_durable",
          layerId: id,
          operationId: op,
          payload: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
      );
      const del = runCliJson(repo, ["layer", "delete", id]);
      expect(del.code).not.toBe(0);
      expect(del.json.error.code).toBe("E_BUSY");
      expect(del.json.error.retryable).toBe(true);
      const list = runCliJson(repo, ["layer", "list"]);
      expect((list.json.layers as Array<any>).some((l) => l.id === id)).toBe(true);
    } finally {
      rmTemp(t.base);
    }
  });

  test("delete succeeds once the journal finalizes", async () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "DONE");
      const { join } = await import("node:path");
      const { writeFile } = await import("node:fs/promises");
      const op = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      await writeFile(
        join(repo, ".javelin", "journal", `${op}.json`),
        JSON.stringify({
          op,
          kind: "publish",
          state: "finalized",
          layerId: id,
          operationId: op,
          payload: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
      );
      expect(runCliJson(repo, ["layer", "delete", id]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("fault injection (JVCLI_FAULT)", () => {
  test("crash after merge-durable retries into the same world", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "FI1");
      writeWs(repo, a.id, "fi.txt", "fault\n");
      const op = "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1";
      const crashed = runCliJson(repo, ["publish", a.id, "--operation-id", op], { JVCLI_FAULT: "publish:after-merge-durable" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(crashed.json.error.retryable).toBe(true);
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      const { join } = require("node:path") as typeof import("node:path");
      const entry = JSON.parse(readFileSync(join(repo, ".javelin", "journal", `${op}.json`), "utf8"));
      expect(entry.state).toBe("objects_durable");
      expect(typeof entry.payload.checkpoint).toBe("string");
      expect(typeof entry.payload.root).toBe("string");
      expect(runCliJson(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["publish", a.id, "--operation-id", op]);
      expect(retry.code).toBe(0);
      expect(retry.json.seq).toBe(2);
      const again = runCliJson(repo, ["history", "--world"]);
      expect((again.json.worlds as Array<any>)).toHaveLength(2);
    } finally {
      rmTemp(t.base);
    }
  });

  test("crash after world-created retries without duplicating the version", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "FI2");
      writeWs(repo, a.id, "fi.txt", "fault\n");
      const op = "f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2";
      const crashed = runCliJson(repo, ["publish", a.id, "--operation-id", op], { JVCLI_FAULT: "publish:after-world-created" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      const { join } = require("node:path") as typeof import("node:path");
      const entry = JSON.parse(readFileSync(join(repo, ".javelin", "journal", `${op}.json`), "utf8"));
      expect(entry.state).toBe("world_created");
      expect(typeof entry.payload.world).toBe("string");
      expect(runCliJson(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["publish", a.id, "--operation-id", op]);
      expect(retry.code).toBe(0);
      expect(retry.json.seq).toBe(2);
      expect((runCliJson(repo, ["history", "--world"]).json.worlds as Array<any>)).toHaveLength(2);
    } finally {
      rmTemp(t.base);
    }
  });

  test("stale retry reuses the journaled checkpoint and root instead of re-merging dirt", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "FI4");
      const b = createLayer(repo, "FI5");
      writeWs(repo, a.id, "stale.txt", "stale-work\n");
      writeWs(repo, b.id, "bump.txt", "bump\n");
      const op = "f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4";
      const crashed = runCliJson(repo, ["publish", a.id, "--operation-id", op], { JVCLI_FAULT: "publish:after-merge-durable" });
      expect(crashed.code).not.toBe(0);
      expect(runCliJson(repo, ["publish", b.id]).code).toBe(0);
      writeWs(repo, a.id, "post-crash.txt", "must-not-publish\n");
      const retry = runCliJson(repo, ["publish", a.id, "--operation-id", op]);
      expect(retry.code).toBe(0);
      const diff = runCliJson(repo, ["diff", "v2", "v3"]);
      expect(JSON.stringify(diff.json.changes)).not.toContain("post-crash.txt");
      expect(JSON.stringify(diff.json.changes)).toContain("stale.txt");
    } finally {
      rmTemp(t.base);
    }
  });

  test("crash after accepted recovers the existing world on retry", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "FI3");
      writeWs(repo, a.id, "fi.txt", "fault\n");
      const op = "f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3";
      const crashed = runCliJson(repo, ["publish", a.id, "--operation-id", op], { JVCLI_FAULT: "publish:after-accepted" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(runCliJson(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["publish", a.id, "--operation-id", op]);
      expect(retry.code).toBe(0);
      expect(retry.json.status).toBe("recovered");
      expect(retry.json.seq).toBe(2);
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      const { join } = require("node:path") as typeof import("node:path");
      const entry = JSON.parse(readFileSync(join(repo, ".javelin", "journal", `${op}.json`), "utf8"));
      expect(entry.state).toBe("accepted");
      expect(retry.json.world).toBe(entry.payload.worldId);
      expect((runCliJson(repo, ["history", "--world"]).json.worlds as Array<any>)).toHaveLength(2);
    } finally {
      rmTemp(t.base);
    }
  });
});
