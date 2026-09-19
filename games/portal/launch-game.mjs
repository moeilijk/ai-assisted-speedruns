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
import { ensureSteam } from "../../packages/core/src/windows/steam.mjs";
import { beforeGameStart } from "../../packages/core/src/windows/quiet-start.mjs";
import { moveWindow } from "../../packages/core/src/windows/move-window.mjs";
import { loadSettings } from "../../packages/core/src/settings.mjs";

// This game's own settings, then the machine's: the same two files every command reads (settings.mjs).
loadSettings(import.meta.url);

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
// Optional quiet audio (the Windows default is the quiet device while the game opens its audio device, then
// restored) and displays kept awake; stop-all ends the latter.
const quiet = await beforeGameStart({ processName: "hl2.exe", snapshotFile: path.join(root, "aas-audio-defaults.json") });
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
    // The engine centres its window on the primary display whatever -x/-y says (measured 2026-09-19), so the window
    // is moved here, the way Slay the Spire's launcher does it.
    if (pos) moveWindow({ processName: "hl2", pos, log: console.log });
    quiet.restore();
    quiet.check();
    process.exit(0);
  }
}
quiet.restore();
throw new Error("Portal started but SPT IPC did not come up within 120 s. Check the game console for plugin_print and y_spt_ipc 1.");
