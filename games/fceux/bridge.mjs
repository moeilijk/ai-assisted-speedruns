// The client of fceux-mcp's bridge (IngvarKofoed, MIT; our fork moeilijk/fceux-mcp): a Lua script inside FCEUX that
// answers JSON lines ({id, method, params} → {id, result} or {id, error}) on 127.0.0.1:9999.
//
// One connection per process, kept open: the bridge reads a request on the first pass of FCEUX's loop after it
// arrives, while a new connection costs a pass of its own (~50 ms while paused), and that pass is heard as a gap in
// the game's sound between two calls (measured 2026-09-23: gaps of 66-91 ms per call with a connection per call,
// 20-34 ms with one kept open). The bridge serves several processes at once (the broker plays, the harness saves) and
// runs one job at a time. A deadline covers the connect too: under WSL a connect to a closed local port hangs for
// about two minutes.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";

const HOST = process.env.AAS_FCEUX_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.AAS_FCEUX_BRIDGE_PORT || 9999);
// FCEUX's Qt build on Windows ships no LuaSocket and cannot load one, and the bridge then talks through files in a folder
// (bridge.lua, "File transport"); set to that folder (the bridge's FCEUX_BRIDGE_DIR, or "ipc" next to bridge.lua).
const FILE_DIR = process.env.AAS_FCEUX_BRIDGE_DIR || null;
const FILE_SLOTS = 8;
const FILE_STALE_MS = 10000; // a slot whose client has not touched it for this long is free again

export class BridgeError extends Error {
  constructor(method, error) {
    // The bridge's own messages mostly name the method already ("emu.loadrom: cannot open …").
    const message = String(error?.message ?? error);
    super(message.startsWith(`${method}:`) ? message : `${method}: ${message}`);
    this.code = error?.code ?? null;
  }
}

let conn = null; // { socket, ready: Promise, pending: Map<id, {resolve, reject, method, timer}>, nextId, buf }

function drop(c, error) {
  if (conn === c) conn = null;
  c.socket.destroy();
  for (const p of c.pending.values()) { clearTimeout(p.timer); p.reject(error); }
  c.pending.clear();
}

// The same connection object over files: a socket-like { write, destroy, ref, unref } that emits "data".
function fileSocket(onData) {
  fs.mkdirSync(FILE_DIR, { recursive: true });
  const token = randomBytes(8).toString("hex");
  let slot = null;
  for (let k = 1; k <= FILE_SLOTS && !slot; k += 1) {
    const file = path.join(FILE_DIR, `client-${k}`);
    try {
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (st && Date.now() - st.mtimeMs > FILE_STALE_MS) fs.rmSync(file, { force: true });
      fs.writeFileSync(file, token, { flag: "wx" });
      slot = file;
    } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  if (!slot) throw new Error(`the FCEUX bridge's ${FILE_SLOTS} file slots in ${FILE_DIR} are all taken`);
  let inseq = 1, outseq = 1, closed = false, lastTouch = Date.now();
  const timer = setInterval(() => {
    if (closed) return;
    for (;;) {
      const name = path.join(FILE_DIR, `${token}-out-${outseq}`);
      let data;
      // Not there yet, or (on Windows) still held by bridge.lua's rename: read on the next tick.
      try { data = fs.readFileSync(name, "utf8"); } catch { break; }
      fs.rmSync(name, { force: true });
      outseq += 1;
      onData(data);
    }
    if (Date.now() - lastTouch > 2000) { lastTouch = Date.now(); try { fs.utimesSync(slot, new Date(), new Date()); } catch {} }
  }, 2);
  // The lines written in one tick go out as one file, so a batch reaches the bridge in one pass of FCEUX's loop, as
  // it does over TCP: FCEUX clears its drawing overlay at the first gui call of a pass after the previous drawing was
  // shown (lua-engine.cpp, gui_prepare), so gui calls that land in different passes replace each other.
  let queued = "";
  const flush = () => {
    if (closed || !queued) return;
    const name = path.join(FILE_DIR, `${token}-in-${inseq}`);
    inseq += 1;
    fs.writeFileSync(`${name}.tmp`, queued);
    fs.renameSync(`${name}.tmp`, name);
    queued = "";
  };
  return {
    write(line) {
      if (!queued) queueMicrotask(flush);
      queued += line;
    },
    destroy() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      fs.rmSync(slot, { force: true });
      for (const f of fs.readdirSync(FILE_DIR)) if (f.startsWith(`${token}-`)) fs.rmSync(path.join(FILE_DIR, f), { force: true });
    },
    ref() { timer.ref(); },
    unref() { timer.unref(); },
  };
}

