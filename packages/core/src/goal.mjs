// The goal of a run is one of the game's ends. The game plugin defines the ends (`ends`: ordered, each with the
// milestone split that marks it, one of them `final`: the game's own end); the harness owns the logic: no goal
// means the game's own end, `--goal` picks an earlier or alternative end from the list, and the run is complete
// when the milestone of that end goes by. The plugin never knows the goal. A resume may move the goal to a later
// end only (the earlier victory then no longer ends the attempt), recorded as `run.human` and `game.goal`.

/**
 * The game's ends, checked: every game plugin declares them (at least its own end), each with an `id` and a `label`,
 * exactly one `final`. The core has no per-game fallback, so goals, their labels and their history work the same for
 * every game.
 */
export function endsOf(plugin) {
  const ends = plugin?.ends;
  const who = plugin?.id ?? "the game plugin";
  if (!Array.isArray(ends) || !ends.length) throw new Error(`${who} declares no ends: every game plugin lists its ends ({ id, label, final }), at least the game's own end.`);
  for (const e of ends) {
    if (typeof e?.id !== "string" || !e.id) throw new Error(`${who}: every end needs an id`);
    if (typeof e.label !== "string" || !e.label) throw new Error(`${who}: end "${e.id}" needs a label`);
  }
  if (ends.filter((e) => e.final).length !== 1) throw new Error(`${who}: exactly one end is final (the game's own end)`);
  return ends;
}

/** An end as a bundle carries it: `{ id, label, final }`. */
export const publicEnd = (end) => ({ id: end.id, label: end.label, final: end.final === true });

/** The game's own end: the entry marked `final`. */
export function defaultGoal(plugin) {
  return endsOf(plugin).find((e) => e.final).id;
}

/**
 * The game's shortest end: the first one the plugin lists. This is what a run no model plays aims at (owner,
 * 2026-09-19): a mock run is a test of the machine, and playing on to the game's own end proves nothing the first
 * end did not, while it costs the whole game's running time.
 */
export function lowestGoal(plugin) {
  return endsOf(plugin)[0].id;
}

/**
 * `{ id, end }` for a requested goal, checked against the game's ends. Without one the goal follows who plays:
 * the game's own end for a model, the game's first end for anything else. `ai` is the runtime plugin's own
 * declaration, the same one that decides whether a bundle is a mock (SPEC §3).
 */
export function resolveGoal(plugin, goal, { ai = true } = {}) {
  const ends = endsOf(plugin);
  const fallback = ai === true ? defaultGoal(plugin) : lowestGoal(plugin);
  const id = goal || fallback;
  const end = ends.find((e) => e.id === id);
  if (!end) throw new Error(`Unknown goal "${id}" for ${plugin.id}; its ends are ${ends.map((e) => e.id).join(", ")} (no goal = ${fallback}, ${ai === true ? "the game's own end" : "the game's first end, because no model plays this run"}).`);
  return { id, end };
}

/**
 * Every goal the run had, in order, from its own events: the goal at the first `run.started` (older logs without
 * `data.goal`: the `from` of the first `game.goal`, else `current`), then each `game.goal` extension. Each entry is
 * `{ id, declared_at, reached_at }`; a goal is reached by the first victory (`game.over` with `victory`) while it held.
 */
export function goalHistory(events, current) {
  const firstChange = events.find((e) => e.event === "game.goal");
  const goals = [];
  let now = null;
  for (const e of events) {
    if (e.event === "run.started" && !now) {
      now = { id: e.data?.goal ?? firstChange?.data?.from ?? current, declared_at: e.timestamp, reached_at: null };
      goals.push(now);
    } else if (e.event === "game.goal") {
      if (!now) goals.push({ id: e.data?.from ?? current, declared_at: null, reached_at: null });
      now = { id: e.data?.to, declared_at: e.timestamp, reached_at: null };
      goals.push(now);
    } else if (e.event === "game.over" && e.data?.victory === true && now && !now.reached_at) {
      now.reached_at = e.timestamp;
    }
  }
  return goals;
}

/** Whether a `game.milestone` event marks this end. The plugin's own victory milestone (`victory: true`) is left to its `game.over`. */
export function goalReached(end, event) {
  if (!end || event?.event !== "game.milestone" || event.data?.victory) return false;
  return event.data?.end === end.id || (Boolean(end.split) && event.data?.split === end.split);
}

/** Whether `to` comes after `from` in the game's ends (a resume may only extend the goal). */
export function laterGoal(plugin, from, to) {
  const ends = endsOf(plugin);
  const a = ends.findIndex((e) => e.id === from), b = ends.findIndex((e) => e.id === to);
  return a >= 0 && b > a;
}
