// Concurrency matrix: four deterministic races over real child processes.
//
// Method: every race overlaps real `node dist/cli-entry.js` processes by
// spawning them together and joining with Promise.all (the spawn/join is
// the only synchronization). There are no sleeps, no polls, no timing
// thresholds, no barrier files with timeouts. Whatever interleaving the OS
// picks, each test asserts the same online invariants: contiguous world
// sequences (exactly one world per accepted publish, never a partial
// world), same-operation-id resume for losers, documented error codes with
// the exit-code contract (2 on E_CONFLICT/E_STALE, 1 otherwise), and
// `verify --full`.
//
// Losers settle with immediate, bounded retries reusing their
// --operation-id (idempotent resume, cf. tests/recovery.test.ts), never
// with backoff: convergence comes from CAS, not timing.

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_PATH,
  createLayer,
  mkTempRepo,
  readWs,
  rmTemp,
  runCli,
  runCliJson,
  writeWs
} from "./e2e-helpers";

interface ConcResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: any;
}

/** Async `node <CLI> ... --json`, mirroring runCliJson but non-blocking so
 *  races overlap in real OS processes instead of serializing on spawnSync. */
function runCliAsync(repoDir: string, args: ReadonlyArray<string>, env?: Record<string, string>): Promise<ConcResult> {
  const withJson = args.includes("--json") ? [...args] : [...args, "--json"];
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_PATH, ...withJson], {
      cwd: repoDir,
      env: { ...process.env, ...(env ?? {}) }
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", (e: Error) => {
      resolve({ code: 1, stdout: "", stderr: `spawn failed: ${e.message}`, json: null });
    });
    child.on("close", (code) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      resolve({ code: code ?? 1, stdout, stderr, json });
    });
  });
}

/** Fail fast with raw output when a child produced no JSON (host-load spawn
 *  flake per PR 14): that is a harness signal, not an assertion subject. */
function requireJson(r: ConcResult, what: string): any {
  if (r.json === null) {
    throw new Error(
      `${what}: no JSON output (code=${r.code} stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 500)})`
    );
  }
  return r.json;
}

/** Exit-code contract from src/cli.ts: 2 on E_CONFLICT/E_STALE, 1 otherwise. */
function expectExitContract(r: ConcResult, what: string): void {
  const j = requireJson(r, what);
  if (r.code === 0) {
    expect(j.ok).toBe(true);
    return;
  }
  expect(j.ok).toBe(false);
  const code = j.error.code as string;
  expect(typeof code).toBe("string");
  if (code === "E_CONFLICT" || code === "E_STALE") expect(r.code).toBe(2);
  else expect(r.code).toBe(1);
}

const isRetryable = (r: ConcResult): boolean =>
  r.code !== 0 && r.json !== null && r.json?.error?.retryable === true;

/** Re-run the same publish operation-id until it lands or fails
 *  non-retryably. Immediate bounded retries: resume is deterministic
 *  (journal terminal states), not timing-dependent. */
async function settlePublish(
  repo: string,
  layerId: string,
  op: string,
  first: ConcResult,
  maxExtra = 5
): Promise<ConcResult> {
  let cur = first;
  let extra = 0;
  while (isRetryable(cur) && extra < maxExtra) {
    extra++;
    cur = await runCliAsync(repo, ["publish", layerId, "--operation-id", op]);
    expectExitContract(cur, `publish retry ${extra} layer ${layerId}`);
  }
  return cur;
}

function worldSeqs(repo: string): Array<number> {
  const hist = runCliJson(repo, ["history", "--world"]);
  expect(hist.code).toBe(0);
  return (hist.json.worlds as Array<{ seq: number }>)
    .map((w) => w.seq)
    .sort((x, y) => x - y);
}