function fileConnection() {
  const c = { pending: new Map(), nextId: 1, buf: "" };
  conn = c;
  c.socket = fileSocket((d) => receive(c, d));
  c.ready = Promise.resolve();
  return c;
}

function receive(c, d) {
  c.buf += d;
  let at;
  while ((at = c.buf.indexOf("\n")) !== -1) {
    const line = c.buf.slice(0, at);
    c.buf = c.buf.slice(at + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { drop(c, new Error(`the FCEUX bridge answered something that is not JSON: ${line.slice(0, 120)}`)); return; }
    const p = c.pending.get(msg.id);
    if (!p) continue;
    c.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new BridgeError(p.method, msg.error)); else p.resolve(msg.result);
  }
  if (!c.pending.size) c.socket.unref();
}

function connection(timeoutMs) {
  if (conn) return conn;
  if (FILE_DIR) return fileConnection();
  const c = { socket: net.createConnection({ host: HOST, port: PORT }), pending: new Map(), nextId: 1, buf: "" };
  conn = c;
  c.socket.setEncoding("utf8");
  c.socket.setNoDelay(true);
  c.ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => { drop(c, new Error(`the FCEUX bridge on ${HOST}:${PORT} did not accept a connection within ${timeoutMs} ms`)); reject(new Error(`the FCEUX bridge on ${HOST}:${PORT} did not accept a connection within ${timeoutMs} ms`)); }, timeoutMs);
    c.socket.once("connect", () => { clearTimeout(t); resolve(); });
    c.socket.once("error", (e) => { clearTimeout(t); reject(new Error(`the FCEUX bridge on ${HOST}:${PORT}: ${e.code ?? e.message}`)); });
  });
  c.ready.catch(() => {});
  c.socket.on("error", (e) => drop(c, new Error(`the FCEUX bridge on ${HOST}:${PORT}: ${e.code ?? e.message}`)));
  c.socket.on("close", () => drop(c, new Error("the FCEUX bridge closed the connection")));
  c.socket.on("data", (d) => receive(c, d));
  return c;
}

/** Sends the requests together and returns their results in order; the first error is thrown. */
export async function batch(requests, { timeoutMs = 30000 } = {}) {
  const c = connection(Math.min(timeoutMs, 5000));
  await c.ready;
  c.socket.ref();
  const promises = requests.map((r) => new Promise((resolve, reject) => {
    const id = c.nextId++;
    // A request that is not answered in time leaves the connection in an unknown state: it is dropped, and the next
    // call opens a new one.
    const timer = setTimeout(() => drop(c, new Error(`the FCEUX bridge did not answer ${r.method} within ${timeoutMs} ms`)), timeoutMs);
    c.pending.set(id, { resolve, reject, method: r.method, timer });
    c.socket.write(`${JSON.stringify({ id, method: r.method, ...(r.params ? { params: r.params } : {}) })}\n`);
  }));
  return Promise.all(promises);
}

export const call = async (method, params, opts) => (await batch([{ method, params }], opts))[0];

/** Closes this process's connection (tests, and scripts that end). */
export function disconnect() { if (conn) drop(conn, new Error("disconnected")); }

/** Does FCEUX answer, with the bridge loaded? */
export const ping = async () => { try { return (await call("ping", undefined, { timeoutMs: 3000 })) === "pong"; } catch { disconnect(); return false; } };
