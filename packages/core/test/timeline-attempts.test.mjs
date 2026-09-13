// A session with a death and a restart: the timeline lists the runs (attempts), sections get an
// "Attempt 2" boundary, and `attempt: "last"` keeps only the last run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeTimeline } from "../src/timeline.mjs";

test("attempts in the timeline and the cut of the last run", () => {
  const runDir = mkdtempSync(join(tmpdir(), "aas-attempts-"));
  const t0 = Date.parse("2026-09-11T10:00:00.000Z");
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const pb = (i, s, e, extra = {}) => [
    { timestamp: at(s), kind: "event", event: "game.playback", data: { phase: "start", index: i, command: extra.command ?? "END" } },
    { timestamp: at(e), kind: "event", event: "game.playback", data: { phase: "end", index: i, seconds: e - s, command: extra.command ?? "END" } },
  ];
  const rows = [
    { timestamp: at(0), kind: "event", event: "run.started", data: {} },
    { timestamp: at(1), kind: "event", event: "game.ready", data: { seed: "1044066542771276695", seed_code: "ATGY4CVU47AK" } },
    ...pb(1, 2, 3), ...pb(2, 10, 11),
    { timestamp: at(11), kind: "event", event: "game.milestone", data: { label: "Death 1", chapter: false } },
    { timestamp: at(11), kind: "event", event: "game.over", data: { victory: false, label: "Defeat", floor: 6, deaths: 1 } },
    ...pb(3, 20, 24, { command: "RESTART" }), // thinking 9 s, then the restart: card from 11 s
    { timestamp: at(24), kind: "event", event: "game.attempt", data: { phase: "start", attempt: 2, seed: "1044066542771276695", seed_code: "ATGY4CVU47AK" } },
    ...pb(4, 30, 31), ...pb(5, 40, 41),
    { timestamp: at(41), kind: "event", event: "game.milestone", data: { label: "Act 1 boss", chapter: true } },
    { timestamp: at(50), kind: "event", event: "run.ended", data: {} },
  ];
  writeFileSync(join(runDir, "run.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(runDir, "recording.json"), JSON.stringify({ recorder: "obs", t0: at(0), ended_at: at(50), files: ["recording/rec.mp4"] }));
  writeFileSync(join(runDir, "brief.json"), JSON.stringify({ cut: { marginBefore: 0.5, marginAfter: 1 } }));

  const all = computeTimeline(runDir);
  assert.equal(all.totals.attempts, 2);
  assert.equal(all.totals.deaths, 1);
  assert.deepEqual(all.attempts.map((a) => [a.attempt, a.start_rta, a.end_rta, a.outcome, a.playbacks]), [[1, 0, 11, "death", 2], [2, 24, 50, "stopped", 2]]);
  assert.equal(all.attempts[1].card_at, 11, "the second run's cut starts at the death that ended the first");
  assert.deepEqual(all.attempts.map((a) => a.seed_code), ["ATGY4CVU47AK", "ATGY4CVU47AK"], "every run carries its seed");
  assert.ok(all.sections.some((s) => s.label === "Attempt 2"));
  assert.equal(all.cut_attempt, null);

  const last = computeTimeline(runDir, { attempt: "last" });
  assert.equal(last.cut_attempt, 2);
  // the cut of one attempt opens where that attempt's run begins (the death that ended the previous one)
  assert.deepEqual(last.keep.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]), [[11, 25], [29.5, 32], [39.5, 42]]);
  assert.equal(last.playbacks.length, 5, "the playback list still covers the whole session");
  assert.throws(() => computeTimeline(runDir, { attempt: 3 }), /No attempt 3/);
});
