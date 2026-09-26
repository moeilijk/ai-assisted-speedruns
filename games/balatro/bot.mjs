// A scripted player for the "scripted" runtime: the end-to-end test of the Balatro chain (actions -> splits ->
// game over -> restart -> publish). Unlike the first version, this one aims to actually clear ante 1, because a
// mock run that dies on the small blind tests nothing past the first two actions.
//
// The policy is ported from the `smart_agent` of TylerFlar/jackdaw-balatro (MIT, see UPSTREAM.json), a 1:1 Python
// reimplementation of Balatro with a bit-exact PRNG: play the best-scoring hand, discard only a hopeless one,
// spend the early money on jokers, skip packs. Measured in that simulator over 30 seeds (Red Deck, White Stake,
// `ante1.py` in the research notes): that policy clears ante 1 in 22 of 30, and the "play the largest group, buy
// nothing" policy it replaces in 0 of 30. It is not a strategy for a whole run — nobody's is; the best published
// search agent wins about 5% of runs.
//
// After `AAS_BOT_BALATRO_ATTEMPTS` game overs (default 1) it stops.
const RANKS = "23456789TJQKA";
/** What a card is worth in chips when it scores, as the game counts it. */
const CHIPS = { T: 10, J: 10, Q: 10, K: 10, A: 11 };
const chipsOf = (rank) => CHIPS[rank] ?? (Number(rank) || 0);

// Level 1 chips and mult per hand, for the hands a first ante can make. The game reports the real numbers per
// hand in `state.hands`, so this table is only the fallback when it does not.
const BASE = {
  "Flush Five": [160, 16], "Flush House": [140, 14], "Five of a Kind": [120, 12], "Straight Flush": [100, 8],
  "Four of a Kind": [60, 7], "Full House": [40, 4], Flush: [35, 4], Straight: [30, 4],
  "Three of a Kind": [30, 3], "Two Pair": [20, 2], Pair: [10, 2], "High Card": [5, 1],
};
/** Best first: the order the agent prefers when two hands score the same. */
export const PRIORITY = Object.keys(BASE);

const one = (code, note) => ({ code, note });
const rankOf = (c) => c?.value?.rank ?? "";
const suitOf = (c) => (c?.key ?? "").split("_")[0] || c?.value?.suit || "";

/** The poker hand a set of 1 to 5 cards makes, by Balatro's rules (no jokers that change them). */
export function handType(cards) {
  const ranks = cards.map(rankOf);
  const counts = [...ranks.reduce((m, r) => m.set(r, (m.get(r) ?? 0) + 1), new Map()).values()].sort((a, b) => b - a);
  const flush = cards.length === 5 && new Set(cards.map(suitOf)).size === 1;
  const idx = [...new Set(ranks.map((r) => RANKS.indexOf(r)))].sort((a, b) => a - b);
  const straight = cards.length === 5 && idx.length === 5
    && (idx[4] - idx[0] === 4 || (idx[0] === 0 && idx[1] === 1 && idx[2] === 2 && idx[3] === 3 && idx[4] === 12));
  if (counts[0] === 5) return flush ? "Flush Five" : "Five of a Kind";
  if (counts[0] === 3 && counts[1] === 2) return flush ? "Flush House" : "Full House";
  if (counts[0] === 4) return "Four of a Kind";
  if (flush && straight) return "Straight Flush";
  if (flush) return "Flush";
  if (straight) return "Straight";
  if (counts[0] === 3) return "Three of a Kind";
  if (counts[0] === 2 && counts[1] === 2) return "Two Pair";
  if (counts[0] === 2) return "Pair";
  return "High Card";
}

/** The cards of a hand that score: the matched ranks, or all five when the hand is made of all of them. */
export function scoringCards(cards, type) {
  if (["Flush Five", "Flush House", "Five of a Kind", "Full House", "Straight Flush", "Flush", "Straight", "Two Pair"].includes(type)) return cards;
  const want = { "Four of a Kind": 4, "Three of a Kind": 3, Pair: 2 }[type];
  if (!want) return [cards.reduce((best, c) => (chipsOf(rankOf(c)) > chipsOf(rankOf(best)) ? c : best), cards[0])].filter(Boolean);
  const rank = [...cards.reduce((m, c) => m.set(rankOf(c), (m.get(rankOf(c)) ?? 0) + 1), new Map())].find(([, n]) => n === want)?.[0];
  return cards.filter((c) => rankOf(c) === rank);
}

/** What a set of cards is worth, with the hand's own level from the state when the game reports it. */
export function estimate(cards, hands = null) {
  const type = handType(cards);
  const level = hands?.[type];
  const [baseChips, baseMult] = [level?.chips ?? BASE[type][0], level?.mult ?? BASE[type][1]];
  const chips = scoringCards(cards, type).reduce((sum, c) => sum + chipsOf(rankOf(c)), 0);
  return { type, score: (baseChips + chips) * baseMult };
}

/** The best hand to play from `cards`: every set of one to five cards, by estimated score. */
export function bestHand(cards, hands = null) {
  let best = { indices: [], type: "High Card", score: -1 };
  const n = Math.min(cards.length, 8);
  for (let mask = 1; mask < 1 << n; mask += 1) {
    const indices = [...Array(n).keys()].filter((i) => mask & (1 << i));
    if (indices.length > 5) continue;
    const { type, score } = estimate(indices.map((i) => cards[i]), hands);
    if (score > best.score || (score === best.score && PRIORITY.indexOf(type) < PRIORITY.indexOf(best.type))) best = { indices, type, score };
  }
  return best;
}

