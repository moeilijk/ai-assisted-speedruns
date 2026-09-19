#!/usr/bin/env node
// Builds a route for the scripted player out of the run log of a real run: the calls that run sent to the game, in
// the order it sent them. Nothing is written by hand, so a route can always be traced back to a run.
//
// Usage: node games/portal/extract-route.mjs <run dir> [--out routes/chamber01.json] [--segment 1] [--wait 58]
//
// What it leaves out or changes, and why:
//   * the screenshots the model took: a replay does not look, and they cost wall-clock time and no game time;
//   * the waits before the player first moves: they are the chamber's countdown, and the model waited longer than
//     the countdown takes. `--wait` sets how long that one wait is (58 s: the countdown of chamber 00 reads
//     00:00:00:00 and the portal opens at IGT 57.3, measured from the recording of portal-03 on 2026-09-19).
// Turns are never merged: one run with merged turns took another path (2026-09-19).
import fs from "node:fs";
import path from "node:path";
import { loadSettings } from "../../packages/core/src/settings.mjs";

// This game's own settings, then the machine's: the same two files every command reads (settings.mjs).
loadSettings(import.meta.url);

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const runDir = args[0];
if (!runDir) throw new Error("usage: node games/portal/extract-route.mjs <run dir> [--out <file>] [--segment 1] [--wait 58]");
const segment = Number(opt("--segment", 1));
const waitSeconds = Number(opt("--wait", 58));
const out = path.resolve(opt("--out", path.join(path.dirname(new URL(import.meta.url).pathname), "routes", "chamber01.json")));

const rows = fs.readFileSync(path.join(runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const starts = rows.map((r, i) => (r.event === "run.started" ? i : -1)).filter((i) => i >= 0);
const from = starts[segment - 1] ?? 0;
const to = starts[segment] ?? rows.length;
const slice = rows.slice(from, to);

const position = new Map();
for (const r of slice) if (r.kind === "tool_result") for (const o of r.output ?? []) if (o.type === "text") { try { const j = JSON.parse(o.text); if (j?.position) position.set(r.call, j.position); } catch { /* not a state */ } }

const steps = [];
for (const r of slice) {
  if (r.kind !== "tool_call" || !r.input?.code) continue;
  const code = String(r.input.code).replace(/\s*(?:return\s+)?await\s+portal\.screenshot\(\s*\);?/g, "").trim();
  if (!/portal\.(tas|look)/.test(code)) continue;
  steps.push({ call: r.call, code });
}

// The countdown: everything up to the call after which the player has moved.
const moved = (a, b) => a && b && (Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1 || Math.abs(a.z - b.z) > 1);
let first = 0, prev = null;
for (let i = 0; i < steps.length; i += 1) {
  const p = position.get(steps[i].call);
  if (moved(p, prev)) { first = i; break; }
  if (p) prev = p;
}
const waits = steps.slice(0, first).filter((s) => /\.wait\(/.test(s.code)).length;
const kept = steps.slice(0, first).filter((s) => !/\.wait\(/.test(s.code));
const countdown = { call: "countdown", code: `const t = portal.tas(); t.wait(portal.seconds(${waitSeconds})); const r = await t.run(); return r;` };
const route = {
  reaches: opt("--reaches", "chamber01"),
  source: { run: path.basename(runDir), segment, runtime: JSON.parse(fs.readFileSync(path.join(runDir, "brief.json"), "utf8")).runtime ?? null, started: slice[0]?.timestamp ?? null },
  built: { by: "games/portal/extract-route.mjs", screenshots: "left out", waitsBeforeFirstMove: `${waits} waits replaced by one of ${waitSeconds} s (the chamber countdown)`, turns: "never merged" },
  steps: [...kept, countdown, ...steps.slice(first)],
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(route, null, 2)}\n`);
console.log(`${route.steps.length} steps -> ${out} (from ${route.source.run} segment ${segment}; ${waits} waits before the first move became one of ${waitSeconds} s)`);
