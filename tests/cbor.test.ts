import { describe, test, expect } from "bun:test";
import {
  arr,
  at,
  b,
  bool,
  decodeStateRef,
  decodeTop,
  decodeTree,
  encodeBlob,
  encodeCbor,
  encodeTree,
  nul,
  objectId,
  stateRef,
  t,
  u,
  unwrapObject,
  wrapObject,
} from "../src/core/cbor.ts";

const hx = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (by: Uint8Array): string => Buffer.from(by).toString("hex");

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe("cbor scalar round-trips", () => {
  test("uint boundaries use minimal encoding", () => {
    expect(hex(encodeCbor(u(0)))).toBe("00");
    expect(hex(encodeCbor(u(23)))).toBe("17");
    expect(hex(encodeCbor(u(24)))).toBe("1818");
    expect(hex(encodeCbor(u(255)))).toBe("18ff");
    expect(hex(encodeCbor(u(256)))).toBe("190100");
    expect(hex(encodeCbor(u(65535)))).toBe("19ffff");
    expect(hex(encodeCbor(u(65536)))).toBe("1a00010000");
    for (const n of [0, 1, 23, 24, 255, 256, 65535, 65536, 4294967295]) {
      const v = decodeTop(encodeCbor(u(n)));
      expect(v).toEqual({ tag: "uint", value: n });
    }
  });

  test("bytes/text/array/bool/null round-trip", () => {
    expect(decodeTop(encodeCbor(b(new Uint8Array(0))))).toEqual({ tag: "bytes", value: new Uint8Array(0) });
    expect(decodeTop(encodeCbor(b(Uint8Array.of(1, 2, 3))))).toEqual({ tag: "bytes", value: Uint8Array.of(1, 2, 3) });
    expect(decodeTop(encodeCbor(t("")))).toEqual({ tag: "text", value: "" });
    expect(decodeTop(encodeCbor(t("héllo-😀")))).toEqual({ tag: "text", value: "héllo-😀" });
    expect(decodeTop(encodeCbor(arr([])))).toEqual({ tag: "array", value: [] });
    expect(decodeTop(encodeCbor(arr([u(1), t("a"), b(Uint8Array.of(9)), arr([u(2)]), bool(true), nul()])))).toEqual({
      tag: "array",
      value: [
        { tag: "uint", value: 1 },
        { tag: "text", value: "a" },
        { tag: "bytes", value: Uint8Array.of(9) },
        { tag: "array", value: [{ tag: "uint", value: 2 }] },
        { tag: "bool", value: true },
        { tag: "null" },
      ],
    });
    expect(decodeTop(hx("f4"))).toEqual({ tag: "bool", value: false });
    expect(decodeTop(hx("f5"))).toEqual({ tag: "bool", value: true });
    expect(decodeTop(hx("f6"))).toEqual({ tag: "null" });
  });

  test("long-form lengths are minimal at 24+", () => {
    expect(hex(encodeCbor(t("a".repeat(24)))).slice(0, 4)).toBe("7818");
    expect(decodeTop(encodeCbor(t("a".repeat(24))))).toEqual({ tag: "text", value: "a".repeat(24) });
    const a24 = arr(Array.from({ length: 24 }, () => u(0)));
    expect(hex(encodeCbor(a24)).slice(0, 4)).toBe("9818");
    expect((decodeTop(encodeCbor(a24)) as { tag: "array"; value: unknown }).value).toHaveLength(24);
    const b24 = b(new Uint8Array(24));
    expect(hex(encodeCbor(b24)).slice(0, 4)).toBe("5818");
    expect((decodeTop(encodeCbor(b24)) as { tag: "bytes"; value: Uint8Array }).value).toHaveLength(24);
  });

  test("invalid uints are rejected at encode time", () => {
    expect(codeOf(() => encodeCbor(u(-1)))).toBe("E_CORRUPT_OBJECT");
    expect(codeOf(() => encodeCbor(u(1.5)))).toBe("E_CORRUPT_OBJECT");
    expect(codeOf(() => encodeCbor(u(Number.MAX_SAFE_INTEGER + 1)))).toBe("E_CORRUPT_OBJECT");
  });
});

