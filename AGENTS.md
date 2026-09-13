# AGENTS.md

## Runtime

- Bun first. Use `bun install`, `bun run build`, `bun test`,
  `bun benchmarks/run.ts`, and `bun run typecheck` by default. Use `node`
  only when a script explicitly requires it.
- Do not use `npm` or `npx` when a `bun` equivalent exists. Respect the
  existing lockfile.

## Workflow

- Branch per task. Open a draft PR first for reviewable work.
- Small commits with prefixes: `feat:`, `fix:`, `test:`, `chore:`,
  `refactor:`.
- Run typecheck and tests before push: `bun run typecheck` and `bun test`.
  Do not push with failures.
- Never invoke git inside jvcli runtime code (`src/`). Git is only for the
  development workflow of this repository, never a storage backend.

## Scope

- Read `docs/commands.md`, `docs/architecture.md`, and
  `docs/conformance.md` before changing behavior.
- Keep CLI flags exactly as defined in `src/cli.ts`. Do not invent flags.
- Keep error shape `{ ok: false, error: { code, message, repo, layer,
  operation, paths, retryable, hint } }` and exit codes (2 on
  `E_CONFLICT` or `E_STALE`, 1 otherwise).
- v1 backends are filesystem workspaces plus in-memory reference semantics.
  FSKit, OverlayFS, and ProjFS are out of scope. Say so honestly in docs.
