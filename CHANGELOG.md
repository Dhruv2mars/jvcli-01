# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

Added:

- `JVCLI_FAULT` crash points for publish recovery with retry tests.
- `context append --ordinal` with gap tracking and completeness 3.
- Workspace autodetect through the `.jvcli-layer` marker.
- Diagnostics bundle with journal states, layer states, and verify summary.
- `scripts/ga-walkthrough.sh` plus `scripts/pack-smoke.sh`, both gated in CI.
- Reference-model property tests for the merge engine.
- Measured performance budgets at 5 and 100 layers.

Fixed:

- Clone and child now flush dirty sources before branching.
- Publish op-id retry resumes finalized operations instead of failing.
- GC pins live journal objects and quarantines fresh writes.
- Delete refuses while a live journal cites the layer.
- Journal-checkpoint adopt on retry uses compare-and-swap.

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
