// The upload sheet: everything for one upload in one file next to the videos, in the private run directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDuration, writeUploadSheet } from "../src/upload-sheet.mjs";

test("times read the way the archive shows them", () => {
  assert.equal(formatDuration(39.405), "39.4s");
  assert.equal(formatDuration(177.48), "2m 57.4s");
  assert.equal(formatDuration(122.04), "2m 02.0s");
  assert.equal(formatDuration(1362.641, { whole: true }), "22m 42s");
  assert.equal(formatDuration(3675, { whole: true }), "1h 01m 15s");
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
  assert.ok(!/\.zip|submit/i.test(sheet), "nothing about submitting the bundle");
  const fp = "AAS sts-claude-code-01 · fingerprint 36d633208676bfdb";
  const cut = sheet.split("CUT VIDEO")[1].split("FULL RECORDING")[0];
  assert.ok(cut.includes(join(runDir, "recording", "AAS_run_1.cut.mp4")));
  assert.ok(cut.includes(`line:  ${fp} · 769 s`), "the cut's own length");
  assert.ok(cut.includes("11:15 Act 1 boss"));
  const full = sheet.split("FULL RECORDING")[1].split("EXAMPLE")[0];
  assert.match(full, /2 files: the run and its continuation after a resume/);
  assert.ok(full.includes(`1. ${join(runDir, "recording", "AAS_run_1.mp4")}`));
  assert.ok(full.includes(`line:  ${fp} · 1368 s`));
  assert.ok(full.includes(`line:  ${fp} · 191 s`));
  assert.ok(full.includes("22:42 Act 1 boss"), "part 1 keeps its chapters");
  assert.ok(full.includes("0:04 Human: resumed after completed"), "part 2's chapters start from its own 0:00, without the harness's details");
  const example = sheet.split("-".repeat(78))[1];
  assert.match(example, /^\nclaude-sonnet-5 plays Slay the Spire through Claude Code/);
  assert.ok(example.includes("This run is an example."));
  assert.ok(!example.includes("fingerprint"), "the example leaves the line to the video it goes with");
  assert.ok(readFileSync(writeUploadSheet(runDir), "utf8").includes("This run is an example."), "bundle and note are remembered");
});

test("paths on a WSL drive mount are shown as the Windows drive the file dialog knows", async () => {
  const { shownPath } = await import("../src/upload-sheet.mjs");
  assert.equal(shownPath("/mnt/g/OBS/Portal/portal-01/recording/a.cut.mp4"), "G:\\OBS\\Portal\\portal-01\\recording\\a.cut.mp4");
  assert.equal(shownPath("/home/me/runs/x"), "/home/me/runs/x");
});

