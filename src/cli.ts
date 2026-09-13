import { Effect } from "effect";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { unwrapObject } from "./core/cbor.js";
import { CODES, JvError, fail } from "./core/types.js";
import { openRepo, currentWorldId, resolveWorldSelector, flattenRoot } from "./core/repo.js";
import { initRepository } from "./domain-init.js";
import {
  childLayer,
  cloneLayer,
  closeLayer,
  createLayer,
  deleteLayer,
  flushLayer,
  layerStatus,
  listLayers,
  openLayer,
  refreshLayer,
  renameLayer
} from "./domain-layers.js";
import { publishLayer, stackLayers } from "./domain-compose.js";
import { layerContextStatus, sessionAppend, sessionEnd, sessionStart } from "./domain-context.js";
import { gcRepo, verifyRepo } from "./domain-verify.js";
import { loadRefs, resolveLayerRef } from "./core/refs.js";
import { decodeCheckpoint, decodeContextManifest, decodeWorldVersion, diffTrees } from "./core/objects.js";
import { findRepoRoot, findLayerForCwd } from "./locate.js";

export interface Output {
  human: string;
  json: unknown;
}

function out(human: string, json: unknown): Output {
  return { human, json };
}

function jvErrorJson(e: JvError, repoId?: string): unknown {
  return {
    ok: false,
    error: {
      code: e.code,
      message: e.message,
      repo: repoId ?? null,
      layer: e.layerId ?? null,
      operation: e.operationId ?? null,
      paths: e.paths ?? null,
      retryable: e.retryable,
      hint: e.hint ?? null
    }
  };
}

const HELP = `jvcli. Local agent-native version control.

Usage:
  jvcli init [path]
  jvcli status [--layer <id>] [--json]
  jvcli history [--world | --layer <id>] [--json]
  jvcli show <object-or-version> [--json]
  jvcli diff <left> [right] [--json]
  jvcli verify [--full] [--json]
  jvcli gc [--dry-run] [--json]
  jvcli diagnostics bundle [--output <path>]
  jvcli layer create [--name <n>] [--from <base>] [--json]
  jvcli layer clone <layer> [--name <n>] [--checkpoint <cp>] [--json]
  jvcli layer child <parent> [--name <n>] [--checkpoint <cp>] [--json]
  jvcli layer open <layer> [--json]
  jvcli layer close <layer> [--json]
  jvcli layer rename <layer> <name> [--json]
  jvcli layer list [--json]
  jvcli layer status <layer> [--json]
  jvcli layer refresh <layer> [--json]
  jvcli layer delete <layer> [--json]
  jvcli stack <layer>... [--into <name>] [--json]
  jvcli publish <layer> [--allow-missing-context] [--operation-id <id>] [--json]
  jvcli context status [--layer <id>] [--json]
  jvcli context sessions [--layer <id>] [--json]
  jvcli context show <session-or-manifest> [--json]
  jvcli context begin --layer <id> [--session <id>] [--parent <id>] [--agent <a>] [--format <f>] [--json]
  jvcli context append --layer <id> --session <id> --kind <k> [--ordinal <n>] [--text <t>] [--file <p>] [--json]
  jvcli context end --layer <id> --session <id> [--interrupted] [--json]
`;

function flag(args: ReadonlyArray<string>, name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return "";
  return v;
}

function has(args: ReadonlyArray<string>, name: string): boolean {
  return args.includes(name);
}

function emit(o: Output, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(o.json, null, 2)}\n`);
  else process.stdout.write(o.human.endsWith("\n") ? o.human : `${o.human}\n`);
}

async function repoRootOrThrow(start: string): Promise<string> {
  return findRepoRoot(start);
}

export function runCli(argv: ReadonlyArray<string>) {
  return Effect.tryPromise({
    try: () => execute(argv),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        if (e instanceof JvError) {
          const json = has(argv as ReadonlyArray<string>, "--json");
          if (json) process.stdout.write(`${JSON.stringify(jvErrorJson(e), null, 2)}\n`);
          else process.stderr.write(`jvcli: ${e.code}: ${e.message}${e.hint !== undefined ? ` (${e.hint})` : ""}\n`);
          process.exitCode = e.code === "E_CONFLICT" || e.code === "E_STALE" ? 2 : 1;
        } else {
          if (has(argv as ReadonlyArray<string>, "--json")) {
            process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "E_IO", message: String(e) } }, null, 2)}\n`);
          } else {
            process.stderr.write(`jvcli: ${(e as Error).message ?? String(e)}\n`);
          }
          process.exitCode = 1;
        }
      })
    )
  );
}

