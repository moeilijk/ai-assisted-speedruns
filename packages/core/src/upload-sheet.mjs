// `aas upload-sheet <run-dir>`: what it takes to upload the run's videos to a video site, in one plain-text file next to
// them: <run-dir>/recording/UPLOAD.txt. The runner uploads the cut, the full recording (one video per segment of a
// resumed run), or both; per video the file, its length, the code (before schema 14: the line) its description must
// contain, and its chapters; then
// an example title and description. `aas publish` and `aas render` write it.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ARCHIVE_URL } from "./plugins.mjs";
import { CODE_SCHEMA, formatDuration, recordingVideos, videoCode } from "./videos.mjs";
import { withVideoTexts } from "./youtube-text.mjs";

export const UPLOAD_SHEET = path.join("recording", "UPLOAD.txt");

/** A path as the publisher's file dialog shows it: a WSL drive mount (/mnt/g/...) as its Windows drive (G:\\...). */
export const shownPath = (p) => (/^\/mnt\/[a-z]\//.test(p) ? p.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replaceAll("/", "\\") : p);
const REVISION_FILE = "publish-revision.json";

export { formatDuration };

/** A video file's length by ffprobe, or null when it cannot be read (no ffprobe, not a video). */
function videoSeconds(file) {
  try { return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) || null; } catch { return null; }
}

/** The bundle this sheet describes: an explicit directory, else the one the last `aas publish` of this run wrote. */
function bundleDirOf(runDir, bundleDir) {
  if (bundleDir) return path.resolve(bundleDir);
  try { return JSON.parse(fs.readFileSync(path.join(runDir, REVISION_FILE), "utf8")).bundle_dir ?? null; } catch { return null; }
}

/** Stores the bundle directory and the note for the next sheet, keeping what publish wrote there. */
export function rememberUploadSettings(runDir, { bundleDir, note } = {}) {
  const file = path.join(runDir, REVISION_FILE);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first publication */ }
  if (bundleDir) data.bundle_dir = path.resolve(bundleDir);
  if (note !== undefined) data.upload_note = note || null;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

/**
 * Writes <run-dir>/recording/UPLOAD.txt from the published bundle and the run directory. Returns the file, or null when
 * the run has no bundle yet. `note` (kept in publish-revision.json) is a sentence added to the description.
 */
export function writeUploadSheet(runDir, { bundleDir, note, log = () => {} } = {}) {
  runDir = path.resolve(runDir);
  if (bundleDir || note !== undefined) rememberUploadSettings(runDir, { bundleDir, note });
  const dir = bundleDirOf(runDir, bundleDir);
  const summaryFile = dir && path.join(dir, "summary.json");
  if (!summaryFile || !fs.existsSync(summaryFile)) {
    log("upload sheet: no published bundle for this run yet (aas publish writes it)");
    return null;
  }
  const s = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(path.join(runDir, REVISION_FILE), "utf8")); } catch { /* none */ }
  const uploadNote = note !== undefined ? note : stored.upload_note ?? null;

  const id = s.run_id;
  let timeline = null;
  try { timeline = JSON.parse(fs.readFileSync(path.join(dir, "timeline.json"), "utf8")); } catch { /* an older bundle */ }
  // The videos the runner may upload, with their suggested title and description, as the bundle lists them; for an
  // older bundle the tooling lists them the same way.
  const listed = s.recording?.videos?.every((v) => v.title && v.description) ? s.recording.videos
    : withVideoTexts(s.recording?.videos ?? recordingVideos({ runId: id, fingerprint: s.recording?.fingerprint, durationSeconds: s.recording?.duration_seconds, files: s.recording?.files ?? [], timeline, schema: s.schema_version ?? 0 }), s, { archiveUrl: ARCHIVE_URL, note: uploadNote });
  const videos = listed.map((v) => ({ ...v, abs: v.file ? path.join(runDir, v.file) : null }));
  const whole = (x) => formatDuration(x, { whole: true });
  const code = (s.schema_version ?? 0) >= CODE_SCHEMA;
  const rule = "-".repeat(78);
  const one = (v) => {
    const made = v.abs && fs.existsSync(v.abs);
    // A cut rendered before a resume or before this revision's cut list has another length than its line: its line
    // would not match it, so the sheet says to render it again.
    const actual = made && v.kind === "cut" ? videoSeconds(v.abs) : null;
    const stale = actual !== null && Math.abs(actual - v.seconds) > 1;
    const what = v.kind === "cut" ? "CUT VIDEO  (the recording with the thinking pauses removed)"
      : v.kind === "segment" ? `FULL RECORDING, PART ${v.part} OF ${v.parts}  (the run was resumed; each part is its own video)`
      : "FULL RECORDING";
    return [
      what,
      `  ${shownPath(v.abs ?? "")}${!made ? `   (not made yet: aas render ${runDir})` : stale ? `   (out of date: this file is ${whole(actual)}, this revision's cut is ${whole(v.seconds)}; aas render ${runDir})` : ""}`,
      `  ${whole(v.seconds)}`,
      code ? `  code:  ${v.line}` : `  line:  ${v.line}`,
      "",
      `  Title: ${v.title}`,
      "",
      rule,
      v.description,
      rule,
      "",
    ];
  };
  const sheet = [
    `Video upload: ${id}`,
    "",
    "Upload the cut video, the full recording, or both: that is the runner's choice.",
    ...(code ? [
      `REQUIRED: the description of every uploaded video contains the code ${videoCode(s.recording?.fingerprint)} (or its title, where a`,
      "site has no description). That is the only requirement. The code is the same for every video of this revision.",
      "It is \"aas\" and the start of the sha256 of the run's published timeline; the archive measures each video's length.",
      "Each video below has a suggested title and description, ending on the code: use, change or leave them out.",
    ] : [
      "REQUIRED: the description of every uploaded video contains that video's line (or its title, where a site has no",
      "description). That is the only requirement. A line of its own keeps it easy to find.",
      "The fingerprint is the start of the sha256 of the run's published timeline; the seconds are that video's length.",
      "Each video below has a suggested title and description, ending on its line: use, change or leave them out.",
    ]),
    "The run's page in the archive exists once the archive has accepted the run and put it online.",
    "",
    ...[...videos.filter((v) => v.kind === "cut"), ...videos.filter((v) => v.kind !== "cut")].flatMap(one),
  ].join("\n");
  const out = path.join(runDir, UPLOAD_SHEET);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, sheet);
  log(`upload sheet: ${out}`);
  return out;
}
