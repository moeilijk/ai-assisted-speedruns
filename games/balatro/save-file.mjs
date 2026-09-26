// The game's own save: %AppData%/Balatro/<profile>/save.jkr, deflate-compressed Lua (`return {...}`, as the game's
// STR_PACK writes it), the file the Continue button loads. The run's saves are copies of it, taken once it describes
// the state balatrobot reports: the game writes it a moment after each change (measured: up to about two seconds).
// balatrobot's own `save` is not used: it rebuilds the save at the moment it is called, a moment the game itself
// never saves at. In the cash-out screen the game has already cleared the blind (Blind:defeat), so such a save loaded
// back gave the hands money and not the blind reward.
import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/** G.STATES of the game, as balatrobot names them. */
export const STATES = {
  SELECTING_HAND: 1, HAND_PLAYED: 2, DRAW_TO_HAND: 3, GAME_OVER: 4, SHOP: 5, PLAY_TAROT: 6, BLIND_SELECT: 7, ROUND_EVAL: 8,
  TAROT_PACK: 9, PLANET_PACK: 10, MENU: 11, TUTORIAL: 12, SPLASH: 13, SANDBOX: 14, SPECTRAL_PACK: 15, DEMO_CTA: 16,
  STANDARD_PACK: 17, BUFFOON_PACK: 18, NEW_ROUND: 19,
};

/** How long saveState waits for the game's file to describe the reported state. */
export const SAVE_WAIT_MS = Number(process.env.AAS_BALATRO_SAVE_WAIT_MS) || 8000;

/** The save file of the profile slot the runs use (AAS_BALATRO_PROFILE, default 3); AAS_BALATRO_SAVE_FILE names another file. */
export function profileSaveFile() {
  if (process.env.AAS_BALATRO_SAVE_FILE) return path.resolve(process.env.AAS_BALATRO_SAVE_FILE);
  const profile = Number(process.env.AAS_BALATRO_PROFILE || 3);
  const text = (cmd, args) => (spawnSync(cmd, args, { encoding: "utf8", cwd: "/mnt/c" }).stdout ?? "").trim();
  const appData = text("wslpath", ["-u", text("cmd.exe", ["/c", "echo %APPDATA%"])]);
  if (!appData) throw new Error("cannot find %APPDATA%, where the game keeps its save");
  return path.join(appData, "Balatro", String(profile), "save.jkr");
}

/** A Lua table literal as STR_PACK writes it (`return {["k"]=v,[1]=v,...}`; strings quoted with %q) as an object. */
export function parseLuaTable(text) {
  let i = text.indexOf("{");
  if (i < 0) throw new Error("not a Lua table");
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  const expect = (c) => { ws(); if (text[i] !== c) throw new Error(`'${c}' expected at ${i}`); i += 1; };
  const string = () => {
    let out = "";
    i += 1;
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') return out;
      if (c !== "\\") { out += c; continue; }
      const e = text[i++];
      if (e === "n") out += "\n";
      else if (e === "r") out += "\r";
      else if (e === "t") out += "\t";
      else if (/\d/.test(e)) { const m = text.slice(i - 1, i + 2).match(/^\d{1,3}/)[0]; out += String.fromCharCode(Number(m)); i += m.length - 1; }
      else out += e; // \" \\ and a backslash before a newline
    }
    throw new Error("unterminated string");
  };
  const value = () => {
    ws();
    if (text[i] === "{") return table();
    if (text[i] === '"') return string();
    let j = i;
    while (j < text.length && !/[,}]/.test(text[j])) j += 1;
    const raw = text.slice(i, j).trim();
    i = j;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "nil") return null;
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  };
  const table = () => {
    expect("{");
    const t = {};
    for (;;) {
      ws();
      if (text[i] === "}") { i += 1; return t; }
      expect("[");
      ws();
      let key;
      if (text[i] === '"') key = string();
      else { const j = text.indexOf("]", i); key = Number(text.slice(i, j)); i = j; }
      expect("]");
      expect("=");
      t[key] = value();
      ws();
      if (text[i] === ",") i += 1;
    }
  };
  return table();
}

/** The fields of a save that say which moment of the run it holds. */
export function describeSave(t) {
  const g = t.GAME ?? {};
  return {
    state: t.STATE ?? null, round: g.round ?? null, ante: g.round_resets?.ante ?? null,
    hands_left: g.current_round?.hands_left ?? null, discards_left: g.current_round?.discards_left ?? null,
    dollars: g.dollars ?? null, blind_dollars: t.BLIND?.dollars ?? null,
  };
}

/** The same fields from balatrobot's gamestate. A state balatrobot names that the game's list does not have is null. */
export function describeGamestate(s) {
  return {
    state: STATES[s?.state] ?? null, round: s?.round_num ?? null, ante: s?.ante_num ?? null,
    hands_left: s?.round?.hands_left ?? null, discards_left: s?.round?.discards_left ?? null, dollars: s?.money ?? null,
  };
}

/** True when the save holds every field the gamestate reports (a field the gamestate lacks is not compared). */
export function sameMoment(saved, reported) {
  return Object.entries(reported).every(([k, v]) => v === null || v === undefined || saved[k] === v);
}

export function readSave(file) {
  return describeSave(parseLuaTable(inflateRawSync(readFileSync(file)).toString("latin1")));
}

const fmt = (d) => (d ? `state ${d.state ?? "?"}, round ${d.round ?? "?"}, ante ${d.ante ?? "?"}, ${d.hands_left ?? "?"} hands, ${d.discards_left ?? "?"} discards, $${d.dollars ?? "?"}` : "nothing readable");

/** Resolves once `file` describes `reported` (polling), with how long that took; rejects after `waitMs` saying what each side holds. */
export async function waitForSave(file, reported, { waitMs = SAVE_WAIT_MS, pollMs = 100 } = {}) {
  const t0 = Date.now();
  let saved = null;
  let problem = null;
  for (;;) {
    try { saved = readSave(file); problem = null; if (sameMoment(saved, reported)) return { saved, waited: Date.now() - t0 }; } catch (e) { problem = e; }
    if (Date.now() - t0 >= waitMs) {
      const has = problem ? (problem.code === "ENOENT" ? "there is no save file" : `the save file cannot be read (${problem.message})`) : `the save file holds ${fmt(saved)}`;
      throw new Error(`the game has not saved this state after ${(waitMs / 1000).toFixed(1)} s: balatrobot reports ${fmt(reported)}; ${has} (${file})`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
