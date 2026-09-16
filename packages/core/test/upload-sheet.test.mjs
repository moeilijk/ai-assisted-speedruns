// The upload sheet: everything for one upload in one file next to the videos, in the private run directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDuration, writeUploadSheet } from "../src/upload-sheet.mjs";

test("times read the way the archive shows them", () => {
  assert.equal(formatDuration(39.405), "00:00:39.4");
  assert.equal(formatDuration(177.48), "00:02:57.4");
  assert.equal(formatDuration(122.04), "00:02:02.0");
  assert.equal(formatDuration(1362.641, { whole: true }), "00:22:42");
  assert.equal(formatDuration(3675, { whole: true }), "01:01:15");
  assert.equal(formatDuration(90180, { whole: true }), "25:03:00", "hours past a day go on counting");
});

test("the sheet offers the cut and the full recording per segment, each with its own line, length and chapters", () => {
  const root = mkdtempSync(join(tmpdir(), "aas-sheet-"));
  const runDir = join(root, "sts-claude-code-01");
  const bundle = join(root, "public", "sts-claude-code-01");
  mkdirSync(join(runDir, "timeline"), { recursive: true });
  mkdirSync(join(runDir, "recording"), { recursive: true });
  mkdirSync(bundle, { recursive: true });
  for (const f of ["AAS_run_1.mp4", "AAS_run_2.mp4", "AAS_run_1.cut.mp4"]) writeFileSync(join(runDir, "recording", f), "");
  writeFileSync(join(runDir, "timeline", "chapters.txt"), "00:00:00 Start\n00:22:42 Act 1 boss\n00:22:53 Human: resumed from save s1 after completed (claude -p exited with 0; cost $9.98)\n");
  writeFileSync(join(runDir, "timeline", "chapters.cut.txt"), "00:00:00 Start\n00:11:15 Act 1 boss\n");
  writeFileSync(join(bundle, "timeline.json"), JSON.stringify({
    segments: [{ index: 0, offset: 0, seconds: 1368.498, file: "recording/AAS_run_1.mp4" }, { index: 1, offset: 1368.498, seconds: 190.949, file: "recording/AAS_run_2.mp4" }],
    sections: [{ label: "Start", start_rta: 0 }, { label: "Act 1 boss", start_rta: 1362.6 }, { label: "Human: resumed from save s1 after completed (claude -p exited with 0; cost $9.98)", start_rta: 1373 }],
    keep: [[0, 700], [800, 869.134]], totals: { cut_video: 769.134 },
    cut_chapters: [{ at: 0, label: "Start" }, { at: 675.2, label: "Act 1 boss" }],
  }));
  writeFileSync(join(bundle, "summary.json"), JSON.stringify({
    schema_version: 7, spec_version: "0.25", run_id: "sts-claude-code-01", completed_at: "2026-09-13T11:14:00.165+02:00",
    bundle: { revision: 11 }, models: [{ model: "claude-sonnet-5" }],
    category: { game: "slay_the_spire", goal: "act1", goal_end: { id: "act1", label: "Act 1 boss", final: false }, human: "none" },
    game: { game: "Slay the Spire" }, harness: { plugins: { runtime: { id: "claude-code", name: "Claude Code" } } },
    recording: { fingerprint: "36d633208676bfdb0000", duration_seconds: 1559, igt_seconds: 217.26, wall_clock_seconds: 1559, files: ["recording/AAS_run_1.mp4", "recording/AAS_run_2.mp4"] },
    totals_to_completion: { rta_seconds: 1362.641, igt_seconds: 177.48 },
  }));
  const out = writeUploadSheet(runDir, { bundleDir: bundle, note: "This run is an example." });
  assert.equal(out, join(runDir, "recording", "UPLOAD.txt"));
  const sheet = readFileSync(out, "utf8");
  assert.match(sheet, /the cut video, the full recording, or both: that is the runner's choice/);
  assert.match(sheet, /That is the only requirement/);
  assert.match(sheet, /suggested title and description, ending on its line: use, change or leave them out/);
  assert.ok(!/\.zip|submit/i.test(sheet), "nothing about submitting the bundle");
  const fp = "AAS sts-claude-code-01 · fingerprint 36d633208676bfdb";
  const cut = sheet.split("CUT VIDEO")[1].split("FULL RECORDING")[0];
  assert.ok(cut.includes(join(runDir, "recording", "AAS_run_1.cut.mp4")));
  assert.ok(cut.includes(`line:  ${fp} · 769 s`), "the cut's own length");
  assert.ok(cut.includes("Title: Claude Sonnet 5 plays Slay the Spire (cut) — reached the Act 1 boss in 00:02:57.4"));
  assert.ok(cut.includes("so 00:25:59 of recording becomes 00:12:49"));
  assert.ok(cut.includes("At 11:15 it reached the Act 1 boss"));
  assert.ok(cut.includes("This run is an example."));
  assert.ok(cut.trim().split("\n").at(-2).startsWith(`${fp} · 769 s`), "the description ends on the cut's line");
  const cutText = cut.split("-".repeat(78))[1].trim().split("\n");
  assert.equal(cutText[0], "Claude Sonnet 5, a language model, plays Slay the Spire by itself. Its goal was the Act 1 boss; it got there in 00:02:57.4 of game time (00:22:42 of real time).", "the result first");
  assert.ok(cut.includes("Run sts-claude-code-01 is in the AAS Archive: ai-assisted-speedruns.org"), "the domain and the run id as text, no link YouTube would shorten");
  assert.ok(!cut.includes("https://"), "no links: a viewer has no bundle to check, and a link is shortened in view");
  assert.equal(cutText.at(-2), "Verification line for the AAS Archive:");
  assert.equal(cutText.at(-1), `${fp} · 769 s`, "the line is the last line");
  assert.match(sheet, /exists once the archive has accepted the run/);
  const part2 = sheet.split("FULL RECORDING, PART 2 OF 2")[1];
  const part1 = sheet.split("FULL RECORDING, PART 1 OF 2")[1].split("FULL RECORDING, PART 2")[0];
  assert.ok(part1.includes(`line:  ${fp} · 1368 s`) && part1.includes("At 22:42 it reached the Act 1 boss."));
  assert.ok(part1.includes("Title: Claude Sonnet 5 plays Slay the Spire (part 1 of 2) — reached the Act 1 boss in 00:02:57.4"));
  assert.ok(part2.includes(`line:  ${fp} · 191 s`));
  assert.ok(part2.includes("At 0:04 the model had reached its goal and a person started it again."), "part 2's moments on its own clock, without the harness's details");
  assert.ok(readFileSync(writeUploadSheet(runDir), "utf8").includes("This run is an example."), "bundle and note are remembered");
});

test("a cut rendered before this revision is marked out of date: its line would not match it", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "no ffmpeg" }, () => {
  const root = mkdtempSync(join(tmpdir(), "aas-sheet-stale-"));
  const runDir = join(root, "run-01");
  const bundle = join(root, "public", "run-01");
  mkdirSync(join(runDir, "recording"), { recursive: true });
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(runDir, "recording", "a.mp4"), "");
  spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x36:d=2", join(runDir, "recording", "a.cut.mp4")]);
  writeFileSync(join(bundle, "timeline.json"), JSON.stringify({ segments: [{ index: 0, offset: 0, seconds: 30, file: "recording/a.mp4" }], sections: [], keep: [[0, 10]], totals: { cut_video: 10 }, cut_chapters: [] }));
  writeFileSync(join(bundle, "summary.json"), JSON.stringify({ schema_version: 7, run_id: "run-01", models: [], category: {}, recording: { fingerprint: "0123456789abcdef", duration_seconds: 30, files: ["recording/a.mp4"] } }));
  const sheet = readFileSync(writeUploadSheet(runDir, { bundleDir: bundle }), "utf8");
  assert.match(sheet, /a\.cut\.mp4 {3}\(out of date: this file is 00:00:02, this revision's cut is 00:00:10; aas render /);
});

test("paths on a WSL drive mount are shown as the Windows drive the file dialog knows", async () => {
  const { shownPath } = await import("../src/upload-sheet.mjs");
  assert.equal(shownPath("/mnt/g/OBS/Portal/portal-01/recording/a.cut.mp4"), "G:\\OBS\\Portal\\portal-01\\recording\\a.cut.mp4");
  assert.equal(shownPath("/home/me/runs/x"), "/home/me/runs/x");
});

