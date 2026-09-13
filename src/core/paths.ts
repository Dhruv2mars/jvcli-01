import { Effect } from "effect";
import { CODES, fail } from "./types.js";

export const JV_DIR = ".javelin";
export const STORE_DIR = "objects";
export const REPO_FILE = "repo.json";
export const REFS_FILE = "refs.json";
export const JOURNAL_DIR = "journal";
export const LAYERS_DIR = "layers";
export const TMP_DIR = "tmp";
export const IGNORE_FILE = ".javelinignore";

const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

export function normalizePath(raw: string): string {
  const portable = raw.replaceAll("\\", "/");
  if (portable.length === 0 || portable === "." || portable.startsWith("/") || portable.startsWith("./")) {
    throw fail(CODES.invalidPath, `invalid path: ${raw}`);
  }
  const parts = portable.split("/");
  for (const part of parts) {
    if (part.length === 0 || part === "." || part === "..") throw fail(CODES.invalidPath, `invalid path: ${raw}`);
  }
  const nfc = portable.normalize("NFC");
  if (nfc.normalize("NFC") !== nfc) throw fail(CODES.invalidPath, `path is not NFC: ${raw}`);
  if (new TextEncoder().encode(nfc).byteLength > 4096) throw fail(CODES.invalidPath, `path too long: ${raw}`);
  for (const part of nfc.split("/")) {
    const bytes = new TextEncoder().encode(part).byteLength;
    if (bytes === 0 || bytes > 255) throw fail(CODES.invalidPath, `bad component: ${raw}`);
    if (part.endsWith(".") || part.endsWith(" ")) throw fail(CODES.invalidPath, `bad component: ${raw}`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0001-\u001F\u007F]/.test(part)) throw fail(CODES.invalidPath, `control character: ${raw}`);
    const stem = part.includes(".") ? part.slice(0, part.indexOf(".")) : part;
    if (WINDOWS_RESERVED.has(stem.toLowerCase()) || WINDOWS_RESERVED.has(part.toLowerCase())) {
      throw fail(CODES.invalidPath, `reserved name: ${raw}`);
    }
  }
  const folded = nfc.toLowerCase();
  if (folded === ".javelin" || folded.startsWith(".javelin/")) throw fail(CODES.invalidPath, ".javelin is reserved");
  const siblings = new Map<string, string>();
  for (const part of nfc.split("/")) {
    const key = part.toLowerCase();
    const seen = siblings.get(key);
    if (seen !== undefined && seen !== part) throw fail(CODES.invalidPath, `case collision: ${raw}`);
    siblings.set(key, part);
  }
  return nfc;
}

export function validateTreePaths(paths: Iterable<string>): void {
  const byDir = new Map<string, Set<string>>();
  for (const raw of paths) {
    const p = normalizePath(raw);
    const slash = p.lastIndexOf("/");
    const dir = slash === -1 ? "" : p.slice(0, slash);
    const name = slash === -1 ? p : p.slice(slash + 1);
    let set = byDir.get(dir);
    if (set === undefined) {
      set = new Set();
      byDir.set(dir, set);
    }
    const key = name.toLowerCase();
    if (set.has(key)) throw fail(CODES.invalidPath, `sibling collision: ${p}`);
    set.add(key);
  }
}

export interface IgnoreRule {
  readonly negated: boolean;
  readonly dirOnly: boolean;
  readonly anchored: boolean;
  readonly pattern: string;
}

export function parseIgnoreFile(text: string): ReadonlyArray<IgnoreRule> {
  const lines = text.split("\n");
  const rules: Array<IgnoreRule> = [];
  for (const line of lines) {
    let s = line;
    if (s.endsWith("\r")) s = s.slice(0, -1);
    if (s.trim().length === 0) continue;
    let i = 0;
    let negated = false;
    if (s.startsWith("!")) {
      negated = true;
      i = 1;
    }
    let pattern = "";
    let escaped = false;
    for (; i < s.length; i++) {
      const c = s[i]!;
      if (escaped) {
        pattern += c;
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === "#" && pattern.length === 0 && i === (negated ? 1 : 0)) {
        pattern = "";
        break;
      } else {
        pattern += c;
      }
    }
    if (escaped) throw fail(CODES.invalidIgnore, "trailing escape in ignore file");
    if (pattern.length === 0) continue;
    let anchored = false;
    if (pattern.startsWith("/")) {
      anchored = true;
      pattern = pattern.slice(1);
    }
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    if (pattern.includes("**")) anchored = anchored || pattern.startsWith("**/");
    rules.push({ negated, dirOnly, anchored, pattern });
  }
  return rules;
}

function globMatch(pattern: string, text: string): boolean {
  const px = Array.from(pattern);
  const tx = Array.from(text);
  const memo = new Map<string, boolean>();
  const go = (pi: number, ti: number): boolean => {
    const key = `${pi}:${ti}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let out = false;
    if (pi === px.length) {
      out = ti === tx.length;
    } else if (px[pi] === "*" && px[pi + 1] === "*") {
      let ni = pi + 2;
      if (px[ni] === "/") ni += 1;
      out = go(ni, ti) || (ti < tx.length && go(pi, ti + 1));
    } else if (px[pi] === "*") {
      out = go(pi + 1, ti) || (ti < tx.length && tx[ti] !== "/" && go(pi, ti + 1));
    } else if (px[pi] === "?") {
      out = ti < tx.length && tx[ti] !== "/" && go(pi + 1, ti + 1);
    } else if (px[pi] === "[") {
      const close = px.indexOf("]", pi);
      if (close === -1) {
        out = ti < tx.length && px[pi] === tx[ti] && go(pi + 1, ti + 1);
      } else {
        const cls = px.slice(pi + 1, close).join("");
        const neg = cls.startsWith("!") || cls.startsWith("^");
        const body = neg ? cls.slice(1) : cls;
        let hit2 = false;
        for (let k = 0; k < body.length; k++) {
          if (body[k] === "-" && k > 0 && k + 1 < body.length) {
            const lo = body[k - 1]!;
            const hi = body[k + 1]!;
            if (ti < tx.length && tx[ti]! >= lo && tx[ti]! <= hi) hit2 = true;
          } else if (ti < tx.length && body[k] === tx[ti]) {
            hit2 = true;
          }
        }
        out = (neg ? !hit2 : hit2) && ti < tx.length && go(close + 1, ti + 1);
      }
    } else {
      out = ti < tx.length && px[pi] === tx[ti] && go(pi + 1, ti + 1);
    }
    memo.set(key, out);
    return out;
  };
  return go(0, 0);
}

export function ignoreMatch(rules: ReadonlyArray<IgnoreRule>, path: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir && !globMatch(rule.pattern, path) && !globMatch(`${rule.pattern}/**`, path)) {
      continue;
    }
    let hit: boolean;
    if (rule.pattern.includes("/")) {
      hit = globMatch(rule.pattern, path) || globMatch(`${rule.pattern}/**`, path);
    } else if (rule.anchored) {
      hit = globMatch(rule.pattern, path);
    } else {
      const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
      hit = globMatch(rule.pattern, base) || globMatch(rule.pattern, path) || globMatch(`**/${rule.pattern}`, path);
    }
    if (hit) ignored = !rule.negated;
  }
  return ignored;
}

export const validatePathEffect = (raw: string) => Effect.try({ try: () => normalizePath(raw), catch: (e) => e as Error });
