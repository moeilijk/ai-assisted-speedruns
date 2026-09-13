// Runtime plugin "scripted": a bot module plays through the broker, one tool call per
// decision, exactly like an agent would (same three tools, same run log, a Claude-shaped
// session log so `aas publish` works). Used for baselines and for end-to-end tests of a
// game plugin on a fixed seed; the model name in the summary is "scripted".
//
// Bot module (brief.bot or AAS_BOT): `export function createBot({ log, brief })` returning
// `{ next(result) }`: `result` is the parsed JSON the previous exec returned (null at the
// start, `{ error }` when it failed); `next` returns `{ code, note }` for the next
// `<game>_exec` call, or null when the bot is done.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startBroker } from "../core/src/mcp-client.mjs";

let interrupted = null;
export default {
  id: "scripted",
  version: "0.1.0",
  interrupt(reason) { interrupted = reason; },
  async configure(runDir, broker, brief) {
    const bot = brief.bot ?? process.env.AAS_BOT ?? null;
    fs.writeFileSync(path.join(runDir, "AGENTS.md"), brief.instructions, { flag: "wx" });
    fs.mkdirSync(path.join(runDir, "runtime-config"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "runtime-config", "scripted.json"), `${JSON.stringify({ bot: bot ? path.basename(bot) : null }, null, 2)}\n`);
    fs.writeFileSync(path.join(runDir, ".scripted-broker.json"), JSON.stringify({ gameModule: broker.gameModule, readable: broker.readable, endpoints: broker.allowedEndpoints, envNames: broker.envNames ?? [], bot }));
    return { files: [], hint: `scripted bot ${bot ?? "(set AAS_BOT)"}` };
  },
  async reconfigure(runDir, broker) {
    const spec = JSON.parse(fs.readFileSync(path.join(runDir, ".scripted-broker.json"), "utf8"));
    fs.writeFileSync(path.join(runDir, ".scripted-broker.json"), JSON.stringify({ ...spec, gameModule: broker.gameModule, readable: broker.readable, endpoints: broker.allowedEndpoints, envNames: broker.envNames ?? [] }));
  },
  async start(runDir, brief) {
    interrupted = null;
    const spec = JSON.parse(fs.readFileSync(path.join(runDir, ".scripted-broker.json"), "utf8"));
    const botPath = brief.bot ?? spec.bot ?? process.env.AAS_BOT;
    if (!botPath) throw new Error("scripted runtime: no bot module (aas configure --bot <module>, or AAS_BOT)");
    const log = (t) => process.stderr.write(`[runtime-scripted] ${t}\n`);
    const { createBot } = await import(pathToFileURL(path.resolve(botPath)).href);
    const bot = createBot({ log, brief, runDir });
    const maxSteps = Number(brief.budget?.toolCalls) || 5000;
    const client = startBroker({ gameModule: spec.gameModule, runDir, readable: spec.readable, endpoints: spec.endpoints, passThrough: spec.envNames ?? [], timeoutMs: 120000 });
    const session = [];
    const rec = (type, message, extra = {}) => session.push({ type, message, timestamp: new Date().toISOString(), uuid: `u${session.length}`, sessionId: "scripted", ...extra });
    let steps = 0, status = "stopped", notes = "";
    try {
      await client.initialize();
      rec("user", { role: "user", content: [{ type: "text", text: brief.goalPrompt ?? brief.instructions.split("\n")[0] }] });
      let result = null;
      while (steps < maxSteps && !interrupted) {
        const step = bot.next(result);
        if (!step) { notes = bot.broken ? bot.broken : "bot done"; break; }
        steps += 1;
        const id = `toolu_${String(steps).padStart(6, "0")}`;
        rec("assistant", { role: "assistant", model: brief.model ?? "scripted", content: [{ type: "text", text: step.note ?? "" }, { type: "tool_use", id, name: `mcp__${brief.game.id}__${brief.game.id}_exec`, input: { code: step.code } }], usage: { input_tokens: 0, output_tokens: 0 } }, { requestId: `req_${steps}` });
        const r = await client.request("tools/call", { name: `${brief.game.id}_exec`, arguments: { code: step.code } });
        const content = r.content.map((c) => (c.type === "image" ? { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } } : c));
        rec("user", { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: r.isError === true }] });
        const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        if (r.isError) result = { error: text };
        else { try { result = JSON.parse(text); } catch { result = { text }; } }
        if (steps % 50 === 0) log(`${steps} steps${step.note ? `; last: ${step.note}` : ""}`);
      }
      if (interrupted) notes = `interrupted: ${interrupted}`;
      if (steps >= maxSteps) notes = `step budget of ${maxSteps} reached`;
      rec("assistant", { role: "assistant", model: brief.model ?? "scripted", content: [{ type: "text", text: `Done: ${notes}` }], usage: { input_tokens: 0, output_tokens: 0 } }, { requestId: "req_end" });
    } catch (error) {
      status = "failed"; notes = String(error?.message ?? error);
    } finally {
      client.close();
      await client.exited();
    }
    fs.appendFileSync(path.join(runDir, "session.jsonl"), `${session.map((r) => JSON.stringify(r)).join("\n")}\n`);
    log(`${steps} steps; ${notes}`);
    return { status, endedAt: new Date().toISOString(), notes: `${steps} steps; ${notes}`, privateLog: path.join(runDir, "session.jsonl"), sessionId: "scripted" };
  },
};
