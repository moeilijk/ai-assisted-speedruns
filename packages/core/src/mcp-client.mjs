// Minimal MCP stdio client used by `aas check-connection` and the tests:
// spawns the broker under node --permission and speaks newline-delimited
// JSON-RPC 2.0 with it. No dependencies.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** What this client is: the framework's own version, so a broker log never says 0.1.0 for a 0.29.1 harness. */
export const CLIENT_VERSION = JSON.parse(readFileSync(join(CORE_DIR, "package.json"), "utf8")).version;
export const BROKER_PATH = resolve(CORE_DIR, "src", "broker.mjs");

/** Node flags that sandbox the broker: read core, the game plugin, extra dirs and its own run dir; write only the run dir. */
export function brokerNodeArgs({ gameModule, readable = [], runDir }) {
  const dirs = [CORE_DIR, dirname(resolve(gameModule)), resolve(runDir), ...readable];
  const reads = [...new Set(dirs.map((d) => resolve(d)))].map((d) => `--allow-fs-read=${d}`);
  return ["--permission", ...reads, `--allow-fs-write=${resolve(runDir)}`, BROKER_PATH];
}

/**
 * The broker's environment: what the harness sets, plus the variables the game plugin declares it reads
 * (`plugin.env`, passed as `passThrough`). Nothing else of the machine's environment reaches the broker:
 * until every AAS_* variable went through, and the run configuration published with each bundle
 * carried the machine's whole .env, the OBS password included.
 */
export function brokerEnv({ gameModule, runDir, endpoints = [], timeZone, extra = {}, passThrough = [] }) {
  const env = {
    ...Object.fromEntries(passThrough.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
    AAS_GAME_MODULE: resolve(gameModule),
    AAS_RUN_DIR: resolve(runDir),
    AAS_ALLOWED_ENDPOINTS: endpoints.map((e) => `${e.host}:${e.port}`).join(","),
    ...extra,
  };
  if (timeZone) env.AAS_TIME_ZONE = timeZone;
  return env;
}

export function startBroker({ gameModule, runDir, readable, endpoints, timeZone, env = {}, passThrough = [], timeoutMs = 180000 }) {
  const child = spawn(process.execPath, brokerNodeArgs({ gameModule, readable, runDir }), {
    cwd: resolve(runDir),
    env: brokerEnv({ gameModule, runDir, endpoints, timeZone, extra: env, passThrough }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  let nextId = 0;
  let exited = false;
  const pending = new Map();
  const failAll = (error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (t) => (stderr = (stderr + t).slice(-8000)));
  child.on("error", failAll);
  child.on("exit", (code, signal) => {
    exited = true;
    failAll(new Error(`broker exited (${code ?? signal}). ${stderr}`));
  });
  child.stdin.on("error", failAll);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (t) => {
    buffer += t;
    let at;
    while ((at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (error) {
        failAll(new Error(`invalid broker response: ${error.message}`));
        continue;
      }
      const p = pending.get(msg.id);
      if (!p) continue;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });

  function request(method, params) {
    if (exited) return Promise.reject(new Error(`broker is no longer running. ${stderr}`));
    const id = ++nextId;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`timed out waiting for ${method}. ${stderr}`));
      }, timeoutMs);
      pending.set(id, { resolve: res, reject: rej, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  async function call(name, args = {}) {
    const result = await request("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(result.content.map((c) => c.text ?? "").join("\n"));
    return result;
  }
  async function initialize(clientInfo = { name: "aas", version: CLIENT_VERSION }) {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo });
    notify("notifications/initialized");
    return init;
  }
  function close() {
    failAll(new Error("client closed"));
    child.stdin.end();
    setTimeout(() => {
      if (!exited) child.kill();
    }, 1000).unref();
  }
  return {
    request,
    call,
    initialize,
    close,
    get stderr() {
      return stderr;
    },
    exited: () => new Promise((res) => (exited ? res() : child.once("exit", res))),
  };
}

/** Load a game plugin module in-process (not sandboxed; for configuration and checks). */
export async function loadGamePlugin(modulePath) {
  const { pathToFileURL } = await import("node:url");
  const loaded = await import(pathToFileURL(resolve(modulePath)).href);
  const plugin = loaded.default ?? loaded;
  if (!plugin || typeof plugin.id !== "string") throw new Error(`${modulePath} does not export a GamePlugin.`);
  const { endsOf } = await import("./goal.mjs");
  endsOf(plugin); // every game declares its ends
  return plugin;
}
