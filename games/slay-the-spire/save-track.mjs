#!/usr/bin/env node
// Ground truth for a Slay the Spire run: the game's own saves and run history.
// The harness copies the game's autosave into <run>/saves/ at every save
// (milestone, interval, end); endRun copies the run-history file the game
// writes when a run ends into <run>/history/. Both carry the game's own floor,
// act, path per floor and its run clock (`play_time`, seconds the run was open,
// thinking included). This tool decodes them and puts them next to the harness's
// timeline (IGT = the game's processing time per command, from run.jsonl), so the
// splits and the IGT model can be checked against what the game recorded.
// Nothing here is published: saves contain the player's profile name.
//
//   node games/slay-the-spire/save-track.mjs <run-dir>
import fs from "node:fs";
import path from "node:path";
import { loadSettings } from "../../packages/core/src/settings.mjs";

// This game's own settings, then the machine's: the same two files every command reads (settings.mjs).
loadSettings(import.meta.url);

const XOR_KEY = Buffer.from("key");
/** The game obfuscates saves as base64 of the JSON XORed with "key"; run-history files are plain JSON. */
export function decodeSave(file) {
  const raw = fs.readFileSync(file);
  const text = raw.toString("utf8").trim();
  if (text.startsWith("{")) return JSON.parse(text);
  const bytes = Buffer.from(text, "base64");
  const plain = Buffer.from(bytes.map((b, i) => b ^ XOR_KEY[i % XOR_KEY.length]));
  return JSON.parse(plain.toString("utf8"));
}
/** The fields that matter for verification; the profile name and everything else stay out. */
export function saveSummary(d) {
  const num = (v) => (typeof v === "number" ? v : null);
  return {
    seed: d.seed ?? d.seed_played ?? null,
    ascension: num(d.ascension_level),
    floor: num(d.floor_num ?? d.floor_reached),
    act: num(d.act_num),
    level: d.level_name ?? null,
    boss: d.boss ?? null,
    playTime: num(d.play_time ?? d.playtime),
    floorReached: num(d.metric_floor_reached ?? d.floor_reached),
    pathPerFloor: d.metric_path_per_floor ?? d.path_per_floor ?? [],
    pathTaken: d.metric_path_taken ?? d.path_taken ?? [],
    hp: num(d.current_health),
    maxHp: num(d.max_health),
    hpPerFloor: d.metric_current_hp_per_floor ?? d.current_hp_per_floor ?? [],
    damageTaken: (d.metric_damage_taken ?? d.damage_taken ?? []).map((x) => ({ floor: x.floor, enemies: x.enemies, damage: x.damage, turns: x.turns })),
    savedAt: typeof d.save_date === "number" ? new Date(d.save_date) : typeof d.timestamp === "number" ? new Date(d.timestamp * 1000) : null,
    victory: typeof d.victory === "boolean" ? d.victory : null,
    killedBy: d.killed_by ?? null,
  };
}
export function saveFiles(runDir) {
  const dir = path.join(runDir, "saves");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".autosave")).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}
export function historyFiles(runDir) {
  const dir = path.join(runDir, "history");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".run")).map((f) => path.join(dir, f)).sort();
}
/** Harness view from run.jsonl: cumulative IGT at every save and the act splits it reported. */
export function harnessTrack(runDir) {
  const file = path.join(runDir, "run.jsonl");
  const saves = [], splits = [];
  let igt = 0, floor = null, act = null;
  if (!fs.existsSync(file)) return { saves, splits, igt };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.kind !== "event") continue;
    if (e.event === "game.playback" && e.data?.phase === "end") { igt += e.data.seconds ?? 0; if (typeof e.data.floor === "number") floor = e.data.floor; if (typeof e.data.act === "number") act = e.data.act; }
    if (e.event === "game.milestone" && e.data?.chapter) splits.push({ label: e.data.label, split: e.data.split, floor: e.data.floor, at: e.timestamp, igt });
    if (e.event === "game.saved") saves.push({ name: e.data.name, reason: e.data.reason, file: e.data.file, at: e.timestamp, igt, floor, act });
  }
  return { saves, splits, igt };
}
const hms = (s) => { if (s == null) return "?"; const t = Math.round(s); return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };
const local = (d) => (d ? d.toLocaleTimeString("en-GB", { hour12: false }) : "?");

if (process.argv[1]?.endsWith("save-track.mjs")) {
  const runDir = process.argv[2];
  if (!runDir) throw new Error("usage: save-track.mjs <run-dir>");
  const harness = harnessTrack(runDir);
  console.log(`saves in ${path.join(runDir, "saves")}: ${saveFiles(runDir).length}; harness IGT total ${hms(harness.igt)} (${harness.igt.toFixed(1)} s)`);
  for (const f of saveFiles(runDir)) {
    const s = saveSummary(decodeSave(f));
    const h = harness.saves.find((x) => x.file && path.basename(x.file) === path.basename(f));
    console.log(`  ${path.basename(f).padEnd(28)} game: ${local(s.savedAt)} floor ${s.floor} act ${s.act} ${s.level ?? ""} hp ${s.hp}/${s.maxHp} clock ${hms(s.playTime)} path ${s.pathPerFloor.join("")}` + (h ? ` | harness: ${h.reason}, floor ${h.floor} act ${h.act}, IGT ${hms(h.igt)}` : " | harness: no game.saved event"));
  }
  for (const f of historyFiles(runDir)) {
    const s = saveSummary(decodeSave(f));
    console.log(`history ${path.basename(f)}: seed ${s.seed}, ${s.victory ? "victory" : `defeat${s.killedBy ? ` by ${s.killedBy}` : ""}`} at floor ${s.floorReached}, clock ${hms(s.playTime)}, path ${s.pathPerFloor.join("")}`);
    const bosses = s.pathPerFloor.map((p, i) => (p === "BOSS" ? i + 1 : null)).filter(Boolean);
    if (bosses.length) console.log(`  boss floors per the game: ${bosses.join(", ")}`);
  }
  if (harness.splits.length) console.log(`harness splits: ${harness.splits.map((s) => `${s.split ?? s.label} at floor ${s.floor}, IGT ${hms(s.igt)}`).join("; ")}`);
}
