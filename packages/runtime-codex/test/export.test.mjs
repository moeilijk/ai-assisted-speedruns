// completed_at is the game.over with victory: true (SPEC §6), and the agent's completion marker only without one. The
// Codex exporter knew only the marker, so a Codex run that won published completed_at null and an archive read it as
// a run that did not reach its goal (balatro-codex-01, 2026-10-16).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportRollout } from "../export-rollout.mjs";

const rollout = (lastMessage) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-rollout-"));
  const file = path.join(dir, "rollout.jsonl");
  const rows = [
    { timestamp: "2026-10-16T00:05:49.000Z", type: "session_meta", payload: { cli_version: "0.99.0", model_provider: "openai" } },
    { timestamp: "2026-10-16T00:05:50.000Z", type: "turn_context", payload: { model: "gpt-x", effort: "medium" } },
    { timestamp: "2026-10-16T00:08:20.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: lastMessage } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { file, out: path.join(dir, "out") };
};
const summaryOf = (out) => JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8"));
const victory = "2026-10-16T02:08:13.144+02:00";

test("a Codex run the game declared won is completed at that victory, without any marker", async () => {
  const { file, out } = rollout("I played on.");
  await exportRollout(file, out, { completionMarker: null, completionTime: victory, timeZone: "UTC" });
  const s = summaryOf(out);
  assert.equal(Date.parse(s.completed_at), Date.parse(victory));
  assert.equal(s.elapsed_to_completion_seconds, Math.round((Date.parse(victory) - Date.parse("2026-10-16T00:05:49.000Z")) / 1000));
});

test("without a victory, the agent's completion marker completes the run, as before", async () => {
  const { file, out } = rollout("DONE: reached the goal");
  await exportRollout(file, out, { completionMarker: "DONE:", completionTime: null, timeZone: "UTC" });
  assert.equal(Date.parse(summaryOf(out).completed_at), Date.parse("2026-10-16T00:08:20.000Z"));
});

test("with both, the game's victory decides, not the agent's own words", async () => {
  const { file, out } = rollout("DONE: reached the goal");
  await exportRollout(file, out, { completionMarker: "DONE:", completionTime: victory, timeZone: "UTC" });
  assert.equal(Date.parse(summaryOf(out).completed_at), Date.parse(victory));
});

test("with neither, the run is not completed", async () => {
  const { file, out } = rollout("I played on.");
  await exportRollout(file, out, { completionMarker: "DONE:", completionTime: null, timeZone: "UTC" });
  assert.equal(summaryOf(out).completed_at, null);
});
