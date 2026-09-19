#!/usr/bin/env node
// How often is a seed actually won? The deciding criterion for an AI seed (seed-criteria.md, criterion 9).
//
// Every playout is a whole run by gamerpuppy's sts_lightspeed search agent (lightspeed/aas.cpp, `aas playout`):
// RNG-accurate tree search inside every fight, the simulator's own policy outside it. That policy picks card
// rewards at weighted random from an expert rating table and never skips a card, so each agent RNG gives a
// different run: good tactics with a mediocre draft, which is the situation an LLM is in. The share of playouts
// that reach the act 3 victory is therefore a measure of how forgiving a seed is, and it is the only criterion
// that looks at the whole run instead of the map on paper.
//
//   node games/slay-the-spire/seed-winrate.mjs <seeds.txt|CODE...> [--playouts 8] [--sims 50000] [--jobs 8]
//                                              [--out <dir>] [--ascension 0] [--timeout 180] [--neow <0..3>]
//
// A playout takes about 20 seconds at 50000 simulations, but on some seeds the agent never finishes (measured
// eight of a thousand playouts still running after two hours, burning a core each and starving the
// queue), so every playout gets --timeout seconds. A timed-out playout counts as a run that was not won and is
// reported separately.
//
// --neow forces Neow's choice (the simulator's own `aas playout ... <neowOption>`): the agent may otherwise take
// "obtain a random rare Card", and the rare card the simulator rolls is not the one the game gives, which makes the
// whole plan unreplayable from floor 1 (, measured: on 23M: the plan wanted Bludgeon, the game had given
// another card). Neow's Lament adds no card and cannot diverge.
//
// A seeds file holds one seed code per line (anything after the code is ignored). --out keeps the decision line
// of every won playout there (<code>-<rng>.jsonl), which is the plan the scripted bot can replay (AAS_BOT_LINE).
// The binary comes from AAS_STS_PLAYOUT or .local/sts_lightspeed/build/aas (lightspeed/build.sh builds it).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedNumber } from "./plugin.mjs";
import { loadSettings } from "../../packages/core/src/settings.mjs";

// This game's own settings, then the machine's: the same two files every command reads (settings.mjs).
loadSettings(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.AAS_STS_PLAYOUT || path.resolve(here, "../../.local/sts_lightspeed/build/aas");

/** One whole-run playout; resolves { code, rng, won, floor, hp, line }. */
export function playout({ bin = BIN, code, seed, rng, sims, ascension = 0, out, timeoutMs = 180000, neow = null }) {
  const line = out ? path.join(out, `${code}-${rng}.jsonl`) : path.join(os.tmpdir(), `aas-playout-${process.pid}-${rng}.jsonl`);
  return new Promise((resolve) => {
    execFile(bin, ["playout", String(seed), String(ascension), String(sims), String(rng), line, ...(neow === null ? [] : [String(neow)])], { maxBuffer: 1 << 20, timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout) => {
      const timedOut = err?.killed === true;
      const text = `${stdout || ""}${err && !stdout ? String(err.message) : ""}`.trim();
      const m = /^(victory|defeat) at floor (\d+) hp (-?\d+)/.exec(text);
      const won = m?.[1] === "victory";
      if (!out || !won) { try { fs.unlinkSync(line); } catch {} }
      resolve({ code, rng, won, timedOut, floor: Number(m?.[2] ?? -1), hp: Number(m?.[3] ?? -1), line: won && out ? line : null, text });
    });
  });
}

/** Run `playouts` playouts for every seed over `jobs` workers, calling onResult as they come in. */
export async function winRates(seeds, { playouts = 8, sims = 50000, jobs = os.cpus().length, ascension = 0, out = null, timeoutMs = 180000, neow = null, onResult = () => {} } = {}) {
  if (out) fs.mkdirSync(out, { recursive: true });
  const queue = seeds.flatMap((s) => Array.from({ length: playouts }, (_, i) => ({ ...s, rng: i + 1 })));
  const tally = new Map(seeds.map((s) => [s.code, { code: s.code, seed: s.seed, wins: 0, runs: 0, timeouts: 0, floors: [], hps: [] }]));
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const job = queue[next++];
      const r = await playout({ ...job, sims, ascension, out, timeoutMs, neow });
      const t = tally.get(job.code);
      t.runs += 1;
      if (r.timedOut) t.timeouts += 1; else t.floors.push(r.floor);
      if (r.won) { t.wins += 1; t.hps.push(r.hp); }
      onResult(r, t);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  return [...tally.values()].sort((a, b) => b.wins / b.runs - a.wins / a.runs || b.runs - a.runs);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };
  const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!positional.length) { console.error("usage: seed-winrate.mjs <seeds.txt|CODE...> [--playouts 8] [--sims 50000] [--jobs 8] [--out dir] [--ascension 0]"); process.exit(2); }
  const codes = positional.length === 1 && fs.existsSync(positional[0])
    ? fs.readFileSync(positional[0], "utf8").split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
    : positional;
  const seeds = codes.map((code) => ({ code, seed: seedNumber(code).toString() }));
  const playouts = Number(opt("playouts", 8)), sims = Number(opt("sims", 50000)), jobs = Number(opt("jobs", os.cpus().length));
  const out = opt("out", null), ascension = Number(opt("ascension", 0)), timeoutMs = Number(opt("timeout", 180)) * 1000;
  const neow = opt("neow", null) === null ? null : Number(opt("neow", null));
  console.error(`${seeds.length} seed(s) x ${playouts} playouts, ${sims} simulations per fight, ${jobs} workers`);
  let done = 0;
  const rows = await winRates(seeds, { playouts, sims, jobs, ascension, out, timeoutMs, neow, onResult: (r) => {
    done += 1;
    if (r.won || r.timedOut || done % 25 === 0) console.error(`  ${done}/${seeds.length * playouts}  ${r.code} rng ${r.rng}: ${r.timedOut ? "TIMEOUT" : r.won ? `VICTORY hp ${r.hp}` : `floor ${r.floor}`}`);
  } });
  console.log("wins/runs  rate   seed        avg floor  avg win hp  timeouts");
  for (const t of rows) {
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    console.log(`${String(t.wins).padStart(5)}/${String(t.runs).padEnd(4)} ${(100 * t.wins / t.runs).toFixed(0).padStart(3)}%   ${t.code.padEnd(14)} ${avg(t.floors).toFixed(1).padStart(5)}      ${avg(t.hps).toFixed(0).padStart(3)}     ${String(t.timeouts).padStart(5)}`);
  }
}
