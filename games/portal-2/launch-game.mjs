#!/usr/bin/env node
// Start Portal 2 with SourceAutoRecord loaded and its TAS protocol server open, and wait until that port answers.
//
// SAR is not loaded by being in the folder: the game loads it from the console (`plugin_load sar`, SAR's own setup
// page). install-mod.mjs writes games/portal-2's own config next to the game and this launcher runs it with
// `+exec aas_portal2`, so the game's autoexec.cfg stays the player's own file.
//
// Usage: node games/portal-2/launch-game.mjs [--game-root <dir>] [--size 1920x1080] [--pos X,Y]
// Env: AAS_PORTAL2_GAME_ROOT, AAS_PORTAL2_RESOLUTION (WxH, default 1920x1080), AAS_PORTAL2_PORT (default 6555).
// Optional, per machine (all off by default): AAS_PORTAL2_WINDOW_POS (X,Y), AAS_QUIET_AUDIO_DEVICE +
// AAS_SOUNDVOLUMEVIEW, AAS_KEEP_DISPLAYS_AWAKE=1.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ensureSteam } from "../../packages/core/src/windows/steam.mjs";
import { beforeGameStart } from "../../packages/core/src/windows/quiet-start.mjs";
import { moveWindow } from "../../packages/core/src/windows/move-window.mjs";
import { CONFIG_NAME } from "./install-mod.mjs";
import { loadSettings } from "../../packages/core/src/settings.mjs";

// This game's own settings, then the machine's: the same two files every command reads (settings.mjs).
loadSettings(import.meta.url);

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const root = path.resolve(opt("--game-root", process.env.AAS_PORTAL2_GAME_ROOT ?? ""));
const [w, h] = opt("--size", process.env.AAS_PORTAL2_RESOLUTION ?? "1920x1080").split("x").map(Number);
const pos = opt("--pos", process.env.AAS_PORTAL2_WINDOW_POS || null);
const [x, y] = pos ? pos.split(",").map(Number) : [null, null];
const port = Number(process.env.AAS_PORTAL2_PORT ?? 6555);
const exe = path.join(root, "portal2.exe");
if (!fs.existsSync(exe)) throw new Error(`portal2.exe not found at ${exe}; set AAS_PORTAL2_GAME_ROOT to the Portal 2 folder.`);
const cfg = path.join(root, "portal2", "cfg", `${CONFIG_NAME}.cfg`);
if (!fs.existsSync(cfg)) throw new Error(`${cfg} is missing; run games/portal-2/install-mod.mjs first (it puts SAR and this config next to the game).`);

const probe = () => new Promise((res) => { const s = net.connect(port, "127.0.0.1"); s.setTimeout(2000); s.on("connect", () => (s.destroy(), res(true))); s.on("error", () => res(false)); s.on("timeout", () => (s.destroy(), res(false))); });
if (await probe()) {
  console.log(`Portal 2 is already running (SAR's protocol server on ${port}).`);
  process.exit(0);
}
console.log(`steam: ${await ensureSteam({ log: console.log })}`);
const quiet = await beforeGameStart({ processName: "portal2.exe", snapshotFile: path.join(root, "aas-audio-defaults.json") });
// +snd_mute_losefocus 0: the Source engine mutes itself without focus, which would make the recording silent.
// -condebug: the engine writes portal2/console.log, which is where the plugin reads the map a run is in from
// (games/portal-2/maps.mjs; SAR's TAS protocol names the map once and never again).
const gameArgs = ["-novid", "-console", "-condebug", "-noborder", "-window", "-w", String(w), "-h", String(h), ...(pos ? ["-x", String(x), "-y", String(y)] : []), "+snd_mute_losefocus", "0", "+exec", CONFIG_NAME];
console.log(`starting ${exe} ${gameArgs.join(" ")}`);
const child = spawn(exe, gameArgs, { cwd: root, detached: true, stdio: "ignore" });
child.on("error", (e) => { throw new Error(`could not start portal2.exe: ${e.message}`); });
child.unref();
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  if (await probe()) {
    console.log(`Portal 2 is up; SAR's TAS protocol server listening on ${port}.`);
    // The Source engine centres its window on the primary display whatever -x/-y says (measured on Portal, 2026-09-19).
    if (pos) moveWindow({ processName: "portal2", pos, log: console.log });
    quiet.restore();
    quiet.check();
    process.exit(0);
  }
}
quiet.restore();
throw new Error(`Portal 2 started but nothing answers on ${port} within 180 s. Open the console and check that "plugin_load sar" printed SAR's version and that "sar_tas_protocol_server ${port}" ran (games/portal-2/README.md).`);
