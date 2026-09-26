// The scripted player's decisions: the hand it reads out of a hand of cards, when it throws cards away, what it
// buys, and the order it walks the phases in. The numbers behind the policy come from jackdaw's simulator; these
// tests only hold the policy to what it says it does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bestHand, createBot, discardChoice, handType, shopChoice } from "../bot.mjs";

const card = (key) => ({ key, value: { rank: key.split("_")[1], suit: key.split("_")[0] } });
const hand = (...keys) => keys.map(card);

test("a set of cards is the hand the game would call it", () => {
  assert.equal(handType(hand("H_A", "S_A", "C_A", "D_A", "H_5")), "Four of a Kind");
  assert.equal(handType(hand("H_2", "S_2", "C_7", "D_7", "H_9")), "Two Pair");
  assert.equal(handType(hand("H_2", "H_5", "H_9", "H_J", "H_K")), "Flush");
  assert.equal(handType(hand("H_5", "S_6", "C_7", "D_8", "H_9")), "Straight");
  assert.equal(handType(hand("H_A", "S_2", "C_3", "D_4", "H_5")), "Straight", "the ace counts low as well");
  assert.equal(handType(hand("H_5", "H_6", "H_7", "H_8", "H_9")), "Straight Flush");
  assert.equal(handType(hand("H_3", "S_3", "C_3", "D_8", "H_8")), "Full House");
  assert.equal(handType(hand("H_K", "S_9", "C_4")), "High Card");
});

test("the best hand out of a full hand of eight is the one that scores most", () => {
  // Three of a kind on tens: (30+30)*3 = 180, against a pair of twos at (10+4)*2.
  const best = bestHand(hand("H_T", "S_T", "C_T", "D_2", "H_3", "S_4", "C_5", "D_7"));
  assert.equal(best.type, "Three of a Kind");
  assert.deepEqual(best.indices, [0, 1, 2]);
  // A flush is worth more than the pair inside it.
  const flush = bestHand(hand("H_2", "H_4", "H_9", "H_J", "H_K", "S_4", "C_5", "D_6"));
  assert.equal(flush.type, "Flush");
  // And a full house beats the three of a kind inside it, which is what the first case must not contain.
  assert.equal(bestHand(hand("H_T", "S_T", "C_T", "D_2", "H_2")).type, "Full House");
});

test("what is thrown away is what the best hand does not use, lowest first", () => {
  const cards = hand("H_T", "S_T", "C_3", "D_2", "H_4", "S_5", "C_6", "D_7");
  const thrown = discardChoice(cards, [0, 1]);
  assert.equal(thrown.length, 5);
  assert.ok(!thrown.includes(0) && !thrown.includes(1), "the pair stays in hand");
  assert.deepEqual(thrown, [...thrown].sort((a, b) => a - b), "indices go up, as the game reads them");
});

test("early money goes into a joker, later money keeps the interest floor", () => {
  const shop = (cost) => ({ cards: [{ set: "Joker", cost: { buy: cost }, value: { effect: "+4 Mult" } }] });
  assert.equal(shopChoice({ ante_num: 1, money: 4, jokers: { count: 0, limit: 5 }, shop: shop(4) }), 0, "ante 1 spends its last dollar on a joker");
  assert.equal(shopChoice({ ante_num: 4, money: 4, jokers: { count: 1, limit: 5 }, shop: shop(4) }), null, "later on $5 stays put");
  assert.equal(shopChoice({ ante_num: 1, money: 9, jokers: { count: 5, limit: 5 }, shop: shop(4) }), null, "no room, no purchase");
  const two = { cards: [{ set: "Joker", cost: { buy: 5 }, value: { effect: "+30 Chips" } }, { set: "Joker", cost: { buy: 6 }, value: { effect: "+4 Mult" } }] };
  assert.equal(shopChoice({ ante_num: 1, money: 10, jokers: { count: 0, limit: 5 }, shop: two }), 1, "mult beats chips, even at a dollar more");
});

