// The cheap half of a runtime's verification for Vibe: the MCP server the run's .vibe/config.toml names, started
// exactly as written there, answers a handshake and lists the broker's tools. Vibe has no command that lists its MCP
// servers outside a session, so this reads the file this plugin wrote and asks the server; no model is involved.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The [[mcp_servers]] entry of a configuration this plugin rendered: `{ command, args, cwd, env }`. */
export function readServer(text) {
  const at = text.indexOf("[[mcp_servers]]");
  if (at < 0) return null;
  const block = text.slice(at);
  const one = (key) => { const m = block.match(new RegExp(`^${key} = (.+)$`, "m")); return m ? JSON.parse(m[1]) : null; };
  const envAt = block.indexOf("[mcp_servers.env]");
  const env = {};
  if (envAt >= 0) for (const line of block.slice(envAt).split("\n").slice(1)) { const m = line.match(/^([A-Z0-9_]+) = (".*")$/); if (m) env[m[1]] = JSON.parse(m[2]); else if (line.startsWith("[")) break; }
  return { command: one("command"), args: one("args"), cwd: one("cwd"), env };
}

export function checkConfiguredServer(runDir, { expect = [], timeoutMs = 60000 } = {}) {
  const file = path.join(path.resolve(runDir), ".vibe", "config.toml");
  if (!fs.existsSync(file)) return Promise.resolve({ ok: false, detail: `${file} is not there (aas configure writes it)` });
  const server = readServer(fs.readFileSync(file, "utf8"));
  if (!server?.command) return Promise.resolve({ ok: false, detail: `${file} names no MCP server` });
  return new Promise((resolve) => {
    const command = server.command === "node" ? process.execPath : server.command;
    const child = spawn(command, server.args ?? [], { cwd: server.cwd ?? runDir, env: server.env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", done = false, stderr = "";
    // The broker ends when its input ends (as core's own client closes it); a server that does not is killed after a second.
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      const kill = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000);
      kill.unref();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: `the MCP server did not answer within ${timeoutMs / 1000} s${stderr ? `: ${stderr.trim().split("\n").at(-1)}` : ""}` }), timeoutMs);
    child.on("error", (e) => finish({ ok: false, detail: `the MCP server could not be started: ${e.message}` }));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let at;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at); buf = buf.slice(at + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`); send(2, "tools/list", {}); }
        if (m.id === 2) {
          const names = (m.result?.tools ?? []).map((t) => t.name).sort();
          const missing = expect.filter((t) => !names.includes(t));
          finish(missing.length ? { ok: false, detail: `the MCP server lists ${names.join(", ") || "no tools"}; missing ${missing.join(", ")}` } : { ok: true, detail: `the run's MCP server answers with ${names.join(", ")}` });
        }
      }
    });
    send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aas-vibe-check", version: "1" } });
  });
}
