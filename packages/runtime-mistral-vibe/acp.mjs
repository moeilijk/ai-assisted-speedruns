// Mistral Vibe's own answer to "which models, which thinking levels": its editor mode (vibe-acp, the Agent Client
// Protocol) starts a session without a prompt and names both, with the ones in use. No prompt is sent, so no model is
// asked anything and nothing is billed (measured with 2.25.8: no session folder is written either).
import { spawn } from "node:child_process";
import os from "node:os";

/** `{ models: [{ id, label }], model, efforts, effort }` as `session/new` names them; throws when vibe-acp does not answer. */
export function askVibe({ bin = "vibe-acp", cwd = os.tmpdir(), timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", id = 0, done = false;
    const waits = new Map();
    const finish = (err, value) => { if (done) return; done = true; clearTimeout(timer); child.kill(); err ? reject(err) : resolve(value); };
    const timer = setTimeout(() => finish(new Error(`${bin} did not answer within ${timeoutMs / 1000} s`)), timeoutMs);
    child.on("error", (e) => finish(new Error(`${bin} could not be started: ${e.message}`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let at;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at); buf = buf.slice(at + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
      }
    });
    const call = (method, params) => new Promise((res) => { const n = ++id; waits.set(n, res); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`); });
    (async () => {
      const init = await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
      if (init.error) throw new Error(`initialize: ${init.error.message}`);
      const s = await call("session/new", { cwd, mcpServers: [] });
      if (s.error) throw new Error(`session/new: ${s.error.message}`);
      finish(null, parseSessionNew(s.result, init.result?.agentInfo?.version ?? null));
    })().catch((e) => finish(e));
  });
}

/** The model and thinking choices of a `session/new` result (its `configOptions`). */
export function parseSessionNew(result, version = null) {
  const opt = (id) => (result?.configOptions ?? []).find((o) => o.id === id);
  const model = opt("model");
  const thinking = opt("thinking");
  return {
    version,
    models: (model?.options ?? []).filter((o) => typeof o.value === "string").map((o) => ({ id: o.value, label: o.name && o.name !== o.value ? `${o.value} (${o.name}${o.description ? `, ${o.description}` : ""})` : o.value })),
    model: model?.currentValue ?? null,
    efforts: (thinking?.options ?? []).map((o) => o.value).filter((v) => typeof v === "string"),
    effort: thinking?.currentValue ?? null,
  };
}
