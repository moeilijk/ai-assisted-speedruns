// The scripted player of the "scripted" runtime for BizHawk: it plays the inputs the profile names under `bot`, one
// `bizhawk_exec` call per step, and stops when they are done. For a test profile that is the game's own means (nes15:
// its auto-solver); for a showcase game it will be a published TAS movie, credited in the profile.
import { PROFILE } from "./plugin.mjs";

export function createBot({ log = () => {} } = {}) {
  const steps = PROFILE?.bot?.steps ?? [];
  let i = 0;
  return {
    next(result) {
      if (result?.error) log(`step ${i} failed: ${result.error}`);
      if (i >= steps.length) return null;
      const s = steps[i++];
      const buttons = Object.keys(s.buttons ?? {}).filter((b) => s.buttons[b]);
      const code = buttons.length ? `return await emu.press(${JSON.stringify(buttons)}, ${s.frames ?? 1})` : `return await emu.wait(${s.frames ?? 1})`;
      return { code, note: `${PROFILE.id} step ${i}/${steps.length}: ${buttons.length ? buttons.join("+") : "wait"} ${s.frames ?? 1} frames` };
    },
  };
}
