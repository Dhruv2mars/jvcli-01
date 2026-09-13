import { describe, test, expect } from "bun:test";
import { ignoreMatch, normalizePath, parseIgnoreFile, validateTreePaths } from "../src/core/paths.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe("normalizePath basics", () => {
  test("accepts ordinary nested paths unchanged", () => {
    expect(normalizePath("a/b/c.txt")).toBe("a/b/c.txt");
    expect(normalizePath(".foo")).toBe(".foo");
    expect(normalizePath(".javelinignore")).toBe(".javelinignore");
    expect(normalizePath("a b/c")).toBe("a b/c");
    expect(normalizePath("héllo/wörld")).toBe("héllo/wörld");
  });

  test("converts backslashes but still rejects escapes", () => {
    expect(normalizePath("a\\b")).toBe("a/b");
    expect(codeOf(() => normalizePath("a/../b"))).toBe("E_INVALID_PATH");
    expect(codeOf(() => normalizePath("\\a"))).toBe("E_INVALID_PATH");
  });

  test("rejects empty, dot, absolute and parent segments", () => {
    for (const raw of ["", ".", "/a", "./a", "a//b", "a/./b", "a/../b", "..", "a/..", "../a"]) {
      expect(codeOf(() => normalizePath(raw)), raw).toBe("E_INVALID_PATH");
    }
  });

  test("normalizes to NFC", () => {
    const nfd = "é".normalize("NFD");
    expect(nfd.normalize("NFC")).not.toBe(nfd);
    expect(normalizePath(nfd)).toBe(nfd.normalize("NFC"));
  });
});

describe("normalizePath reserved .javelin", () => {
  test("top-level .javelin is reserved in any case", () => {
    expect(codeOf(() => normalizePath(".javelin"))).toBe("E_INVALID_PATH");
    expect(codeOf(() => normalizePath(".javelin/x"))).toBe("E_INVALID_PATH");
    expect(codeOf(() => normalizePath(".JAVELIN/x"))).toBe("E_INVALID_PATH");
  });

  test("nested .javelin and lookalikes are allowed", () => {
    expect(normalizePath("a/.javelin/b")).toBe("a/.javelin/b");
    expect(normalizePath(".javelin2/x")).toBe(".javelin2/x");
    expect(normalizePath(".javelin-backup")).toBe(".javelin-backup");
  });
});

describe("normalizePath windows reserved names", () => {
  test("bare reserved stems are rejected", () => {
    for (const raw of ["con", "prn", "aux", "nul", "com1", "lpt9", "COM1", "docs/prn"]) {
      expect(codeOf(() => normalizePath(raw)), raw).toBe("E_INVALID_PATH");
    }
  });

  test("reserved stems with extensions are rejected", () => {
    for (const raw of ["con.txt", "com1.txt", "aux.log", "lpt9.txt"]) {
      expect(codeOf(() => normalizePath(raw)), raw).toBe("E_INVALID_PATH");
    }
  });

  test("names that merely contain reserved words pass", () => {
    expect(normalizePath("console")).toBe("console");
    expect(normalizePath("contest.txt")).toBe("contest.txt");
    expect(normalizePath("auxiliary")).toBe("auxiliary");
  });
});

describe("normalizePath component rules", () => {
  test("trailing dot or space is rejected in any component", () => {
    for (const raw of ["foo.", "foo ", "a./b", "a/ /b", "a/b."]) {
      expect(codeOf(() => normalizePath(raw)), raw).toBe("E_INVALID_PATH");
    }
  });

  test("control characters are rejected", () => {
    expect(codeOf(() => normalizePath("ab"))).toBe("E_INVALID_PATH");
    expect(codeOf(() => normalizePath("a\nb"))).toBe("E_INVALID_PATH");
    expect(codeOf(() => normalizePath("ab"))).toBe("E_INVALID_PATH");
  });

  test("overlong components are rejected, 255 bytes pass", () => {
    expect(normalizePath("a".repeat(255))).toHaveLength(255);
    expect(codeOf(() => normalizePath("a".repeat(256)))).toBe("E_INVALID_PATH");
    expect(codeOf(() => normalizePath(`${"a".repeat(254)}.b`))).toBe("E_INVALID_PATH");
  });

  test("case collision within one path is rejected", () => {
    expect(codeOf(() => normalizePath("Foo/FOO"))).toBe("E_INVALID_PATH");
    expect(normalizePath("Foo/bar")).toBe("Foo/bar");
  });
});

describe("validateTreePaths", () => {
  test("sibling names collide case-insensitively", () => {
    expect(codeOf(() => validateTreePaths(["a", "A"]))).toBe("E_INVALID_PATH");
    expect(codeOf(() => validateTreePaths(["a", "a"]))).toBe("E_INVALID_PATH");
    expect(codeOf(() => validateTreePaths(["dir/a", "dir/A"]))).toBe("E_INVALID_PATH");
  });

  test("same names in different dirs pass (grouped per dir)", () => {
    validateTreePaths(["Dir/a", "dir/b"]);
  });

  test("distinct names and distinct dirs pass", () => {
    validateTreePaths(["a/b", "a/c"]);
    validateTreePaths(["X/f", "x/g"]);
    validateTreePaths([]);
  });
});

