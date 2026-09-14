#!/usr/bin/env node
// Prints or validates the expected release tag (vX.Y.Z) for jvcli-01.
// Usage:
//   node scripts/release-tag.mjs --print        # print expected tag from package.json
//   node scripts/release-tag.mjs [<tag>]        # exit 0 when <tag> (default: $GITHUB_REF_NAME) matches, else exit 1
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expected = `v${version}`;

const args = process.argv.slice(2);
if (args.includes("--print")) {
  process.stdout.write(`${expected}\n`);
  process.exit(0);
}

const tag = args.find((a) => !a.startsWith("-")) ?? process.env.GITHUB_REF_NAME ?? "";
if (tag !== expected) {
  process.stderr.write(`tag mismatch: got ${JSON.stringify(tag)}, want ${JSON.stringify(expected)} (package.json ${version})\n`);
  process.exit(1);
}
process.stdout.write(`tag ok: ${tag}\n`);
