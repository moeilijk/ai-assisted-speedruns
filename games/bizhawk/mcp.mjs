// The client of bizhawk-mcp-native (StealthC, MIT): an external tool inside EmuHawk that serves MCP over HTTP on
// 127.0.0.1:8767. One call is one `tools/call`; the tool's text answer is parsed as JSON when it is JSON. It uses
// node:http (json-rpc-http.mjs), because the broker blocks `fetch` and lets node:http reach only the declared endpoint.
import { jsonRpcClient } from "../../packages/core/src/json-rpc-http.mjs";

const url = new URL(process.env.AAS_BIZHAWK_MCP_URL || "http://127.0.0.1:8767/mcp/");
const clients = new Map();
const client = (timeoutMs) => {
  if (!clients.has(timeoutMs)) clients.set(timeoutMs, jsonRpcClient({ host: url.hostname, port: Number(url.port), path: url.pathname, timeoutMs }));
  return clients.get(timeoutMs);
};

export class BizHawkError extends Error {}

export async function call(name, args = {}, { timeoutMs = 30000 } = {}) {
  const result = await client(timeoutMs).call("tools/call", { name, arguments: args });
  const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
  if (result?.isError) throw new BizHawkError(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

/** A plain MCP request (resources/read and the like). */
export const rpc = (method, params, { timeoutMs = 30000 } = {}) => client(timeoutMs).call(method, params);

/** Does EmuHawk answer, with the tool loaded? */
export const ping = async () => { try { return (await call("ping", {}, { timeoutMs: 3000 })) === "pong"; } catch { return false; } };
