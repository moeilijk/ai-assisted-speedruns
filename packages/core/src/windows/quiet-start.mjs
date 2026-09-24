// The per-machine options around a game start, shared by the game launchers (all off unless set in .env):
// AAS_KEEP_DISPLAYS_AWAKE=1 keeps the displays on, AAS_QUIET_AUDIO_DEVICE makes the quiet device the Windows default
// while the game opens its audio (audio-route.mjs). A quiet device that is a display's HDMI audio endpoint disappears
// while that display sleeps and comes back when it wakes, so it is waited for; without it the game would open its
// audio on the speakers, so the game is not started then.
//
//   const quiet = await beforeGameStart({ processName: "Balatro.exe", snapshotFile, log });
//   ...start the game, wait until it is up...
//   quiet.restore(); quiet.check();
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));

function tool(name, args, { processName, log }) {
  const r = spawnSync(process.execPath, [script(name), ...args], { encoding: "utf8", env: { ...process.env, AAS_AUDIO_PROCESS: processName } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (out) log(out.split("\n").map((l) => `${name.replace(".mjs", "")}: ${l}`).join("\n"));
  if (r.status !== 0) throw new Error(`${name} ${args[0] ?? ""} failed${out ? `: ${out.split("\n").at(-1)}` : ""}`);
}

// `route: "app"` is for a game that follows the Windows default when it changes and has no output setting of its own
// (FCEUX): the quiet device is set as the program's own output in Windows' per-app setting instead, once it runs
// (started()); clearAppRoute() undoes that when it has closed.
export async function beforeGameStart({ processName, snapshotFile, log = console.log, route = "default" } = {}) {
  const quiet = Boolean(process.env.AAS_QUIET_AUDIO_DEVICE);
  const run = (name, ...args) => tool(name, args, { processName, log });
  if (process.env.AAS_KEEP_DISPLAYS_AWAKE === "1") run("keep-display-awake.mjs", "start");
  if (quiet && route === "app") {
    // SoundVolumeView applies /SetAppDefault to a running process (measured 2026-09-24: set before FCEUX started, its
    // session opened on the speakers), so it is set once the game runs: call started() then, before it plays sound.
    return {
      started() { run("audio-route.mjs", "--set-app", "--process", processName); },
      restore() {},
      check() { run("audio-route.mjs", "--check", "--process", processName); },
    };
  }
  if (quiet) {
    run("audio-route.mjs", "--snapshot", snapshotFile);
    for (let attempt = 1; ; attempt += 1) {
      try { run("audio-route.mjs", "--set-quiet"); break; } catch (error) {
        if (attempt >= 6) throw new Error(`quiet audio device not available after 90 s; not starting the game (${error.message})`);
        log(`audio: quiet device not active yet (attempt ${attempt}/6); waiting 15 s`);
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
  }
  return {
    started() {},
    /** Puts the saved defaults back; call it once the game has its audio open (or has failed to start). */
    restore() { if (quiet) run("audio-route.mjs", "--restore", snapshotFile); },
    /** Reports where the game's audio session is; fails when it is not on the quiet device. */
    check() { run("audio-route.mjs", "--check", "--process", processName); },
  };
}

/** Undoes route "app": the program follows the Windows default again; returns its report line ("" when off). */
export function clearAppRoute(processName) {
  if (!process.env.AAS_QUIET_AUDIO_DEVICE) return "";
  const r = spawnSync(process.execPath, [script("audio-route.mjs"), "--clear-app", "--process", processName], { encoding: "utf8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
}

/** Ends the keep-awake helper a launcher may have started (a no-op when none runs); returns its report line. */
export function afterGameClose() {
  return (spawnSync(process.execPath, [script("keep-display-awake.mjs"), "stop"], { encoding: "utf8" }).stdout ?? "").trim();
}
