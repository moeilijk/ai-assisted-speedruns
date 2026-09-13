#!/usr/bin/env node
// A tape is the exact list of commands a run sent, with the floor, screen and combat turn each was
// sent from. On a fixed seed the game is deterministic, so the scripted bot replays a tape verbatim
// up to a known-good point and only then decides for itself: progress on a seed is kept, never
// re-gambled. Built from a run directory's run.jsonl (the harness's own record of every command).
//   node games/slay-the-spire/tape.mjs <run-dir> [--until-floor N] [--out tape.json]
import fs from "node:fs";
import path from "node:path";

/** Every command the run sent, in order, with what the game showed when it was sent. */
export function tapeFromRun(runDir, { untilFloor = Infinity } = {}) {
  const rows = fs.readFileSync(path.join(runDir, "run.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const calls = rows.filter((r) => r.kind === "tool_call");
  const results = new Map(rows.filter((r) => r.kind === "tool_result").map((r) => [r.call, r]));
  const tape = [];
  let before = null; // the state the previous exec returned = what the game showed when this command was sent
  for (const call of calls) {
    const code = typeof call.input === "string" ? call.input : call.input?.code ?? "";
    const res = results.get(call.call);
    const text = res?.output?.map?.((c) => c.text ?? "").join("") ?? "";
    let after = null; try { after = JSON.parse(text); } catch { after = null; }
    const g = before?.game_state ?? null;
    if (g && !/sts\.state\(\)|sts\.observe\(\)/.test(code)) {
      if ((g.floor ?? 0) > untilFloor) break;
      tape.push({ code, floor: g.floor ?? null, screen: g.screen_type ?? null, turn: g.combat_state?.turn ?? null, hp: g.current_hp ?? null });
    }
    if (after && typeof after.in_game === "boolean") before = after;
  }
  return tape;
}
export function loadTape(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
/** True when the live state is what the tape step expects (floor, screen, combat turn). */
export function tapeMatches(step, state) {
  const g = state?.game_state ?? {};
  return step.floor === (g.floor ?? null) && step.screen === (g.screen_type ?? null) && (step.turn ?? null) === (g.combat_state?.turn ?? null);
}

if (process.argv[1]?.endsWith("tape.mjs")) {
  const args = process.argv.slice(2);
  const runDir = args.find((a) => !a.startsWith("--"));
  const opt = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
  if (!runDir) throw new Error("usage: tape.mjs <run-dir> [--until-floor N] [--out file]");
  const tape = tapeFromRun(runDir, { untilFloor: Number(opt("--until-floor", Infinity)) });
  const out = opt("--out", path.join(runDir, "tape.json"));
  fs.writeFileSync(out, `${JSON.stringify(tape, null, 0)}\n`);
  const floors = tape.map((t) => t.floor).filter((f) => f !== null);
  console.log(`${tape.length} commands, floors ${Math.min(...floors)}..${Math.max(...floors)}, written ${out}`);
}
