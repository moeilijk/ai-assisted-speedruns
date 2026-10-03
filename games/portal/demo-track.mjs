#!/usr/bin/env node
// The player's position per tick from a Source demo (.dem, demo protocol 3 as
// written by Portal's speedrun_demorecord): the exact ground truth for chamber
// progress and in-game time, independent of the agent's own observations.
//   node games/portal/demo-track.mjs <run-dir | demo folder | file.dem ...>
// prints every chamber entry with its tick and in-game time.
import fs from "node:fs";
import path from "node:path";
import { createChamberTracker } from "./chambers.mjs";
import { loadSettings } from "../../packages/core/src/settings.mjs";

/**
 * `partial`: the demo is still being recorded, so its last frame may be cut off; parsing stops there instead of failing.
 */
export function parseDemo(file, { partial = false } = {}) {
  const d = fs.readFileSync(file);
  if (d.length < 1072 || d.subarray(0, 8).toString("latin1") !== "HL2DEMO\0") throw new Error(`${file}: not a Source demo`);
  const demoProtocol = d.readInt32LE(8);
  const map = d.subarray(536, 796).toString("latin1").split("\0")[0];
  const samples = [];
  let pos = 1072;
  const fits = (n) => pos + n <= d.length;
  const block = (skip) => { if (!fits(skip + 4)) return false; pos += skip; const size = d.readInt32LE(pos); pos += 4; if (!fits(size)) return false; pos += size; return true; };
  while (pos < d.length) {
    const cmd = d[pos]; pos += 1;
    if (cmd === 7) break; // stop (the file may end right after it)
    if (!fits(4)) { if (partial) break; throw new Error(`${file}: cut off at ${pos}`); }
    const tick = d.readInt32LE(pos); pos += 4;
    let whole = true;
    if (cmd === 1 || cmd === 2) { // signon / packet: cmdinfo (76 bytes: flags + 6 vectors), sequences, size, data
      if (!fits(76 + 8 + 4)) whole = false;
      else {
        const x = d.readFloatLE(pos + 4), y = d.readFloatLE(pos + 8), z = d.readFloatLE(pos + 12);
        whole = block(76 + 8);
        if (whole && (x || y || z)) samples.push({ tick, x, y, z });
      }
    } else if (cmd === 3) {} // synctick
    else if (cmd === 4 || cmd === 6 || cmd === 8) whole = block(0); // consolecmd, datatables, stringtables
    else if (cmd === 5) whole = block(4); // usercmd
    else if (partial) break;
    else throw new Error(`${file}: unknown demo command ${cmd} at ${pos - 5}`);
    if (!whole) { if (partial) break; throw new Error(`${file}: cut off at ${pos}`); }
  }
  return { file, map, demoProtocol, samples, ticks: samples.length ? samples.at(-1).tick - samples[0].tick : 0 };
}

/**
 * Follows the demos of the run being recorded in `dir` (portal-agent's agent_runs/<time>/): `read(map)` gives the
 * positions per tick of `map` not given before. The engine writes a demo in blocks of 64 KiB (measured 2026-10-02
 * 19:26-19:27: the file grew by 65536 bytes about every 5 s of play), so the last seconds of a playback come at a
 * later read. A demo of another map waits until the run is in that map; a demo that no longer grows and is not the
 * newest is not read again.
 */
export function createDemoFollower(dir) {
  const state = new Map(); // file -> { tick, size, done }
  return {
    read(map) {
      if (!dir || !fs.existsSync(dir)) return [];
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".dem")).map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
      const out = [];
      for (const file of files) {
        const st = state.get(file) ?? { tick: -Infinity, size: -1, done: false };
        if (st.done) continue;
        const size = fs.statSync(file).size;
        if (size === st.size) { if (file !== files.at(-1)) st.done = true; continue; }
        let demo;
        try { demo = parseDemo(file, { partial: true }); } catch { continue; } // its header is not written yet
        if (demo.map !== map) continue;
        for (const s of demo.samples) if (s.tick > st.tick) { out.push(s); st.tick = s.tick; }
        st.size = size;
        state.set(file, st);
      }
      return out;
    },
  };
}

/** Demo files of a run in recording order (name order within a folder). */
export function demoFiles(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return [target];
  const runDemos = path.join(target, "demos");
  const dir = fs.existsSync(runDemos) ? runDemos : target;
  return fs.readdirSync(dir).filter((f) => f.endsWith(".dem")).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

/** Chamber entries over one or more demos: [{ chamber, map, tick, igt }], igt in seconds of played ticks so far. */
export function chamberEntries(files, { tracker = createChamberTracker() } = {}) {
  const entries = [];
  let played = 0;
  let lastMap = null;
  for (const file of files) {
    const demo = parseDemo(file);
    if (demo.map !== lastMap) {
      const entered = lastMap === null && demo.map === tracker.map ? tracker.chamber ?? tracker.enterMap(demo.map) : tracker.enterMap(demo.map);
      if (entered && !entries.some((e) => e.chamber === entered)) entries.push({ chamber: entered, map: demo.map, tick: demo.samples[0]?.tick ?? 0, igt: played, file: path.basename(file) });
      lastMap = demo.map;
    }
    const t0 = demo.samples[0]?.tick ?? 0;
    for (const s of demo.samples) {
      const entered = tracker.observe(s);
      if (entered) entries.push({ chamber: entered, map: demo.map, tick: s.tick, igt: played + (s.tick - t0) * 0.015, file: path.basename(file) });
    }
    played += demo.ticks * 0.015;
  }
  return { entries, played };
}

if (process.argv[1]?.endsWith("demo-track.mjs")) {
  // This game's own settings, then the machine's: the same two files every command reads (settings.mjs). Only as a
  // command: the plugin imports this file inside the broker, which may not read them.
  loadSettings(import.meta.url);
  const files = process.argv.slice(2).flatMap(demoFiles);
  if (!files.length) throw new Error("no .dem files");
  const { entries, played } = chamberEntries(files);
  const hms = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  for (const f of files) { const d = parseDemo(f); console.log(`${path.basename(f)}: map ${d.map}, ${d.samples.length} samples, ${(d.ticks * 0.015).toFixed(1)} s`); }
  console.log(`played ${hms(played)}; chamber entries:`);
  for (const e of entries) console.log(`  ${e.chamber.padEnd(4)} at IGT ${hms(e.igt)} (tick ${e.tick}, ${e.map}, ${e.file})`);
}