describe("cbor preferred-encoding rejection", () => {
  const cases: Array<[string, string]> = [
    ["1800", "uint 0 in 1-byte form"],
    ["1817", "uint 23 in 1-byte form"],
    ["1900ff", "uint 255 in 2-byte form"],
    ["1a0000ffff", "uint 65535 in 4-byte form"],
    ["1b0000000000000000", "uint 0 in 8-byte form"],
    ["5817", "bytes length 23 in long form"],
    ["7817", "text length 23 in long form"],
    ["9817", "array length 23 in long form"],
  ];
  for (const [raw, label] of cases) {
    test(`non-minimal int rejected: ${label}`, () => {
      expect(codeOf(() => decodeTop(hx(raw)))).toBe("E_CORRUPT_OBJECT");
    });
  }

  test("minimal forms at the boundary are accepted", () => {
    expect(decodeTop(hx("1818"))).toEqual({ tag: "uint", value: 24 });
    expect(decodeTop(hx("190100"))).toEqual({ tag: "uint", value: 256 });
    expect(decodeTop(hx("1a00010000"))).toEqual({ tag: "uint", value: 65536 });
  });

  test("oversized ints are rejected", () => {
    expect(codeOf(() => decodeTop(hx("1bffffffffffffffff")))).toBe("E_CORRUPT_OBJECT");
  });
});

describe("cbor indefinite-length rejection", () => {
  for (const raw of ["5fff", "7fff", "9fff", "9fffff", "bfff", "ff"]) {
    test(`indefinite/break rejected: ${raw}`, () => {
      expect(codeOf(() => decodeTop(hx(raw)))).toBe("E_CORRUPT_OBJECT");
    });
  }
});

describe("cbor map/tag/float/simple rejection", () => {
  for (const raw of ["a0", "a101020304", "c0", "c600", "d90100", "f93c00", "fa3f800000", "fb3ff8000000000000", "f7", "f820", "ff"]) {
    test(`forbidden major/simple rejected: ${raw}`, () => {
      expect(codeOf(() => decodeTop(hx(raw)))).toBe("E_CORRUPT_OBJECT");
    });
  }

  test("negative ints are forbidden", () => {
    expect(codeOf(() => decodeTop(hx("20")))).toBe("E_CORRUPT_OBJECT");
    expect(codeOf(() => decodeTop(hx("3bffffffffffffffff")))).toBe("E_CORRUPT_OBJECT");
  });

  test("only f4/f5/f6 are valid major-7 values", () => {
    expect(decodeTop(hx("f4"))).toEqual({ tag: "bool", value: false });
    expect(decodeTop(hx("f5"))).toEqual({ tag: "bool", value: true });
    expect(decodeTop(hx("f6"))).toEqual({ tag: "null" });
  });
});

describe("cbor text rules", () => {
  test("NFC-normalized text is accepted", () => {
    const nfc = "é";
    const raw = Uint8Array.from(Buffer.concat([Buffer.from([0x62]), Buffer.from(nfc)]));
    expect(decodeTop(raw)).toEqual({ tag: "text", value: nfc });
  });

  test("non-NFC text is rejected", () => {
    const nfd = "é".normalize("NFD");
    expect(nfd.normalize("NFC")).not.toBe(nfd);
    const raw = Uint8Array.from(Buffer.concat([Buffer.from([0x63]), Buffer.from(nfd)]));
    expect(codeOf(() => decodeTop(raw))).toBe("E_CORRUPT_OBJECT");
    expect(codeOf(() => decodeTop(encodeCbor(t(nfd))))).toBe("E_CORRUPT_OBJECT");
  });

  test("invalid utf-8 is rejected", () => {
    expect(codeOf(() => decodeTop(hx("61ff")))).toBe("E_CORRUPT_OBJECT");
  });
});

describe("cbor framing", () => {
  test("trailing bytes are rejected", () => {
    expect(codeOf(() => decodeTop(hx("0506")))).toBe("E_CORRUPT_OBJECT");
    const withTrailer = Uint8Array.from([...encodeBlob(Uint8Array.of(1)), 0x00]);
    expect(codeOf(() => decodeTop(withTrailer))).toBe("E_CORRUPT_OBJECT");
  });

  test("empty and truncated inputs are rejected", () => {
    expect(codeOf(() => decodeTop(hx("")))).toBe("E_CORRUPT_OBJECT");
    expect(codeOf(() => decodeTop(hx("18")))).toBe("E_CORRUPT_OBJECT");
    expect(codeOf(() => decodeTop(hx("8201")))).toBe("E_CORRUPT_OBJECT");
    expect(codeOf(() => decodeTop(hx("41")))).toBe("E_CORRUPT_OBJECT");
  });
});

