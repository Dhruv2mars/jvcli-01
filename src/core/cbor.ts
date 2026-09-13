import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  CODES,
  fail,
  FORMAT_V1,
  type FileView,
  type Files,
  type ObjectType,
  type Symlinks,
  type TreeEntryInput,
  type TreeEntryKind
} from "./types.js";

export const objectId = (canonical: Uint8Array): string => bytesToHex(blake3(canonical));

export function encodeLength(n: number): Uint8Array {
  if (n < 24) return Uint8Array.of(n);
  if (n < 256) return Uint8Array.of(0x18, n);
  if (n < 65536) return Uint8Array.of(0x19, (n >> 8) & 0xff, n & 0xff);
  if (n < 4294967296) {
    return Uint8Array.of(0x1a, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  const hi = Math.floor(n / 4294967296);
  const lo = n >>> 0;
  return Uint8Array.of(
    0x1b,
    (hi >>> 24) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff
  );
}

export type CborValue =
  | { tag: "uint"; value: number }
  | { tag: "bytes"; value: Uint8Array }
  | { tag: "text"; value: string }
  | { tag: "array"; value: ReadonlyArray<CborValue> }
  | { tag: "bool"; value: boolean }
  | { tag: "null" };

export const u = (value: number): CborValue => ({ tag: "uint", value });
export const b = (value: Uint8Array): CborValue => ({ tag: "bytes", value });
export const t = (value: string): CborValue => ({ tag: "text", value });
export const arr = (value: ReadonlyArray<CborValue>): CborValue => ({ tag: "array", value });
export const bool = (value: boolean): CborValue => ({ tag: "bool", value });
export const nul = (): CborValue => ({ tag: "null" });
export const optBytes = (hex: string | null): CborValue => (hex === null ? nul() : b(hexToBytes(hex)));
export const optText = (value: string | null): CborValue => (value === null ? nul() : t(value));
export const optNum = (value: number | null): CborValue => (value === null ? nul() : u(value));

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function encodeUintValue(n: number, major: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw fail(CODES.corruptObject, "bad uint");
  const base = major << 5;
  if (n < 24) return Uint8Array.of(base | n);
  if (n < 256) return Uint8Array.of(base | 24, n);
  if (n < 65536) return Uint8Array.of(base | 25, (n >> 8) & 0xff, n & 0xff);
  if (n < 4294967296) {
    return Uint8Array.of(base | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  const hi = Math.floor(n / 4294967296);
  const lo = n >>> 0;
  return Uint8Array.of(
    base | 27,
    (hi >>> 24) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff
  );
}

export function encodeCbor(value: CborValue): Uint8Array {
  switch (value.tag) {
    case "uint":
      return encodeUintValue(value.value, 0);
    case "bytes":
      return concat([encodeUintValue(value.value.length, 2), value.value]);
    case "text": {
      const bytes = new TextEncoder().encode(value.value);
      return concat([encodeUintValue(bytes.length, 3), bytes]);
    }
    case "array": {
      const parts: Array<Uint8Array> = [encodeUintValue(value.value.length, 4)];
      for (const item of value.value) parts.push(encodeCbor(item));
      return concat(parts);
    }
    case "bool":
      return Uint8Array.of(value.value ? 0xf5 : 0xf4);
    case "null":
      return Uint8Array.of(0xf6);
  }
}

export interface Decoded {
  readonly value: CborValue;
  readonly rest: Uint8Array;
}

function readUint(bytes: Uint8Array, info: number): { n: number; rest: Uint8Array; header: Uint8Array } {
  if (info < 24) return { n: info, rest: bytes, header: Uint8Array.of() };
  if (info === 24) {
    if (bytes.length < 1) throw fail(CODES.corruptObject, "truncated cbor");
    if (bytes[0]! < 24) throw fail(CODES.corruptObject, "non preferred cbor int");
    return { n: bytes[0]!, rest: bytes.slice(1), header: bytes.slice(0, 1) };
  }
  if (info === 25) {
    if (bytes.length < 2) throw fail(CODES.corruptObject, "truncated cbor");
    const n = (bytes[0]! << 8) | bytes[1]!;
    if (n < 256) throw fail(CODES.corruptObject, "non preferred cbor int");
    return { n, rest: bytes.slice(2), header: bytes.slice(0, 2) };
  }
  if (info === 26) {
    if (bytes.length < 4) throw fail(CODES.corruptObject, "truncated cbor");
    const n = bytes[0]! * 16777216 + bytes[1]! * 65536 + bytes[2]! * 256 + bytes[3]!;
    if (n < 65536) throw fail(CODES.corruptObject, "non preferred cbor int");
    return { n, rest: bytes.slice(4), header: bytes.slice(0, 4) };
  }
  if (info === 27) {
    if (bytes.length < 8) throw fail(CODES.corruptObject, "truncated cbor");
    let n = 0;
    for (let i = 0; i < 8; i++) {
      n = n * 256 + bytes[i]!;
      if (n > Number.MAX_SAFE_INTEGER) throw fail(CODES.corruptObject, "cbor int too large");
    }
    if (n < 4294967296) throw fail(CODES.corruptObject, "non preferred cbor int");
    return { n, rest: bytes.slice(8), header: bytes.slice(0, 8) };
  }
  throw fail(CODES.corruptObject, "indefinite cbor forbidden");
}

export function decodeOne(input: Uint8Array): Decoded {
  if (input.length === 0) throw fail(CODES.corruptObject, "empty cbor");
  const ib = input[0]!;
  const major = ib >> 5;
  const info = ib & 31;
  if (major === 0) {
    const { n, rest } = readUint(input.slice(1), info);
    return { value: u(n), rest };
  }
  if (major === 1) throw fail(CODES.corruptObject, "negative ints forbidden");
  if (major === 2) {
    const { n, rest } = readUint(input.slice(1), info);
    if (rest.length < n) throw fail(CODES.corruptObject, "truncated bytes");
    return { value: b(rest.slice(0, n)), rest: rest.slice(n) };
  }
  if (major === 3) {
    const { n, rest } = readUint(input.slice(1), info);
    if (rest.length < n) throw fail(CODES.corruptObject, "truncated text");
    const slice = rest.slice(0, n);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
    } catch {
      throw fail(CODES.corruptObject, "bad utf8");
    }
    if (text.normalize("NFC") !== text) throw fail(CODES.corruptObject, "text not NFC");
    return { value: t(text), rest: rest.slice(n) };
  }
  if (major === 4) {
    const { n, rest } = readUint(input.slice(1), info);
    const items: Array<CborValue> = [];
    let cur = rest;
    for (let i = 0; i < n; i++) {
      const d = decodeOne(cur);
      items.push(d.value);
      cur = d.rest;
    }
    return { value: arr(items), rest: cur };
  }
  if (major === 5) throw fail(CODES.corruptObject, "maps forbidden");
  if (major === 6) throw fail(CODES.corruptObject, "tags forbidden");
  if (major === 7) {
    if (ib === 0xf4) return { value: bool(false), rest: input.slice(1) };
    if (ib === 0xf5) return { value: bool(true), rest: input.slice(1) };
    if (ib === 0xf6) return { value: nul(), rest: input.slice(1) };
    throw fail(CODES.corruptObject, `bad simple ${ib}`);
  }
  throw fail(CODES.corruptObject, "bad cbor");
}

export function decodeTop(bytes: Uint8Array): CborValue {
  const d = decodeOne(bytes);
  if (d.rest.length !== 0) throw fail(CODES.corruptObject, "trailing bytes");
  return d.value;
}

function expectArray(v: CborValue, n: number): ReadonlyArray<CborValue> {
  if (v.tag !== "array" || v.value.length !== n) throw fail(CODES.corruptObject, "bad arity");
  return v.value;
}

export function at(items: ReadonlyArray<CborValue>, i: number): CborValue {
  const v = items[i];
  if (v === undefined) throw fail(CODES.corruptObject, "bad arity");
  return v;
}

function expectUint(v: CborValue): number {
  if (v.tag !== "uint") throw fail(CODES.corruptObject, "expected uint");
  return v.value;
}

function expectBytes32(v: CborValue): string {
  if (v.tag !== "bytes" || v.value.length !== 32) throw fail(CODES.corruptObject, "expected id32");
  return bytesToHex(v.value);
}

function expectBytes16(v: CborValue): string {
  if (v.tag !== "bytes" || v.value.length !== 16) throw fail(CODES.corruptObject, "expected id16");
  return bytesToHex(v.value);
}

function expectText(v: CborValue): string {
  if (v.tag !== "text") throw fail(CODES.corruptObject, "expected text");
  return v.value;
}

function expectBool(v: CborValue): boolean {
  if (v.tag !== "bool") throw fail(CODES.corruptObject, "expected bool");
  return v.value;
}

function expectNull(v: CborValue): null {
  if (v.tag !== "null") throw fail(CODES.corruptObject, "expected null");
  return null;
}

export function optBytesOut(v: CborValue): string | null {
  if (v.tag === "null") return null;
  if (v.tag === "bytes" && v.value.length === 32) return bytesToHex(v.value);
  throw fail(CODES.corruptObject, "bad optional id");
}

export function optTextOut(v: CborValue): string | null {
  if (v.tag === "null") return null;
  if (v.tag === "text") return v.value;
  throw fail(CODES.corruptObject, "bad optional text");
}

export function optUintOut(v: CborValue): number | null {
  if (v.tag === "null") return null;
  if (v.tag === "uint") return v.value;
  throw fail(CODES.corruptObject, "bad optional uint");
}

export function wrapObject(type: ObjectType, payload: CborValue): Uint8Array {
  return encodeCbor(arr([u(type), u(FORMAT_V1), payload]));
}

export function unwrapObject(bytes: Uint8Array): { type: ObjectType; payload: CborValue } {
  const top = decodeTop(bytes);
  const items = expectArray(top, 3);
  const ty = at(items, 0);
  const ver = at(items, 1);
  const payload = at(items, 2);
  const n = expectUint(ty);
  if (n < 1 || n > 9) throw fail(CODES.unsupportedFormat, `unknown object type ${n}`);
  if (expectUint(ver) !== FORMAT_V1) throw fail(CODES.unsupportedFormat, "unknown format version");
  return { type: n as ObjectType, payload };
}

export function encodeBlob(content: Uint8Array): Uint8Array {
  return wrapObject(1, b(content));
}

export function sortedEntries(entries: ReadonlyArray<TreeEntryInput>): ReadonlyArray<TreeEntryInput> {
  const enc = new TextEncoder();
  return [...entries].sort((x, y) => {
    const a = enc.encode(x.name);
    const c = enc.encode(y.name);
    const n = Math.min(a.length, c.length);
    for (let i = 0; i < n; i++) {
      if (a[i]! !== c[i]!) return a[i]! - c[i]!;
    }
    return a.length - c.length;
  });
}

export function encodeTree(entries: ReadonlyArray<TreeEntryInput>): Uint8Array {
  const sorted = sortedEntries(entries);
  const seen = new Set<string>();
  const items: Array<CborValue> = [];
  for (const e of sorted) {
    if (seen.has(e.name)) throw fail(CODES.corruptObject, "duplicate tree name");
    seen.add(e.name);
    const kind = e.kind === "file" ? 1 : e.kind === "dir" ? 2 : 3;
    const target: CborValue = kind === 3 ? t(e.target) : b(hexToBytes(e.target));
    items.push(arr([t(e.name), u(kind), target, bool(kind === 1 ? e.executable : false)]));
  }
  return wrapObject(2, arr(items));
}

export interface DecodedTreeEntry {
  readonly name: string;
  readonly kind: TreeEntryKind;
  readonly target: string;
  readonly executable: boolean;
}

export function decodeTree(bytes: Uint8Array): ReadonlyArray<DecodedTreeEntry> {
  const { type, payload } = unwrapObject(bytes);
  if (type !== 2) throw fail(CODES.corruptObject, "not a tree");
  if (payload.tag !== "array") throw fail(CODES.corruptObject, "bad tree");
  const out: Array<DecodedTreeEntry> = [];
  for (const item of payload.value) {
    const [nm, kd, tg, ex] = expectArray(item, 4);
    const name = expectText(nm as CborValue);
    const kind = expectUint(kd as CborValue);
    const executable = expectBool(ex as CborValue);
    const target = tg as CborValue;
    if (kind === 1) {
      if (target.tag !== "bytes" || target.value.length !== 32) throw fail(CODES.corruptObject, "bad file target");
      out.push({ name, kind: "file", target: bytesToHex(target.value), executable });
    } else if (kind === 2) {
      if (target.tag !== "bytes" || target.value.length !== 32) throw fail(CODES.corruptObject, "bad dir target");
      if (executable) throw fail(CODES.corruptObject, "dir executable");
      out.push({ name, kind: "dir", target: bytesToHex(target.value), executable: false });
    } else if (kind === 3) {
      if (target.tag !== "text") throw fail(CODES.corruptObject, "bad link target");
      if (executable) throw fail(CODES.corruptObject, "link executable");
      out.push({ name, kind: "symlink", target: target.value, executable: false });
    } else {
      throw fail(CODES.corruptObject, "bad entry kind");
    }
  }
  return out;
}

export function stateRef(kind: 1 | 2, id: string): CborValue {
  return arr([u(kind), b(hexToBytes(id))]);
}

export function decodeStateRef(v: CborValue): { kind: 1 | 2; id: string } {
  const [k, id] = expectArray(v, 2);
  const kn = expectUint(k as CborValue);
  if (kn !== 1 && kn !== 2) throw fail(CODES.corruptObject, "bad state kind");
  const idv = id as CborValue;
  if (idv.tag !== "bytes" || idv.value.length !== 32) throw fail(CODES.corruptObject, "bad state id");
  return { kind: kn, id: bytesToHex(idv.value) };
}

export { expectArray, expectBool, expectBytes16, expectBytes32, expectNull, expectText, expectUint };
export type { Files, FileView, Symlinks };
