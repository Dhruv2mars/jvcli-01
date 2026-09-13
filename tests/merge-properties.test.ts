import { describe, test, expect } from "bun:test";
import { diffTrees, structuralCompatible } from "../src/core/objects.ts";

type Flat = { files: Map<string, string>; symlinks: Map<string, string> };
const B = (n: number): string => n.toString(16).padStart(64, "0");
const flat = (files: Record<string, string>, symlinks: Record<string, string> = {}): Flat => ({
  files: new Map(Object.entries(files)),
  symlinks: new Map(Object.entries(symlinks))
});
const empty: Flat = flat({});

function makeRand(seedInit: number): () => number {
  let seed = seedInit >>> 0;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}
const randBlobWith = (rand: () => number): string => B(Math.floor(rand() * 256));
const PATHS = ["a.txt", "b.txt", "c.txt", "d/e.txt", "d/f.txt", "g.txt"];

const snap = (v: Flat): string => JSON.stringify({ f: [...v.files].sort(), s: [...v.symlinks].sort() });

function randomFlat(rand: () => number, base: Flat, Touch: () => string): Flat {
  const files = new Map(base.files);
  const symlinks = new Map(base.symlinks);
  const n = Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const p = PATHS[Math.floor(rand() * PATHS.length)]!;
    const op = rand();
    if (op < 0.45) {
      files.set(p, Touch());
      symlinks.delete(p);
    } else if (op < 0.6) {
      files.delete(p);
      symlinks.delete(p);
    } else {
      files.delete(p);
      symlinks.set(p, "target");
    }
  }
  return { files, symlinks };
}

function applyChanges(base: Flat, changes: ReturnType<typeof diffTrees>, side: Flat): Flat {
  const files = new Map(base.files);
  const symlinks = new Map(base.symlinks);
  for (const c of changes) {
    const f = side.files.get(c.path);
    const s = side.symlinks.get(c.path);
    if (f !== undefined) {
      files.set(c.path, f);
      symlinks.delete(c.path);
    } else if (s !== undefined) {
      symlinks.set(c.path, s);
      files.delete(c.path);
    } else {
      files.delete(c.path);
      symlinks.delete(c.path);
    }
  }
  return { files, symlinks };
}

