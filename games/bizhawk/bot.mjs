// The scripted player of the "scripted" runtime for BizHawk. It plays what the profile names under `bot`:
// - `movie`: a published TAS movie (.bk2, in .local/tas, made by `npm run bizhawk:tas`), its own input replayed frame by
//   frame through the same buttons the agent has, from power-on, for `frames` frames; the movie is credited in the
//   profile's `tas`;
// - `steps`: a few inputs of the profile's own (the test profile: the game's auto-solver).
// It never gives the agent a way to play a movie: a mock plays the published input as button presses.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILE } from "./plugin.mjs";
import { bizhawkDir } from "./paths.mjs";
import { readZipEntry } from "../../packages/core/src/zip-read.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHUNK = 600; // frames per exec call

/** The movie's input, one list of pressed buttons per frame (player 1, and Reset/Power where the movie has them). */
export function movieFrames(file) {
  const log = readZipEntry(file, "Input Log.txt");
  if (!log) throw new Error(`${file} is not a BizHawk movie (no Input Log.txt)`);
  const lines = log.toString("utf8").split(/\r?\n/);
  const key = lines.find((l) => l.startsWith("LogKey:"));
  if (!key) throw new Error(`${file} has no LogKey`);
  // "#Reset|Power|#P1 Up|…|#P2 Up|…": groups start with "#"; each group is one |…| field of the log, one character per button.
  const groups = key.slice("LogKey:".length).split("#").filter(Boolean).map((g) => g.split("|").filter(Boolean));
  const out = [];
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const fields = line.split("|").slice(1, -1);
    const pressed = [];
    groups.forEach((names, gi) => {
      const f = fields[gi] ?? "";
      names.forEach((name, i) => {
        if (f[i] && f[i] !== ".") {
          if (name.startsWith("P1 ")) pressed.push(name.slice(3));
          else if (name === "Reset" || name === "Power") pressed.push(name);
        }
      });
    });
    out.push(pressed);
  }
  return out;
}

/** Consecutive frames with the same buttons as one step: { buttons, frames }. */
export function steps(frames) {
  const out = [];
  for (const b of frames) {
    const last = out.at(-1);
    if (last && last.buttons.join("+") === b.join("+")) last.frames += 1;
    else out.push({ buttons: b, frames: 1 });
  }
  return out;
}

export function createBot({ log = () => {} } = {}) {
  const b = PROFILE?.bot ?? {};
  const calls = [];
  if (b.movie) {
    const file = path.join(REPO, ".local", "tas", b.movie);
    // A movie replays only on the core it was made or imported for: the mock refuses to start on another one.
    const header = readZipEntry(file, "Header.txt")?.toString("utf8") ?? "";
    const movieCore = header.match(/^Core (.+)$/m)?.[1]?.trim() ?? null;
    let core = null;
    try { core = JSON.parse(fs.readFileSync(path.join(bizhawkDir(), "config.ini"), "utf8").replace(/^\uFEFF/, "")).PreferredCores?.[PROFILE.system] ?? null; } catch { /* no config */ }
    if (movieCore && core !== movieCore) throw new Error(`the movie was made on ${movieCore}, but BizHawk plays ${PROFILE.system} on ${core ?? "an unknown core"}: set "core": "${movieCore}" in the profile and start the game again`);
    const frames = movieFrames(file).slice(0, b.frames ?? Infinity);
    let chunk = [];
    let n = 0;
    for (const s of steps(frames)) {
      let left = s.frames;
      while (left > 0) {
        const take = Math.min(left, CHUNK - n);
        chunk.push({ buttons: s.buttons, frames: take });
        n += take; left -= take;
        if (n === CHUNK) { calls.push(chunk); chunk = []; n = 0; }
      }
    }
    if (chunk.length) calls.push(chunk);
    log(`${PROFILE.id}: ${frames.length} frames of ${b.movie} in ${calls.length} calls`);
  } else {
    for (const s of b.steps ?? []) calls.push([{ buttons: Object.keys(s.buttons ?? {}).filter((k) => s.buttons[k]), frames: s.frames ?? 1 }]);
  }
  let i = 0;
  return {
    next(result) {
      if (result?.error) log(`call ${i} failed: ${result.error}`);
      // The game (or the run's goal) has reached its end: the plugin takes no more input.
      if (i >= calls.length || /reached its end/.test(result?.error ?? "")) return null;
      const c = calls[i++];
      const code = c.length === 1
        ? (c[0].buttons.length ? `return await emu.press(${JSON.stringify(c[0].buttons)}, ${c[0].frames})` : `return await emu.wait(${c[0].frames})`)
        : `return await emu.sequence(${JSON.stringify(c)})`;
      return { code, note: `${PROFILE.id} ${i}/${calls.length}` };
    },
  };
}
