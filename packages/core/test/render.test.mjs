import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegArgs, render, probeDuration } from "../src/render.mjs";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("aas render keeps only the playbacks and burns the subtitles", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const runDir = mkdtempSync(join(tmpdir(), "aas-render-"));
  mkdirSync(join(runDir, "recording"));
  const video = join(runDir, "recording", "rec.mp4");
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "12", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", video], { stdio: "ignore" });
  const t0 = Date.parse("2026-09-09T10:00:00.000Z");
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const rows = [
    { timestamp: at(0), kind: "event", event: "run.started", data: {} },
    { timestamp: at(2), kind: "event", event: "game.playback", data: { phase: "start", index: 1, planned_ticks: 67, steps: [{ ticks: 67, keys: ["forward"] }] } },
    { timestamp: at(3), kind: "event", event: "game.playback", data: { phase: "end", index: 1, ticks: 67 } },
    { timestamp: at(8), kind: "event", event: "game.playback", data: { phase: "start", index: 2, planned_ticks: 134, steps: [{ ticks: 134, keys: ["forward", "jump"] }] } },
    { timestamp: at(10), kind: "event", event: "game.playback", data: { phase: "end", index: 2, ticks: 134 } },
    { timestamp: at(12), kind: "event", event: "run.ended", data: {} },
  ];
  writeFileSync(join(runDir, "run.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(runDir, "recording.json"), JSON.stringify({ recorder: "obs", t0: at(0), ended_at: at(12), files: ["recording/rec.mp4"] }));
  const r = render(runDir, { burn: ["timers", "inputs"], crf: 30, log: () => {} });
  // kept: [0,3.5] (the cut opens at the start of the recording) + [7.5,10.5] = 6.5 s
  assert.equal(Math.round(r.kept * 10) / 10, 6.5);
  const duration = probeDuration(r.out);
  assert.ok(duration && Math.abs(duration - 6.5) < 0.6, `duration ${duration}`);
});

test("the cut carries no data stream: OBS's chapter track would give it the recording's full length", () => {
  const args = ffmpegArgs({ video: "/r/rec.mp4", out: "/r/rec.cut.mp4", keep: [[0, 1]], timelineDir: "/r/timeline" });
  assert.ok(args.includes("-dn"), args.join(" "));
  assert.equal(args[args.indexOf("-map_chapters") + 1], "-1");
  assert.ok(args.indexOf("-dn") < args.indexOf("-c:v"));
});

test("after a run without a video there is no cut, and the run is not failed for it", async () => {
  const { renderAfterRun } = await import("../src/render.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const lines = [];
  assert.equal(renderAfterRun(mkdtempSync(join(tmpdir(), "aas-norec-")), { log: (l) => lines.push(l) }), null);
  assert.deepEqual(lines, ["no video recording, so no cut"]);
});
