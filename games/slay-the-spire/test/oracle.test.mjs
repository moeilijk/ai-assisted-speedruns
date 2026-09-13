// The combat oracle (sts_lightspeed) output is parsed and mapped onto live commands with verification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBot, parseOracle } from "../bot.mjs";

const SAMPLE = `2PL
steps: 200000 search time: 0.511719s
best search value: 11499 depth: 7
{ use card (1) (Carnage+,9,2,2) -> (0) SPHERIC_GUARDIAN }
{ use card (1) (Strike,0,1,1) -> (0) SPHERIC_GUARDIAN }
{ end turn }
{ drink potion (0) Flex Potion }
{ use card (1) (Defend,6,1,1) }
ending hp: 80
`;
test("parseOracle reads cards, targets, potions, end turn and the ending HP", () => {
  const p = parseOracle(SAMPLE);
  assert.equal(p.endingHp, 80); assert.equal(p.value, 11499);
  assert.deepEqual(p.actions.map((a) => a.type), ["card", "card", "end", "potion", "card"]);
  assert.deepEqual(p.actions[0], { type: "card", index: 1, name: "Carnage+", cost: 2, target: 0, targetName: "SPHERIC_GUARDIAN" }, "cost is what the card cost that turn");
  assert.deepEqual(p.actions[3], { type: "potion", use: true, index: 0, name: "Flex Potion", target: null, targetName: null });
});

test("the bot follows the oracle while the live hand matches, then falls back to its planner", () => {
  const logs = [];
  const oracle = { saveInfo: () => ({ floor: 18, room: "MonsterRoom", postCombat: false, hp: 80 }), run: () => SAMPLE };
  const bot = createBot({ log: (m) => logs.push(m), oracle });
  bot.next(null);
  const mon = { name: "Spheric Guardian", current_hp: 20, block: 40, intent: "ATTACK", move_adjusted_damage: 10, move_hits: 1, is_gone: false };
  const state = (hand, turn = 1, extra = {}) => ({ in_game: true, ready_for_command: true, available_commands: ["play", "end", "potion", "state"], game_state: { screen_type: "NONE", floor: 18, current_hp: 80, max_hp: 80, potions: [{ id: "FlexPotion", name: "Flex Potion", can_use: true, requires_target: false }], combat_state: { turn, hand, monsters: [mon], player: { energy: 3, max_energy: 3, block: 0, current_hp: 80 }, discard_pile: [], exhaust_pile: [] }, ...extra } });
  const card = (name, extra = {}) => ({ name, type: "ATTACK", cost: 1, is_playable: true, has_target: true, ...extra });
  const s1 = bot.next(state([card("Strike"), card("Carnage+", { cost: 2 }), card("Defend", { type: "SKILL", has_target: false })]));
  assert.equal(s1.code, "return await sts.play(2, 0)", s1.note);
  const s2 = bot.next(state([card("Strike"), card("Strike"), card("Defend", { type: "SKILL", has_target: false })]));
  assert.equal(s2.code, "return await sts.play(2, 0)");
  // no energy left: the game drops "play" from the commands; the oracle's "end turn" is still taken from the line
  const noPlay = state([card("Defend", { type: "SKILL", has_target: false, is_playable: false })]);
  noPlay.available_commands = ["end", "potion", "state"];
  const s3 = bot.next(noPlay);
  assert.equal(s3.code, "return await sts.end()"); assert.match(s3.note, /oracle: end turn/);
  assert.equal(bot.next(state([card("Strike")], 2)).code, 'return await sts.potion("use", 0)');
  // desync: the oracle wants Defend at hand[1], the game shows Strike there -> planner
  const s5 = bot.next(state([card("Strike"), card("Strike")], 2));
  assert.ok(!/oracle/.test(s5.note), s5.note);
  assert.ok(logs.some((m) => /desync/.test(m)), logs.join(" | "));
  assert.ok(logs.some((m) => /oracle: floor 18: 5 actions, ending hp 80/.test(m)));
});

