import { describe, test, expect } from "bun:test";
import { chmodSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLayer, mkTempRepo, rmTemp, runCli, runCliJson, writeWs } from "./e2e-helpers";

const readJournal = (repo: string, op: string): any =>
  JSON.parse(readFileSync(join(repo, ".javelin", "journal", `${op}.json`), "utf8"));

const historyCount = (repo: string): number => {
  const h = runCliJson(repo, ["history", "--world"]);
  expect(h.code).toBe(0);
  return (h.json.worlds as Array<any>).length;
};

const layerStates = (repo: string): Map<string, string> => {
  const list = runCliJson(repo, ["layer", "list"]);
  expect(list.code).toBe(0);
  return new Map((list.json.layers as Array<any>).map((l) => [l.id as string, l.state as string]));
};

const checkpointCount = (repo: string, layer: string): number => {
  const h = runCliJson(repo, ["history", "--layer", layer]);
  expect(h.code).toBe(0);
  return (h.json.checkpoints as Array<any>).length;
};

describe("fault matrix: checkpoint", () => {
  test("checkpoint:after-prepared fails retryable, verify clean, retry creates one checkpoint", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "CK1");
      writeWs(repo, a.id, "w.txt", "work\n");
      const before = checkpointCount(repo, a.id);
      const crashed = runCliJson(repo, ["checkpoint", "--layer", a.id], { JVCLI_FAULT: "checkpoint:after-prepared" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(crashed.json.error.retryable).toBe(true);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["checkpoint", "--layer", a.id]);
      expect(retry.code).toBe(0);
      expect(checkpointCount(repo, a.id)).toBe(before + 1);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });

  test("checkpoint:after-objects-durable is durable; retry does not duplicate", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "CK2");
      writeWs(repo, a.id, "w.txt", "work\n");
      const before = checkpointCount(repo, a.id);
      const crashed = runCliJson(repo, ["checkpoint", "--layer", a.id], { JVCLI_FAULT: "checkpoint:after-objects-durable" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["checkpoint", "--layer", a.id]);
      expect(retry.code).toBe(0);
      expect(checkpointCount(repo, a.id)).toBe(before + 1);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("fault matrix: refresh", () => {
  const seedStale = (repo: string): { a: string } => {
    const a = createLayer(repo, "RFA");
    const b = createLayer(repo, "RFB");
    writeWs(repo, b.id, "bump.txt", "bump\n");
    expect(runCliJson(repo, ["publish", b.id]).code).toBe(0);
    return { a: a.id };
  };

  test("refresh:after-prepared retries to a single re-anchored checkpoint", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { a } = seedStale(repo);
      const before = checkpointCount(repo, a);
      const crashed = runCliJson(repo, ["layer", "refresh", a], { JVCLI_FAULT: "refresh:after-prepared" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["layer", "refresh", a]);
      expect(retry.code).toBe(0);
      expect(checkpointCount(repo, a)).toBe(before + 1);
      const status = runCliJson(repo, ["layer", "status", a]);
      expect(status.json.layer.stale).toBe(false);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });

  test("refresh:after-merge-durable reuses journaled objects without duplicating", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { a } = seedStale(repo);
      const before = checkpointCount(repo, a);
      const crashed = runCliJson(repo, ["layer", "refresh", a], { JVCLI_FAULT: "refresh:after-merge-durable" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["layer", "refresh", a]);
      expect(retry.code).toBe(0);
      expect(checkpointCount(repo, a)).toBe(before + 1);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });

  test("refresh:after-accepted leaves the layer re-anchored; plain retry is then a no-op", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { a } = seedStale(repo);
      const before = checkpointCount(repo, a);
      const crashed = runCliJson(repo, ["layer", "refresh", a], { JVCLI_FAULT: "refresh:after-accepted" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const afterCrash = checkpointCount(repo, a);
      expect(afterCrash).toBe(before + 1);
      const status = runCliJson(repo, ["layer", "status", a]);
      expect(status.json.layer.stale).toBe(false);
      const retry = runCliJson(repo, ["layer", "refresh", a]);
      expect(retry.code).toBe(0);
      expect(checkpointCount(repo, a)).toBe(afterCrash);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("fault matrix: stack", () => {
  const seedStack = (repo: string): { a: string; b: string } => {
    const a = createLayer(repo, "STA");
    const b = createLayer(repo, "STB");
    writeWs(repo, a.id, "aa.txt", "from-a\n");
    writeWs(repo, b.id, "bb.txt", "from-b\n");
    return { a: a.id, b: b.id };
  };

  test("stack:after-prepared retries into one destination", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { a, b } = seedStack(repo);
      const op = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
      const crashed = runCliJson(repo, ["stack", a, b, "--into", "combo", "--operation-id", op], { JVCLI_FAULT: "stack:after-prepared" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(readJournal(repo, op).state).toBe("prepared");
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["stack", a, b, "--into", "combo", "--operation-id", op]);
      expect(retry.code).toBe(0);
      const dest = retry.json.dest as string;
      const states = layerStates(repo);
      expect(states.get(dest)).toBe("active");
      expect(states.get(a)).toBe("consumed");
      expect(states.get(b)).toBe("consumed");
      const again = runCliJson(repo, ["stack", a, b, "--into", "combo", "--operation-id", op]);
      expect(again.code).toBe(0);
      expect(again.json.dest).toBe(dest);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });

  test("stack:after-objects-durable retries into the same destination, no duplicate", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { a, b } = seedStack(repo);
      const op = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
      const crashed = runCliJson(repo, ["stack", a, b, "--into", "combo", "--operation-id", op], { JVCLI_FAULT: "stack:after-objects-durable" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      const entry = readJournal(repo, op);
      expect(entry.state).toBe("objects_durable");
      expect(typeof entry.payload.dest).toBe("string");
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["stack", a, b, "--into", "combo", "--operation-id", op]);
      expect(retry.code).toBe(0);
      expect(retry.json.dest).toBe(entry.payload.dest);
      const list = runCliJson(repo, ["layer", "list"]);
      expect((list.json.layers as Array<any>).filter((l) => l.name === "combo")).toHaveLength(1);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });

  test("stack:after-accepted recovers the existing destination on retry", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { a, b } = seedStack(repo);
      const op = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
      const crashed = runCliJson(repo, ["stack", a, b, "--into", "combo", "--operation-id", op], { JVCLI_FAULT: "stack:after-accepted" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["stack", a, b, "--into", "combo", "--operation-id", op]);
      expect(retry.code).toBe(0);
      expect(retry.json.dest).toBe(readJournal(repo, op).payload.dest);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("fault matrix: delete-layer", () => {
  test("delete-layer:after-accepted retries to the same tombstone", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "DELA");
      const crashed = runCliJson(repo, ["layer", "delete", id], { JVCLI_FAULT: "delete-layer:after-accepted" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["layer", "delete", id]);
      expect(retry.code).toBe(0);
      const list = runCliJson(repo, ["layer", "list"]);
      expect((list.json.layers as Array<any>).map((l: any) => l.id)).not.toContain(id);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });

  test("delete-layer:after-workspace-removed retries idempotently", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "DELB");
      const crashed = runCliJson(repo, ["layer", "delete", id], { JVCLI_FAULT: "delete-layer:after-workspace-removed" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["layer", "delete", id]);
      expect(retry.code).toBe(0);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("fault matrix: gc", () => {
  test("gc:after-prepared verifies clean and retries to the same result", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "GCD");
      expect(runCliJson(repo, ["layer", "delete", id]).code).toBe(0);
      const crashed = runCliJson(repo, ["gc"], { JVCLI_FAULT: "gc:after-prepared" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["gc"]);
      expect(retry.code).toBe(0);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });

  test("gc:after-mark deletes nothing; retry completes", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "GCM");
      expect(runCliJson(repo, ["layer", "delete", id]).code).toBe(0);
      const crashed = runCliJson(repo, ["gc"], { JVCLI_FAULT: "gc:after-mark" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["gc"]);
      expect(retry.code).toBe(0);
      expect(retry.json.ok).toBe(true);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });

  test("gc:after-sweep retries to a recorded result", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const { id } = createLayer(repo, "GCS");
      expect(runCliJson(repo, ["layer", "delete", id]).code).toBe(0);
      const crashed = runCliJson(repo, ["gc"], { JVCLI_FAULT: "gc:after-sweep" });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.error.code).toBe("E_INTERRUPTED");
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["gc"]);
      expect(retry.code).toBe(0);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("fault matrix: store boundary (disk-full / short-write)", () => {
  test("unwritable objects dir fails the op but leaves a verifiable repo; retry succeeds", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "DISK");
      writeWs(repo, a.id, "d.txt", "data\n");
      const before = historyCount(repo);
      const objectsDir = join(repo, ".javelin", "objects");
      chmodSync(objectsDir, 0o555);
      let crashed;
      try {
        crashed = runCliJson(repo, ["publish", a.id]);
      } finally {
        chmodSync(objectsDir, 0o755);
      }
      expect(crashed.code).not.toBe(0);
      expect(crashed.json).not.toBeNull();
      expect(crashed.json.ok).toBe(false);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
      const retry = runCliJson(repo, ["publish", a.id]);
      expect(retry.code).toBe(0);
      expect(retry.json.seq).toBe(before + 1);
      expect(historyCount(repo)).toBe(before + 1);
      expect(runCli(repo, ["verify", "--full"]).code).toBe(0);
    } finally {
      try {
        chmodSync(join(t.repo, ".javelin", "objects"), 0o755);
      } catch { /* already cleaned */ }
      rmTemp(t.base);
    }
  });

  test("truncated object bytes are rejected on read; verify flags the corruption", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "SHORT");
      writeWs(repo, a.id, "s.txt", "short-write-probe\n");
      expect(runCliJson(repo, ["publish", a.id]).code).toBe(0);
      const hist = runCliJson(repo, ["history", "--world"]);
      expect(hist.code).toBe(0);
      const worlds = hist.json.worlds as Array<any>;
      const newest = worlds[worlds.length - 1];
      const worldId = newest.id as string;
      const objPath = join(repo, ".javelin", "objects", worldId.slice(0, 2), worldId.slice(2));
      expect(existsSync(objPath)).toBe(true);
      const { readFileSync: readSync, writeFileSync: writeSync } = require("node:fs") as typeof import("node:fs");
      const full = readSync(objPath);
      writeSync(objPath, full.subarray(0, Math.max(1, Math.floor(full.length / 2))));
      const v = runCli(repo, ["verify", "--full"]);
      expect(v.code).not.toBe(0);
      expect(`${v.stdout}${v.stderr}`).toContain("E_CORRUPT_OBJECT");
    } finally {
      rmTemp(t.base);
    }
  });
});
