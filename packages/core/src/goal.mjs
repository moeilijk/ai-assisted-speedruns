// The goal of a run is one of the game's ends. The game plugin defines the ends (`ends`: ordered, each with the
// milestone split that marks it, one of them `final`: the game's own end); the harness owns the logic: no goal
// means the game's own end, `--goal` picks an earlier or alternative end from the list, and the run is complete
// when the milestone of that end goes by. The plugin never knows the goal. A resume may move the goal to a later
// end only (the earlier victory then no longer ends the attempt), recorded as `run.human` and `game.goal`.

export function endsOf(plugin) {
  return Array.isArray(plugin?.ends) && plugin.ends.length ? plugin.ends : null;
}

/** The game's own end: the entry marked `final`, else the last one; games without `ends` keep their category goal. */
export function defaultGoal(plugin) {
  const ends = endsOf(plugin);
  if (!ends) return plugin?.category?.goal ?? "";
  return (ends.find((e) => e.final) ?? ends.at(-1)).id;
}

/** `{ id, end }` for a requested goal (or the default), checked against the game's ends. */
export function resolveGoal(plugin, goal) {
  const ends = endsOf(plugin);
  const id = goal || defaultGoal(plugin);
  if (!ends) return { id, end: null };
  const end = ends.find((e) => e.id === id);
  if (!end) throw new Error(`Unknown goal "${id}" for ${plugin.id}; its ends are ${ends.map((e) => e.id).join(", ")} (no goal = ${defaultGoal(plugin)}, the game's own end).`);
  return { id, end };
}

/** Whether a `game.milestone` event marks this end. The plugin's own victory milestone (`victory: true`) is left to its `game.over`. */
export function goalReached(end, event) {
  if (!end || event?.event !== "game.milestone" || event.data?.victory) return false;
  return event.data?.end === end.id || (Boolean(end.split) && event.data?.split === end.split);
}

/** Whether `to` comes after `from` in the game's ends (a resume may only extend the goal). */
export function laterGoal(plugin, from, to) {
  const ends = endsOf(plugin);
  if (!ends) return false;
  const a = ends.findIndex((e) => e.id === from), b = ends.findIndex((e) => e.id === to);
  return a >= 0 && b > a;
}
