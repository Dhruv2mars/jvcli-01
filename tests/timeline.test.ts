import { describe, test, expect } from "bun:test";
import { createLayer, mkTempRepo, rmTemp, runCli, runCliJson, writeWs } from "./e2e-helpers";

describe("timeline command", () => {
  test("2 publishes + 1 stack + 1 open session: sorted rows, filters, no bodies or paths", () => {
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
      const p2 = runCliJson(repo, ["publish", b.id]);
      expect(p2.code).toBe(0);
      expect(p2.json.seq).toBe(3);

      const c = createLayer(repo, "C");
      const d = createLayer(repo, "D");
      writeWs(repo, c.id, "cc.txt", "from-c\n");
      writeWs(repo, d.id, "dd.txt", "from-d\n");
      const s = runCliJson(repo, ["stack", c.id, d.id, "--into", "combined"]);
      expect(s.code).toBe(0);

      const e = createLayer(repo, "OPEN");
      const begin = runCliJson(repo, ["context", "begin", "--layer", e.id]);
      expect(begin.code).toBe(0);

      const full = runCliJson(repo, ["timeline"]);
      expect(full.code).toBe(0);
      expect(full.json.ok).toBe(true);
      const rows = full.json.rows as Array<any>;
      expect(rows.length).toBeGreaterThan(0);

      const keys = rows.map((r) => (r.t.seq === null ? Number.POSITIVE_INFINITY : r.t.seq));
      expect([...keys].sort((x, y) => x - y)).toEqual(keys);

      const kinds = new Set(rows.map((r) => r.kind));
      for (const k of ["world", "publish", "checkpoint", "journal"]) {
        expect(kinds.has(k)).toBe(true);
      }

      const worlds = runCliJson(repo, ["timeline", "--kind", "world"]);
      expect(worlds.code).toBe(0);
      expect((worlds.json.rows as Array<any>).length).toBe(3);
      expect((worlds.json.rows as Array<any>).every((r) => r.kind === "world")).toBe(true);

      const limited = runCliJson(repo, ["timeline", "--limit", "2"]);
      expect(limited.code).toBe(0);
      expect((limited.json.rows as Array<any>)).toHaveLength(2);
      expect(JSON.stringify((limited.json.rows as Array<any>)[0])).toBe(JSON.stringify(rows[0]));
      const onlyA = runCliJson(repo, ["timeline", "--layer", a.id]);
      expect(onlyA.code).toBe(0);
      const aRows = onlyA.json.rows as Array<any>;
      expect(aRows.length).toBeGreaterThan(0);
      expect(aRows.every((r) => r.layer === a.id)).toBe(true);

      const raw = JSON.stringify(full.json);
      expect(raw).not.toContain('"bytes"');
      expect(raw).not.toContain('"workspace"');

      const human = runCli(repo, ["timeline"]);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("v1 world");
      expect(human.stdout).toContain("v3 publish");
    } finally {
      rmTemp(t.base);
    }
  }, { timeout: 30000 });
});
