// `aas check-agent`: does the agent's own CLI reach the broker, without asking the model anything (so: no tokens)?
// It configures a throwaway run directory for that runtime and game exactly as a run would, has the CLI list and
// health-check its MCP servers (Claude Code: `claude mcp list`; Codex: `codex mcp list`), and removes the directory
// again. This is the last step of a set-up that a mock run cannot prove: the agent's configuration, its trust flag
// and the broker together.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure } from "./configure.mjs";
import { loadGamePlugin, loadRuntime } from "./plugins.mjs";

export async function checkAgent({ runtime: runtimeId, game, runDir = null, keep = false, log = console.log } = {}) {
  const runtime = await loadRuntime(runtimeId);
  const plugin = await loadGamePlugin(game);
  if (!runtime.connectCheck) throw new Error(`${runtimeId} has no connection check (only a runtime that drives an agent CLI has one).`);
  const dir = runDir ? path.resolve(runDir) : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aas-agent-")), "check");
  const made = !runDir;
  try {
    if (!fs.existsSync(path.join(dir, "brief.json"))) await configure({ runtime: runtimeId, game, "run-dir": dir, id: `agent-check-${plugin.id}` }, { log: () => {} });
    const r = await runtime.connectCheck(dir, { gameId: plugin.id });
    log(`${r.ok ? "PASS" : "FAIL"}: ${runtime.name ?? runtimeId} reaches the ${plugin.id} tools — ${r.detail}`);
    return r;
  } finally {
    if (made && !keep) fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
}
