// A tape from a run is replayed verbatim while the game matches it, then the heuristics take over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tapeFromRun, tapeMatches } from "../tape.mjs";
import { createBot } from "../bot.mjs";

const st = (game_state, cmds = ["choose", "proceed", "end", "state"]) => ({ in_game: true, ready_for_command: true, available_commands: cmds, game_state });

test("tapeFromRun records every command with the screen it was sent from; the bot replays it and then decides", () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-tape-"));
  const s1 = st({ floor: 1, screen_type: "MAP", choice_list: ["x=0,y=0"] });
  const s2 = st({ floor: 2, screen_type: "NONE", combat_state: { turn: 1, hand: [], monsters: [], player: {} } }, ["play", "end", "state"]);
  const s3 = st({ floor: 2, screen_type: "NONE", combat_state: { turn: 2, hand: [], monsters: [], player: {} } }, ["play", "end", "state"]);
  const rows = [
    { kind: "tool_call", call: "call-00001", input: { code: "return await sts.state()" } }, { kind: "tool_result", call: "call-00001", output: [{ type: "text", text: JSON.stringify(s1) }] },
    { kind: "tool_call", call: "call-00002", input: { code: "return await sts.choose(0)" } }, { kind: "tool_result", call: "call-00002", output: [{ type: "text", text: JSON.stringify(s2) }] },
    { kind: "tool_call", call: "call-00003", input: { code: "return await sts.end()" } }, { kind: "tool_result", call: "call-00003", output: [{ type: "text", text: JSON.stringify(s3) }] },
  ];
  writeFileSync(join(dir, "run.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const tape = tapeFromRun(dir);
  assert.deepEqual(tape.map((t) => [t.code, t.floor, t.screen, t.turn]), [["return await sts.choose(0)", 1, "MAP", null], ["return await sts.end()", 2, "NONE", 1]]);
  assert.ok(tapeMatches(tape[1], s2) && !tapeMatches(tape[1], s3));
  assert.equal(tapeFromRun(dir, { untilFloor: 1 }).length, 1);

  const logs = [];
  const bot = createBot({ tape, log: (m) => logs.push(m) });
  bot.next(null);
  assert.match(bot.next(s1).code, /choose\(0\)/);
  assert.match(bot.next(s2).code, /sts\.end\(\)/);
  const live = bot.next(s3); // tape exhausted: heuristics (empty hand -> end turn)
  assert.match(live.code, /sts\.end\(\)/);
  assert.ok(logs.some((m) => /tape done after 2 commands/.test(m)), logs.join(" | "));

  const bot2 = createBot({ tape, log: (m) => logs.push(m) });
  bot2.next(null);
  bot2.next(s3); // does not match the first tape step: live from the start
  assert.ok(logs.some((m) => /tape diverged at command 1/.test(m)), logs.join(" | "));
});