test("the bot walks a round: blind, play, cash out, shop, next round", () => {
  const bot = createBot();
  assert.match(bot.next(null).code, /bal\.state\(\)/);
  assert.match(bot.next({ state: "BLIND_SELECT" }).code, /bal\.select\(\)/);
  const play = bot.next({ state: "SELECTING_HAND", round: { hands_left: 4, discards_left: 4 }, hand: { cards: hand("H_T", "S_T", "C_T", "D_2", "H_5") } });
  assert.match(play.code, /bal\.play\(\[0,1,2\]\)/);
  const bad = bot.next({ state: "SELECTING_HAND", round: { hands_left: 4, discards_left: 4 }, hand: { cards: hand("H_K", "S_9", "C_4", "D_2", "H_7") } });
  assert.match(bad.code, /bal\.discard\(/, "a High Card is thrown away while there is room");
  const last = bot.next({ state: "SELECTING_HAND", round: { hands_left: 1, discards_left: 4 }, hand: { cards: hand("H_K", "S_9", "C_4", "D_2", "H_7") } });
  assert.match(last.code, /bal\.play\(/, "on the last hand it plays whatever it has");
  assert.match(bot.next({ state: "ROUND_EVAL" }).code, /bal\.cashOut\(\)/);
  assert.match(bot.next({ state: "SHOP", money: 0, jokers: { count: 0, limit: 5 }, shop: { cards: [] } }).code, /bal\.nextRound\(\)/);
  assert.match(bot.next({ state: "SMODS_BOOSTER_OPENED" }).code, /bal\.pack\(\{ skip: true \}\)/);
});

test("an action refused five times in a row ends the bot with the reason; a refusal that is answered does not count", () => {
  const logs = [];
  const bot = createBot({ log: (m) => logs.push(m) });
  const handState = { state: "SELECTING_HAND", round: { hands_left: 4, discards_left: 4 }, hand: { cards: hand("H_T", "S_T", "C_T", "D_2", "H_3", "S_4", "C_5", "D_6") } };
  bot.next(null);
  assert.match(bot.next(handState).code, /bal\.play\(/);
  for (let i = 0; i < 4; i += 1) {
    const again = bot.next({ error: "Balatro refused play: attempt to index field 'buttons' (a nil value)" });
    assert.match(again.code, /bal\.state\(\)/, "after a refusal the state is read again");
    assert.equal(again.delayMs, 300, "300 ms later: the game may still be busy");
    const play = bot.next(handState);
    assert.match(play.code, /bal\.play\(/);
    assert.equal(play.delayMs, undefined, "a plain step waits for nothing");
  }
  assert.equal(bot.broken, null);
  assert.equal(bot.next({ error: "Balatro refused play: attempt to index field 'buttons' (a nil value)" }), null, "the fifth refusal ends the bot");
  assert.match(bot.broken, /refused the bot's action 5 times in a row; last: Balatro refused play/);
  assert.ok(logs.some((m) => /stopping/.test(m)));
  const fresh = createBot();
  fresh.next(null);
  fresh.next(handState);
  fresh.next({ error: "refused once" });
  assert.match(fresh.next(handState).code, /bal\.play\(/);
  assert.match(fresh.next({ state: "ROUND_EVAL" }).code, /bal\.cashOut\(\)/, "an action that went through resets the count");
  assert.equal(fresh.broken, null);
});

test("a Planet card is used before anything else, and a won run ends the bot", () => {
  const bot = createBot();
  const s = { state: "SELECTING_HAND", consumables: { cards: [{ set: "Planet" }] }, round: { hands_left: 4, discards_left: 4 }, hand: { cards: hand("H_T", "S_T") } };
  assert.match(bot.next(s).code, /bal\.use\(0\)/);
  assert.equal(bot.next({ state: "SELECTING_HAND", won: true }), null);
});

test("after the last attempt the bot is done", () => {
  const bot = createBot();
  assert.match(bot.next({ state: "GAME_OVER" }).code, /bal\.restart\(\)/, "the first game over is followed by one more attempt");
  assert.equal(bot.next({ state: "GAME_OVER" }), null, "the second one ends it (AAS_BOT_BALATRO_ATTEMPTS defaults to 1)");
});

test("the set of a card is read whatever case the game writes it in", () => {
  // The real game says "JOKER" and "PLANET"; jackdaw's simulator says "Joker" and "Planet".
  const joker = (set) => ({ cards: [{ set, cost: { buy: 4 }, value: { effect: "+4 Mult" } }] });
  for (const set of ["JOKER", "Joker", "joker"]) {
    assert.equal(shopChoice({ ante_num: 1, money: 9, jokers: { count: 0, limit: 5 }, shop: joker(set) }), 0, `set ${set} is a joker`);
  }
  assert.equal(shopChoice({ ante_num: 1, money: 9, jokers: { count: 0, limit: 5 }, shop: joker("PLANET") }), null, "a planet in the shop is not a joker");
  for (const set of ["PLANET", "Planet"]) {
    const bot = createBot();
    const s = { state: "SELECTING_HAND", consumables: { cards: [{ set }] }, round: { hands_left: 4, discards_left: 4 }, hand: { cards: [{ key: "H_T", value: { rank: "T" } }] } };
    assert.match(bot.next(s).code, /bal\.use\(0\)/, `set ${set} is used at once`);
  }
});
