// In-combat card-select actions from the oracle (Armaments, Headbutt, Gambler's Brew) are parsed and executed by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBot, parseOracle } from "../bot.mjs";

test("parseOracle: single and multi card-select actions", () => {
  const p = parseOracle("{ ARMAMENTS (3) hand=Strike discard=Defend }\n{ HEADBUTT (9) hand=INVALID discard=Bash }\n{ HEADBUTT (1) hand=Defend+ discard=Pommel Strike+ draw=Thunderclap+ }\n{ GAMBLE (1) Strike, (2) Defend }\n{ GAMBLE none }\n");
  assert.deepEqual(p.actions[0], { type: "select", task: "ARMAMENTS", index: 3, piles: { hand: "Strike", discard: "Defend" } });
  assert.deepEqual(p.actions[1], { type: "select", task: "HEADBUTT", index: 9, piles: { discard: "Bash" } });
  assert.deepEqual(p.actions[2], { type: "select", task: "HEADBUTT", index: 1, piles: { hand: "Defend+", discard: "Pommel Strike+", draw: "Thunderclap+" } });
  assert.deepEqual(p.actions[3], { type: "select", task: "GAMBLE", cards: [{ index: 1, name: "Strike" }, { index: 2, name: "Defend" }] });
  assert.deepEqual(p.actions[4], { type: "select", task: "GAMBLE", cards: [] });
});

test("the bot answers a hand-select screen from the oracle's line, then continues the line", () => {
  const oracle = { saveInfo: () => ({ floor: 6, room: "MonsterRoom", postCombat: false }), run: () => "{ use card (0) (Armaments,0,1,1) }\n{ ARMAMENTS (1) hand=Bash }\n{ use card (0) (Bash+,10,2,2) -> (0) CULTIST }\n{ end turn }\nending hp: 80\n" };
  const bot = createBot({ log() {}, oracle });
  bot.next(null);
  const mon = { name: "Cultist", current_hp: 40, intent: "ATTACK", move_adjusted_damage: 6, move_hits: 1 };
  const combat = (hand, extra = {}, cmds = ["play", "end", "state"]) => ({ in_game: true, ready_for_command: true, available_commands: cmds, game_state: { screen_type: "NONE", floor: 6, current_hp: 80, max_hp: 80, potions: [], combat_state: { turn: 1, hand, monsters: [mon], player: { energy: 3, max_energy: 3, block: 0, current_hp: 80 }, discard_pile: [], exhaust_pile: [] }, ...extra } });
  const arm = { name: "Armaments", type: "SKILL", cost: 1, is_playable: true, has_target: false };
  const bash = { name: "Bash", type: "ATTACK", cost: 2, is_playable: true, has_target: true };
  assert.equal(bot.next(combat([arm, bash])).code, "return await sts.play(1)");
  // the game shows the hand-select screen for Armaments: pick Bash by name
  const sel = bot.next(combat([bash], { screen_type: "HAND_SELECT", choice_list: ["bash"], screen_state: { selected: [], max_cards: 1 } }, ["choose", "state"]));
  assert.equal(sel.code, "return await sts.choose(0)", sel.note);
  const next = bot.next(combat([{ ...bash, name: "Bash+" }], { combat_state: { turn: 1, hand: [{ ...bash, name: "Bash+" }], monsters: [mon], player: { energy: 2, max_energy: 3, block: 0, current_hp: 80 }, discard_pile: [arm], exhaust_pile: [] } }));
  assert.equal(next.code, "return await sts.play(1, 0)", next.note);
});
