#!/usr/bin/env node
// Keep the game's sound off the user's speakers: a game opens its audio device at startup and keeps it (the
// Source engine's DirectSound does not follow later changes; Balatro's audio session stayed on the quiet device
// after the default was restored, measured 2026-09-17), so the Windows default playback device is switched to a
// quiet output for the seconds the game starts, then restored exactly. OBS's
// application audio capture reads the process, not the speakers.
// Uses NirSoft SoundVolumeView (portable). Optional, per machine: nothing here
// runs unless AAS_QUIET_AUDIO_DEVICE names an active playback device (a monitor's
// HDMI output, a virtual cable); by default the game plays on the default device
// and only the recording captures it.
//
//   node packages/core/src/windows/audio-route.mjs --check --process <exe>  report defaults and the game's audio sessions
//   node packages/core/src/windows/audio-route.mjs --snapshot <file>       save the current defaults
//   node packages/core/src/windows/audio-route.mjs --set-quiet             make the quiet device the default (all roles)
//   node packages/core/src/windows/audio-route.mjs --restore <file>        restore the saved defaults
// Env: AAS_QUIET_AUDIO_DEVICE (device name; unset = feature off), AAS_SOUNDVOLUMEVIEW (path to
// SoundVolumeView.exe, required when the device is set); --process <exe> or AAS_AUDIO_PROCESS (the game's executable, for the session report)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
export const DEVICE = opt("--device", process.env.AAS_QUIET_AUDIO_DEVICE || null);
export const CONFIGURED = Boolean(DEVICE); // quiet routing is off unless a device is named
export const PROCESS = opt("--process", process.env.AAS_AUDIO_PROCESS ?? null); // the game's executable name
const svv = process.env.AAS_SOUNDVOLUMEVIEW ?? null;
export const NOT_CONFIGURED = "no quiet audio device configured (AAS_QUIET_AUDIO_DEVICE unset): the game uses the default playback device";
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') q = false; else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() ?? [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

export function listAll() {
  if (!CONFIGURED) throw new Error(NOT_CONFIGURED);
  if (!svv) throw new Error("AAS_SOUNDVOLUMEVIEW is not set: path to NirSoft SoundVolumeView.exe, needed to switch the default playback device");
  if (!fs.existsSync(svv)) throw new Error(`SoundVolumeView not found at ${svv} (AAS_SOUNDVOLUMEVIEW)`);
  const csv = path.join(os.tmpdir(), `svv-${process.pid}.csv`);
  const winCsv = execFileSync("wslpath", ["-w", csv], { encoding: "utf8" }).trim();
  spawnSync(svv, ["/scomma", winCsv], { stdio: "ignore" });
  for (let i = 0; i < 40 && !fs.existsSync(csv); i += 1) sleep(250);
  sleep(300);
  const text = fs.readFileSync(csv, "utf8").replace(/^﻿/, "");
  fs.rmSync(csv, { force: true });
  return parseCsv(text);
}
const renderDevices = (rows) => rows.filter((r) => r.Type === "Device" && r.Direction === "Render" && r["Device State"] === "Active");
export function defaults(rows = listAll()) {
  const d = renderDevices(rows);
  const pick = (col) => d.find((r) => r[col] === "Render");
  return {
    console: pick("Default")?.["Item ID"] ?? null,
    multimedia: pick("Default Multimedia")?.["Item ID"] ?? null,
    communications: pick("Default Communications")?.["Item ID"] ?? null,
    names: { console: pick("Default")?.Name, multimedia: pick("Default Multimedia")?.Name, communications: pick("Default Communications")?.Name },
  };
}
export function quietDevice(rows = listAll()) {
  return renderDevices(rows).find((r) => r.Name === DEVICE) ?? null;
}
// Only the session the game currently holds; SoundVolumeView also lists stale
// (Inactive) entries from earlier launches on every device the game ever used.
export function gameSessions(rows = listAll(), processName = PROCESS) {
  if (!processName) return [];
  return rows
    .filter((r) => r.Type === "Application" && (r["Process Path"] ?? "").toLowerCase().endsWith(`\\${processName.toLowerCase()}`) && r["Device State"] === "Active")
    .map((r) => ({ deviceId: (r["Item ID"] ?? "").split("|")[0], device: r["Device Name"] }));
}
export function setDefault(itemId, role /* 0 console, 1 multimedia, 2 communications, all */) {
  spawnSync(svv, ["/SetDefault", itemId, String(role)], { stdio: "ignore" });
}
export function audioStatus({ processName = PROCESS } = {}) {
  const rows = listAll();
  const q = quietDevice(rows);
  const d = defaults(rows);
  const sessions = gameSessions(rows, processName);
  const gameOnQuiet = sessions.length > 0 && sessions.every((s) => s.deviceId === q?.["Item ID"]);
  return {
    ok: Boolean(q),
    quiet: q,
    defaults: d,
    sessions,
    gameOnQuiet,
    detail: `quiet device "${DEVICE}": ${q ? "active" : "NOT FOUND"}; defaults: play=${d.names.console ?? "?"}, media=${d.names.multimedia ?? "?"}, comms=${d.names.communications ?? "?"}; ${processName ?? "(no game named)"} active audio session on: ${sessions.length ? sessions.map((s) => `${s.device} (${s.deviceId === q?.["Item ID"] ? DEVICE : "NOT the quiet device"})`).join(", ") : "none (game silent or not running)"}`,
  };
}

if (process.argv[1]?.endsWith("audio-route.mjs")) {
  if (!CONFIGURED) {
    // Without a quiet device every subcommand is a no-op that says so; --set-quiet is the one
    // callers must not rely on, so it fails.
    console.log(NOT_CONFIGURED);
    if (args.includes("--set-quiet")) process.exitCode = 1;
  } else if (args.includes("--snapshot")) {
    const d = defaults();
    fs.writeFileSync(opt("--snapshot"), JSON.stringify(d, null, 2));
    console.log(`saved defaults: play=${d.names.console}, media=${d.names.multimedia}, comms=${d.names.communications}`);
  } else if (args.includes("--set-quiet")) {
    const q = quietDevice();
    if (!q) throw new Error(`quiet device "${DEVICE}" not active`);
    setDefault(q["Item ID"], "all");
    sleep(1500);
    const d = defaults();
    console.log(`default now: play=${d.names.console}, media=${d.names.multimedia}, comms=${d.names.communications}`);
    if (d.names.console !== DEVICE) throw new Error("default device did not switch");
  } else if (args.includes("--restore")) {
    const d = JSON.parse(fs.readFileSync(opt("--restore"), "utf8"));
    if (d.console) setDefault(d.console, 0);
    if (d.multimedia) setDefault(d.multimedia, 1);
    if (d.communications) setDefault(d.communications, 2);
    sleep(1500);
    const now = defaults();
    const ok = now.console === d.console && now.multimedia === d.multimedia && now.communications === d.communications;
    console.log(`restored: play=${now.names.console}, media=${now.names.multimedia}, comms=${now.names.communications} -> ${ok ? "matches the snapshot" : "MISMATCH"}`);
    if (!ok) process.exitCode = 1;
  } else {
    const st = audioStatus();
    console.log(st.detail);
    if (args.includes("--check")) process.exitCode = st.ok && (st.sessions.length === 0 || st.gameOnQuiet) ? 0 : 1;
  }
}
