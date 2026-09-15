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

test("the sheet holds only the upload: the video file, the one requirement, and an example title and description", () => {
  const root = mkdtempSync(join(tmpdir(), "aas-sheet-"));
  const runDir = join(root, "sts-claude-code-01");
  const bundle = join(root, "public", "sts-claude-code-01");
  mkdirSync(join(runDir, "timeline"), { recursive: true });
  mkdirSync(join(runDir, "recording"), { recursive: true });
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(runDir, "recording", "AAS_run_1.mp4"), "");
  writeFileSync(join(runDir, "timeline", "chapters.txt"), "00:00:00 Start\n00:22:42 Act 1 boss\n");
  writeFileSync(join(bundle, "summary.json"), JSON.stringify({
    schema_version: 7, spec_version: "0.24", run_id: "sts-claude-code-01", completed_at: "2026-09-13T11:14:00.165+02:00",
    bundle: { revision: 11 }, models: [{ model: "claude-sonnet-5" }],
    category: { game: "slay_the_spire", goal: "act1", goal_end: { id: "act1", label: "Act 1 boss", final: false }, human: "none" },
    game: { game: "Slay the Spire" }, harness: { plugins: { runtime: { id: "claude-code", name: "Claude Code" } } },
    recording: { fingerprint: "36d633208676bfdb0000", duration_seconds: 1559, igt_seconds: 217.26, wall_clock_seconds: 1559, files: ["recording/AAS_run_1.mp4"] },
    totals_to_completion: { rta_seconds: 1362.641, igt_seconds: 177.48 },
  }));
  const out = writeUploadSheet(runDir, { bundleDir: bundle, note: "This run is an example." });
  assert.equal(out, join(runDir, "recording", "UPLOAD.txt"));
  const sheet = readFileSync(out, "utf8");
  assert.deepEqual(sheet.split("\n").filter((l) => /^[A-Z][A-Z ]+(\s{2}\(.*\))?$/.test(l)), ["VIDEO FILE", "REQUIRED", "EXAMPLE  (not required: a title and a description to use, change or leave out)"]);
  const required = sheet.split("REQUIRED")[1].split("EXAMPLE")[0];
  assert.ok(required.includes("\n  AAS sts-claude-code-01 · fingerprint 36d633208676bfdb · 1559 s\n"), "the line on its own");
  assert.match(required, /That is the only requirement/);
  assert.ok(sheet.includes(join(runDir, "recording", "AAS_run_1.mp4")));
  assert.ok(!/\.zip|submit/i.test(sheet), "nothing about submitting the bundle");
  assert.ok(sheet.includes("Slay the Spire · Act 1 boss in 2m 57.4s · claude-sonnet-5"));
  const desc = sheet.split("-".repeat(78))[1].trim().split("\n");
  assert.match(desc[0], /^claude-sonnet-5 plays Slay the Spire through Claude Code/);
  assert.ok(desc.includes("Result: Act 1 boss reached in 2m 57.4s in-game time, 22m 42s real time."));
  assert.ok(desc.includes("This run is an example."));
  assert.ok(sheet.includes("0:00 Start\n22:42 Act 1 boss"));
  assert.ok(desc.includes("https://ai-assisted-speedruns.org/runs/sts-claude-code-01/".replace(/^/, "The run in the AAS Archive: ")));
  assert.ok(desc.indexOf("AAS sts-claude-code-01 · fingerprint 36d633208676bfdb · 1559 s") > desc.indexOf("Chapters"));
  // Written again without options: the bundle and the note are remembered.
  assert.ok(readFileSync(writeUploadSheet(runDir), "utf8").includes("This run is an example."));
});

test("paths on a WSL drive mount are shown as the Windows drive the file dialog knows", async () => {
  const { shownPath } = await import("../src/upload-sheet.mjs");
  assert.equal(shownPath("/mnt/g/OBS/Portal/portal-01/recording/a.cut.mp4"), "G:\\OBS\\Portal\\portal-01\\recording\\a.cut.mp4");
  assert.equal(shownPath("/home/me/runs/x"), "/home/me/runs/x");
});

test("chapter labels for viewers leave out the save name and the resumed session's exit code, turns and cost", async () => {
  const { viewerLabel } = await import("../src/upload-sheet.mjs");
  assert.equal(viewerLabel("Human: resumed from save aas_portal_03_003 after failed (claude -p exited with 1; 410 assistant turns; cost $77.53; success)"), "Human: resumed after failed");
  assert.equal(viewerLabel("Human: goal extended from act1 to act3"), "Human: goal extended from act1 to act3");
  assert.equal(viewerLabel("Act 1 boss"), "Act 1 boss");
});