async function execute(argv: ReadonlyArray<string>): Promise<void> {
  const [cmd = "help", ...rest] = argv;
  const json = has(rest, "--json");
  const args = rest.filter((a) => a !== "--json");
  switch (cmd) {
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(HELP);
      return;
    }
    case "init": {
      const target = args[0] ?? process.cwd();
      const r = await initRepository(target);
      emit(out(`initialized jvcli repository: ${r.root}\nworld v1: ${r.worldId}${r.warnings.length > 0 ? `\nwarnings:\n${r.warnings.map((w) => `- ${w}`).join("\n")}` : ""}\n`, { ok: true, repo: r.repoId, root: r.root, world: r.worldId, seq: 1, files: r.files, warnings: r.warnings }), json);
      return;
    }
    case "status": {
      const layerFlag = flag(args, "--layer");
      const root = await repoRootOrThrow(process.cwd());
      const repo = await openRepo(root);
      const refs = await loadRefs(repo.metaDir);
      const curId = await currentWorldId(repo);
      const cur = decodeWorldVersion(await repo.store.readChecked(curId, 3));
      if (layerFlag !== null && layerFlag !== "") {
        const s = await layerStatus(repo, layerFlag);
        const ctx = await layerContextStatus(repo, s.id).catch(() => null);
        emit(
          out(
            `world: v${cur.seq} ${curId}\nlayer: ${s.name ?? s.id.slice(0, 12)} (${s.id})\nstate: ${s.state}\ncheckpoint: ${s.checkpoint}\nanchor: v${s.anchorSeq}\nworkspace: ${s.workspace ?? "-"}\ndirty: ${s.dirty ? "yes" : "no"}\ncheckpoint_pending: ${s.pendingCheckpoint ? "yes" : "no"}\nstale: ${s.stale ? "yes" : "no"}\ncontext: ${ctx === null ? "unknown" : ctx.missing ? "missing" : "ok"}\n`,
            { ok: true, repo: repo.repoId, root, world: { seq: cur.seq, id: curId }, layer: { id: s.id, name: s.name, state: s.state, checkpoint: s.checkpoint, anchorSeq: s.anchorSeq, anchor: s.anchorId, workspace: s.workspace, workspace_dirty: s.dirty, checkpoint_pending: s.pendingCheckpoint, checkpoint_durable: !s.pendingCheckpoint, stale: s.stale, context: ctx } }
          ),
          json
        );
        return;
      }
      const auto = layerFlag === null ? await findLayerForCwd(process.cwd()).catch(() => null) : null;
      if (auto !== null) {
        const s = await layerStatus(repo, auto);
        const ctx = await layerContextStatus(repo, s.id).catch(() => null);
        emit(
          out(
            `world: v${cur.seq} ${curId}\nlayer: ${s.name ?? s.id.slice(0, 12)} (${s.id})\nstate: ${s.state}\ncheckpoint: ${s.checkpoint}\nanchor: v${s.anchorSeq}\nworkspace: ${s.workspace ?? "-"}\ndirty: ${s.dirty ? "yes" : "no"}\ncheckpoint_pending: ${s.pendingCheckpoint ? "yes" : "no"}\nstale: ${s.stale ? "yes" : "no"}\ncontext: ${ctx === null ? "unknown" : ctx.missing ? "missing" : "ok"}\n`,
            { ok: true, repo: repo.repoId, root, world: { seq: cur.seq, id: curId }, layer: { id: s.id, name: s.name, state: s.state, checkpoint: s.checkpoint, anchorSeq: s.anchorSeq, anchor: s.anchorId, workspace: s.workspace, workspace_dirty: s.dirty, checkpoint_pending: s.pendingCheckpoint, checkpoint_durable: !s.pendingCheckpoint, stale: s.stale, context: ctx } }
          ),
          json
        );
        return;
      }
      const layers = await listLayers(repo);
      const lines = [`world: v${cur.seq} ${curId}`, `layers: ${layers.length}`];
      for (const l of layers) lines.push(`- ${(l.name ?? l.id.slice(0, 12)).padEnd(20)} ${l.state.padEnd(9)} anchor v${l.anchorSeq}${l.stale ? " (stale)" : ""}`);
      emit(out(`${lines.join("\n")}\n`, { ok: true, repo: repo.repoId, root, world: { seq: cur.seq, id: curId }, layers: layers.map((l) => ({ id: l.id, name: l.name, state: l.state, anchorSeq: l.anchorSeq, stale: l.stale })) }), json);
      return;
    }
    case "history": {
      const root = await repoRootOrThrow(process.cwd());
      const repo = await openRepo(root);
      if (has(args, "--world") || (!has(args, "--layer") && flag(args, "--layer") === null)) {
        const refs = await loadRefs(repo.metaDir);
        const seqs = Object.keys(refs.worldsBySeq).map(Number).sort((a, b) => a - b);
        const lines: Array<string> = [];
        const items: Array<unknown> = [];
        for (const seq of seqs) {
          const id = refs.worldsBySeq[String(seq)]!;
          const w = decodeWorldVersion(await repo.store.readChecked(id, 3));
          lines.push(`v${seq} ${id}`);
          items.push({ seq, id, root: w.rootId, prev: w.prevId, publication: w.publicationId, contexts: w.contextIds });
        }
        if (flag(args, "--layer") !== null) {
          // fallthrough to layer history below
        } else {
          emit(out(`${lines.join("\n")}\n`, { ok: true, repo: repo.repoId, worlds: items }), json);
          return;
        }
      }
      const sel = flag(args, "--layer") ?? args[0] ?? (await findLayerForCwd(process.cwd()).catch(() => null));
      if (sel === null || sel === "") throw fail(CODES.invalidPath, "history needs --world or --layer <id>");
      const repo2 = repo;
      const refs = await loadRefs(repo2.metaDir);
      const ref = resolveLayerRef(refs, sel);
      const chain: Array<{ id: string; anchor: string; root: string }> = [];
      let cur: string | null = ref.checkpoint;
      while (cur !== null) {
        const cp = decodeCheckpoint(await repo2.store.readChecked(cur, 4));
        chain.push({ id: cur, anchor: cp.anchorId, root: cp.rootId });
        cur = cp.prevId;
      }
      emit(out(`${chain.map((c) => c.id).join("\n")}\n`, { ok: true, repo: repo.repoId, layer: ref.id, checkpoints: chain }), json);
      return;
    }
    case "show": {
      const sel = args[0];
      if (sel === undefined) throw fail(CODES.invalidPath, "show needs an object or version");
      const root = await repoRootOrThrow(process.cwd());
      const repo = await openRepo(root);
      let id = sel;
      if (/^v[0-9]+$/.test(sel)) {
        id = await resolveWorldSelector(repo, sel.slice(1));
      } else if (/^[0-9]+$/.test(sel)) {
        const refs = await loadRefs(repo.metaDir);
        if (refs.worldsBySeq[sel] !== undefined) id = refs.worldsBySeq[sel]!;
      } else {
        try {
          id = await resolveWorldSelector(repo, sel);
        } catch {
          id = sel.toLowerCase();
        }
      }
      const bytes = await repo.store.read(id);
      const { type } = unwrapObject(bytes);
      const names = ["", "blob", "tree", "world", "checkpoint", "context-object", "context-manifest", "publication", "refresh", "stack"];
      if (type === 1) {
        const { payload } = unwrapObject(bytes);
        if (payload.tag === "bytes") process.stdout.write(payload.value);
        emit(out(``, { ok: true, id, type: names[type] }), true && false ? json : false);
        return;
      }
      emit(out(`object ${id} type ${names[type]}\n`, { ok: true, id, type: names[type] }), json);
      return;
    }
    case "diff": {
      const [left, right] = args;
      if (left === undefined) throw fail(CODES.invalidPath, "diff needs two states");
      const root = await repoRootOrThrow(process.cwd());
      const repo = await openRepo(root);
      const resolveState = async (s: string): Promise<string> => {
        if (/^v[0-9]+$/.test(s)) return flattenRootId(repo, await resolveWorldSelector(repo, s.slice(1)));
        if (/^[0-9]+$/.test(s)) {
          const refs = await loadRefs(repo.metaDir);
          if (refs.worldsBySeq[s] !== undefined) return flattenRootId(repo, refs.worldsBySeq[s]!);
        }
        try {
          const wid = await resolveWorldSelector(repo, s);
          return flattenRootId(repo, wid);
        } catch {
          // layer selector or checkpoint id
        }
        try {
          const refs = await loadRefs(repo.metaDir);
          const ref = resolveLayerRef(refs, s);
          return decodeCheckpoint(await repo.store.readChecked(ref.checkpoint, 4)).rootId;
        } catch {
          // raw root/tree/checkpoint id
        }
        try {
          const cp = decodeCheckpoint(await repo.store.read(s));
          return cp.rootId;
        } catch {
          // raw tree root
        }
        return s.toLowerCase();
      };
      const lroot = await resolveState(left);
      const rroot = right === undefined ? await flattenRootId(repo, await currentWorldId(repo)) : await resolveState(right);
      const lf = await flattenRoot(repo.store, lroot);
      const rf = await flattenRoot(repo.store, rroot);
      const changes = diffTrees(lf, rf);
      const lines = changes.map((c) => `${c.kind}\t${c.path}`);
      emit(out(`${lines.join("\n")}${lines.length > 0 ? "\n" : "no changes\n"}`, { ok: true, left: lroot, right: rroot, changes }), json);
      return;
    }
    case "verify": {
      const root = await repoRootOrThrow(process.cwd());
      const r = await verifyRepo(root, has(args, "--full"));
      emit(out(`verified: ${r.worlds} worlds, ${r.layers} layers, ${r.objects} objects\n`, { ok: true, ...r }), json);
      return;
    }
    case "gc": {
      const root = await repoRootOrThrow(process.cwd());
      const r = await gcRepo(root, has(args, "--dry-run"));
      emit(out(`${r.dryRun ? "candidates" : "removed"}: ${r.removed} (reachable ${r.reachable}/${r.total})\n`, { ok: true, ...r }), json);
      return;
    }
    case "diagnostics": {
      if (args[0] !== "bundle") throw fail(CODES.invalidPath, "usage: jvcli diagnostics bundle [--output <path>]");
      const root = await repoRootOrThrow(process.cwd());
      const repo = await openRepo(root);
      const refs = await loadRefs(repo.metaDir);
      const curId = await currentWorldId(repo);
      const cur = decodeWorldVersion(await repo.store.readChecked(curId, 3));
      const { listJournals } = await import("./core/refs.js");
      const journals = await listJournals(repo.metaDir);
      const byState: Record<string, number> = {};
      const opIds: Array<string> = [];
      for (const j of journals) {
        byState[j.state] = (byState[j.state] ?? 0) + 1;
        opIds.push(j.operationId);
      }
      opIds.sort();
      const layerStates: Record<string, number> = {};
      let staleLayers = 0;
      for (const l of Object.values(refs.layers)) {
        if (l.state === "deleted") continue;
        layerStates[l.state] = (layerStates[l.state] ?? 0) + 1;
        try {
          const cp = decodeCheckpoint(await repo.store.readChecked(l.checkpoint, 4));
          if (cp.anchorId !== curId) staleLayers++;
        } catch {
          // unreadable checkpoint surfaces in verify, not here
        }
      }
      const bundle = {
        version: 1,
        repo: repo.repoId,
        world: { seq: cur.seq, id: curId },
        layers: Object.keys(refs.layers).length,
        layerStates,
        staleLayers,
        worlds: Object.keys(refs.worldsBySeq).length,
        journals: { total: journals.length, byState, operationIds: opIds.slice(0, 100) },
        verify: await verifyRepo(root, false).then(
          (r) => ({ ok: true as const, worlds: r.worlds, layers: r.layers, objects: r.objects }),
          (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })
        ),
        platform: process.platform,
        node: process.version
      };
      const output = flag(args, "--output");
      if (output !== null && output !== "") {
        await writeFile(resolve(output), `${JSON.stringify(bundle, null, 2)}\n`);
        emit(out(`bundle: ${resolve(output)}\n`, { ok: true, ...bundle, output: resolve(output) }), json);
      } else {
        emit(out(`${JSON.stringify(bundle, null, 2)}\n`, { ok: true, ...bundle }), true);
      }
      return;
    }
    case "layer": {
      const sub = args[0];
      const rest2 = args.slice(1);
      const root = await repoRootOrThrow(process.cwd());
      const repo = await openRepo(root);
      switch (sub) {
        case "create": {
          const name = flag(rest2, "--name") ?? undefined;
          const from = flag(rest2, "--from") ?? undefined;
          const { ref, workspace } = await createLayer(repo, { name: name === "" ? undefined : name ?? undefined, from: from === "" ? undefined : from ?? undefined });
          emit(out(`layer: ${ref.id}\nworkspace: ${workspace}\n`, { ok: true, repo: repo.repoId, layer: ref.id, name: ref.name, workspace }), has(argv as ReadonlyArray<string>, "--json"));
          return;
        }
        case "clone": {
          const sel = rest2[0];
          if (sel === undefined) throw fail(CODES.invalidPath, "clone needs a layer");
          const { ref, workspace } = await cloneLayer(repo, sel, flag(rest2, "--name") ?? undefined, flag(rest2, "--checkpoint") ?? undefined);
          emit(out(`layer: ${ref.id}\nworkspace: ${workspace}\n`, { ok: true, repo: repo.repoId, layer: ref.id, workspace }), has(argv as ReadonlyArray<string>, "--json"));
          return;
        }
        case "child": {
          const sel = rest2[0];
          if (sel === undefined) throw fail(CODES.invalidPath, "child needs a parent layer");
          const { ref, workspace } = await childLayer(repo, sel, flag(rest2, "--name") ?? undefined, flag(rest2, "--checkpoint") ?? undefined);
          emit(out(`layer: ${ref.id}\nworkspace: ${workspace}\n`, { ok: true, repo: repo.repoId, layer: ref.id, workspace }), has(argv as ReadonlyArray<string>, "--json"));
          return;
        }
        case "open": {
          const sel = rest2[0];
          if (sel === undefined) throw fail(CODES.invalidPath, "open needs a layer");
          const { ref, workspace } = await openLayer(repo, sel);
          emit(out(`layer: ${ref.id}\nworkspace: ${workspace}\n`, { ok: true, repo: repo.repoId, layer: ref.id, workspace }), has(argv as ReadonlyArray<string>, "--json"));
          return;
        }
        case "close": {
          const sel = rest2[0];
          if (sel === undefined) throw fail(CODES.invalidPath, "close needs a layer");
          const ref = await closeLayer(repo, sel);
          emit(out(`closed ${ref.id}\n`, { ok: true, layer: ref.id }), has(argv as ReadonlyArray<string>, "--json"));
          return;
        }
        case "rename": {
          const [sel, name] = rest2;
          if (sel === undefined || name === undefined) throw fail(CODES.invalidPath, "rename needs a layer and a name");
          const ref = await renameLayer(repo, sel, name);
          emit(out(`renamed ${ref.id} to ${ref.name}\n`, { ok: true, layer: ref.id, name }), has(argv as ReadonlyArray<string>, "--json"));
          return;
        }
        case "list": {
          const layers = await listLayers(repo);
          const lines = layers.map((l) => `${l.id}\t${l.name ?? "-"}\t${l.state}\tanchor v${l.anchorSeq}${l.stale ? " stale" : ""}\t${l.workspace ?? "-"}`);
          emit(out(`${lines.join("\n")}${lines.length > 0 ? "\n" : "no layers\n"}`, { ok: true, layers }), has(argv as ReadonlyArray<string>, "--json"));
          return;
        }
        case "status": {
          const sel = rest2[0] ?? (await findLayerForCwd(process.cwd()).catch(() => null));
          if (sel === null || sel === undefined) throw fail(CODES.invalidPath, "status needs a layer");
          const s = await layerStatus(repo, sel);
          emit(out(`layer: ${s.id}\nstate: ${s.state}\ncheckpoint: ${s.checkpoint}\nanchor: v${s.anchorSeq}\nworkspace: ${s.workspace ?? "-"}\ndirty: ${s.dirty}\n`, { ok: true, layer: s }), has(argv as ReadonlyArray<string>, "--json"));
          return;
        }
        case "refresh": {
          const sel = rest2[0] ?? (await findLayerForCwd(process.cwd()).catch(() => null));
          if (sel === null || sel === undefined) throw fail(CODES.invalidPath, "refresh needs a layer");
          await flushLayer(repo, sel);
          const r = await refreshLayer(repo, sel);
          if (r.conflicts.length > 0) {
            const e = fail(CODES.conflict, `refresh conflicts: ${r.conflicts.map((c) => c.path).join(", ")}`, { paths: r.conflicts.map((c) => c.path) });
            throw e;
          }
          emit(out(`refreshed to v${r.adopted}: ${r.checkpoint}\n`, { ok: true, checkpoint: r.checkpoint, adopted: r.adopted }), has(argv as ReadonlyArray<string>, "--json"));
          return;
        }
        case "delete": {
          const sel = rest2[0];
          if (sel === undefined) throw fail(CODES.invalidPath, "delete needs a layer");
          await deleteLayer(repo, sel);
          emit(out(`deleted ${sel}\n`, { ok: true }), has(argv as ReadonlyArray<string>, "--json"));
          return;
        }
        default:
          throw fail(CODES.invalidPath, `unknown layer command: ${sub ?? ""}`);
      }
    }
    case "stack": {
      const into = flag(args, "--into") ?? undefined;
      const selectors = args.filter((a) => !a.startsWith("--") && a !== (flag(args, "--into") ?? "\0"));
      const root = await repoRootOrThrow(process.cwd());
      const repo = await openRepo(root);
      const r = await stackLayers(repo, selectors, into === "" ? undefined : into ?? undefined);
      emit(out(`stacked into ${r.destId}\nworkspace: ${r.workspace}\n`, { ok: true, dest: r.destId, workspace: r.workspace, operation: r.operationId, order: r.order }), json);
      return;
    }
    case "publish": {
      const sel = args.find((a) => !a.startsWith("--")) ?? (await findLayerForCwd(process.cwd()).catch(() => null));
      if (sel === null || sel === undefined) throw fail(CODES.invalidPath, "publish needs a layer");
      const root = await repoRootOrThrow(process.cwd());
      const repo = await openRepo(root);
      const r = await publishLayer(repo, sel, {
        allowMissingContext: has(args, "--allow-missing-context"),
        operationId: flag(args, "--operation-id") ?? undefined,
        actor: undefined
      });
      if (r.status === "conflict") {
        const e = fail(CODES.conflict, `publish conflicts: ${(r.conflicts ?? []).map((c) => c.path).join(", ")}`, { layerId: sel, operationId: r.operationId, paths: (r.conflicts ?? []).map((c) => c.path) });
        throw e;
      }
      emit(out(`published v${r.seq}: ${r.worldId}\n`, { ok: true, seq: r.seq, world: r.worldId, operation: r.operationId, status: r.status }), json);
      return;
    }
    case "context": {
      const sub = args[0];
      const rest2 = args.slice(1);
      const root = await repoRootOrThrow(process.cwd());
      const repo = await openRepo(root);
      const j = has(argv as ReadonlyArray<string>, "--json");
      switch (sub) {
        case "status":
        case "sessions": {
          const sel = flag(rest2, "--layer") ?? rest2[0] ?? (await findLayerForCwd(process.cwd()).catch(() => null));
          if (sel === null || sel === undefined || sel === "") throw fail(CODES.invalidPath, "context status needs a layer");
          const refs = await loadRefs(repo.metaDir);
          const ref = resolveLayerRef(refs, sel);
          const s = await layerContextStatus(repo, ref.id);
          emit(
            out(
              s.sessions.length === 0 ? `no sessions (agent: ${ref.agent ?? "none"})\n` : `${s.sessions.map((x) => `${x.session} completeness=${x.completeness} objects=${x.objects} bytes=${x.bytes}`).join("\n")}\n`,
              { ok: true, layer: ref.id, missing: s.missing, sessions: s.sessions }
            ),
            j
          );
          return;
        }
        case "show": {
          const sel = rest2[0];
          if (sel === undefined) throw fail(CODES.invalidPath, "context show needs a session or manifest");
          const refs = await loadRefs(repo.metaDir);
          let manifestId: string | null = null;
          for (const l of Object.values(refs.layers)) {
            if (l.sessions[sel.toLowerCase()] !== undefined) manifestId = l.sessions[sel.toLowerCase()]!;
            for (const mid of Object.values(l.sessions)) {
              if (mid.toLowerCase().startsWith(sel.toLowerCase())) manifestId = mid;
            }
          }
          if (manifestId !== null && manifestId.toLowerCase().startsWith(sel.toLowerCase())) {
            // resolved
          }
          if (manifestId === null) {
            try {
              manifestId = sel.toLowerCase();
              await repo.store.readChecked(manifestId, 6);
            } catch {
              throw fail(CODES.invalidPath, `no such session: ${sel}`);
            }
          }
          const m = decodeContextManifest(await repo.store.readChecked(manifestId, 6));
          emit(out(`session ${m.sessionId} completeness=${m.completeness} objects=${m.objectIds.length}\n`, { ok: true, manifest: manifestId, ...m }), j);
          return;
        }
        case "begin": {
          const layer = flag(rest2, "--layer") ?? (await findLayerForCwd(process.cwd()).catch(() => null));
          if (layer === null || layer === undefined || layer === "") throw fail(CODES.invalidPath, "context begin needs --layer");
          const refs = await loadRefs(repo.metaDir);
          const ref = resolveLayerRef(refs, layer);
          const sessionFlag = flag(rest2, "--session");
          const parentFlag = flag(rest2, "--parent");
          const formatFlag = flag(rest2, "--format");
          const agentFlag = flag(rest2, "--agent");
          const beginOpts: { sessionId: string | undefined; parent: string | undefined; format: string | undefined; agent: string | undefined } = {
            sessionId: sessionFlag === null || sessionFlag === "" ? undefined : sessionFlag,
            parent: parentFlag === null || parentFlag === "" ? undefined : parentFlag,
            format: formatFlag === null || formatFlag === "" ? undefined : formatFlag,
            agent: agentFlag === null || agentFlag === "" ? undefined : agentFlag
          };
          const r = await sessionStart(repo, ref.id, beginOpts);
          emit(out(`session: ${r.sessionId}\nmanifest: ${r.manifest}\n`, { ok: true, ...r }), j);
          return;
        }
        case "append": {
          const layer = flag(rest2, "--layer") ?? (await findLayerForCwd(process.cwd()).catch(() => null));
          const session = flag(rest2, "--session");
          const kind = flag(rest2, "--kind") ?? "note";
          if (layer === null || layer === undefined || layer === "" || session === null || session === "") {
            throw fail(CODES.invalidPath, "context append needs --layer and --session");
          }
          const ordinalFlag = flag(rest2, "--ordinal");
          let ordinal: number | undefined;
          if (ordinalFlag !== null && ordinalFlag !== "") {
            ordinal = Number(ordinalFlag);
            if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw fail(CODES.invalidPath, "ordinal must be a non-negative integer");
          }
          const text = flag(rest2, "--text");
          const file = flag(rest2, "--file");
          let bytes: Uint8Array;
          if (file !== null && file !== "") {
            bytes = await readFile(resolve(file));
          } else if (text !== null) {
            bytes = new TextEncoder().encode(text === "" ? "" : text);
          } else {
            throw fail(CODES.invalidPath, "context append needs --text or --file");
          }
          const refs = await loadRefs(repo.metaDir);
          const ref = resolveLayerRef(refs, layer);
          const r = await sessionAppend(repo, ref.id, session, [{ kind, bytes, ordinal, format: undefined }]);
          emit(out(`manifest: ${r.manifest}\nobjects: ${r.objects.length}\n`, { ok: true, ...r }), j);
          return;
        }
        case "end": {
          const layer = flag(rest2, "--layer") ?? (await findLayerForCwd(process.cwd()).catch(() => null));
          const session = flag(rest2, "--session");
          if (layer === null || layer === undefined || layer === "" || session === null || session === "") {
            throw fail(CODES.invalidPath, "context end needs --layer and --session");
          }
          const refs = await loadRefs(repo.metaDir);
          const ref = resolveLayerRef(refs, layer);
          const m = await sessionEnd(repo, ref.id, session, has(rest2, "--interrupted") ? "interrupted" : "complete");
          emit(out(`manifest: ${m}\n`, { ok: true, manifest: m }), j);
          return;
        }
        default:
          throw fail(CODES.invalidPath, `unknown context command: ${sub ?? ""}`);
      }
    }
    default:
      throw fail(CODES.invalidPath, `unknown command: ${cmd}\n\n${HELP}`);
  }
}

async function flattenRootId(repo: { store: { readChecked: (id: string, t?: number) => Promise<Uint8Array> } }, worldId: string): Promise<string> {
  const bytes = await repo.store.readChecked(worldId, 3);
  return decodeWorldVersion(bytes).rootId;
}

export { CODES, JvError };
