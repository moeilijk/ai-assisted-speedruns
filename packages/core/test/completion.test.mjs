// completed_at is the game.over with victory: true (SPEC §6), whatever runtime played. Each runtime brings its own
// exporter, and two of them (Codex, Mistral Vibe) knew only the agent's completion marker: a Codex run that won
// published completed_at null and an archive read it as a run that did not reach its goal (balatro-codex-01,
// 2026-10-16). The harness saw the victory itself and writes it after any exporter, so no runtime can leave it out.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTimeline } from "../src/timeline-build.mjs";

const T0 = "2026-10-16T02:05:48.781+02:00";
const VICTORY = "2026-10-16T02:08:13.144+02:00";

function runWith(events, exported) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aas-completion-"));
  const runDir = path.join(root, "run");
  const outDir = path.join(root, "out");
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(runDir, "run.jsonl"), events.map((e) => JSON.stringify({ kind: "event", source: "harness", ...e })).join("\n") + "\n");
  // A runtime's exporter as a runtime might write one: here, one that leaves completed_at as it finds it.
  const exportSession = async (_session, out) => {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify({ started_at: T0, ...exported }));
    fs.writeFileSync(path.join(out, "session.sanitized.jsonl"), `${JSON.stringify({ sequence: 1, timestamp: T0, elapsed_seconds: 0, kind: "message", role: "user", text: "Play." })}\n`);
  };
  return { runDir, outDir, exportSession, summary: () => JSON.parse(fs.readFileSync(path.join(outDir, "summary.json"), "utf8")) };
}
const brief = { category: { goal: "ante1" } };
const started = { event: "run.started", timestamp: T0, data: { goal: "ante1" } };
const won = { event: "game.over", timestamp: VICTORY, data: { victory: true, goal: "ante1", reached_at: VICTORY } };

test("a run that won is completed at its victory even when the runtime's exporter wrote no completion", async () => {
  const r = runWith([started, won], { completed_at: null, elapsed_to_completion_seconds: null });
  await buildTimeline({ runDir: r.runDir, outDir: r.outDir, brief, exportSession: r.exportSession, session: "private.jsonl", log() {} });
  const s = r.summary();
  assert.equal(s.completed_at, VICTORY);
  assert.equal(s.elapsed_to_completion_seconds, Math.round((Date.parse(VICTORY) - Date.parse(T0)) / 1000));
});

test("the victory decides over a completion the agent claimed in its own words", async () => {
  const r = runWith([started, won], { completed_at: "2026-10-16T02:08:20.000+02:00", elapsed_to_completion_seconds: 151 });
  await buildTimeline({ runDir: r.runDir, outDir: r.outDir, brief, exportSession: r.exportSession, session: "private.jsonl", log() {} });
  assert.equal(r.summary().completed_at, VICTORY);
});

test("a run with no victory keeps what its exporter found: the harness does not invent a completion", async () => {
  const died = { event: "game.over", timestamp: VICTORY, data: { victory: false, label: "Game over" } };
  const r = runWith([started, died], { completed_at: null, elapsed_to_completion_seconds: null });
  await buildTimeline({ runDir: r.runDir, outDir: r.outDir, brief, exportSession: r.exportSession, session: "private.jsonl", log() {} });
  assert.equal(r.summary().completed_at, null);
});