/** Up to five cards to throw away: the ones the best hand does not use, worst first. */
export function discardChoice(cards, keep) {
  const held = new Set(keep);
  return cards.map((c, i) => i).filter((i) => !held.has(i))
    .sort((a, b) => chipsOf(rankOf(cards[a])) - chipsOf(rankOf(cards[b]))).slice(0, 5).sort((a, b) => a - b);
}

// The game writes a card's set in capitals ("JOKER", "PLANET"); jackdaw's simulator writes it as "Joker". Both are
// the same card, so the comparison ignores case — reading it strictly is what made the first run against the real
// game buy nothing at all and die on the big blind with $9 in hand.
const isSet = (card, set) => String(card?.set ?? "").toUpperCase() === set;

/** The first Planet card held: a free hand level, so it is used the moment it is there. */
const planetIndex = (s) => (s.consumables?.cards ?? []).findIndex((c) => isSet(c, "PLANET"));

/**
 * What to buy in the shop. Early on the money is worth more as a joker than as interest, so while there are fewer
 * than three jokers in ante 1 and 2 everything is spendable; after that $5 stays put for the interest.
 */
export function shopChoice(s) {
  const room = (s.jokers?.count ?? 0) < (s.jokers?.limit ?? 5);
  if (!room) return null;
  const floor = (s.ante_num ?? 1) <= 2 && (s.jokers?.count ?? 0) < 3 ? 0 : 5;
  const spendable = (s.money ?? 0) - floor;
  const jokers = (s.shop?.cards ?? []).map((c, i) => ({ c, i }))
    .filter(({ c }) => isSet(c, "JOKER") && (c?.cost?.buy ?? Infinity) <= spendable);
  if (!jokers.length) return null;
  // Mult beats chips beats the rest, and the cheapest of the best kind: the same order jackdaw's agent uses.
  const rank = ({ c }) => (/mult/i.test(c?.value?.effect ?? "") ? 0 : /chip/i.test(c?.value?.effect ?? "") ? 1 : 2);
  jokers.sort((a, b) => rank(a) - rank(b) || (a.c.cost?.buy ?? 0) - (b.c.cost?.buy ?? 0));
  return jokers[0].i;
}

export function createBot({ log = () => {} } = {}) {
  const maxAttempts = Number(process.env.AAS_BOT_BALATRO_ATTEMPTS || 1);
  const maxRefusals = 5; // the same action refused this often in a row ends the bot: the game is not where it should be
  let overs = 0;
  let refusals = 0;
  let broken = null;
  let pending = null; // what the last exec was
  return {
    /** Why the bot gave up, once it has. */
    get broken() { return broken; },
    next(result) {
      if (result?.error) {
        log(`error: ${result.error}`);
        if (pending === "state") return null;
        refusals += 1;
        if (refusals >= maxRefusals) {
          broken = `the game refused the bot's action ${refusals} times in a row; last: ${String(result.error).split("\n")[0]}`;
          log(`${broken}; stopping`);
          return null;
        }
      } else if (pending === "act") refusals = 0;
      const s = result && !result.error ? result : null;
      // After a refusal the state is read again 300 ms later: the game may not have finished its animation yet.
      if (!s) { const refused = pending === "act"; pending = "state"; return { ...one("return await bal.state();", "read the state"), ...(refused ? { delayMs: 300 } : {}) }; }
      if (s.won) return null;
      pending = "act";
      switch (s.state) {
        case "BLIND_SELECT": return one("return await bal.select();", "play the blind");
        case "SELECTING_HAND": {
          const planet = planetIndex(s);
          if (planet >= 0) return one(`return await bal.use(${planet});`, "use the Planet card");
          const cards = s.hand?.cards ?? [];
          if (!cards.length) { pending = "state"; return one("return await bal.state();", "wait for a hand"); }
          const best = bestHand(cards, s.hands);
          const handsLeft = s.round?.hands_left ?? 4;
          const discardsLeft = s.round?.discards_left ?? 0;
          // Only throw away a hopeless hand: a High Card, or a Pair while there is room to look for better.
          const hopeless = best.type === "High Card" || (best.type === "Pair" && handsLeft >= 3 && discardsLeft >= 2);
          if (hopeless && discardsLeft > 0 && handsLeft > 1) {
            const throwAway = discardChoice(cards, best.indices);
            if (throwAway.length) return one(`return await bal.discard(${JSON.stringify(throwAway)});`, `discard ${throwAway.length} (best was ${best.type})`);
          }
          return one(`return await bal.play(${JSON.stringify(best.indices)});`, `play ${best.type}`);
        }
        case "ROUND_EVAL": {
          const planet = planetIndex(s);
          if (planet >= 0) return one(`return await bal.use(${planet});`, "use the Planet card");
          return one("return await bal.cashOut();", "cash out");
        }
        case "SHOP": {
          const buy = shopChoice(s);
          if (buy !== null) return one(`return await bal.buy({ card: ${buy} });`, "buy a joker");
          return one("return await bal.nextRound();", "leave the shop");
        }
        case "SMODS_BOOSTER_OPENED": return one("return await bal.pack({ skip: true });", "skip the pack");
        case "GAME_OVER":
          overs += 1;
          if (overs > maxAttempts) return null;
          return one("return await bal.restart();", "new run");
        default: pending = "state"; return one("return await bal.state();", `wait (${s.state})`);
      }
    },
  };
}
