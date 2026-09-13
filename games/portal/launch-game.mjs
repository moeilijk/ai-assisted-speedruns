#!/usr/bin/env node
// Start Portal from the Source Unpack the way Portal.bat does, but with an
// explicit window size and position so the borderless window fits the
// primary display (Portal.bat leaves the size to the engine, which may pick
// a resolution larger than the screen). Waits until SPT's IPC port answers.
//
// Usage: node games/portal/launch-game.mjs [--game-root <dir>] [--size 1920x1080] [--pos X,Y]
// Env: AAS_PORTAL_GAME_ROOT, AAS_PORTAL_RESOLUTION (WxH, default 1920x1080), AAS_PORTAL_SPT_PORT.
// Optional, per machine (all off by default): AAS_PORTAL_WINDOW_POS (X,Y; a secondary display
// keeps the run off the desktop you work on), AAS_QUIET_AUDIO_DEVICE + AAS_SOUNDVOLUMEVIEW
// (game audio away from the speakers while it starts), AAS_KEEP_DISPLAYS_AWAKE=1.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ensureSteam } from "./steam.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const root = path.resolve(opt("--game-root", process.env.AAS_PORTAL_GAME_ROOT ?? ""));
const [w, h] = opt("--size", process.env.AAS_PORTAL_RESOLUTION ?? "1920x1080").split("x").map(Number);
const pos = opt("--pos", process.env.AAS_PORTAL_WINDOW_POS || null);
const [x, y] = pos ? pos.split(",").map(Number) : [null, null];
const port = Number(process.env.AAS_PORTAL_SPT_PORT ?? 27182);
const exe = path.join(root, "hl2.exe");
if (!fs.existsSync(exe)) throw new Error(`hl2.exe not found at ${exe}; set AAS_PORTAL_GAME_ROOT to the Source Unpack folder.`);
fs.writeFileSync(path.join(root, "steam_appid.txt"), "400\n");

const probe = () => new Promise((res) => { const s = net.connect(port, "127.0.0.1"); s.setTimeout(2000); s.on("connect", () => (s.destroy(), res(true))); s.on("error", () => res(false)); s.on("timeout", () => (s.destroy(), res(false))); });
if (await probe()) {
  console.log(`Portal is already running (SPT IPC on ${port}).`);
  process.exit(0);
}
// +snd_mute_losefocus 0: the Source engine mutes itself when its window loses
// focus; on a secondary display without focus the recording would be silent.
console.log(`steam: ${await ensureSteam({ log: console.log })}`);
// Optional quiet audio: the Windows default is the quiet device while the game opens its audio device, then restored.
const quiet = Boolean(process.env.AAS_QUIET_AUDIO_DEVICE);
const audioRoute = new URL("./audio-route.mjs", import.meta.url).pathname;
const snapshot = path.join(root, "aas-audio-defaults.json");
const audio = (...a) => { const r = spawnSync(process.execPath, [audioRoute, ...a], { encoding: "utf8" }); const out = (r.stdout + r.stderr).trim(); console.log(out.split("\n").map((l) => `audio: ${l}`).join("\n")); if (r.status !== 0) throw new Error(`audio routing failed: ${out}`); };
if (quiet) audio("--snapshot", snapshot); else audio("--check");
// Optional: keep the displays awake (an HDMI audio endpoint vanishes while its display sleeps); stop-all ends this.
if (process.env.AAS_KEEP_DISPLAYS_AWAKE === "1") console.log(spawnSync(process.execPath, [new URL("./keep-display-awake.mjs", import.meta.url).pathname, "start"], { encoding: "utf8" }).stdout.trim());
// A quiet device that is an HDMI audio endpoint disappears while that display sleeps and comes
// back when it wakes, so wait for it instead of failing at once. Without it the game would open
// its audio on the speakers the user wanted to keep quiet, so the game is not started at all then.
for (let attempt = 1; quiet; attempt += 1) {
  try { audio("--set-quiet"); break; } catch (error) {
    if (attempt >= 6) throw new Error(`quiet audio device not available after 90 s; not starting the game (${error.message.split("\n").at(-1)})`);
    console.log(`audio: quiet device not active yet (attempt ${attempt}/6); waiting 15 s`);
    await new Promise((r) => setTimeout(r, 15000));
  }
}
const gameArgs = ["-game", "portal", "-novid", "-console", "-noborder", "-window", "-high", "-w", String(w), "-h", String(h), ...(pos ? ["-x", String(x), "-y", String(y)] : []), "+snd_mute_losefocus", "0"];
console.log(`starting ${exe} ${gameArgs.join(" ")}`);
const child = spawn(exe, gameArgs, { cwd: root, detached: true, stdio: "ignore" });
child.on("error", (e) => { throw new Error(`could not start hl2.exe: ${e.message}`); });
child.unref();
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  if (await probe()) {
    console.log(`Portal is up; SPT IPC listening on ${port} (autoexec ran exec portal_agent).`);
    if (quiet) audio("--restore", snapshot);
    audio("--check");
    process.exit(0);
  }
}
if (quiet) audio("--restore", snapshot);
throw new Error("Portal started but SPT IPC did not come up within 120 s. Check the game console for plugin_print and y_spt_ipc 1.");
