// A scripted player for the "scripted" runtime: the end-to-end test of the Balatro chain (actions -> splits ->
// game over -> restart -> publish), not a strategy. Plain rules: play the largest group of equal ranks, filled up with
// the highest cards; take nothing in the shop; skip packs. After `AAS_BOT_BALATRO_ATTEMPTS` game overs (default 1)
// it stops.
const RANKS = "23456789TJQKA";
const one = (code, note) => ({ code, note });

/** The indices of up to five cards to play: the largest group of one rank, then the highest remaining cards. */
export function pickHand(cards) {
  const byRank = new Map();
  cards.forEach((c, i) => { const r = c?.value?.rank ?? ""; byRank.set(r, [...(byRank.get(r) ?? []), i]); });
  const group = [...byRank.values()].sort((a, b) => b.length - a.length || RANKS.indexOf(cards[b[0]]?.value?.rank) - RANKS.indexOf(cards[a[0]]?.value?.rank))[0] ?? [];
  const rest = cards.map((c, i) => i).filter((i) => !group.includes(i)).sort((a, b) => RANKS.indexOf(cards[b]?.value?.rank) - RANKS.indexOf(cards[a]?.value?.rank));
  return [...group, ...rest].slice(0, 5).sort((a, b) => a - b);
}

export function createBot({ log = () => {} } = {}) {
  const maxAttempts = Number(process.env.AAS_BOT_BALATRO_ATTEMPTS || 1);
  let overs = 0;
  let pending = null; // what the last exec was
  return {
    next(result) {
      if (result?.error) { log(`error: ${result.error}`); if (pending === "state") return null; }
      const s = result && !result.error ? result : null;
      if (!s) { pending = "state"; return one("return await bal.state();", "read the state"); }
      if (s.won) return null;
      switch (s.state) {
        case "BLIND_SELECT": pending = "act"; return one("return await bal.select();", "play the blind");
        case "SELECTING_HAND": pending = "act"; return one(`return await bal.play(${JSON.stringify(pickHand(s.hand?.cards ?? []))});`, "play the largest group");
        case "ROUND_EVAL": pending = "act"; return one("return await bal.cashOut();", "cash out");
        case "SHOP": pending = "act"; return one("return await bal.nextRound();", "leave the shop");
        case "SMODS_BOOSTER_OPENED": pending = "act"; return one("return await bal.pack({ skip: true });", "skip the pack");
        case "GAME_OVER":
          overs += 1;
          if (overs > maxAttempts) return null;
          pending = "act"; return one("return await bal.restart();", "new run");
        default: pending = "state"; return one("return await bal.state();", `wait (${s.state})`);
      }
    },
  };
}
