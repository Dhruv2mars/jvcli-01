# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-09-13

Initial v1 release of `jvcli`, local agent native version control.

Added:

- `init`, `status`, `history`, `show`, `diff`, `verify`, `gc`, and
  `diagnostics bundle` commands.
- Layer lifecycle: `create`, `clone`, `child`, `open`, `close`, `rename`,
  `list`, `status`, `refresh`, `delete`.
- Atomic `publish` with CAS advance and resumable operation ids, and ordered
  `stack` with deterministic merge order.
- Agent context sessions: `begin`, `append`, `end`, `status`, `sessions`,
  `show`, with publish gating on incomplete context.
- Content addressed object store (BLAKE3-256 of deterministic CBOR) with
  hash on read, `refs.json` with CAS discipline, and per operation journal
  recovery.
- User docs (`docs/commands.md`, `docs/architecture.md`,
  `docs/conformance.md`) and benchmark harness (`benchmarks/run.ts`,
  `benchmarks/budgets.json`).