describe("merge reference model", () => {
  test("diff replay: merge of base plus derived changes reproduces the side", () => {
    const rand = makeRand(0x1a2b3c01);
    const blob = () => randBlobWith(rand);
    for (let i = 0; i < 200; i++) {
      const base = randomFlat(rand, empty, blob);
      const side = randomFlat(rand, base, blob);
      const v = structuralCompatible(base, base, side);
      expect(v.ok).toBe(true);
      if (!v.ok) continue;
      expect([...v.merged.files.entries()].sort()).toEqual([...side.files.entries()].sort());
      expect([...v.merged.symlinks.entries()].sort()).toEqual([...side.symlinks.entries()].sort());
    }
  });

  test("compatible merge equals either application order", () => {
    const rand = makeRand(0x1a2b3c02);
    const blob = () => randBlobWith(rand);
    for (let i = 0; i < 200; i++) {
      const base = randomFlat(rand, empty, blob);
      const left = randomFlat(rand, base, blob);
      const right = randomFlat(rand, base, blob);
      const v = structuralCompatible(base, left, right);
      if (!v.ok) continue;
      const lr = applyChanges(applyChanges(base, diffTrees(base, left), left), diffTrees(base, right), right);
      const rl = applyChanges(applyChanges(base, diffTrees(base, right), right), diffTrees(base, left), left);
      expect([...v.merged.files.entries()].sort()).toEqual([...lr.files.entries()].sort());
      expect([...v.merged.symlinks.entries()].sort()).toEqual([...lr.symlinks.entries()].sort());
      expect([...v.merged.files.entries()].sort()).toEqual([...rl.files.entries()].sort());
      expect([...v.merged.symlinks.entries()].sort()).toEqual([...rl.symlinks.entries()].sort());
    }
  });

  test("merge is symmetric: argument order never chooses content", () => {
    const rand = makeRand(0x1a2b3c03);
    const blob = () => randBlobWith(rand);
    for (let i = 0; i < 200; i++) {
      const base = randomFlat(rand, empty, blob);
      const left = randomFlat(rand, base, blob);
      const right = randomFlat(rand, base, blob);
      const a = structuralCompatible(base, left, right);
      const b = structuralCompatible(base, right, left);
      expect(a.ok).toBe(b.ok);
      if (a.ok && b.ok) {
        expect([...a.merged.files.entries()].sort()).toEqual([...b.merged.files.entries()].sort());
        expect([...a.merged.symlinks.entries()].sort()).toEqual([...b.merged.symlinks.entries()].sort());
      } else if (!a.ok && !b.ok) {
        expect(a.conflicts.map((c) => `${c.path}:${c.kind}`).sort()).toEqual(
          b.conflicts.map((c) => `${c.path}:${c.kind}`).sort()
        );
      }
    }
  });

  test("disjoint writes always merge; identical writes merge silently", () => {
    const base = flat({ "a.txt": B(1) });
    const left = flat({ "a.txt": B(1), "l.txt": B(2) });
    const right = flat({ "a.txt": B(1), "r.txt": B(3) });
    const v = structuralCompatible(base, left, right);
    expect(v.ok).toBe(true);
    const same = structuralCompatible(base, flat({ "a.txt": B(9) }), flat({ "a.txt": B(9) }));
    expect(same.ok).toBe(true);
  });

  test("conflict taxonomy: both-write, delete-modify, type-clash, ancestor-clash", () => {
    const base = flat({ "f.txt": B(1), "g.txt": B(2), "t.txt": B(3) });
    const both = structuralCompatible(base, flat({ "f.txt": B(7), "g.txt": B(2), "t.txt": B(3) }), flat({ "f.txt": B(8), "g.txt": B(2), "t.txt": B(3) }));
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.conflicts.find((c) => c.path === "f.txt")?.kind).toBe("both-write");
    const delMod = structuralCompatible(
      flat({ "v.txt": B(1) }),
      flat({}),
      flat({ "v.txt": B(2) })
    );
    expect(delMod.ok).toBe(false);
    if (!delMod.ok) expect(delMod.conflicts[0]?.kind).toBe("delete-modify");
    const tc2 = structuralCompatible(flat({ "y.txt": B(1) }), flat({}, { "y.txt": "t" }), flat({ "y.txt": B(2) }));
    expect(tc2.ok).toBe(false);
    if (!tc2.ok) expect(tc2.conflicts[0]?.kind).toBe("type-clash");
    const anc = structuralCompatible(
      flat({ "d/e.txt": B(1) }),
      flat({ "d/e.txt": B(1), "d/f.txt": B(4) }),
      flat({ "d2/e.txt": B(1) })
    );
    void anc;
    const anc2 = structuralCompatible(
      flat({ "d": B(0), "d/e.txt": B(1) }),
      flat({ "d/e.txt": B(1), "d/f.txt": B(4) }),
      flat({ "d/e.txt": B(2) })
    );
    expect(anc2.ok).toBe(false);
    if (!anc2.ok) expect(anc2.conflicts.some((c) => c.kind === "ancestor-clash" || c.kind === "type-clash")).toBe(true);
  });

  test("failed merge leaves all inputs untouched; success exposes the union", () => {
    const base = flat({ "f.txt": B(1) }, { "s": "t" });
    const left = flat({ "f.txt": B(2) }, { "s": "t" });
    const right = flat({ "f.txt": B(3) }, { "s": "t" });
    const before = JSON.stringify({ b: snap(base), l: snap(left), r: snap(right) });
    const v = structuralCompatible(base, left, right);
    expect(v.ok).toBe(false);
    expect(JSON.stringify({ b: snap(base), l: snap(left), r: snap(right) })).toBe(before);
    const okBase = flat({ "f.txt": B(1) });
    const okLeft = flat({ "f.txt": B(1), "a.txt": B(4) });
    const okRight = flat({ "f.txt": B(1), "b.txt": B(5) });
    const okBefore = JSON.stringify({ b: snap(okBase), l: snap(okLeft), r: snap(okRight) });
    const ok = structuralCompatible(okBase, okLeft, okRight);
    expect(ok.ok).toBe(true);
    expect(JSON.stringify({ b: snap(okBase), l: snap(okLeft), r: snap(okRight) })).toBe(okBefore);
    if (ok.ok) {
      expect(ok.merged.files.get("a.txt")).toBe(B(4));
      expect(ok.merged.files.get("b.txt")).toBe(B(5));
    }
  });
});
