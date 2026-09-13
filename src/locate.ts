import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CODES, fail } from "./core/types.js";

export async function findRepoRoot(start: string): Promise<string> {
  let cur = resolve(start);
  while (true) {
    try {
      await access(join(cur, ".javelin", "repo.json"), constants.F_OK);
      return cur;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) throw fail(CODES.notRepository, `not a jvcli repository (searched from ${start})`, { hint: "run jvcli init" });
      cur = parent;
    }
  }
}

export async function findLayerForCwd(cwd: string): Promise<string> {
  let cur = resolve(cwd);
  while (true) {
    const marker = join(cur, ".jvcli-layer");
    try {
      const [raw, st] = await Promise.all([readFile(marker, "utf8"), stat(marker)]);
      if (st.isFile()) {
        const id = raw.trim().toLowerCase();
        if (/^[0-9a-f]{32}$/.test(id)) return id;
      }
    } catch {
      // keep walking
    }
    const repoCheck = join(cur, ".javelin", "repo.json");
    try {
      await access(repoCheck, constants.F_OK);
      break;
    } catch {
      // not repo root yet
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw fail(CODES.notLayerWorkspace, "not inside a layer workspace; pass --layer", { hint: "run from the layer workspace or pass --layer" });
}
