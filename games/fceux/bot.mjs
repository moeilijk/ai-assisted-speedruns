// The scripted player of the "scripted" runtime for FCEUX. It plays what the profile names under `bot`:
// - `movie`: a published TAS movie (.fm2, in .local/tas, made ready by `npm run fceux:tas`), its own input replayed
//   frame by frame through the same buttons the agent has, from power-on, the movie's reset command included; the
//   movie is credited in the profile's `tas`;
// - `steps`: a few inputs of the profile's own (the test profile: the game's auto-solver).
// It never gives the agent a way to play a movie: a mock plays the published input as button presses.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILE } from "./plugin.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHUNK = 600; // frames per exec call

/**
 * The movie's input, one list of pressed buttons per frame (controller 1), with "Reset" on a frame whose command
 * field asks for a soft reset. FM2 input lines are |commands|RLDUTSBA|…|| (FCEUX's fm2 format, documentation/fm2.txt).
 */
export function movieFrames(file) {
  const names = ["Right", "Left", "Down", "Up", "Start", "Select", "B", "A"];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const [, cmd, pad = ""] = line.split("|");
    const pressed = [];
    if (Number(cmd) & 1) pressed.push("Reset");
    if (Number(cmd) & 2) throw new Error(`${file}: a power command at frame ${out.length}; the mock plays from power-on and has no power button`);
    [...pad].forEach((c, i) => { if (c !== "." && c !== " " && names[i]) pressed.push(names[i]); });
    out.push(pressed);
  }
  return out;
}

/** Consecutive frames with the same buttons as one step: { buttons, frames }; a reset frame is a step of its own. */
export function steps(frames) {
  const out = [];
  for (const b of frames) {
    const last = out.at(-1);
    if (last && !b.includes("Reset") && !last.buttons.includes("Reset") && last.buttons.join("+") === b.join("+")) last.frames += 1;
    else out.push({ buttons: b, frames: 1 });
  }
  return out;
}

export function createBot({ log = () => {} } = {}) {
  const b = PROFILE?.bot ?? {};
  const calls = [];
  if (b.movie) {
    const file = path.join(REPO, ".local", "tas", b.movie);
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