test("no oracle run when the autosave is not this fight", () => {
  const logs = [];
  const bot = createBot({ log: (m) => logs.push(m), oracle: { saveInfo: () => ({ floor: 3, room: "MonsterRoom", postCombat: false }), run: () => { throw new Error("must not run"); } } });
  bot.next(null);
  const r = bot.next({ in_game: true, ready_for_command: true, available_commands: ["play", "end", "state"], game_state: { screen_type: "NONE", floor: 18, current_hp: 80, max_hp: 80, potions: [], combat_state: { turn: 1, hand: [{ name: "Strike", type: "ATTACK", cost: 1, is_playable: true, has_target: true }], monsters: [{ name: "Cultist", current_hp: 40, intent: "ATTACK", move_adjusted_damage: 6, move_hits: 1 }], player: { energy: 3, max_energy: 3, block: 0, current_hp: 80 }, discard_pile: [], exhaust_pile: [] } } });
  assert.match(r.code, /sts\.play\(1, 0\)/);
  assert.ok(logs.some((m) => /autosave is not this fight/.test(m)));
});

test("the oracle never targets a gone monster, and a refused play hands the fight to the planner", () => {
  const logs = [];
  const oracle = { saveInfo: () => ({ floor: 22, room: "MonsterRoom", postCombat: false }), run: () => "{ use card (0) (Clash,14,0,0) -> (0) CENTURION }\n{ use card (0) (Strike,6,1,1) -> (0) CENTURION }\n{ end turn }\nending hp: 70\n" };
  const bot = createBot({ log: (m) => logs.push(m), oracle });
  bot.next(null);
  const mons = [{ name: "Centurion", current_hp: 0, is_gone: true }, { name: "Mystic", current_hp: 49, intent: "BUFF", move_adjusted_damage: -1, move_hits: 1 }];
  const state = (hand) => ({ in_game: true, ready_for_command: true, available_commands: ["play", "end", "state"], game_state: { screen_type: "NONE", floor: 22, current_hp: 70, max_hp: 93, potions: [], combat_state: { turn: 1, hand, monsters: mons, player: { energy: 3, max_energy: 3, block: 0, current_hp: 70 }, discard_pile: [], exhaust_pile: [] } } });
  const clash = { name: "Clash", type: "ATTACK", cost: 0, is_playable: true, has_target: true };
  const r1 = bot.next(state([clash]));
  assert.equal(r1.code, "return await sts.play(1, 1)", "the living Mystic, not the gone Centurion");
  const r2 = bot.next({ error: 'Slay the Spire refused "PLAY 1 0": Selected card cannot be played with the selected target.' });
  assert.match(r2.code, /sts\.state\(\)/);
  const r3 = bot.next(state([{ name: "Strike", type: "ATTACK", cost: 1, is_playable: true, has_target: true }]));
  assert.ok(!/oracle/.test(r3.note), r3.note);
  assert.ok(logs.some((m) => /refused an action/.test(m)), logs.join(" | "));
});


test("a card is matched on what it costs this turn: the free copy from Liquid Memories, not its twin", () => {
  const actions = parseOracle("{ use card (3) (Defend,7,1,0) }").actions;
  assert.equal(actions[0].cost, 0, "costForTurn, not the base cost");
  const bot = createBot({ oracle: null, line: [] });
  // Two Defends in hand: one made free by the potion, one at its normal price. The plan played the free one.
  const hand = [{ name: "Defend", cost: 1, is_playable: true }, { name: "Defend", cost: 0, is_playable: true }];
  const state = {
    in_game: true, ready_for_command: true, available_commands: ["play", "end", "state"],
    game_state: { screen_type: "NONE", floor: 8, current_hp: 85, max_hp: 85, combat_state: { turn: 1, hand, draw_pile: [], discard_pile: [], exhaust_pile: [], player: { energy: 1, block: 0, powers: [] }, monsters: [{ name: "Fungi Beast", current_hp: 10, is_gone: false }] } },
  };
  bot.next(null);
  const step = bot.next(state);
  assert.match(step.code, /sts\.play\(2\)/, "the second Defend is the free one (1-based index)");
});
