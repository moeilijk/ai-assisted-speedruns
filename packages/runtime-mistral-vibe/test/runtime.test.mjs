// The Mistral Vibe runtime against a stand-in for `vibe` (a script on the PATH that answers the way vibe 2.25.8 does,
// measured 2026-09-29): the configuration it writes, the command line it starts, the stream it keeps, the export, the
// limits, the connection check and hostile values. No model is asked anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aas-vibe-"));
const broker = (runDir) => ({ gameId: "gui_fake", runDir, nodeArgs: ["--permission", `--allow-fs-write=${runDir}`, "/repo/packages/core/src/broker.mjs"], env: { AAS_GAME_MODULE: "/repo/games/x/plugin.mjs", AAS_RUN_DIR: runDir, AAS_SECRET_ROOT: "C:\\Users\\someone\\game" } });
const vibe = (await import("../index.mjs")).default;
const { renderConfig, toolNames } = await import("../index.mjs");

test("the configuration names only the broker and enables only its three tools; the published copy hides the machine", () => {
  const dir = tmp();
  const text = renderConfig(broker(dir), { model: "mistral-medium-3.5", effort: "medium" });
  assert.match(text, /^enabled_tools = \["aas_gui_fake_documentation", "aas_gui_fake_screenshot", "aas_gui_fake_exec"\]$/m);
  assert.equal((text.match(/\[\[mcp_servers\]\]/g) ?? []).length, 1, "one MCP server");
  assert.match(text, /^active_model = "mistral-medium-3.5"$/m);
  assert.match(text, /\[\[models\]\]\nalias = "mistral-medium-3.5"\nthinking = "medium"/);
  assert.deepEqual(toolNames("gui_fake"), ["aas_gui_fake_documentation", "aas_gui_fake_screenshot", "aas_gui_fake_exec"]);
  const pub = renderConfig(broker(dir), { placeholders: true });
  assert.doesNotMatch(pub, /someone|C:\\\\Users/, "a game's own setting is published as __ENV__");
  assert.match(pub, /AAS_SECRET_ROOT = "__ENV__"/);
  assert.doesNotMatch(renderConfig(broker(dir)), /active_model|\[\[models\]\]/, "no model chosen: Vibe's own");
});

test("a hostile model or thinking level never reaches the configuration", async () => {
  for (const [model, effort] of [['x"\nactive_model = "evil', null], ["mistral", "high\n[[mcp_servers]]"], ["--yolo", null], ["a b", null]]) {
    const dir = tmp();
    await assert.rejects(vibe.configure(dir, broker(dir), { instructions: "play", model, reasoningEffort: effort }), /is not a plain name/);
    assert.ok(!fs.existsSync(path.join(dir, ".vibe", "config.toml")), "nothing written");
  }
  // A value in the broker's environment stays one TOML string, whatever it holds.
  const dir = tmp();
  const b = broker(dir);
  b.env.AAS_X = 'a"\n[[mcp_servers]]\nname = "evil';
  const text = renderConfig(b);
  assert.equal((text.match(/^\[\[mcp_servers\]\]$/gm) ?? []).length, 1);
});

test("configure writes the configuration, the instructions and the published copy, and refuses to overwrite", async () => {
  const dir = tmp();
  await vibe.configure(dir, broker(dir), { instructions: "Play the fake.", model: "mistral-medium-3.5", reasoningEffort: "low" });
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "Play the fake.");
  assert.match(fs.readFileSync(path.join(dir, ".vibe", "config.toml"), "utf8"), /thinking = "low"/);
  assert.ok(fs.existsSync(path.join(dir, "runtime-config", "config.template.toml")));
  await assert.rejects(vibe.configure(dir, broker(dir), { instructions: "again" }), /Refusing to overwrite/);
});

test("the models and thinking levels are Vibe's own answer to session/new", async () => {
  const { parseSessionNew } = await import("../acp.mjs");
  const result = { configOptions: [
    { id: "mode", currentValue: "accept-edits", options: [{ value: "ask", name: "Ask" }] },
    { id: "model", currentValue: "mistral-medium-3.5", options: [{ value: "mistral-medium-3.5", name: "Mistral Medium 3.5", description: "mistral-vibe-cli-latest" }, { value: "local", name: "Devstral (local)", description: "devstral" }] },
    { id: "thinking", currentValue: "high", options: [{ value: "off" }, { value: "low" }, { value: "medium" }, { value: "high" }, { value: "max" }] },
  ] };
  assert.deepEqual(parseSessionNew(result, "2.25.8"), {
    version: "2.25.8",
    models: [{ id: "mistral-medium-3.5", label: "mistral-medium-3.5 (Mistral Medium 3.5, mistral-vibe-cli-latest)" }, { id: "local", label: "local (Devstral (local), devstral)" }],
    model: "mistral-medium-3.5", efforts: ["off", "low", "medium", "high", "max"], effort: "high",
  });
});

