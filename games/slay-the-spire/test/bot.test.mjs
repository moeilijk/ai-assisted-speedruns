// The scripted Ironclad: decisions on synthetic states, and a full run through the fake game.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBot } from "../bot.mjs";
import { startFakeSts } from "./fake-sts.mjs";

const st = (game_state, cmds) => ({ in_game: true, ready_for_command: true, available_commands: cmds, game_state });
const hand = (...cards) => cards.map(([name, type, extra]) => ({ name, type, is_playable: true, has_target: type === "ATTACK", ...(extra ?? {}) }));

test("turn planner: kills, vulnerable before attacks, block when hurt, area attacks on groups", () => {
  const bot = createBot();
  bot.next(null);
  const combat = (h, monsters, player = { block: 0, current_hp: 50, energy: 3 }) => bot.next(st({ screen_type: "NONE", floor: 3, current_hp: player.current_hp, max_hp: 80, potions: [], combat_state: { turn: 1, hand: h, monsters, player } }, ["play", "end", "state"]));
  const cultist = { name: "Cultist", current_hp: 40, block: 0, intent: "ATTACK", move_adjusted_damage: 6, move_hits: 1, is_gone: false };
  const h = hand(["Strike", "ATTACK", { cost: 1 }], ["Bash", "ATTACK", { cost: 2 }], ["Defend", "SKILL", { cost: 1 }]);
  // 3 energy: Bash (vulnerable) + Strike beats Strike + Defend against a 6-damage attacker at 50 HP
  const r1 = combat(h, [cultist]);
  assert.match(r1.code, /play\(2, 0\)/, r1.note);
  // low HP and enough block in hand: block it all (two Defends) rather than hit
  const r2 = combat(hand(["Strike", "ATTACK", { cost: 1 }], ["Bash", "ATTACK", { cost: 2 }], ["Defend", "SKILL", { cost: 1 }], ["Defend", "SKILL", { cost: 1 }]), [{ ...cultist, move_adjusted_damage: 10 }], { block: 0, current_hp: 20, energy: 3 });
  assert.match(r2.note, /block 10 vs 10/, r2.note);
  // a kill available: take it
  const r3 = combat(h, [{ ...cultist, current_hp: 6 }]);
  assert.match(r3.code, /play\(1, 0\)|play\(2, 0\)/, r3.note);
  // two monsters: Cleave over Strike
  const r4 = combat(hand(["Strike", "ATTACK", { cost: 1 }], ["Cleave", "ATTACK", { cost: 1, has_target: false }]), [cultist, { ...cultist, name: "Cultist 2" }]);
  assert.match(r4.note, /Cleave/, r4.note);
});

test("combat: powers first, then a kill, then block what is coming, then the strongest attack", () => {
  const bot = createBot();
  bot.next(null);
  const combat = (h, monsters, player = { block: 0, current_hp: 50 }) => bot.next(st({ screen_type: "NONE", floor: 3, current_hp: 50, max_hp: 80, potions: [], combat_state: { turn: 1, hand: h, monsters, player } }, ["play", "end", "state"]));
  const mons = [{ name: "Cultist", current_hp: 40, block: 0, intent: "ATTACK", move_adjusted_damage: 6, move_hits: 1, is_gone: false }];
  assert.match(combat(hand(["Strike", "ATTACK"], ["Inflame", "POWER", { has_target: false }]), mons).code, /play\(2\)/);
  assert.match(combat(hand(["Defend", "SKILL"], ["Strike", "ATTACK"]), mons).code, /play\([12](, 0)?\)/, "6 incoming at 50 HP: either is fine");
  assert.match(combat(hand(["Defend", "SKILL"], ["Strike", "ATTACK"]), [{ ...mons[0], current_hp: 5 }]).code, /play\(2, 0\)/, "a kill beats blocking");
  assert.match(combat(hand(["Strike", "ATTACK", { cost: 1 }], ["Carnage", "ATTACK", { cost: 2 }]), mons, { block: 10, current_hp: 50, energy: 3 }).code, /play\([12], 0\)/, "blocked: attack");
  assert.match(combat(hand(["Cleave", "ATTACK", { has_target: false }], ["Strike", "ATTACK"]), [mons[0], { ...mons[0], name: "Cultist 2" }], { block: 10 }).code, /play\(1\)/, "two monsters: the area attack");
  const end = combat([], mons);
  assert.match(end.code, /sts\.end\(\)/);
});

