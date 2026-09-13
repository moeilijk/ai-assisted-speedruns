#!/usr/bin/env node
// Is a plan replayable in the real game, from beginning to end, without dying?
//
// A won playout is its own proof that the decisions survive: every fight in it ends above zero hit points
// and its last line is the victory on floor 51. That proof only carries over to the game where the game
// does the same thing as the simulator, and two places are measured not to: effects that
// generate a card (Discovery, Liquid Memories, Gamble, the card potions) roll a different card there, and
// an event option is numbered per screen instead of straight through (the plan carries its label for that).
// This check therefore refuses a plan that contains such a step, and refuses one whose steps do not all map
// onto an action the bot can take.
//
//   node games/slay-the-spire/check-plan.mjs <plan.jsonl>...
import fs from "node:fs";

const GENERATES_A_CARD = /DISCOVERY|LIQUID_MEMORIES|GAMBLE|COLORLESS|SKILL_POTION|ATTACK_POTION|POWER_POTION|TRANSMUTATION|CHRYSALIS|METAMORPHOSIS/;
const KNOWN_SCREENS = new Set(["EVENT", "MAP", "REWARDS", "BATTLE", "BATTLE_END", "SHOP", "REST", "TREASURE", "BOSS_RELIC", "POTION", "CARD_SELECT"]);

export function checkPlan(rows) {
  const problems = [];
  let victory = false, floors = 0, lowest = Infinity, fights = 0;
  for (const [i, r] of rows.entries()) {
    if (r.outcome) { victory = r.outcome === "victory"; floors = r.floor ?? floors; continue; }
    if (r.seedCode) continue;
    if (r.screen && !KNOWN_SCREENS.has(r.screen)) problems.push(`line ${i + 1}: screen ${r.screen} is not a step the bot knows`);
    if (GENERATES_A_CARD.test(String(r.desc ?? ""))) problems.push(`line ${i + 1} (floor ${r.floor}): ${String(r.desc).slice(0, 60)} generates a card, which the game rolls differently`);
    if (r.screen === "EVENT" && !r.label) problems.push(`line ${i + 1} (floor ${r.floor}): event ${r.event} has no label, only index ${r.option}`);
    if (r.screen === "BATTLE_END") { fights += 1; if (typeof r.hpAfter === "number") lowest = Math.min(lowest, r.hpAfter); }
    if (typeof r.hp === "number") lowest = Math.min(lowest, r.hp);
  }
  if (!victory) problems.push("the plan does not end in a victory");
  if (lowest <= 0) problems.push(`hit points reach ${lowest} during the plan`);
  return { ok: problems.length === 0, victory, floors, fights, lowest, problems };
}

if (process.argv[1]?.endsWith("check-plan.mjs")) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("usage: check-plan.mjs <plan.jsonl>..."); process.exit(2); }
  let clean = 0;
  for (const file of files) {
    // An unreadable line is a refusal, not an empty row: the bot's loader drops it too, so both would agree on a
    // plan that is missing a decision the game does ask for (measured: a raw tab in an event label hid Neow's choice).
    const bad = [];
    const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l, i) => {
      try { return JSON.parse(l); } catch (e) { bad.push(`line ${i + 1} is not valid JSON (${e.message})`); return {}; }
    });
    const r = checkPlan(rows);
    if (bad.length) { r.ok = false; r.problems = [...bad, ...r.problems]; }
    if (r.ok) clean += 1;
    const name = file.split("/").pop();
    console.log(`${r.ok ? "REPLAYABLE" : "refused   "} ${name.padEnd(18)} victory ${r.victory} floor ${r.floors} fights ${r.fights} lowest hp ${r.lowest}${r.ok ? "" : `\n   ${r.problems.slice(0, 3).join("\n   ")}${r.problems.length > 3 ? `\n   (+${r.problems.length - 3} more)` : ""}`}`);
  }
  console.log(`\n${clean} of ${files.length} plan(s) replayable from beginning to end`);
}
