// The scripted runtime plays a bot through the broker: one exec per decision, session log written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../core/src/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("scripted runtime: the bot's decisions become tool calls until it is done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-scripted-"));
  const bot = join(dir, "bot.mjs");
  writeFileSync(bot, `export function createBot() { let n = 0; return { next(result) { n += 1; if (n === 1) return { code: "return await game.observe()", note: "look" }; if (result?.turn >= 3) return null; return { code: "return await game.act('step')", note: "step " + n }; } }; }`);
  const instructions = join(dir, "AGENTS.md");
  writeFileSync(instructions, "Play the fake game.\n");
  const runDir = join(dir, "run-01");
  const r = await run({ runtime: join(here, "..", "index.mjs"), game: join(here, "..", "..", "core", "test", "fake-game.mjs"), recorder: "null", "run-dir": runDir, bot, instructions }, { log() {} });
  assert.equal(r.outcome.status, "stopped");
  assert.match(r.outcome.notes, /3 steps; bot done/);
  const session = readFileSync(join(runDir, "session.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(session.filter((x) => x.type === "assistant" && x.message.content.some((c) => c.type === "tool_use")).length, 3);
  assert.ok(session.some((x) => x.type === "user" && /\\"turn\\":\s*3/.test(JSON.stringify(x.message))), "the tool result with turn 3 is in the session log");
});
