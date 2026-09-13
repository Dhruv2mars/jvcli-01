import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer, mkTempRepo, rmTemp, runCliJson, writeWs } from "./e2e-helpers";

describe("diagnostics bundle", () => {
  test("bundle carries ops, layer states, and verify summary with no file bytes", () => {
    const t = mkTempRepo({ "a.txt": "base\n", "secret.txt": "top-secret-bytes\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "DIAG");
      writeWs(repo, a.id, "work.txt", "work\n");
      const begin = runCliJson(repo, ["context", "begin", "--layer", a.id, "--agent", "diag"]);
      expect(begin.code).toBe(0);
      const session = begin.json.sessionId as string;
      expect(
        runCliJson(repo, ["context", "append", "--layer", a.id, "--session", session, "--kind", "note", "--text", "super-secret-trace"]).code
      ).toBe(0);
      expect(runCliJson(repo, ["context", "end", "--layer", a.id, "--session", session]).code).toBe(0);
      expect(runCliJson(repo, ["publish", a.id]).code).toBe(0);

      const b = runCliJson(repo, ["diagnostics", "bundle"]);
      expect(b.code).toBe(0);
      const raw = JSON.stringify(b.json);
      expect(raw).not.toContain("top-secret-bytes");
      expect(raw).not.toContain("super-secret-trace");
      expect(b.json.version).toBe(1);
      expect(typeof b.json.repo).toBe("string");
      expect(b.json.world.seq).toBe(2);
      expect(b.json.layerStates.published).toBeGreaterThanOrEqual(1);
      expect(typeof b.json.staleLayers).toBe("number");
      expect(b.json.worlds).toBe(2);
      expect(b.json.journals.total).toBeGreaterThanOrEqual(1);
      expect(b.json.verify.ok).toBe(true);
      expect(b.json.verify.objects).toBeGreaterThan(0);

      const outDir = mkdtempSync(join(tmpdir(), "jv-diag-"));
      try {
        const outPath = join(outDir, "diag.json");
        const filed = runCliJson(repo, ["diagnostics", "bundle", "--output", outPath]);
        expect(filed.code).toBe(0);
        const onDisk = JSON.parse(readFileSync(outPath, "utf8"));
        expect(onDisk.repo).toBe(b.json.repo);
        expect(JSON.stringify(onDisk)).not.toContain("top-secret-bytes");
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    } finally {
      rmTemp(t.base);
    }
  });
});