function expectContiguousWorlds(repo: string, count: number): void {
  expect(worldSeqs(repo)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
}

function expectVerifyFull(repo: string): void {
  const v = runCli(repo, ["verify", "--full"]);
  expect(v.code).toBe(0);
  expect(v.stdout).toContain("verified");
}

function checkpointOf(repo: string, layerId: string): string {
  const s = runCliJson(repo, ["layer", "status", layerId]);
  expect(s.code).toBe(0);
  return s.json.layer.checkpoint as string;
}

describe("concurrency matrix: concurrent publishers", () => {
  test("two concurrent publishers yield v2+v3, losers retry cleanly", async () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "PA");
      const b = createLayer(repo, "PB");
      writeWs(repo, a.id, "pa.txt", "from-a\n");
      writeWs(repo, b.id, "pb.txt", "from-b\n");
      const opA = "a".repeat(32);
      const opB = "b".repeat(32);

      // Overlap the publishes: the spawn/join is the only synchronization.
      const [firstA, firstB] = await Promise.all([
        runCliAsync(repo, ["publish", a.id, "--operation-id", opA]),
        runCliAsync(repo, ["publish", b.id, "--operation-id", opB])
      ]);
      expectExitContract(firstA, "publish A first attempt");
      expectExitContract(firstB, "publish B first attempt");
      // Losers carry only documented codes: retryable E_STALE/E_BUSY, or a
      // deterministic conflict (impossible here: disjoint files).
      for (const r of [firstA, firstB]) {
        if (r.code !== 0) {
          expect(["E_STALE", "E_BUSY", "E_CONFLICT"]).toContain(r.json.error.code);
          if (r.json.error.code !== "E_CONFLICT") expect(r.json.error.retryable).toBe(true);
        }
      }

      const finalA = await settlePublish(repo, a.id, opA, firstA);
      const finalB = await settlePublish(repo, b.id, opB, firstB);
      expect(finalA.code).toBe(0);
      expect(finalB.code).toBe(0);
      expect(["published", "recovered"]).toContain(finalA.json.status);
      expect(["published", "recovered"]).toContain(finalB.json.status);

      // Exactly one world per accepted publish: distinct worlds, seqs {2,3}.
      expect(finalA.json.world).not.toBe(finalB.json.world);
      expect([finalA.json.seq, finalB.json.seq].sort()).toEqual([2, 3]);
      expectContiguousWorlds(repo, 3);

      // No partial worlds: both files land, full verify passes, both layers
      // are published exactly once.
      const diff = runCliJson(repo, ["diff", "v1", "v3"]);
      expect(diff.code).toBe(0);
      const paths = (diff.json.changes as Array<{ path: string }>).map((c) => c.path);
      expect(paths).toContain("pa.txt");
      expect(paths).toContain("pb.txt");
      const list = runCliJson(repo, ["layer", "list"]);
      const byId = new Map((list.json.layers as Array<any>).map((l) => [l.id, l]));
      expect(byId.get(a.id)?.state).toBe("published");
      expect(byId.get(b.id)?.state).toBe("published");
      expectVerifyFull(repo);
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("concurrency matrix: checkpoint vs publish", () => {
  test("checkpoint racing publish never corrupts; publish lands exactly once", async () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const l = createLayer(repo, "CP");
      writeWs(repo, l.id, "cp.txt", "cp\n");
      const op = "c".repeat(32);

      const [ckpt, firstPub] = await Promise.all([
        runCliAsync(repo, ["checkpoint", "--layer", l.id]),
        runCliAsync(repo, ["publish", l.id, "--operation-id", op])
      ]);
      expectExitContract(ckpt, "checkpoint attempt");
      expectExitContract(firstPub, "publish first attempt");
      // Checkpoint either wins (any checkpoint id) or loses with retryable
      // E_BUSY against publish's flush; it must never corrupt.
      if (ckpt.code !== 0) {
        expect(ckpt.json.error.code).toBe("E_BUSY");
        expect(ckpt.json.error.retryable).toBe(true);
      } else {
        expect(typeof ckpt.json.checkpoint).toBe("string");
      }

      const pub = await settlePublish(repo, l.id, op, firstPub);
      expect(pub.code).toBe(0);
      expect(pub.json.seq).toBe(2);
      expect(["published", "recovered"]).toContain(pub.json.status);

      // Exactly one new world, intact layer chain, full verify passes.
      expectContiguousWorlds(repo, 2);
      const diff = runCliJson(repo, ["diff", "v1", "v2"]);
      expect(diff.code).toBe(0);
      expect((diff.json.changes as Array<{ path: string }>).map((c) => c.path)).toContain("cp.txt");
      expect(runCliJson(repo, ["history", "--layer", l.id]).code).toBe(0);
      expect(runCliJson(repo, ["layer", "status", l.id]).json.layer.state).toBe("published");
      expectVerifyFull(repo);
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("concurrency matrix: stack vs source delete", () => {
  test("conflicting stack fails without touching sources", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const a = createLayer(repo, "KA");
      const b = createLayer(repo, "KB");
      writeWs(repo, a.id, "clash.txt", "from-a\n");
      writeWs(repo, b.id, "clash.txt", "from-b\n");
      const listBefore = runCliJson(repo, ["layer", "list"]);
      expect(listBefore.code).toBe(0);
      const byIdBefore = new Map((listBefore.json.layers as Array<any>).map((l) => [l.id, l]));
      const idsBefore = [...byIdBefore.keys()].sort();

      const s = runCliJson(repo, ["stack", a.id, b.id, "--into", "combo"]);
      expect(s.code).toBe(2);
      expect(s.json.error.code).toBe("E_CONFLICT");
      expect(JSON.stringify(s.json.error.paths ?? s.json.error.message)).toContain("clash.txt");

      // Failed stack leaves source layer states and membership unchanged
      // (only their flush checkpoints may advance: stack flushes sources to
      // durable inputs before detecting the conflict).
      const listAfter = runCliJson(repo, ["layer", "list"]);
      expect(listAfter.code).toBe(0);
      const byIdAfter = new Map((listAfter.json.layers as Array<any>).map((l) => [l.id, l]));
      expect([...byIdAfter.keys()].sort()).toEqual(idsBefore);
      for (const id of idsBefore) {
        expect(byIdAfter.get(id)?.state).toBe(byIdBefore.get(id)?.state);
      }
      expect(byIdAfter.get(a.id)?.state).toBe("active");
      expect(byIdAfter.get(b.id)?.state).toBe("active");
      expect(readWs(repo, a.id, "clash.txt")).toBe("from-a\n");
      expect(readWs(repo, b.id, "clash.txt")).toBe("from-b\n");
      expectContiguousWorlds(repo, 1);
      expectVerifyFull(repo);
    } finally {
      rmTemp(t.base);
    }
  });

  // Delete-then-stack race, fully deterministic and sleep-free: a live
  // (non-terminal) stack journal blocks the delete with retryable E_BUSY
  // (delete safety, cf. tests/recovery.test.ts), while a finalized journal
  // lets the delete through. The journal is the real synchronization
  // primitive the implementation itself uses; planting entries exercises the
  // exact race windows (stack in prepared vs. stack settled) with no timing
  // dependence. A genuinely concurrent spawn pair is asserted separately to
  // converge to one winner; both orders are accepted because the ~300ms
  // node-boot stagger makes the delete-vs-unjournalled-stack window the
  // common outcome (stack then fails E_BUSY/E_LAYER_STATE on the CAS or
  // the source check), while the stack-wins order is covered by the live-
  // journal case and the real-overlap case below.
  test("stack journal state decides delete: live blocks, finalized allows", async () => {
    const { writeFile } = await import("node:fs/promises");
    for (const state of ["prepared", "finalized"] as const) {
      const t = mkTempRepo({ "a.txt": "base\n" });
      try {
        const repo = t.repo;
        const c = createLayer(repo, "RC");
        const d = createLayer(repo, "RD");
        writeWs(repo, c.id, "sc.txt", "from-c\n");
        writeWs(repo, d.id, "sd.txt", "from-d\n");
        const stackOp = "d".repeat(32);
        await writeFile(
          join(repo, ".javelin", "journal", `${stackOp}.json`),
          JSON.stringify({
            op: stackOp,
            kind: "stack",
            state,
            operationId: stackOp,
            payload: { sources: [c.id, d.id] },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          })
        );
        const del = runCliJson(repo, ["layer", "delete", c.id]);
        const list = runCliJson(repo, ["layer", "list"]);
        expect(list.code).toBe(0);
        const byId = new Map((list.json.layers as Array<any>).map((l) => [l.id, l]));
        if (state === "prepared") {
          // Live stack cites the source: delete refuses, nothing changes.
          expect(del.code).toBe(1);
          expect(del.json.error.code).toBe("E_BUSY");
          expect(del.json.error.retryable).toBe(true);
          expect(byId.get(c.id)?.state).toBe("active");
          expect(byId.get(d.id)?.state).toBe("active");
          expect(readWs(repo, c.id, "sc.txt")).toBe("from-c\n");
        } else {
          // Settled stack no longer pins the source: delete succeeds, the
          // sibling is untouched, worlds are unchanged.
          expect(del.code).toBe(0);
          expect(byId.has(c.id)).toBe(false);
          expect(byId.get(d.id)?.state).toBe("active");
          expect(readWs(repo, d.id, "sd.txt")).toBe("from-d\n");
          expectContiguousWorlds(repo, 1);
        }
        expectVerifyFull(repo);
      } finally {
        rmTemp(t.base);
      }
    }
  });

  test("real stack/delete overlap converges with no partial destination", async () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const c = createLayer(repo, "RC");
      const d = createLayer(repo, "RD");
      writeWs(repo, c.id, "sc.txt", "from-c\n");
      writeWs(repo, d.id, "sd.txt", "from-d\n");
      const ckptD = checkpointOf(repo, d.id);
      const opS = "d".repeat(32);

      // Overlap the ops: the spawn/join is the only synchronization.
      const [stackRes, delRes] = await Promise.all([
        runCliAsync(repo, ["stack", c.id, d.id, "--into", "combo", "--operation-id", opS]),
        runCliAsync(repo, ["layer", "delete", c.id])
      ]);
      expectExitContract(stackRes, "stack attempt");
      expectExitContract(delRes, "delete attempt");
      const stackOk = stackRes.code === 0;
      const delOk = delRes.code === 0;

      const list = runCliJson(repo, ["layer", "list"]);
      expect(list.code).toBe(0);
      const byId = new Map((list.json.layers as Array<any>).map((l) => [l.id, l]));
      // Stack journals its intent before flushing, so exactly one op wins:
      // the loser fails with a documented code and sources keep terminal
      // states. Both-succeed with a consumed deleted source is rejected.
      expect(stackOk && delOk).toBe(false);
      if (stackOk) {
        // Stack won the race: delete lost with retryable E_BUSY and the
        // stack result is fully intact.
        expect(delRes.json.error.code).toBe("E_BUSY");
        expect(delRes.json.error.retryable).toBe(true);
        expect(byId.get(c.id)?.state).toBe("consumed");
        expect(byId.get(d.id)?.state).toBe("consumed");
        const destWs = requireJson(stackRes, "stack result").workspace as string;
        expect(readFileSync(join(destWs, "sc.txt"), "utf8")).toBe("from-c\n");
        expect(readFileSync(join(destWs, "sd.txt"), "utf8")).toBe("from-d\n");
      } else if (delOk) {
        // Delete won the race: stack lost with E_BUSY/E_LAYER_STATE, the
        // untouched source is unchanged, and no partial destination exists.
        expect(["E_BUSY", "E_LAYER_STATE"]).toContain(stackRes.json.error.code);
        expect(byId.has(c.id)).toBe(false);
        expect(byId.get(d.id)?.state).toBe("active");
        expect(checkpointOf(repo, d.id)).toBe(ckptD);
        expect(readWs(repo, d.id, "sd.txt")).toBe("from-d\n");
        expect((list.json.layers as Array<any>).some((l) => l.name === "combo")).toBe(false);
      } else {
        throw new Error(
          `both ops failed: stack=${JSON.stringify(stackRes.json)} delete=${JSON.stringify(delRes.json)}`
        );
      }

      // Neither op creates worlds; the repo stays consistent on every path.
      expectContiguousWorlds(repo, 1);
      expectVerifyFull(repo);
    } finally {
      rmTemp(t.base);
    }
  });

  // Deterministic regression for the stack/delete lost update (no sleeps,
  // no spawned overlap): stack journals its intent first, then a racing
  // delete must refuse with retryable E_BUSY while the stack journal is
  // live, and the stack must then land with both sources consumed and a
  // whole destination. Covers the flushLayer blind-write window: the old
  // flush resurrected a tombstoned layer via stale saveRefs, so the final
  // CAS consumed a deleted source; the new CAS-aware flush plus journal
  // guard converges to exactly one winner instead.
  test("stack-then-delete: live stack journal blocks delete, stack lands whole", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const c = createLayer(repo, "RC");
      const d = createLayer(repo, "RD");
      writeWs(repo, c.id, "sc.txt", "from-c\n");
      writeWs(repo, d.id, "sd.txt", "from-d\n");
      const ckptC = checkpointOf(repo, c.id);
      const ckptD = checkpointOf(repo, d.id);
      const stackOp = "e".repeat(32);

      // Journal the stack intent directly (what stack does before its
      // flushes): a racing delete must refuse with retryable E_BUSY.
      runCliJson(repo, ["stack", c.id, d.id, "--into", "combo", "--operation-id", stackOp], {
        JVCLI_FAULT: "stack:after-prepared"
      });
      const del = runCliJson(repo, ["layer", "delete", c.id]);
      expect(del.code).toBe(1);
      expect(del.json.ok).toBe(false);
      expect(del.json.error.code).toBe("E_BUSY");
      expect(del.json.error.retryable).toBe(true);

      // Sources untouched while the stack journal is live.
      let list = runCliJson(repo, ["layer", "list"]);
      expect(list.code).toBe(0);
      let byId = new Map((list.json.layers as Array<any>).map((l) => [l.id, l]));
      expect(byId.get(c.id)?.state).toBe("active");
      expect(byId.get(d.id)?.state).toBe("active");
      expect(checkpointOf(repo, c.id)).toBe(ckptC);
      expect(checkpointOf(repo, d.id)).toBe(ckptD);

      // Retrying the same stack op-id resumes past prepared and lands
      // whole: both sources consumed, destination has both files.
      const s = runCliJson(repo, ["stack", c.id, d.id, "--into", "combo", "--operation-id", stackOp]);
      expect(s.code).toBe(0);
      list = runCliJson(repo, ["layer", "list"]);
      expect(list.code).toBe(0);
      byId = new Map((list.json.layers as Array<any>).map((l) => [l.id, l]));
      expect(byId.get(c.id)?.state).toBe("consumed");
      expect(byId.get(d.id)?.state).toBe("consumed");
      const destWs = s.json.workspace as string;
      expect(readFileSync(join(destWs, "sc.txt"), "utf8")).toBe("from-c\n");
      expect(readFileSync(join(destWs, "sd.txt"), "utf8")).toBe("from-d\n");

      expectContiguousWorlds(repo, 1);
      expectVerifyFull(repo);
    } finally {
      rmTemp(t.base);
    }
  });

  // Mirror ordering, fully serial and sleep-free: delete's CAS lands
  // first, then stack must fail on the terminal source with E_LAYER_STATE,
  // leave the sibling active at its pre-stack checkpoint, create no
  // destination, and never resurrect the deleted layer. Raw refs.json is
  // checked because `layer list` hides deleted layers.
  test("delete-then-stack fails cleanly with no resurrection and no partial dest", () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const c = createLayer(repo, "RC");
      const d = createLayer(repo, "RD");
      writeWs(repo, c.id, "sc.txt", "from-c\n");
      writeWs(repo, d.id, "sd.txt", "from-d\n");
      const ckptD = checkpointOf(repo, d.id);

      const del = runCliJson(repo, ["layer", "delete", c.id]);
      expect(del.code).toBe(0);

      const s = runCliJson(repo, ["stack", c.id, d.id, "--into", "combo"]);
      expect(s.code).toBe(1);
      expect(s.json.ok).toBe(false);
      expect(s.json.error.code).toBe("E_LAYER_STATE");

      const list = runCliJson(repo, ["layer", "list"]);
      expect(list.code).toBe(0);
      const byId = new Map((list.json.layers as Array<any>).map((l) => [l.id, l]));
      expect(byId.has(c.id)).toBe(false);
      expect(byId.get(d.id)?.state).toBe("active");
      expect(checkpointOf(repo, d.id)).toBe(ckptD);
      expect(readWs(repo, d.id, "sd.txt")).toBe("from-d\n");
      expect((list.json.layers as Array<any>).some((l) => l.name === "combo")).toBe(false);

      const refs = JSON.parse(readFileSync(join(repo, ".javelin", "refs.json"), "utf8")) as {
        layers: Record<string, { state: string }>;
      };
      expect(refs.layers[c.id]?.state).toBe("deleted");
      expect(refs.layers[d.id]?.state).toBe("active");

      expectContiguousWorlds(repo, 1);
      expectVerifyFull(repo);
    } finally {
      rmTemp(t.base);
    }
  });
});

