#!/usr/bin/env node
// Headless verification of the Claude Code runtime configuration: generates a
// run directory for a game plugin, starts the real `claude -p` in it with the
// generated .mcp.json and settings, asks it to use the three broker tools and
// to try a denied tool, then checks run.jsonl. Costs a few API calls, so it is
// not part of `npm test`.
//
// Usage: node packages/runtime-claude-code/smoke.mjs --game <plugin.mjs> --run-dir <new dir> [--model claude-haiku-4-5-20251001] [--effort high] [--runtime codex]
// With --runtime codex the same verification runs through the Codex runtime's headless start (codex exec).
// For Portal without the game: start games/portal/test/fake-spt.mjs first (see README) or pass --fake-spt.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { configure } from "../core/src/configure.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const gameModule = opt("--game");
const runDir = path.resolve(opt("--run-dir", `runs/claude-smoke-${Date.now()}`));
const model = opt("--model", "claude-haiku-4-5-20251001");
const effort = opt("--effort", null);
if (!gameModule) throw new Error("--game is required");

let fake = null;
if (args.includes("--fake-spt")) {
  const { startFakeSpt } = await import("../../games/portal/test/fake-spt.mjs");
  fake = await startFakeSpt({ transitionAfterTicks: 150 });
  process.env.AAS_PORTAL_SPT_PORT = String(fake.port);
  console.log(`fake SPT on 127.0.0.1:${fake.port}`);
}
const runtimeId = opt("--runtime", "claude-code");
const r = await configure({ runtime: runtimeId, game: gameModule, "run-dir": runDir, model: runtimeId === "codex" && model === "claude-haiku-4-5-20251001" ? undefined : model, effort });
const id = r.brief.game.id;
const scope = id === "portal" ? "portal" : "game";
const prompt =
  `Verification of the harness, not a real run. Do exactly these steps and nothing else, then reply with one line per step saying OK or the error text:\n` +
  `1. Call ${id}_documentation.\n2. Call ${id}_screenshot.\n3. Call ${id}_exec with code: return await ${scope}.observe()\n` +
  (id === "portal" ? `4. Call portal_exec with code: const t = portal.tas(); t.hold(67, { forward: true }); const r = await t.run(); return r.ticks\n` : `4. Call ${id}_exec with code: return 1 + 1\n`) +
  `5. Try to run the shell command "echo hi" with the Bash tool (it should be denied; report what happened).\n6. Try to read the file AGENTS.md with the Read tool (it should be denied; report what happened).`;
const env = { ...process.env };
for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k]; // allow nesting inside a Claude Code session
let res;
if (runtimeId === "codex") {
  // The Codex runtime's own headless start, exactly as aas run uses it.
  const { loadRuntime } = await import("../core/src/plugins.mjs");
  const codex = await loadRuntime("codex");
  const brief = { ...r.brief, headless: true, goalPrompt: prompt, budget: { minutes: 6 } };
  const outcome = await codex.start(runDir, brief);
  const last = fs.existsSync(path.join(runDir, "codex-last-message.txt")) ? fs.readFileSync(path.join(runDir, "codex-last-message.txt"), "utf8") : "";
  res = { status: outcome.status === "failed" ? 1 : 0, stdout: JSON.stringify({ result: last, num_turns: null, modelUsage: {}, total_cost_usd: null, notes: outcome.notes, privateLog: outcome.privateLog }), stderr: "" };
  console.log(`--- codex: ${outcome.notes}; rollout ${outcome.privateLog ?? "not found"}`);
} else {
const cmd = ["-p", prompt, "--output-format", "json", "--mcp-config", ".mcp.json", "--strict-mcp-config", "--settings", path.join(".claude", "settings.json"), "--model", model, "--max-turns", "12"];
console.log(`claude ${cmd.slice(2).join(" ")}  (cwd ${runDir})`);
// Asynchronous on purpose: a fake SPT in this process must keep serving while claude runs.
res = await new Promise((resolve) => {
  const child = spawn("claude", cmd, { cwd: runDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill(), 240000);
  child.on("close", (status) => (clearTimeout(timer), resolve({ status, stdout, stderr })));
});
}
await fake?.close();
fs.writeFileSync(path.join(runDir, "smoke-output.json"), res.stdout ?? "");
if (res.status !== 0) console.error(`claude exited ${res.status}: ${res.stderr}`);
// Claude Code reports on stderr when it did not apply permission rules ("Ignoring 3 permissions.allow entries
// ...: this workspace has not been trusted"). configure() marks the run directory trusted, so nothing of the
// kind may appear; when it does, the set-up on this machine is wrong and the test fails.
const { IGNORED_RULES } = await import("./trust.mjs");
const ignored = res.stderr.match(IGNORED_RULES)?.[0] ?? null;
const warnings = res.stderr.split("\n").filter((l) => /warn|ignor|trust/i.test(l));
if (warnings.length) console.log("--- claude stderr:\n" + warnings.join("\n"));
let out;
try { out = JSON.parse(res.stdout); } catch { console.log(res.stdout); throw new Error("claude did not return JSON"); }
console.log("\n--- agent reply:\n" + (out.result ?? JSON.stringify(out)).trim());
console.log(`\n--- cost: $${out.total_cost_usd?.toFixed(4)}  turns: ${out.num_turns}  model: ${Object.keys(out.modelUsage ?? {}).join(",")}`);
const log = fs.existsSync(path.join(runDir, "run.jsonl")) ? fs.readFileSync(path.join(runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const calls = log.filter((x) => x.kind === "tool_call").map((x) => x.name);
console.log(`--- broker log: ${calls.length} tool calls: ${calls.join(", ")}`);
const results = log.filter((x) => x.kind === "tool_result");
console.log(`--- results with error: ${results.filter((x) => x.is_error).length}; images saved: ${fs.existsSync(path.join(runDir, "screenshots")) ? fs.readdirSync(path.join(runDir, "screenshots")).length : 0}`);
const expected = [`${id}_documentation`, `${id}_screenshot`, `${id}_exec`];
const ok = expected.every((t) => calls.includes(t)) && results.filter((x) => x.is_error).length === 0 && !ignored;
console.log(ok ? `\nPASS: all three broker tools were used through the generated config, and ${runtimeId === "codex" ? "Codex" : "Claude Code"} applied every permission rule` : ignored ? `\nFAIL: Claude Code ignored permission rules: ${ignored}` : "\nFAIL: see above");
process.exitCode = ok ? 0 : 1;
