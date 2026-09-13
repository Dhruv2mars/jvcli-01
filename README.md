# jvcli-01

Local agent-native version control for humans and agents. One World with immutable versions. Isolated Layers with automatic checkpoints. Native agent context. Stack plus atomic Publish.

Built with Effect TypeScript. Installs as `jvcli` and `jvcli-01`.

## Install

Requires Node 22.5 or newer, or Bun 1 or newer.

```sh
npm install -g jvcli-01
jvcli --help
```

From source:

```sh
bun install
bun run build
node dist/cli-entry.js --help
```

## Use

```sh
jvcli init my-repo
cd my-repo
jvcli layer create --name feature
# edit files in the printed workspace with any editor
jvcli status --layer feature
jvcli publish feature
jvcli history --world
jvcli verify --full
```

Agents record context beside the code:

```sh
jvcli context begin --layer feature --agent alice
jvcli context append --layer feature --session <id> --kind note --text "plan approved"
jvcli context end --layer feature --session <id>
jvcli publish feature
```

Combine layers without publishing:

```sh
jvcli stack feat-a feat-b --into combined
jvcli publish combined
```

Every command accepts `--json` for scripting. Conflicts exit `2` with
the conflicting paths. All other failures exit `1`.

## Docs

- `docs/commands.md` lists every command, flag, and JSON shape.
- `docs/architecture.md` maps modules, objects, and merge flows.
- `docs/conformance.md` maps the Javelin spec section by section and names the honest gaps.

## Verify a release

```sh
bun run typecheck
bun test
scripts/ga-walkthrough.sh dist/cli-entry.js
sh scripts/pack-smoke.sh
bun benchmarks/run.ts --layers 5 --files 5
```

## Status

GA for local single-machine use on macOS, Linux, and Windows through plain
filesystem workspaces. The FSKit, OverlayFS, and ProjFS backends from the
spec are out of scope and documented as gaps. No remote protocol ships.