/** A `vibe` on the PATH that prints what it was given and streams the entries a session of 2.25.8 streams. */
function fakeVibe({ exit = 0, stderr = "" } = {}) {
  const bin = tmp();
  const file = path.join(bin, "vibe");
  fs.writeFileSync(file, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("vibe 2.25.8"); process.exit(0); }
if (args[0] === "--help") { console.log("usage: vibe [-h] ... [--experimental-harness | --legacy-harness]"); process.exit(0); }
require("fs").writeFileSync(require("path").join(process.cwd(), "vibe-args.json"), JSON.stringify(args));
const t = 1790700000000;
const out = (e) => console.log(JSON.stringify(e));
out({ type: "message", id: "m1", sessionId: "s-123", createdAt: t, updatedAt: t, generationStatus: "completed", role: "user", content: [{ type: "text", text: "Play." }] });
out({ type: "reasoning", id: "r1", sessionId: "s-123", createdAt: t + 500, updatedAt: t + 500, generationStatus: "completed", text: "thinking" });
out({ type: "effect", id: "e1", sessionId: "s-123", createdAt: t + 1000, updatedAt: t + 2500, generationStatus: "completed", title: "exec", detail: { toolName: "aas_gui_fake_exec", kind: "tool", input: { code: "return await game.observe()" }, display: {} }, state: { status: "completed", outputText: "{\\"turn\\":1}", durationMs: 1500, display: {} } });
out({ type: "message", id: "m2", sessionId: "s-123", createdAt: t + 3000, updatedAt: t + 3000, generationStatus: "completed", role: "assistant", content: [{ type: "text", text: "DONE: reached the end" }] });
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ""}
process.exit(${exit});
`, { mode: 0o755 });
  return bin;
}

async function startWith(bin, env = {}, brief = {}) {
  const dir = tmp();
  const saved = { PATH: process.env.PATH, AAS_VIBE_MAX_PRICE: process.env.AAS_VIBE_MAX_PRICE };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    const outcome = await vibe.start(dir, { headless: true, goalPrompt: "Play.", category: { game: "gui_fake" }, budget: { toolCalls: 7 }, ...brief });
    return { dir, outcome, args: fs.existsSync(path.join(dir, "vibe-args.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "vibe-args.json"), "utf8")) : null };
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.AAS_VIBE_MAX_PRICE === undefined) delete process.env.AAS_VIBE_MAX_PRICE; else process.env.AAS_VIBE_MAX_PRICE = saved.AAS_VIBE_MAX_PRICE;
  }
}

test("start runs vibe headless with only the three tools, the turn and price limits, and keeps what it streams", async () => {
  const { dir, outcome, args } = await startWith(fakeVibe(), { AAS_VIBE_MAX_PRICE: "2.5" });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.sessionId, "s-123", "the session to resume from");
  assert.deepEqual(args.filter((a, i) => args[i - 1] === "--enabled-tools"), toolNames("gui_fake"), "exactly the three tools");
  assert.equal(args[args.indexOf("--max-price") + 1], "2.5");
  assert.equal(args[args.indexOf("--max-turns") + 1], "7");
  assert.equal(args[args.indexOf("--output") + 1], "streaming");
  assert.ok(args.includes("--trust") && args.includes("--auto-approve"));
  assert.ok(args.includes("--legacy-harness"), "the harness whose tool filter holds");
  const stream = fs.readFileSync(path.join(dir, "vibe-stream.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(stream[0].vibe.version, "vibe 2.25.8", "the stream starts with the version that ran");
  assert.equal(stream.filter((r) => r.entry).length, 4, "every entry Vibe streamed, as it streamed it");
  assert.ok(stream.every((r) => !Number.isNaN(Date.parse(r.receivedAt))));
  assert.equal(outcome.privateLog, path.join(dir, "vibe-stream.jsonl"));
  // A resume continues Vibe's own session.
  const again = await startWith(fakeVibe(), { AAS_VIBE_MAX_PRICE: "2.5" }, { resume: { sessionId: "s-123", prompt: "Go on." } });
  assert.equal(again.args[again.args.indexOf("--resume") + 1], "s-123");
  assert.equal(again.args[again.args.indexOf("-p") + 1], "Go on.");
});

test("a run does not start without a price limit, and a limit Vibe reaches is a stop, not a failure", async () => {
  await assert.rejects(startWith(fakeVibe(), { AAS_VIBE_MAX_PRICE: undefined }), /AAS_VIBE_MAX_PRICE is not set/);
  const { outcome } = await startWith(fakeVibe({ exit: 1, stderr: "Error: Session cost exceeds the configured limit\n" }), { AAS_VIBE_MAX_PRICE: "1" });
  assert.equal(outcome.status, "stopped");
  const failed = await startWith(fakeVibe({ exit: 1, stderr: "Error: invalid API key\n" }), { AAS_VIBE_MAX_PRICE: "1" });
  assert.equal(failed.outcome.status, "failed");
});

test("the export makes the timeline from Vibe's own times and the summary from its saved session", async () => {
  const { dir } = await startWith(fakeVibe(), { AAS_VIBE_MAX_PRICE: "1" });
  const home = tmp();
  fs.mkdirSync(path.join(home, "logs", "session", "session_20260929_1"), { recursive: true });
  fs.writeFileSync(path.join(home, "logs", "session", "session_20260929_1", "meta.json"), JSON.stringify({ session_id: "s-123", config: { active_model: "mistral-medium-3.5", models: { "mistral-medium-3.5": { name: "mistral-vibe-cli-latest", provider: "mistral", thinking: "high" } } }, stats: { session_prompt_tokens: 100, session_cached_tokens: 10, session_completion_tokens: 20, session_cost: 0.01 } }));
  const out = path.join(tmp(), "export");
  const { exportStream } = await import("../export-stream.mjs");
  await exportStream(path.join(dir, "vibe-stream.jsonl"), out, { completionMarker: "DONE:", timeZone: "UTC", home });
  const rows = fs.readFileSync(path.join(out, "session.sanitized.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((r) => r.kind), ["message", "tool_call", "tool_result", "message"], "reasoning is left out");
  assert.equal(rows[1].name, "aas_gui_fake_exec");
  assert.equal(rows[1].input, "return await game.observe()");
  assert.equal(rows[2].elapsed_seconds, 3, "the result at Vibe's updatedAt");
  const summary = JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8"));
  assert.deepEqual(summary.models, [{ model: "mistral-vibe-cli-latest", reasoning_effort: "high", context_window: null, max_output_tokens: null, provider: "mistral" }]);
  assert.match(summary.completed_at, /^2026-09-29T16:40:03\.000\+00:00$/, "the completion at the marked message");
  assert.deepEqual(summary.cli_versions, ["vibe 2.25.8"]);
  assert.equal(summary.last_reported_thread_token_usage.cost_usd, 0.01);
});

test("the connection check starts the server the configuration names and asks it for the broker's tools", async () => {
  const dir = tmp();
  const server = path.join(dir, "server.mjs");
  fs.writeFileSync(server, `let b="";process.stdin.on("data",d=>{b+=d;let i;while((i=b.indexOf("\\n"))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.id===1)console.log(JSON.stringify({jsonrpc:"2.0",id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({jsonrpc:"2.0",id:2,result:{tools:[{name:"gui_fake_documentation"},{name:"gui_fake_screenshot"},{name:"gui_fake_exec"}]}}))}});`);
  const b = { gameId: "gui_fake", runDir: dir, nodeArgs: [server], env: { PATH: process.env.PATH } };
  fs.mkdirSync(path.join(dir, ".vibe"));
  fs.writeFileSync(path.join(dir, ".vibe", "config.toml"), renderConfig(b));
  const ok = await vibe.connectCheck(dir, { gameId: "gui_fake" });
  assert.equal(ok.ok, true, ok.detail);
  const missing = await vibe.connectCheck(dir, { gameId: "other_game" });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /missing other_game_documentation/);
});

test("aas configure with the real broker: the configuration it writes starts the broker, which serves the three tools", async () => {
  const { configure } = await import("../../core/src/configure.mjs");
  const game = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "core", "test", "gui-game", "fake", "plugin.mjs");
  const dir = path.join(tmp(), "run");
  await configure({ runtime: "mistral-vibe", game, "run-dir": dir, model: "mistral-medium-3.5", effort: "low" });
  const r = await vibe.connectCheck(dir, { gameId: "gui_fake" });
  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail, /gui_fake_documentation, gui_fake_exec, gui_fake_screenshot/);
});
