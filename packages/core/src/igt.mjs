// The in-game time one playback took, the same way for the timer, the timeline and a resume: the plugin's own
// `seconds` first (it knows its game's tick rate: Portal 2 runs at 60 ticks a second), else `ticks` at Source's 15 ms.
// No imports, so the timer plugin can take it as it is.

/** Seconds of game time in a `game.playback` end's data, to the millisecond; 0 when it says neither. */
export function playbackSeconds(data) {
  if (typeof data?.seconds === "number" && Number.isFinite(data.seconds)) return Math.round(data.seconds * 1000) / 1000;
  if (typeof data?.ticks === "number" && Number.isFinite(data.ticks)) return Math.round(data.ticks * 15) / 1000;
  return 0;
}
