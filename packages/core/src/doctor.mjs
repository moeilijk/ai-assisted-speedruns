// `aas doctor --game <plugin.mjs> [--recorder obs] [--timer livesplit] [--runtime claude-code|codex] [--run-dir <dir>]`:
// check everything a run needs before starting it. Read-only. The core checks what it owns (Node, the game
// plugin's contract); every plugin adds its own rows through `doctor()`, so nothing here knows a game, an
// agent or a recorder by name.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { loadGamePlugin, loadRecorder, loadRuntime, loadTimer } from "./plugins.mjs";

function probe(host, port, ms = 2500) {
  return new Promise((res) => {
    const s = net.connect(port, host);
    const done = (v) => (s.destroy(), res(v));
    s.setTimeout(ms);
    s.on("connect", () => done("open"));
    s.on("error", (e) => done(e.code ?? "error"));
    s.on("timeout", () => done("timeout"));
  });
}

export async function doctor({ game, recorder = null, timer = null, runtime = null, runDir = null, log = console.log } = {}) {
  const rows = [];
  // Every row says which plugin it comes from (`source`), so a reader of `--json` (the GUI's Setup tab) takes the
  // rows of one plugin; `fix`, `level` and `when` are passed on as the plugin gave them (types.d.ts, DoctorRow).
  const add = (ok, what, detail = "", source = "core", extra = {}) => rows.push({ ok, what, detail, source, ...pick(extra) });
  const pick = (r) => Object.fromEntries(["fix", "level", "when"].filter((k) => r?.[k] !== undefined).map((k) => [k, r[k]]));
  add(Number(process.versions.node.split(".")[0]) >= 22, "Node 22+", process.version);
  const pluginRows = async (label, loader, id, ctx) => {
    if (!id) return;
    try {
      const p = await loader(id);
      for (const r of (await p.doctor?.(ctx)) ?? []) add(Boolean(r.ok), r.what, r.detail ?? "", label, r);
    } catch (e) {
      add(false, `${label} ${id}`, e.message, label);
    }
  };
  if (game) {
    try {
      const plugin = await loadGamePlugin(game);
      add(true, `game plugin ${plugin.id}`, path.resolve(game), "game");
      try {
        const doc = typeof plugin.documentation === "function" ? await plugin.documentation() : plugin.documentation;
        add(Boolean(doc), "game documentation", `${String(doc ?? "").length} chars`, "game");
      } catch (e) {
        add(false, "game documentation", e.message, "game");
      }
      for (const dir of plugin.readable ?? []) add(fs.existsSync(dir), "readable dir", dir, "game");
      for (const ep of plugin.endpoints ?? []) {
        const r = await probe(ep.host, ep.port);
        add(r === "open", `game endpoint ${ep.host}:${ep.port}`, r === "open" ? "reachable" : `${r} (is the game running with its IPC enabled?)`, "game", { when: "run" });
      }
      for (const r of (await plugin.doctor?.({ runDir })) ?? []) add(Boolean(r.ok), r.what, r.detail ?? "", "game", r);
    } catch (e) {
      add(false, "game plugin", e.message, "game");
    }
  }
  await pluginRows("runtime", loadRuntime, runtime, { runDir });
  await pluginRows("recorder", loadRecorder, recorder, { runDir });
  await pluginRows("timer", loadTimer, timer, { runDir });
  const width = Math.max(...rows.map((r) => r.what.length));
  for (const r of rows) log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.what.padEnd(width)}  ${r.detail}`);
  const failed = rows.filter((r) => !r.ok).length;
  log(failed ? `${failed} check(s) failed.` : "All checks passed.");
  return { rows, ok: failed === 0 };
}
