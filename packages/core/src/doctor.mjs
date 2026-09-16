// `aas doctor --game <plugin.mjs> [--recorder obs] [--timer livesplit] [--runtime claude-code|codex] [--run-dir <dir>]`:
// check everything a run needs before starting it. Read-only. The core checks what it owns (Node, the game
// plugin's contract); every plugin adds its own rows through `doctor()`, so nothing here knows a game, an
// agent or a recorder by name.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { loadGamePlugin, loadRecorder, loadRuntime, loadTimer } from "./plugins.mjs";
import { witnessKeyStatus } from "./witness.mjs";

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
  const add = (ok, what, detail = "") => rows.push({ ok, what, detail });
  add(Number(process.versions.node.split(".")[0]) >= 22, "Node 22+", process.version);
  const key = await witnessKeyStatus();
  add(key.ok, "publisher key known to the witness", key.detail);
  const pluginRows = async (label, loader, id, ctx) => {
    if (!id) return;
    try {
      const p = await loader(id);
      for (const r of (await p.doctor?.(ctx)) ?? []) add(Boolean(r.ok), r.what, r.detail ?? "");
    } catch (e) {
      add(false, `${label} ${id}`, e.message);
    }
  };
  if (game) {
    try {
      const plugin = await loadGamePlugin(game);
      add(true, `game plugin ${plugin.id}`, path.resolve(game));
      try {
        const doc = typeof plugin.documentation === "function" ? await plugin.documentation() : plugin.documentation;
        add(Boolean(doc), "game documentation", `${String(doc ?? "").length} chars`);
      } catch (e) {
        add(false, "game documentation", e.message);
      }
      for (const dir of plugin.readable ?? []) add(fs.existsSync(dir), "readable dir", dir);
      for (const ep of plugin.endpoints ?? []) {
        const r = await probe(ep.host, ep.port);
        add(r === "open", `game endpoint ${ep.host}:${ep.port}`, r === "open" ? "reachable" : `${r} (is the game running with its IPC enabled?)`);
      }
      for (const r of (await plugin.doctor?.({ runDir })) ?? []) add(Boolean(r.ok), r.what, r.detail ?? "");
    } catch (e) {
      add(false, "game plugin", e.message);
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
