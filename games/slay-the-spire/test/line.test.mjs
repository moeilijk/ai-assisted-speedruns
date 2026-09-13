// The planner's line (lightspeed/aas.cpp output) is followed screen by screen and switched off on a mismatch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBot } from "../bot.mjs";

const st = (game_state, cmds) => ({ in_game: true, ready_for_command: true, available_commands: cmds, game_state });
const LINE = [
  { floor: 0, screen: "EVENT", event: "NEOW", option: 1 },
  { floor: 0, screen: "MAP", x: 5, y: 0, symbol: "M" },
  { floor: 1, screen: "BATTLE", encounter: "Two Louse", turn: 0, desc: "{ use card (3) (Bash,8,2,2) -> (1) GREEN_LOUSE }" },
  { floor: 1, screen: "BATTLE", encounter: "Two Louse", turn: 0, desc: "{ end turn }" },
  { floor: 1, screen: "BATTLE_END", encounter: "Two Louse", hpBefore: 80, hpAfter: 80 },
  { floor: 1, screen: "REWARDS", kind: "gold", amount: 20 },
  { floor: 1, screen: "REWARDS", kind: "card", reward: 0, name: "Combust", options: ["Shrug It Off", "Thunderclap", "Combust"] },
  { floor: 1, screen: "REWARDS", kind: "proceed" },
  { floor: 1, screen: "MAP", x: 4, y: 1, symbol: "R" },
  { floor: 2, screen: "REST", idx: 1, name: "smith" },
  { floor: 2, screen: "CARD_SELECT", type: 3, idx: 1, name: "Strike", ordinal: 1, count: 10 },
  { floor: 2, screen: "MAP", x: 4, y: 2, symbol: "$" },
];

test("the line drives Neow, the map, a battle, rewards, a rest site and a grid; a mismatch switches it off", () => {
  const logs = [];
  const bot = createBot({ log: (m) => logs.push(m), line: LINE, oracle: null });
  bot.next(null);
  assert.match(bot.next(st({ screen_type: "EVENT", floor: 0, screen_state: { event_name: "Neow", options: [{}] }, choice_list: ["talk"] }, ["choose", "state"])).code, /choose\(0\)/);
  const neow = bot.next(st({ screen_type: "EVENT", floor: 0, screen_state: { event_name: "Neow", options: [{}, {}, {}, {}] }, choice_list: ["a", "b", "c", "d"] }, ["choose", "state"]));
  assert.match(neow.code, /choose\(1\)/, neow.note);
  // Neow's closing screen is not in the plan: leave it, then the map
  assert.match(bot.next(st({ screen_type: "EVENT", floor: 0, screen_state: { event_name: "Neow", options: [{}] }, choice_list: ["leave"] }, ["choose", "state"])).code, /choose\(0\)/);
  const map = bot.next(st({ screen_type: "MAP", floor: 0, screen_state: { next_nodes: [{ x: 1, y: 0 }, { x: 5, y: 0 }] }, choice_list: ["x=1", "x=5"] }, ["choose", "state"]));
  assert.match(map.code, /choose\(1\)/, map.note);
  // battle from the line: Bash at hand[3] on the second louse, then end turn
  const hand = [{ name: "Strike", type: "ATTACK", cost: 1, is_playable: true, has_target: true }, { name: "Strike", type: "ATTACK", cost: 1, is_playable: true, has_target: true }, { name: "Defend", type: "SKILL", cost: 1, is_playable: true }, { name: "Bash", type: "ATTACK", cost: 2, is_playable: true, has_target: true }];
  const mons = [{ name: "Louse", current_hp: 12, intent: "ATTACK", move_adjusted_damage: 6, move_hits: 1 }, { name: "Green Louse", current_hp: 15, intent: "ATTACK", move_adjusted_damage: 6, move_hits: 1 }];
  const b1 = bot.next(st({ screen_type: "NONE", floor: 1, current_hp: 80, max_hp: 80, potions: [], combat_state: { turn: 1, hand, monsters: mons, player: { energy: 3, max_energy: 3, block: 0, current_hp: 80 }, discard_pile: [], exhaust_pile: [] } }, ["play", "end", "state"]));
  assert.equal(b1.code, "return await sts.play(4, 1)", b1.note);
  const b2 = bot.next(st({ screen_type: "NONE", floor: 1, current_hp: 80, max_hp: 80, potions: [], combat_state: { turn: 1, hand: hand.slice(0, 3), monsters: mons, player: { energy: 1, max_energy: 3, block: 0, current_hp: 80 }, discard_pile: [{}], exhaust_pile: [] } }, ["play", "end", "state"]));
  assert.equal(b2.code, "return await sts.end()", b2.note);
  // rewards: gold, then the card reward opened and Combust picked, then proceed, then the map
  assert.match(bot.next(st({ screen_type: "COMBAT_REWARD", floor: 1, potions: [], choice_list: ["gold", "card"] }, ["choose", "proceed", "state"])).code, /choose\(0\)/);
  assert.match(bot.next(st({ screen_type: "COMBAT_REWARD", floor: 1, potions: [], choice_list: ["card"] }, ["choose", "proceed", "state"])).code, /choose\(0\)/);
  assert.match(bot.next(st({ screen_type: "CARD_REWARD", floor: 1, choice_list: ["shrug it off", "thunderclap", "combust"] }, ["choose", "skip", "state"])).code, /choose\(2\)/);
  assert.match(bot.next(st({ screen_type: "COMBAT_REWARD", floor: 1, potions: [], choice_list: [] }, ["proceed", "state"])).code, /sts\.proceed\(\)/);
  assert.match(bot.next(st({ screen_type: "MAP", floor: 1, screen_state: { next_nodes: [{ x: 4, y: 1 }, { x: 6, y: 1 }] }, choice_list: ["x=4", "x=6"] }, ["choose", "state"])).code, /choose\(0\)/);
  assert.match(bot.next(st({ screen_type: "REST", floor: 2, choice_list: ["rest", "smith"] }, ["choose", "state"])).code, /choose\(1\)/);
  const grid = bot.next(st({ screen_type: "GRID", floor: 2, choice_list: ["strike", "strike", "defend", "bash"], screen_state: { for_upgrade: true, num_cards: 1, selected_cards: [] } }, ["choose", "state"]));
  assert.match(grid.code, /choose\(1\)/, "the second Strike (ordinal 1)");
  // mismatch: the plan expects the map at floor 2, the game shows a rest site at floor 3 -> strict: the session stops with a diagnosis
  const off = bot.next(st({ screen_type: "REST", floor: 3, current_hp: 30, max_hp: 80, choice_list: ["rest", "smith"] }, ["choose", "state"]));
  assert.equal(off, null);
  assert.match(bot.broken, /plan broken at step 12: floor 3 on REST, plan expects floor 2 MAP/);
  assert.equal(bot.next(st({ screen_type: "MAP", floor: 3, choice_list: ["x=1"] }, ["choose", "state"])), null, "stays stopped");
});