describe("parseIgnoreFile", () => {
  test("comments, blanks and CRLF are skipped", () => {
    expect(parseIgnoreFile("# comment\n\n   \n*.log\n")).toEqual([
      { negated: false, dirOnly: false, anchored: false, pattern: "*.log" },
    ]);
    expect(parseIgnoreFile("*.log\r\nbuild/\r\n")).toEqual([
      { negated: false, dirOnly: false, anchored: false, pattern: "*.log" },
      { negated: false, dirOnly: true, anchored: false, pattern: "build" },
    ]);
  });

  test("negation, escaping, anchoring and dir-only flags parse", () => {
    expect(parseIgnoreFile("!keep")).toEqual([{ negated: true, dirOnly: false, anchored: false, pattern: "keep" }]);
    expect(parseIgnoreFile("\\#keep")).toEqual([{ negated: false, dirOnly: false, anchored: false, pattern: "#keep" }]);
    expect(parseIgnoreFile("a#b")).toEqual([{ negated: false, dirOnly: false, anchored: false, pattern: "a#b" }]);
    expect(parseIgnoreFile("/root")).toEqual([{ negated: false, dirOnly: false, anchored: true, pattern: "root" }]);
    expect(parseIgnoreFile("build/")).toEqual([{ negated: false, dirOnly: true, anchored: false, pattern: "build" }]);
    expect(codeOf(() => parseIgnoreFile("abc\\"))).toBe("E_INVALID_IGNORE");
  });
});

describe("ignoreMatch semantics", () => {
  test("comments never match and empty rules match nothing", () => {
    expect(ignoreMatch(parseIgnoreFile("# c\n"), "anything", false)).toBe(false);
    expect(ignoreMatch(parseIgnoreFile(""), "anything", false)).toBe(false);
    expect(ignoreMatch(parseIgnoreFile("!keep"), "other", false)).toBe(false);
  });

  test("negation is last-wins", () => {
    const rules = parseIgnoreFile("*.log\n!important.log\n");
    expect(ignoreMatch(rules, "a.log", false)).toBe(true);
    expect(ignoreMatch(rules, "important.log", false)).toBe(false);
    const flipped = parseIgnoreFile("!*.log\n*.log\n");
    expect(ignoreMatch(flipped, "a.log", false)).toBe(true);
  });

  test("anchored patterns match only at root", () => {
    const rules = parseIgnoreFile("/root-only.txt");
    expect(ignoreMatch(rules, "root-only.txt", false)).toBe(true);
    expect(ignoreMatch(rules, "sub/root-only.txt", false)).toBe(false);
    const star = parseIgnoreFile("/*.log");
    expect(ignoreMatch(star, "a.log", false)).toBe(true);
    expect(ignoreMatch(star, "sub/a.log", false)).toBe(false);
  });

  test("bare basenames match at any depth", () => {
    const rules = parseIgnoreFile("*.log");
    expect(ignoreMatch(rules, "a.log", false)).toBe(true);
    expect(ignoreMatch(rules, "sub/dir/a.log", false)).toBe(true);
    expect(ignoreMatch(rules, "a.txt", false)).toBe(false);
  });

  test("dir-only patterns match the dir itself", () => {
    const rules = parseIgnoreFile("build/");
    expect(ignoreMatch(rules, "build", false)).toBe(true);
    expect(ignoreMatch(rules, "build", true)).toBe(true);
    expect(ignoreMatch(rules, "other", false)).toBe(false);
  });

  test("slash patterns are path-relative, * does not cross /", () => {
    const rules = parseIgnoreFile("doc/*.txt");
    expect(ignoreMatch(rules, "doc/a.txt", false)).toBe(true);
    expect(ignoreMatch(rules, "doc/sub/a.txt", false)).toBe(false);
  });

  test("** spans path components", () => {
    const rules = parseIgnoreFile("a/**/b");
    expect(ignoreMatch(rules, "a/b", false)).toBe(true);
    expect(ignoreMatch(rules, "a/x/y/b", false)).toBe(true);
    expect(ignoreMatch(rules, "a/x/b/c", false)).toBe(true);
    expect(ignoreMatch(parseIgnoreFile("**/b"), "x/y/b", false)).toBe(true);
    expect(ignoreMatch(parseIgnoreFile("**/b"), "b", false)).toBe(true);
  });

  test("matching is case-sensitive", () => {
    expect(ignoreMatch(parseIgnoreFile("*.log"), "A.LOG", false)).toBe(false);
  });
});
