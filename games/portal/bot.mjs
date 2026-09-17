// A scripted player for the "scripted" runtime: the end-to-end test of the Portal chain (TAS playback -> IGT ->
// chamber milestones -> recording -> publish) without a model and without tokens. It is not a route: it looks around
// and walks the first chamber's own path for a while, then stops. `AAS_BOT_PORTAL_STEPS` (default 8) sets how many
// playbacks it does.
const one = (code, note) => ({ code, note });

export function createBot({ log = () => {} } = {}) {
  const steps = Number(process.env.AAS_BOT_PORTAL_STEPS || 8);
  let n = 0;
  return {
    next(result) {
      if (result?.error) log(`error: ${result.error}`);
      n += 1;
      if (n === 1) return one("return await portal.observe(['facing', 'position']);", "where are we");
      if (n > steps) return null;
      // Every playback is a `game.playback` for the timeline: a short hold of the keys, with a look in between.
      const turn = n % 3 === 0 ? ", { right: 15 }" : n % 3 === 1 ? ", { left: 15 }" : "";
      return one(`const t = portal.tas(); t.hold(33, { forward: true }${turn}); const r = await t.run({ screenshot: false }); return { ticks: r.ticks, position: r.position };`, `walk ${n - 1}`);
    },
  };
}
