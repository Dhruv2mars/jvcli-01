import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CODES, fail } from "./types.js";

export const newId16 = (): string => bytesToHex(randomBytes(16));

export function parseId16(raw: string, what: string): string {
  const s = raw.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) throw fail(CODES.invalidPath, `bad ${what}: ${raw}`);
  return s;
}

export function parseId32(raw: string, what: string): string {
  const s = raw.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw fail(CODES.invalidPath, `bad ${what}: ${raw}`);
  return s;
}
