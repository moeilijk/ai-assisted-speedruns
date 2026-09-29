#!/usr/bin/env node
// Headless verification of the Mistral Vibe runtime, the way smoke.mjs does it for Claude Code: a run directory for a
// game plugin, the real `vibe -p` started by the runtime exactly as `aas run` starts it, asked to use the three broker
// tools and to try a shell command and a file read. PASS when the broker's log holds the three tools, Vibe's own saved
// session offered the agent those three tools and nothing else, and no other tool ran. Costs a few API calls on the
// Mistral account, held to --max-price; not part of `npm test`.
//
// Usage: node packages/runtime-mistral-vibe/smoke.mjs --game <plugin.mjs> --run-dir <new dir> [--model <alias>] [--effort <level>] [--max-price 0.25]
import fs from "node:fs";
import path from "node:path";
import { configure } from "../core/src/configure.mjs";
import { savedSessions } from "./export-stream.mjs";
import runtime, { toolNames } from "./index.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const gameModule = opt("--game");
if (!gameModule) throw new Error("--game is required");
const runDir = path.resolve(opt("--run-dir", `runs/vibe-smoke-${Date.now()}`));
// The most this verification may cost, in dollars, as Vibe counts it.
process.env.AAS_VIBE_MAX_PRICE = opt("--max-price", process.env.AAS_VIBE_MAX_PRICE ?? "0.25");
const r = await configure({ runtime: "mistral-vibe", game: gameModule, "run-dir": runDir, model: opt("--model"), effort: opt("--effort") });
const id = r.brief.game.id;
const prompt =
  `Verification of the harness, not a real run. Do exactly these steps and nothing else, then reply with one line per step saying OK or the error text:\n` +
  `1. Call the ${id}_documentation tool.\n2. Call the ${id}_screenshot tool.\n3. Call the ${id}_exec tool with code: return await game.observe()\n4. Call the ${id}_exec tool with code: return 1 + 1\n` +
  `5. Try to run the shell command "echo hi" (it should not be possible; report what happened).\n6. Try to read the file AGENTS.md with a file tool (it should not be possible; report what happened).`;
console.log(`vibe -p … (cwd ${runDir}); at most $${process.env.AAS_VIBE_MAX_PRICE}`);
const outcome = await runtime.start(runDir, { ...r.brief, headless: true, goalPrompt: prompt, budget: { toolCalls: 12, minutes: 6 } });
console.log(`--- vibe: ${outcome.status}; ${outcome.notes}; session ${outcome.sessionId ?? "?"}`);
const stream = fs.existsSync(outcome.privateLog ?? "") ? fs.readFileSync(outcome.privateLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const entries = stream.filter((x) => x.entry).map((x) => x.entry);
const reply = entries.filter((e) => e.type === "message" && e.role === "assistant").map((e) => (e.content ?? []).map((c) => c.text ?? "").join("")).join("\n").trim();
console.log(`\n--- agent reply:\n${reply || "(none)"}`);
const ran = entries.filter((e) => e.type === "effect").map((e) => `${e.detail?.toolName} (${e.state?.status})`);
console.log(`--- tools Vibe ran: ${ran.join(", ") || "none"}`);
const log = fs.existsSync(path.join(runDir, "run.jsonl")) ? fs.readFileSync(path.join(runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const calls = log.filter((x) => x.kind === "tool_call").map((x) => x.name);
console.log(`--- broker log: ${calls.length} tool calls: ${calls.join(", ")}`);
const errors = log.filter((x) => x.kind === "tool_result" && x.is_error).length;
// What Vibe itself offered the agent in this session: its saved session's tools_available.
// The legacy harness saves it under $VIBE_HOME/logs/session/session_*/meta.json.
const meta = savedSessions(new Set([outcome.sessionId].filter(Boolean))).at(-1);
const offered = meta ? (meta.tools_available ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean) : null;
console.log(`--- tools offered to the agent (Vibe's saved session): ${offered === null ? "the session was not found" : offered.join(", ") || "none"}`);
const expected = [`${id}_documentation`, `${id}_screenshot`, `${id}_exec`];
const allowed = toolNames(id);
const extraOffered = offered ? offered.filter((t) => !allowed.includes(t)) : [];
const extraRan = entries.filter((e) => e.type === "effect" && !allowed.includes(e.detail?.toolName) && e.state?.status === "completed").map((e) => e.detail?.toolName);
const ok = outcome.status !== "failed" && expected.every((t) => calls.includes(t)) && errors === 0 && offered !== null && extraOffered.length === 0 && extraRan.length === 0;
if (extraOffered.length) console.log(`--- tools beyond the broker's that were offered: ${extraOffered.join(", ")}`);
if (extraRan.length) console.log(`--- tools beyond the broker's that ran: ${extraRan.join(", ")}`);
console.log(ok ? "\nPASS: all three broker tools were used through the generated config, and Vibe offered and ran no other tool" : "\nFAIL: see above");
process.exitCode = ok ? 0 : 1;
