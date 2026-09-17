// JSON-RPC 2.0 over HTTP POST with node:http, for game bridges that speak HTTP (balatrobot, and later
// STS2MCP, Celeste DebugRC). The broker blocks `fetch`; node:http goes through net.Socket.connect, which
// hardening.mjs allows for the plugin's declared endpoints only. One request per connection, one at a time:
// the bridges this is for serve a single client and close the connection after each answer.
import http from "node:http";

export class JsonRpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? "error"}${error?.data?.name ? ` (${error.data.name})` : ""}`);
    this.name = "JsonRpcError";
    this.code = error?.code ?? null;
    this.rpcName = error?.data?.name ?? null;
    this.data = error?.data ?? null;
  }
}

/** A client for `http://host:port/`. `call(method, params)` resolves with `result` or rejects with a JsonRpcError. */
export function jsonRpcClient({ host = "127.0.0.1", port, path = "/", timeoutMs = 30000, headers = {} } = {}) {
  if (!Number.isInteger(port) || port <= 0) throw new Error(`jsonRpcClient: invalid port ${port}`);
  let id = 0;
  let queue = Promise.resolve();
  const post = (method, params, ms) => new Promise((resolve, reject) => {
    const body = JSON.stringify(params === undefined ? { jsonrpc: "2.0", method, id: ++id } : { jsonrpc: "2.0", method, params, id: ++id });
    const req = http.request({ host, port, path, method: "POST", agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let msg;
        try { msg = JSON.parse(text); } catch { reject(new Error(`${method}: HTTP ${res.statusCode}, not JSON: ${text.slice(0, 200)}`)); return; }
        if (msg.error) reject(new JsonRpcError(method, msg.error));
        else resolve(msg.result);
      });
      res.on("error", reject);
    });
    // A deadline for the whole call, connecting included: under WSL's mirrored networking a connection to a port
    // where nothing listens is not refused but hangs until the TCP timeout, and req.setTimeout does not cover that.
    const deadline = setTimeout(() => req.destroy(new Error(`${method}: no answer from ${host}:${port} within ${ms} ms`)), ms);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end(body);
  });
  return {
    host,
    port,
    /** Calls are serialised: the next request is sent when the previous one has its answer. */
    call(method, params, { timeoutMs: ms = timeoutMs } = {}) {
      const next = queue.then(() => post(method, params, ms));
      queue = next.catch(() => {});
      return next;
    },
  };
}
