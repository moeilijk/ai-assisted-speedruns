// The GUI fake's scripted player: looks once, takes two steps, and is done (the run ends as stopped, so it can be continued).
export function createBot() {
  let n = 0;
  return { next() { n += 1; if (n === 1) return { code: "return await game.observe()", note: "look" }; if (n > 3) return null; return { code: "return await game.act()", note: `step ${n}` }; } };
}