describe("cbor object envelope", () => {
  test("wrap/unwrap round-trip preserves type and payload", () => {
    const payload = arr([u(1), t("x")]);
    const { type, payload: back } = unwrapObject(wrapObject(3, payload));
    expect(type).toBe(3);
    expect(back).toEqual(payload);
  });

  test("unknown object type is rejected with unsupported-format", () => {
    const bad = wrapObject(10 as unknown as 1, u(1));
    expect(codeOf(() => unwrapObject(bad))).toBe("E_UNSUPPORTED_FORMAT");
    const zero = wrapObject(0 as unknown as 1, u(1));
    expect(codeOf(() => unwrapObject(zero))).toBe("E_UNSUPPORTED_FORMAT");
  });

  test("unknown format version is rejected with unsupported-format", () => {
    const badVer = encodeCbor(arr([u(1), u(99), u(3)]));
    expect(codeOf(() => unwrapObject(badVer))).toBe("E_UNSUPPORTED_FORMAT");
    const ver0 = encodeCbor(arr([u(1), u(0), u(3)]));
    expect(codeOf(() => unwrapObject(ver0))).toBe("E_UNSUPPORTED_FORMAT");
  });

  test("bad envelope arity is rejected", () => {
    const two = encodeCbor(arr([u(1), u(1)]));
    expect(codeOf(() => unwrapObject(two))).toBe("E_CORRUPT_OBJECT");
    expect(codeOf(() => unwrapObject(encodeCbor(u(7))))).toBe("E_CORRUPT_OBJECT");
  });

  test("at() indexes and bounds-checks", () => {
    const items = [u(1), t("a")];
    expect(at(items, 0)).toEqual({ tag: "uint", value: 1 });
    expect(at(items, 1)).toEqual({ tag: "text", value: "a" });
    expect(codeOf(() => at(items, 2))).toBe("E_CORRUPT_OBJECT");
  });
});

describe("cbor blob/tree/state primitives", () => {
  test("objectId is 32-byte hex, deterministic and content-sensitive", () => {
    const a = encodeBlob(new TextEncoder().encode("hello"));
    expect(objectId(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(objectId(a)).toBe(objectId(encodeBlob(new TextEncoder().encode("hello"))));
    expect(objectId(a)).not.toBe(objectId(encodeBlob(new TextEncoder().encode("world"))));
  });

  test("blob envelope unwraps to type 1", () => {
    const { type, payload } = unwrapObject(encodeBlob(Uint8Array.of(9)));
    expect(type).toBe(1);
    expect(payload).toEqual({ tag: "bytes", value: Uint8Array.of(9) });
  });

  test("tree entries are canonically sorted on encode", () => {
    const blob = objectId(encodeBlob(new TextEncoder().encode("x")));
    const bytes = encodeTree([
      { name: "b", kind: "file", target: blob, executable: false },
      { name: "a", kind: "file", target: blob, executable: false },
    ]);
    expect(decodeTree(bytes).map((e) => e.name)).toEqual(["a", "b"]);
  });

  test("tree rejects duplicates and bad executable flags on decode", () => {
    const blob = objectId(encodeBlob(new TextEncoder().encode("x")));
    expect(
      codeOf(() =>
        encodeTree([
          { name: "a", kind: "file", target: blob, executable: false },
          { name: "a", kind: "file", target: blob, executable: false },
        ]),
      ),
    ).toBe("E_CORRUPT_OBJECT");
    const dirExec = wrapObject(2, arr([arr([t("d"), u(2), b(hx(blob)), bool(true)])]));
    expect(codeOf(() => decodeTree(dirExec))).toBe("E_CORRUPT_OBJECT");
    const linkExec = wrapObject(2, arr([arr([t("l"), u(3), t("tgt"), bool(true)])]));
    expect(codeOf(() => decodeTree(linkExec))).toBe("E_CORRUPT_OBJECT");
    expect(codeOf(() => decodeTree(encodeBlob(Uint8Array.of(1))))).toBe("E_CORRUPT_OBJECT");
  });

  test("stateRef round-trips kinds 1 and 2, rejects the rest", () => {
    const id = "ab".repeat(32);
    expect(decodeStateRef(stateRef(1, id))).toEqual({ kind: 1, id });
    expect(decodeStateRef(stateRef(2, id))).toEqual({ kind: 2, id });
    expect(codeOf(() => decodeStateRef(arr([u(3), b(hx(id))])))).toBe("E_CORRUPT_OBJECT");
    expect(codeOf(() => decodeStateRef(arr([u(1), b(hx("00".repeat(16)))])))).toBe("E_CORRUPT_OBJECT");
  });
});
