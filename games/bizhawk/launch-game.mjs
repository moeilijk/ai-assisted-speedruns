#!/usr/bin/env node
// Starts EmuHawk with the run's ROM and the bizhawk-mcp-native external tool loaded (`--open-ext-tool-dll`), and waits
// until the tool answers on 127.0.0.1:8767. An EmuHawk that already answers is left alone, so tests can run one after
// another against it. The first start ever asks whether to trust the tool: that answer is the person's (BizHawk keeps it).
// Env: AAS_BIZHAWK_DIR (install folder), AAS_BIZHAWK_ROM (the ROM of the run; a profile names which one it expects).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadSettings } from "../../packages/core/src/settings.mjs";
import { bizhawkDir, hostPath } from "./paths.mjs";
import { ping } from "./mcp.mjs";
import { trustState } from "./trust.mjs";
import { spawnSync } from "node:child_process";

loadSettings(import.meta.url);
const dir = bizhawkDir();
const exe = dir && path.join(dir, "EmuHawk.exe");
if (!exe || !fs.existsSync(exe)) throw new Error(`EmuHawk.exe not found in ${dir ?? "(no folder)"} (npm run bizhawk:install)`);
// A run never shows BizHawk's trust question: without the stored answer it does not start.
const trust = trustState(dir);
if (!trust.trusted) throw new Error(`${trust.detail}. Not starting: that question belongs to the set-up step, not to a run.`);
const { romPath, playableRom } = await import("./plugin.mjs");
const given = romPath();
if (!given || !fs.existsSync(given)) throw new Error(`the ROM is not there: ${given ?? "(none)"} (put it in .local/roms, or set AAS_BIZHAWK_ROM)`);
// A ROM in a zip is taken out of it (checked by the profile's SHA-1) into BizHawk's own folder: bizhawk-mcp-native
// cannot read the "archive|member" path BizHawk gives a ROM opened inside an archive (measured 2026-09-23).
const rom = playableRom(given, dir);

if (await ping()) {
  console.log("EmuHawk is already running with bizhawk-mcp-native.");
  process.exit(0);
}
// Optional, per machine (off by default): the game's sound on a quiet output (AAS_QUIET_AUDIO_DEVICE). BizHawk has its own
// setting for the output device (SoundDevice in its config.ini, the device's friendly name as Windows lists it), so the
// launcher sets that, while EmuHawk is closed, instead of switching the Windows default: EmuHawk follows the default
// device when it changes (measured 2026-09-23), so a switched default does not keep it on the quiet output.
const quietName = process.env.AAS_QUIET_AUDIO_DEVICE || null;
const soundDevice = quietName ? friendlyName(quietName) : "";
if (quietName && !soundDevice) throw new Error(`the quiet audio device "${quietName}" is not an active output device`);
// BizHawk mutes the sound while frames are advanced one call at a time (its own "Mute Frame Advance", on by default),
// and the plugin advances every frame that way: off, or the recording has no game sound (measured 2026-09-23: -91 dB).
// --chromeless is BizHawk's own option for a window without its menu and status bar, so the recording shows the game;
// BizHawk shows the status bar again when a game loads (MainForm.cs, 2.11.1) unless its own setting says no.
// BizHawk writes its own messages over the game (the first-boot invitation for 30 s, "Rewind started", saves): the
// recording shows the game and nothing the tools made, so its own "Display Messages" is off, and so is rewind, which a
// run does not use (its savestates are the harness's).
// BizHawk filters Left+Right and Up+Down pressed together (its own "Opposing directions" setting, Priority by default:
// only the latest one of the pair counts), and the filter sits on the input the Lua script gives, not on a movie's. A
// TAS presses both on purpose, so the setting is Allow (2) and the plugin's input reaches the game as a movie's does
// (measured 2026-09-23: 84 instead of 108 at frame 240 of TASVideos 3728M under Priority).
// A profile may name the core its game is played on (a TAS movie belongs to one core); BizHawk's own preference then says so.
const { PROFILE } = await import("./plugin.mjs");
setConfig(dir, { SoundDevice: soundDevice, MuteFrameAdvance: false, DispChromeStatusBarWindowed: false, DisplayMessages: false, FirstBoot: false, OpposingDirPolicy: 2 }, { Rewind: { Enabled: false }, ...(PROFILE?.core ? { PreferredCores: { [PROFILE.system]: PROFILE.core } } : {}) });
const child = spawn(exe, ["--open-ext-tool-dll=BizHawkMcp", "--chromeless", hostPath(rom)], { cwd: dir, detached: true, stdio: "ignore" });
child.unref();
console.log(`starting ${exe} with ${path.basename(rom)}${soundDevice ? `, sound on ${soundDevice}` : ""}`);
const deadline = Date.now() + 180000;
let up = false;
while (!up && Date.now() < deadline) { up = await ping(); if (!up) await new Promise((r) => setTimeout(r, 1000)); }
if (!up) throw new Error("EmuHawk did not answer within 3 minutes: the tool did not load.");
console.log("EmuHawk is up; bizhawk-mcp-native answers on 127.0.0.1:8767.");
if (quietName) {
  await new Promise((r) => setTimeout(r, 2000));
  const r = spawnSync(process.execPath, [path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../packages/core/src/windows/audio-route.mjs"), "--check", "--process", "EmuHawk.exe"], { encoding: "utf8", env: process.env });
  console.log(`audio: ${(r.stdout ?? "").trim().split("\n").at(-1)}`);
  if (r.status !== 0) throw new Error("EmuHawk's sound is not on the quiet device");
}

/** "BenQ GW2870 (NVIDIA High Definition Audio)": the name BizHawk matches an output device on. */
function friendlyName(name) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { listAll } from ${JSON.stringify(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../packages/core/src/windows/audio-route.mjs"))}; console.log(JSON.stringify(listAll()));`], { encoding: "utf8", env: process.env });
  const all = JSON.parse(r.stdout || "[]");
  const d = all.find((x) => x.Type === "Device" && x.Direction === "Render" && x["Device State"] === "Active" && x.Name === name);
  return d ? `${d.Name} (${d["Device Name"]})` : null;
}
/** BizHawk's own settings in its config.ini; written only while EmuHawk is closed, since it writes its config on exit. */
function setConfig(dir, values, nested = {}) {
  const file = path.join(dir, "config.ini");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const config = JSON.parse(text.replace(/^\uFEFF/, ""));
  const same = Object.entries(values).every(([k, v]) => config[k] === v) && Object.entries(nested).every(([k, o]) => Object.entries(o).every(([kk, v]) => config[k]?.[kk] === v));
  if (same) return;
  Object.assign(config, values);
  for (const [k, o] of Object.entries(nested)) config[k] = { ...(config[k] ?? {}), ...o };
  fs.writeFileSync(file, `${bom}${JSON.stringify(config, null, 2)}`);
}
