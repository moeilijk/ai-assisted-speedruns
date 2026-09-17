#!/usr/bin/env node
// The bridge between the agent's controller and balatrobot. balatrobot (JSON-RPC over HTTP on
// 127.0.0.1:12346) also serves `add` and `set`, which change the game at will, and `start`, `menu`,
// `save` and `load`, which only the harness may use. The broker may only reach the ports the plugin
// declares, so the plugin declares this bridge (127.0.0.1:12347) and not balatrobot: the bridge passes
// the game actions through and refuses everything else.
//
//   node games/balatro/bridge.mjs [--port 12347] [--bot-port 12346]
//
// Methods for the agent: the game actions in AGENT_METHODS, `aas.screenshot` (the PNG as base64) and
// `aas.restart` (after a game over only: back to the menu and a new run with the deck, stake and seed
// rule the harness started with). The harness sends the token from the state file (STATE_FILE, not
// readable from the broker) in the X-AAS-Token header and may call every method except `add` and `set`.
// The state file also holds the pid, so close-game.mjs can stop the bridge.
import http from "node:http";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonRpcClient } from "../../packages/core/src/json-rpc-http.mjs";

export const BRIDGE_PORT = 12347;
export const BOT_PORT = 12346;
export const STATE_FILE = process.env.AAS_BALATRO_BRIDGE_STATE || join(tmpdir(), "aas-balatro-bridge.json");
export const AGENT_METHODS = new Set(["health", "gamestate", "select", "skip", "buy", "pack", "sell", "reroll", "cash_out", "next_round", "play", "discard", "rearrange", "use"]);
export const HARNESS_METHODS = new Set([...AGENT_METHODS, "start", "menu", "save", "load", "screenshot"]);
export const NEVER = new Set(["add", "set"]);

// AAS_BALATRO_PATHS=native: the game runs on the same system as this process (tests, a Windows-only setup).
const isWsl = () => process.env.AAS_BALATRO_PATHS !== "native" && process.platform === "linux" && /microsoft/i.test((() => { try { return readFileSync("/proc/version", "utf8"); } catch { return ""; } })());

/** A path as the game sees it: under WSL the game is a Windows process, so a WSL path becomes a Windows path. */
export function gamePath(p) {
  return isWsl() ? execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim() : p;
}

/** The bridge's state file (pid, port, token), or null when no bridge is running. */
export function readBridgeState(file = STATE_FILE) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export async function startBridge({ port = BRIDGE_PORT, botPort = BOT_PORT, stateFile = STATE_FILE, shotDir = null, log = () => {} } = {}) {
  const bot = jsonRpcClient({ port: botPort, timeoutMs: 120000 });
  const token = randomBytes(16).toString("hex");
  // Where balatrobot writes a screenshot: a folder both the game and this process can reach.
  const dir = shotDir ?? (isWsl()
    ? execFileSync("wslpath", ["-u", execFileSync("cmd.exe", ["/c", "echo %TEMP%"], { encoding: "utf8", cwd: "/mnt/c" }).trim()], { encoding: "utf8" }).trim()
    : tmpdir());
  let lastStart = null; // the harness's start: { deck, stake, seed? }
  let shots = 0;
  const answer = (res, id, body) => { const text = JSON.stringify({ jsonrpc: "2.0", id: id ?? null, ...body }); res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), Connection: "close" }); res.end(text); };
  const refuse = (message) => ({ error: { code: -32003, message, data: { name: "NOT_ALLOWED" } } });
  const pass = async (method, params) => {
    try { return { result: await bot.call(method, params) }; } catch (e) {
      if (e.name === "JsonRpcError") return { error: { code: e.code, message: e.message.replace(/^[^:]+: /, "").replace(/ \([A-Z_]+\)$/, ""), data: e.data } };
      return { error: { code: -32000, message: `balatrobot: ${e.message}`, data: { name: "INTERNAL_ERROR" } } };
    }
  };
  const handle = async (req, body) => {
    const harness = req.headers["x-aas-token"] === token;
    const { method, params } = body;
    if (typeof method !== "string") return { error: { code: -32600, message: "no method", data: { name: "BAD_REQUEST" } } };
    if (NEVER.has(method)) return refuse(`${method} is not available in an AI Assisted Speedrun`);
    if (method === "aas.screenshot") {
      const file = join(dir, `aas-balatro-shot-${process.pid}-${++shots}.png`);
      const r = await pass("screenshot", { path: gamePath(file) });
      if (r.error) return r;
      try { return { result: { png: readFileSync(file).toString("base64") } }; } finally { rmSync(file, { force: true }); }
    }
    if (method === "aas.restart") {
      const now = await pass("gamestate");
      if (now.error) return now;
      if (now.result?.state !== "GAME_OVER") return refuse("restart is only possible after a game over");
      if (!lastStart) return refuse("the harness did not start this run through the bridge");
      const menu = await pass("menu");
      if (menu.error) return menu;
      return pass("start", lastStart);
    }
    if (!(harness ? HARNESS_METHODS : AGENT_METHODS).has(method)) return refuse(`${method} is not available to the agent`);
    const r = await pass(method, params);
    if (method === "start" && !r.error) lastStart = { deck: params?.deck, stake: params?.stake, ...(params?.seed ? { seed: params.seed } : {}) };
    return r;
  };
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(405, { Connection: "close" }); res.end(); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { answer(res, null, { error: { code: -32700, message: "not JSON", data: { name: "BAD_REQUEST" } } }); return; }
      const out = await handle(req, body).catch((e) => ({ error: { code: -32000, message: String(e?.message ?? e), data: { name: "INTERNAL_ERROR" } } }));
      if (out.error) log(`${body.method}: ${out.error.message}`);
      answer(res, body.id, out);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const actual = server.address().port;
  if (stateFile) writeFileSync(stateFile, JSON.stringify({ pid: process.pid, port: actual, botPort, token }), { mode: 0o600 });
  return {
    port: actual,
    token,
    close: () => new Promise((resolve) => { if (stateFile && readBridgeState(stateFile)?.token === token) rmSync(stateFile, { force: true }); server.close(() => resolve()); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
  const port = arg("--port", Number(process.env.AAS_BALATRO_PORT || BRIDGE_PORT));
  const botPort = arg("--bot-port", Number(process.env.AAS_BALATRO_BOT_PORT || BOT_PORT));
  const running = readBridgeState();
  if (running && running.port === port && existsSync(`/proc/${running.pid}`)) { console.log(`bridge already running (pid ${running.pid}, port ${port})`); process.exit(0); }
  const bridge = await startBridge({ port, botPort, log: (t) => console.log(`[aas balatro bridge] ${t}`) });
  console.log(`[aas balatro bridge] listening on 127.0.0.1:${bridge.port}, balatrobot on 127.0.0.1:${botPort}`);
  const stop = async () => { await bridge.close(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