describe("concurrency matrix: gc vs publication", () => {
  test("gc racing publish keeps the new world durable (quarantine respected)", async () => {
    const t = mkTempRepo({ "a.txt": "base\n" });
    try {
      const repo = t.repo;
      const g = createLayer(repo, "GC");
      writeWs(repo, g.id, "g.txt", "gc-durable\n");
      const op = "e".repeat(32);

      const [firstPub, gcRes] = await Promise.all([
        runCliAsync(repo, ["publish", g.id, "--operation-id", op]),
        runCliAsync(repo, ["gc"])
      ]);
      expectExitContract(firstPub, "publish first attempt");
      expectExitContract(gcRes, "concurrent gc");
      expect(gcRes.code).toBe(0);
      expect(gcRes.json.ok).toBe(true);

      const pub = await settlePublish(repo, g.id, op, firstPub);
      expect(pub.code).toBe(0);
      expect(pub.json.seq).toBe(2);

      // The concurrent writer's objects survived: contiguous worlds, exact
      // bytes readable, full verify passes.
      expectContiguousWorlds(repo, 2);
      const diff = runCliJson(repo, ["diff", "v1", "v2"]);
      expect(diff.code).toBe(0);
      const entry = (diff.json.changes as Array<{ path: string; newBlob: string }>).find((x) => x.path === "g.txt");
      expect(entry).toBeDefined();
      const shown = runCli(repo, ["show", entry!.newBlob]);
      expect(shown.code).toBe(0);
      expect(shown.stdout).toBe("gc-durable\n");
      expectVerifyFull(repo);

      // A second real gc after the publish settles still deletes nothing
      // durable: quarantine respected, world intact.
      const gc2 = runCliJson(repo, ["gc"]);
      expect(gc2.code).toBe(0);
      expect(gc2.json.ok).toBe(true);
      const shown2 = runCli(repo, ["show", entry!.newBlob]);
      expect(shown2.code).toBe(0);
      expect(shown2.stdout).toBe("gc-durable\n");
      expectVerifyFull(repo);
    } finally {
      rmTemp(t.base);
    }
  });
});
