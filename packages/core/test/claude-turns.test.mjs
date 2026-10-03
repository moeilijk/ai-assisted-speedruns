// The Claude Code runtime returns the turns as Claude Code counts them for --max-turns (its result's num_turns), not
// the assistant records of the stream, which come about three per turn: a budget left for a continued session was
// read as spent (2026-10-03: 312 records, num_turns 105). The CLI is a stand-in on PATH; its config is a temp folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("Claude Code, headless: the turns returned are Claude Code's own num_turns", async (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "aas-bin-"));
  const args = path.join(bin, "args.json");
  const record = (content) => JSON.stringify({ type: "assistant", message: { content } });
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)));
for (const l of ${JSON.stringify([record([{ type: "text", text: "thinking" }]), record([{ type: "tool_use", name: "x", input: {} }]), record([{ type: "text", text: "done" }])])}) console.log(l);
console.log(JSON.stringify({ type: "result", subtype: "success", num_turns: 1, total_cost_usd: 0.01, session_id: "s-9", result: "ok" }));
`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  t.after(() => { process.env.PATH = saved.PATH; if (saved.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR; });
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aas-claude-config-"));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-run-"));
  const { default: claude } = await import("../../runtime-claude-code/index.mjs");
  const { trustRunDir } = await import("../../runtime-claude-code/trust.mjs");
  trustRunDir(runDir);
  const out = await claude.start(runDir, { headless: true, resume: { sessionId: "s-9", prompt: "Keep playing towards the goal." }, budget: { toolCalls: 40 } }, { stopRequested: () => null });
  assert.equal(out.turns, 1, "num_turns, not the three records");
  assert.equal(out.sessionId, "s-9");
  const argv = JSON.parse(fs.readFileSync(args, "utf8"));
  assert.deepEqual(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2), ["--resume", "s-9"], "the same session goes on");
  assert.equal(argv[argv.indexOf("--max-turns") + 1], "40", "with the turns left");
});