test("shop steps from the plan: relic names without the article, unavailable items skipped", () => {
  const line = [
    { floor: 14, screen: "SHOP", kind: "relic", name: "The Boot", price: 51 },
    { floor: 14, screen: "SHOP", kind: "relic", name: "Toolbox", price: 51 },
    { floor: 14, screen: "SHOP", kind: "card", name: "Havoc", price: 25 },
    { floor: 14, screen: "SHOP", kind: "leave" },
    { floor: 14, screen: "MAP", x: 2, y: 14, symbol: "R" },
  ];
  const bot = createBot({ log() {}, line, oracle: null });
  bot.next(null);
  const shop = (names, cmds = ["choose", "leave", "state"]) => st({ screen_type: "SHOP_SCREEN", floor: 14, gold: 245, potions: [], choice_list: names, screen_state: {} }, cmds);
  assert.match(bot.next(st({ screen_type: "SHOP_ROOM", floor: 14, choice_list: ["shop"] }, ["choose", "proceed", "state"])).code, /choose\(0\)/);
  assert.match(bot.next(shop(["purge", "havoc", "boot", "toolbox"])).code, /choose\(2\)/, "The Boot as 'boot'");
  assert.match(bot.next(shop(["purge", "havoc"])).code, /choose\(1\)/, "Toolbox gone: skipped, Havoc bought");
  assert.match(bot.next(shop(["purge"])).code, /sts\.leave\(\)/);
  assert.match(bot.next(st({ screen_type: "SHOP_ROOM", floor: 14, choice_list: ["shop"] }, ["choose", "proceed", "state"])).code, /sts\.proceed\(\)/, "back in the shop room with the plan at the map: proceed, do not re-enter");
});


test("with a plan loaded the bot never improvises: an unplayable step ends the run instead of ending the turn", () => {
  // The plan wants a Strike; the game has no Strike in hand. Without a plan the oracle would hand over to the
  // planner and play on; with a plan that hides the divergence, so the session has to stop with a diagnosis.
  const line = [
    { floor: 1, screen: "BATTLE", encounter: "Cultist", turn: 0, energy: 3, hp: 80, desc: "{ use card (0) (Strike,1,1,1) -> (0) CULTIST }" },
    { floor: 1, screen: "BATTLE_END", encounter: "Cultist", hpBefore: 80, hpAfter: 80 },
  ];
  const bot = createBot({ oracle: null, line });
  bot.next(null);
  const state = {
    in_game: true, ready_for_command: true, available_commands: ["play", "end", "state"],
    game_state: { screen_type: "NONE", floor: 1, current_hp: 80, max_hp: 80, combat_state: { turn: 1, hand: [{ name: "Defend", cost: 1, is_playable: true }], draw_pile: [], discard_pile: [], exhaust_pile: [], player: { energy: 3, block: 0, powers: [] }, monsters: [{ name: "Cultist", current_hp: 50, is_gone: false }] } },
  };
  assert.equal(bot.next(state), null, "the bot stops");
  assert.match(String(bot.broken), /desync|plan broken/, bot.broken);
});
