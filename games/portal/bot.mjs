// A scripted player for the "scripted" runtime: the end-to-end test of the Portal chain (TAS playback -> IGT ->
// chamber milestones -> recording -> publish) without a model and without tokens.
//
// It is not a route of its own: it replays the calls an AI run really sent to the game, in the order it sent them.
// routes/chamber01.json is taken from the run log of that run (its `source` names which), so what a mock run plays
// is what was played before, not something written here. The route in that file reaches chamber 01, which the
// chamber tracker of games/portal/chambers.mjs finds in the same log.
//
// `AAS_BOT_PORTAL_STEPS` stops earlier than the end of the route, for a short test; unset it plays the whole route.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The recorded route a goal needs. Only chamber01 is recorded; a longer goal plays it and stops where it ends. */
export function loadRoute(name = "chamber01") {
  return JSON.parse(readFileSync(join(here, "routes", `${name}.json`), "utf8"));
}

export function createBot({ log = () => {} } = {}) {
  const route = loadRoute();
  const limit = Number(process.env.AAS_BOT_PORTAL_STEPS || 0) || route.steps.length;
  const steps = route.steps.slice(0, limit);
  log(`replaying ${steps.length} of ${route.steps.length} recorded calls from ${route.source.run} (segment ${route.source.segment}), which reached ${route.reaches}`);
  let n = 0;
  return {
    next(result) {
      if (result?.error) log(`error: ${result.error}`);
      if (n >= steps.length) return null;
      const step = steps[n];
      n += 1;
      return { code: step.code, note: `${route.source.run} ${step.call}` };
    },
  };
}