test("screens: Neow's Lament, the map avoids elites, cards from the list or skip, rest when hurt, the portal is left", () => {
  const bot = createBot();
  bot.next(null);
  assert.match(bot.next(st({ screen_type: "EVENT", screen_state: { event_name: "Neow" }, choice_list: ["talk"] }, ["choose", "state"])).code, /choose\(0\)/);
  assert.match(bot.next(st({ screen_type: "EVENT", screen_state: { event_name: "Neow" }, choice_list: ["obtain a random rare card", "enemies in your next three combats have 1 hp", "max hp +8"] }, ["choose", "state"])).code, /choose\(1\)/);
  const map = [{ x: 0, y: 0, symbol: "M", children: [{ x: 0, y: 1 }] }, { x: 1, y: 0, symbol: "M", children: [{ x: 1, y: 1 }] }, { x: 0, y: 1, symbol: "E", children: [] }, { x: 1, y: 1, symbol: "R", children: [] }];
  const m = bot.next(st({ screen_type: "MAP", map, screen_state: { next_nodes: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, choice_list: ["x=0,y=0", "x=1,y=0"] }, ["choose", "state"]));
  assert.match(m.code, /choose\(1\)/, m.note);
  assert.match(bot.next(st({ screen_type: "CARD_REWARD", choice_list: ["anger", "shrug it off", "clash"] }, ["choose", "skip", "state"])).code, /choose\(1\)/);
  // The expert ratings decide: Flex (65) against Havoc (8) and Anger (6), and with a starter deck averaging
  // nearly zero every one of them beats 0.6 times that average, so the best is taken instead of skipped.
  assert.match(bot.next(st({ screen_type: "CARD_REWARD", choice_list: ["anger", "havoc", "flex"] }, ["choose", "skip", "state"])).code, /choose\(2\)/);
  assert.match(bot.next(st({ screen_type: "REST", current_hp: 30, max_hp: 80, choice_list: ["rest", "smith"] }, ["choose", "state"])).code, /choose\(0\)/);
  assert.match(bot.next(st({ screen_type: "REST", current_hp: 70, max_hp: 80, choice_list: ["rest", "smith"] }, ["choose", "state"])).code, /choose\(1\)/);
  assert.match(bot.next(st({ screen_type: "EVENT", screen_state: { event_name: "Secret Portal", event_id: "SecretPortal" }, choice_list: ["enter", "leave"] }, ["choose", "state"])).code, /choose\(1\)/);
  // A skipped card reward stays listed: the next visit to the reward screen proceeds instead of reopening it.
  assert.match(bot.next(st({ screen_type: "COMBAT_REWARD", floor: 7, potions: [], choice_list: ["gold", "card"] }, ["choose", "proceed", "state"])).code, /choose\(0\)/);
  assert.match(bot.next(st({ screen_type: "COMBAT_REWARD", floor: 7, potions: [], choice_list: ["card"] }, ["choose", "proceed", "state"])).code, /choose\(0\)/);
  // A deck that is already strong: Corruption and Barricade average 92, so 0.6 times that is 55 and none of
  // Havoc (8), Evolve (20) or Second Wind (18) is worth diluting it with. That is when the expert skips.
  assert.match(bot.next(st({ screen_type: "CARD_REWARD", floor: 7, deck: [{ name: "Corruption" }, { name: "Barricade" }], choice_list: ["havoc", "evolve", "second wind"] }, ["choose", "skip", "state"])).code, /sts\.skip\(\)/);
  assert.match(bot.next(st({ screen_type: "COMBAT_REWARD", floor: 7, potions: [], choice_list: ["card"] }, ["choose", "proceed", "state"])).code, /sts\.proceed\(\)/);
  // Boss chest: a preferred relic, else a harmless one, else skip once and leave the chest.
  assert.match(bot.next(st({ screen_type: "BOSS_REWARD", floor: 17, choice_list: ["sacred bark", "ectoplasm", "philosopher's stone"] }, ["choose", "skip", "state"])).code, /choose\(0\)/);
  assert.match(bot.next(st({ screen_type: "BOSS_REWARD", floor: 17, choice_list: ["runic dome", "snecko eye", "velvet choker"] }, ["choose", "skip", "state"])).code, /sts\.skip\(\)/);
  assert.match(bot.next(st({ screen_type: "CHEST", floor: 17, choice_list: ["open"], screen_state: { chest_open: false, chest_type: "BossChest" } }, ["choose", "proceed", "state"])).code, /sts\.proceed\(\)/);
  // Hurt: the route prefers a rest site over a fight even when it costs a step more.
  const map2 = [{ x: 0, y: 0, symbol: "M", children: [] }, { x: 1, y: 0, symbol: "R", children: [] }];
  assert.match(bot.next(st({ screen_type: "MAP", current_hp: 20, max_hp: 80, map: map2, screen_state: { next_nodes: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, choice_list: ["x=0,y=0", "x=1,y=0"] }, ["choose", "state"])).code, /choose\(1\)/);
  // Shop: purge a Strike first, then a good card within budget, then leave.
  const deck = [{ name: "Strike" }, { name: "Defend" }];
  assert.match(bot.next(st({ screen_type: "SHOP_ROOM", floor: 9, gold: 200, choice_list: ["shop"] }, ["choose", "proceed", "state"])).code, /choose\(0\)/);
  const shopState = { screen_type: "SHOP_SCREEN", floor: 9, gold: 200, deck, potions: [], choice_list: ["pommel strike", "havoc", "anchor", "purge"], screen_state: { cards: [{ name: "Pommel Strike", price: 60 }, { name: "Havoc", price: 50 }], relics: [{ name: "Anchor", price: 150 }], potions: [], purge_available: true, purge_cost: 75 } };
  assert.match(bot.next(st(shopState, ["choose", "leave", "state"])).code, /choose\(3\)/, "purge first");
  assert.match(bot.next(st({ ...shopState, gold: 125, screen_state: { ...shopState.screen_state, purge_available: false } }, ["choose", "leave", "state"])).code, /choose\(0\)/, "then the good card");
  assert.match(bot.next(st({ ...shopState, gold: 65, screen_state: { ...shopState.screen_state, purge_available: false } }, ["choose", "leave", "state"])).code, /sts\.leave\(\)/, "nothing affordable: leave");
  // Empty Cage: remove two cards: Strike, then Defend, then confirm; an upgrade grid picks the best unupgraded card.
  const gridNames = ["strike", "strike", "defend", "bash", "carnage+", "inflame"];
  const grid = (selected) => st({ screen_type: "GRID", floor: 17, choice_list: gridNames, screen_state: { for_purge: true, num_cards: 2, selected_cards: selected, cards: [] } }, selected.length >= 2 ? ["confirm", "potion", "state"] : ["choose", "potion", "state"]);
  assert.match(bot.next(grid([])).code, /choose\(0\)/, "first a Strike");
  assert.match(bot.next(grid([{ name: "Strike" }])).code, /choose\(1\)/, "then the other Strike, not the selected one");
  assert.match(bot.next(grid([{ name: "Strike" }, { name: "Strike" }])).code, /sts\.confirm\(\)/);
  assert.match(bot.next(st({ screen_type: "GRID", floor: 6, choice_list: gridNames, screen_state: { for_upgrade: true, num_cards: 1, selected_cards: [], cards: [] } }, ["choose", "state"])).code, /choose\(5\)/, "upgrade Inflame (Carnage is already upgraded)");
  // A death is not the end of the session: the bot restarts on the same seed (from the GAME_OVER screen and from
  // the controller's refusal alike) and a victory ends it.
  assert.match(bot.next(st({ screen_type: "GAME_OVER", floor: 6, screen_state: { victory: false } }, ["state"])).code, /sts\.restart\(\)/);
  assert.match(bot.next({ error: "you died (death 1); call sts.restart()" }).code, /sts\.restart\(\)/);
  assert.equal(bot.next(st({ screen_type: "GAME_OVER", floor: 51, screen_state: { victory: true } }, ["state"])), null, "a victory ends the run");
});

test("the bot wins the fake game end to end", async () => {
  const fake = await startFakeSts({ floorsPerAct: 2, acts: 3, monsterHp: 10, cardDamage: 6 });
  process.env.AAS_STS_PORT = String(fake.port);
  process.env.AAS_STS_CLASS = "ironclad";
  process.env.AAS_STS_SEED = "";
  const { default: plugin } = await import(`../plugin.mjs?port=${fake.port}&bot=1`);
  const events = [];
  globalThis.aas = { event: (event, data) => events.push({ event, data }), emitImage() {} };
  let sts;
  try {
    await plugin.prepareRun({ log() {} });
    sts = await plugin.connect();
    const api = { state: () => sts.state(), play: (i, t) => sts.play(i, t), end: () => sts.end(), choose: (x) => sts.choose(x), proceed: () => sts.proceed(), confirm: () => sts.confirm(), skip: () => sts.skip(), cancel: () => sts.cancel(), wait: (n) => sts.wait(n), potion: (...a) => sts.potion(...a) };
    const bot = createBot();
    let result = null;
    for (let i = 0; i < 400; i += 1) {
      const step = bot.next(result);
      if (!step) break;
      try { result = await new Function("sts", `return (async () => { ${step.code} })()`)(api); } catch (e) { result = { error: e.message }; }
    }
  } finally {
    sts?.close();
    await fake.close();
  }
  const over = events.find((e) => e.event === "game.over");
  assert.ok(over, "the game ended");
  assert.equal(over.data.victory, true, "the bot won the fake game");
});

test("a death ends the session when a plan is being followed, and restarts the run when there is none", () => {
  const st = (game_state, available_commands) => ({ in_game: true, ready_for_command: true, available_commands, game_state });
  const dead = st({ screen_type: "GAME_OVER", floor: 16, screen_state: { victory: false } }, ["state"]);
  // A plan: replaying it from the start would repeat the same loss, so the bot stops with a diagnosis.
  const planned = createBot({ oracle: null, line: [{ floor: 0, screen: "EVENT", event: "NEOW", option: 1 }] });
  planned.next(null);
  assert.equal(planned.next(dead), null);
  assert.match(String(planned.broken), /died at floor 16/);
  // No plan: a death is not the end of the session.
  const free = createBot({ oracle: null });
  free.next(null);
  assert.match(free.next(dead).code, /sts\.restart\(\)/);
});
