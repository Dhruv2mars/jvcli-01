# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-09-14

Added:

- `JVCLI_FAULT` crash points for publish recovery with retry tests.
- `context append --ordinal` with gap tracking and completeness 3.
- Workspace autodetect through the `.jvcli-layer` marker.
- Diagnostics bundle with journal states, layer states, and verify summary.
- `scripts/ga-walkthrough.sh` plus `scripts/pack-smoke.sh`, both gated in CI.
- Reference-model property tests for the merge engine.
- Measured performance budgets at 5 and 100 layers.
- `checkpoint` and `watch` commands on a coalescing checkpoint engine, with
  CAS advance so concurrent writers retry instead of losing checkpoints.
- `timeline` command: read-only rows over worlds, publications, checkpoints,
  refresh and stack records, context, and journals, carrying no payload
  bytes or workspace paths.
- Workspace backend contract with `fs` and in-memory backends plus a
  cross-backend conformance suite.
- GA design packages and the 178-pass suite log preserved under
  `docs/audit`.

Fixed:

- Clone and child now flush dirty sources before branching.
- Publish op-id retry resumes finalized operations instead of failing.
- GC pins live journal objects and quarantines fresh writes.
- Delete refuses while a live journal cites the layer.
- Journal-checkpoint adopt on retry uses compare-and-swap.
- Merges are executable-aware: chmod-only edits surface as metadata changes
  and conflict against content edits, and the fs fingerprint carries the
  exec bit.
- The CLI fails closed on any stdout or stderr stream error, including
  `EPIPE`, instead of exiting success with missing output.
- Refresh, context, and checkpoint paths advance under CAS; stack resume
  validates sources and target.
- Verify cross-checks publication state and walks record bodies across the
  full checkpoint chain.
- GC sweeps tmp orphans and prunes settled journals.
- Symlink escape check is root-relative; publish and stack skip flag values
  when finding selectors.
- Op ids bind to layers; stale publish journals retry as stale; missing
  context is retryable; ambiguous layer prefixes report `E_AMBIGUOUS_LAYER`.
- `show` writes blob bytes raw.
- e2e harness raises the spawn buffer cap and reports fork failures
  explicitly instead of surfacing them as empty output.

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
