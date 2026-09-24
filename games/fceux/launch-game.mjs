#!/usr/bin/env node
// Starts FCEUX with the run's ROM and fceux-mcp's bridge (`-lua`, FCEUX's own option for a script at start), waits until
// the bridge answers on 127.0.0.1:9999, and plays a few frames so the window shows the game before the recording
// starts (a paused FCEUX that has not run a frame shows black, and the recorder rightly refuses black). The run then
// powers the game on again (prepareRun). A FCEUX that already answers is left alone, so tests can run one after
// another against it.
// Env: AAS_FCEUX_DIR (install folder), AAS_FCEUX_ROM (the ROM of the run; a profile names which one it expects).
// Optional, per machine (all off by default): AAS_FCEUX_WINDOW_POS (X,Y of FCEUX's window, e.g. on a secondary display,
// through FCEUX's own MainWindow_wndx/MainWindow_wndy), AAS_QUIET_AUDIO_DEVICE, AAS_KEEP_DISPLAYS_AWAKE=1.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSettings } from "../../packages/core/src/settings.mjs";
import { beforeGameStart } from "../../packages/core/src/windows/quiet-start.mjs";
import { fceuxDir, hostPath } from "./paths.mjs";
import { call, disconnect, ping } from "./bridge.mjs";

loadSettings(import.meta.url);
const dir = fceuxDir();
const exe = dir && path.join(dir, "fceux64.exe");
if (!exe || !fs.existsSync(exe)) throw new Error(`fceux64.exe not found in ${dir ?? "(no folder)"} (npm run fceux:install)`);
const bridge = path.join(dir, "fceux-mcp", "bridge.lua");
if (!fs.existsSync(bridge)) throw new Error(`fceux-mcp's bridge.lua not found in ${path.dirname(bridge)} (npm run fceux:install)`);
const { romPath } = await import("./plugin.mjs");
const rom = romPath();
// FCEUX shows a modal error window for a ROM it cannot open and then waits for someone to click it away (measured
// 2026-09-23 with emu.loadrom): the path is checked here, before FCEUX sees it.
if (!rom || !fs.existsSync(rom)) throw new Error(`the ROM is not there: ${rom ?? "(none)"} (put it in .local/roms, or set AAS_FCEUX_ROM)`);

if (await ping()) {
  console.log("FCEUX is already running with fceux-mcp's bridge.");
  disconnect();
  process.exit(0);
}

// FCEUX's own settings in fceux.cfg ("key value" lines), written while FCEUX is closed: it writes the whole file again
// when it exits (drivers/win/main.cpp, 2.6.6), so what is set here holds for this start.
// - eoptions: EO_BGRUN (1) keeps FCEUX running while its window has no focus (without it, window.cpp waits in
//   a loop until it gets focus back); EO_HIDEMENU (2048) hides the menu bar, so the recording shows the game.
// - goptions: GOO_CONFIRMEXIT (2) off, or closing FCEUX asks "Exit FCEUX?".
// - frame_display, rerecord_display, input_display, lagCounterDisplay, Show_FPS: FCEUX's counters over the game, off.
// - sicon: FCEUX's status icon over the game, a red pause sign whenever it is paused (drawing.cpp
//   FCEU_DrawRecordingStatus), which is between every two moves of the agent (seen in the recording 2026-09-23), off.
// - newppu 0 and dendy 0: the NTSC NES the profiles' movies were made on (FCEUX's defaults, written so a changed
//   setting does not carry over).
// FCEUX has no setting on Windows for its other messages over the game ("Power on", "Reset"): vidGuiMsgEna is on and
// only the Qt build can change it (src/video.cpp, drivers/Qt/config.cpp).
setConfig(path.join(dir, "fceux.cfg"), {
  // The key as FCEUX writes it: NAC("eoptions", …) in drivers/win/config.cpp puts the quotes in the name.
  '"eoptions"': (v) => ((v ?? 1261569) | 1 | 2048),
  goptions: (v) => ((v ?? 1) & ~2),
  '"sicon"': 0,
  frame_display: 0, rerecord_display: 0, input_display: 0, lagCounterDisplay: 0, Show_FPS: 0, newppu: 0, dendy: 0,
  ...windowPos(process.env.AAS_FCEUX_WINDOW_POS),
});

// The per-machine options (off unless set in .env): the quiet audio device, displays awake. FCEUX has no setting of its
// own for the output device (it always opens the Windows default, OutputDS.cpp) and follows the default when it changes
// (measured 2026-09-23: after the default was switched back for its start, its session was on the speakers), so the
// quiet device is set as FCEUX's own output in Windows' per-app setting (route "app") once it runs and before it plays
// a frame; close-game.mjs clears it.
const quiet = await beforeGameStart({ processName: "fceux64.exe", snapshotFile: path.join(os.tmpdir(), `aas-fceux-audio-${process.pid}.json`), route: "app" });
// The bridge's methods the agent never needs are switched off for this session (the agent reaches the bridge only
// through the plugin; this is the second fence): Lua code, memory writes, loading another ROM, the in-memory savestates.
const env = { ...process.env, FCEUX_BRIDGE_DISABLE: "lua.exec,memory.writebyte,emu.loadrom,savestate.save,savestate.load" };
env.WSLENV = [process.env.WSLENV, "FCEUX_BRIDGE_DISABLE"].filter(Boolean).join(":");
const child = spawn(exe, ["-lua", hostPath(bridge), hostPath(rom)], { cwd: dir, detached: true, stdio: "ignore", env });
child.unref();
console.log(`starting ${exe} with ${path.basename(rom)}`);
let up = false;
try {
  const deadline = Date.now() + 60000;
  while (!up && Date.now() < deadline) { up = await ping(); if (!up) await new Promise((r) => setTimeout(r, 500)); }
  if (!up) throw new Error("FCEUX's bridge did not answer within 60 s");
  quiet.started();
  // A picture for the recorder's check: two seconds of the game from power-on, nothing pressed.
  await call("emu.step", { frames: 120 });
} finally {
  quiet.restore();
}
if (process.env.AAS_QUIET_AUDIO_DEVICE) quiet.check();
console.log("FCEUX is up; fceux-mcp's bridge answers on 127.0.0.1:9999.");
disconnect();

/** AAS_FCEUX_WINDOW_POS ("X,Y") as FCEUX's own window position; nothing when unset. */
function windowPos(pos) {
  if (!pos) return {};
  const [x, y] = pos.split(",").map((v) => Number(v.trim()));
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error(`AAS_FCEUX_WINDOW_POS=${pos}: expected X,Y in pixels`);
  return { MainWindow_wndx: x, MainWindow_wndy: y };
}

/** FCEUX's own settings in fceux.cfg: a value, or a function of the current value (undefined when not in the file). */
function setConfig(file, values) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^(\S+) (.*)$/);
    if (!m || !(m[1] in values)) return line;
    seen.add(m[1]);
    const v = values[m[1]];
    return `${m[1]} ${typeof v === "function" ? v(Number(m[2])) : v}`;
  });
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) out.push(`${k} ${typeof v === "function" ? v(undefined) : v}`);
  const text = `${out.filter((l) => l !== "").join("\n")}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return;
  fs.writeFileSync(file, text);
}
