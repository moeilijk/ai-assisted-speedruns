// Test runtime: drives the broker with a fixed list of exec snippets
// (<run>/stub-codes.json) and writes a Claude Code-shaped session log so
// `aas publish` can be tested end to end without an agent.
import fs from "node:fs";
import path from "node:path";
import { startBroker } from "../src/mcp-client.mjs";

let interrupted = null;
export default {
  id: "stub",
  /** No model: this runtime plays a session that was written down, so its runs are mocks. */
  ai: false,
  name: "Stub runtime",
  version: "0.1.0",
  /** The harness asks the session to end (game over): the remaining codes are skipped. */
  interrupt(reason) { interrupted = reason; },
  async configure(runDir, broker, brief) {
    fs.writeFileSync(path.join(runDir, "AGENTS.md"), brief.instructions, { flag: "wx" });
    fs.mkdirSync(path.join(runDir, "runtime-config"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "runtime-config", "stub.json"), `${JSON.stringify({ gameModule: "__GAME_MODULE__" }, null, 2)}\n`);
    fs.writeFileSync(path.join(runDir, ".stub-broker.json"), JSON.stringify({ gameModule: broker.gameModule, readable: broker.readable, endpoints: broker.allowedEndpoints, envNames: broker.envNames ?? [] }));
    return { files: [], hint: "stub" };
  },
  async reconfigure(runDir, broker) {
    fs.writeFileSync(path.join(runDir, ".stub-broker.json"), JSON.stringify({ gameModule: broker.gameModule, readable: broker.readable, endpoints: broker.allowedEndpoints, envNames: broker.envNames ?? [] }));
  },
  /** The session log this runtime writes into the run directory: what the run's proof covers. */
  sessionLogs(runDir) { const f = path.join(runDir, "session.jsonl"); return fs.existsSync(f) ? [f] : []; },
  async start(runDir, brief) {
    const spec = JSON.parse(fs.readFileSync(path.join(runDir, ".stub-broker.json"), "utf8"));
    const codesFile = path.join(runDir, brief.resume ? "stub-codes-resume.json" : "stub-codes.json");
    const codes = fs.existsSync(codesFile) ? JSON.parse(fs.readFileSync(codesFile, "utf8")) : ["return await game.observe()"];
    const client = startBroker({ gameModule: spec.gameModule, runDir, readable: spec.readable, endpoints: spec.endpoints, passThrough: spec.envNames ?? [], timeoutMs: 60000 });
    interrupted = null;
    const session = [];
    const rec = (type, message, extra = {}) => session.push({ type, message, timestamp: new Date().toISOString(), uuid: `u${session.length}`, sessionId: "stub", ...extra });
    try {
      await client.initialize();
      rec("user", { role: "user", content: [{ type: "text", text: brief.instructions.split("\n")[0] }] });
      let n = 0;
      for (const code of codes) {
        if (interrupted) break;
        const id = `toolu_${String(++n).padStart(6, "0")}`;
        rec("assistant", { role: "assistant", model: brief.model ?? "stub-model", content: [{ type: "text", text: `Step ${n}.` }, { type: "tool_use", id, name: `mcp__${brief.game.id}__${brief.game.id}_exec`, input: { code } }], usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 } }, { requestId: `req_${n}` });
        const result = await client.request("tools/call", { name: `${brief.game.id}_exec`, arguments: { code } });
        const content = result.content.map((c) => (c.type === "image" ? { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } } : c));
        rec("user", { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: result.isError === true }] });
      }
      rec("assistant", { role: "assistant", model: brief.model ?? "stub-model", content: [{ type: "text", text: "Reached the end credits." }], usage: { input_tokens: 1, output_tokens: 1 } }, { requestId: "req_end" });
    } finally {
      client.close();
      await client.exited();
    }
    fs.appendFileSync(path.join(runDir, "session.jsonl"), `${session.map((r) => JSON.stringify(r)).join("\n")}\n`);
    return { status: brief.resume ? "completed" : "stopped", endedAt: new Date().toISOString(), notes: interrupted ? `interrupted: ${interrupted}` : undefined, privateLog: path.join(runDir, "session.jsonl"), sessionId: "stub-session" };
  },
};
