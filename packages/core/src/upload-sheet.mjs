// `aas upload-sheet <run-dir>`: everything the publisher needs to upload one run, in one plain-text file next to the
// videos: <run-dir>/recording/UPLOAD.txt. Which files to upload and where they are (the videos stay in the private run
// directory; the public bundle directory holds only the bundle), the fingerprint line, a title, a description to paste
// as it stands, the chapters of the cut video, and where the bundle zip goes. `aas publish` and `aas render` write it.
import fs from "node:fs";
import path from "node:path";
import { probeDuration } from "./render.mjs";
import { ARCHIVE_URL } from "./plugins.mjs";

export const UPLOAD_SHEET = path.join("recording", "UPLOAD.txt");
const REVISION_FILE = "publish-revision.json";

/** Seconds as the archive shows a time: 39.4s, 2m 57.4s; `whole` drops the tenths: 22m 42s, 1h 01m 15s. */
export function formatDuration(seconds, { whole = false } = {}) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "?";
  const tenths = Math.floor(seconds * 10 + 1e-6);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = (tenths % 600) / 10;
  const sec = whole ? String(Math.floor(s)) : s.toFixed(1);
  const pad = (v) => (v.includes(".") ? v.padStart(4, "0") : v.padStart(2, "0"));
  if (h) return `${h}h ${String(m).padStart(2, "0")}m ${pad(sec)}s`;
  if (m) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/** A chapter time as YouTube reads it: 0:00, 11:15, 1:02:03. */
const youtubeTime = (seconds) => {
  const t = Math.floor(seconds);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};

/** Chapters from a `HH:MM:SS Label` file (aas timeline), as { at, label }. */
function readChapters(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").map((l) => l.match(/^(\d+):(\d{2}):(\d{2})\s+(.+)$/)).filter(Boolean)
    .map((m) => ({ at: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), label: m[4].trim() }));
}

/** YouTube turns timestamps into chapters only when the first is at 0:00, there are at least three, and each lasts 10 s or more. */
export function youtubeChapterProblem(chapters, videoSeconds) {
  if (chapters.length < 3) return `${chapters.length} chapter(s); YouTube needs at least three`;
  if (chapters[0].at !== 0) return "the first chapter is not at 0:00";
  const ends = [...chapters.slice(1).map((c) => c.at), videoSeconds ?? Infinity];
  const short = chapters.find((c, i) => ends[i] - c.at < 10);
  return short ? `"${short.label}" lasts less than 10 s` : null;
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
  const fp = String(s.recording?.fingerprint ?? "").slice(0, 16);
  const fullSeconds = s.recording?.duration_seconds ?? null;
  const line = `AAS ${id} · fingerprint ${fp} · ${fullSeconds ?? "?"} s`;
  const raw = (s.recording?.files ?? []).filter((f) => !/\.cut\.mp4$/.test(f));
  const cutRel = raw.length ? raw[0].replace(/\.(mp4|mkv|mov)$/i, "") + ".cut.mp4" : null;
  const cutAbs = cutRel && path.join(runDir, cutRel);
  const hasCut = Boolean(cutAbs && fs.existsSync(cutAbs));
  const cutSeconds = hasCut ? probeDuration(cutAbs) : null;
  const chapters = readChapters(path.join(runDir, "timeline", hasCut ? "chapters.cut.txt" : "chapters.txt"));

  const game = s.game?.game ?? s.category?.game ?? "the game";
  const goal = s.category?.goal_end?.label ?? s.category?.goal ?? "its goal";
  const models = [...new Set((s.models ?? []).map((m) => m.model))].join(", ") || "a model";
  const runtime = s.harness?.plugins?.runtime?.name ?? s.harness?.plugins?.runtime?.id ?? "its runtime";
  const ttc = s.totals_to_completion;
  const reached = Boolean(s.completed_at && ttc);
  const igt = formatDuration(reached ? ttc.igt_seconds : s.recording?.igt_seconds);
  const real = formatDuration(reached ? ttc.rta_seconds : s.recording?.wall_clock_seconds ?? fullSeconds, { whole: true });
  const full = formatDuration(fullSeconds, { whole: true });
  const runPage = `${ARCHIVE_URL}/runs/${id}/`;

  const title = reached ? `${game} · ${goal} in ${igt} · ${models}` : `${game} · ${goal}, not reached · ${models}`;
  const human = s.category?.human === "restart-only"
    ? "A human resumed the agent after it stopped; no game help was given."
    : s.category?.human === "assisted" ? `A human assisted: ${s.category?.human_notes ?? "see the run page"}.` : null;
  const after = reached && (s.recording?.igt_seconds ?? 0) > (ttc.igt_seconds ?? 0) + 0.05
    ? "The video goes on after the goal was reached; what was played after it is not part of the run's time."
    : null;
  const chapterLines = chapters.map((c) => `${youtubeTime(c.at)} ${c.label}`);
  const description = [
    line,
    "",
    `${models} plays ${game} through ${runtime}, with the goal "${goal}".`,
    reached
      ? `Result: ${goal} reached in ${igt} in-game time, ${real} real time.`
      : `Result: ${goal} not reached. The session stopped after ${igt} in-game time and ${real} real time.`,
    ...(after ? [after] : []),
    ...(human ? [human] : []),
    ...(uploadNote ? [uploadNote] : []),
    "",
    hasCut
      ? `This is the cut version (${formatDuration(cutSeconds, { whole: true })}): the pauses while the model was thinking are removed. The full recording runs ${full}, the ${fullSeconds} s in the first line.`
      : `This is the full recording (${full}), the ${fullSeconds} s in the first line.`,
    ...(chapterLines.length ? ["", "Chapters", ...chapterLines] : []),
    "",
    "The first line ties this video to the run's bundle: the fingerprint is the start of the sha256 of the run's published timeline.",
    `The run in the AAS Archive: ${runPage}`,
    `Check a bundle in the browser: ${ARCHIVE_URL}/verify/`,
  ].join("\n");

  const problem = youtubeChapterProblem(chapters, hasCut ? cutSeconds : fullSeconds);
  const rule = "=".repeat(78);
  const videoLines = hasCut
    ? [
        `  Upload this file:   ${cutAbs}`,
        `                      the cut version, ${formatDuration(cutSeconds, { whole: true })}: thinking pauses removed (aas render)`,
        `  Full recording:     ${raw.map((f) => path.join(runDir, f)).join("\n                      ")}`,
        `                      ${full}${raw.length > 1 ? `, in ${raw.length} segments` : ""}; not needed for the upload`,
      ]
    : [
        `  No cut video yet: run  aas render ${runDir}  and this sheet is written again.`,
        `  Full recording:     ${raw.map((f) => path.join(runDir, f)).join("\n                      ") || "(none found)"}`,
      ];
  const sheet = [
    rule,
    `AAS UPLOAD SHEET  ${id}  (bundle revision ${s.bundle?.revision ?? "?"}, schema ${s.schema_version}, spec ${s.spec_version})`,
    rule,
    "Written by the aas tooling. This file stays in the private run directory and is not part of the bundle.",
    "",
    "WHERE THE FILES ARE",
    `  The video is NOT in the public folder. It is in this run's private directory:`,
    `    ${path.join(runDir, "recording")}`,
    `  The public folder holds only the bundle for the archive:`,
    `    ${dir}`,
    "",
    "1. VIDEO  (upload where you publish video)",
    ...videoLines,
    "",
    "2. FINGERPRINT LINE  (the first line of the description, exactly as written)",
    `  ${line}`,
    "",
    "3. TITLE",
    `  ${title}`,
    "",
    "4. DESCRIPTION  (paste everything between the lines as it stands)",
    "-".repeat(78),
    description,
    "-".repeat(78),
    "",
    "5. CHAPTERS",
    ...(chapterLines.length ? chapterLines.map((l) => `  ${l}`) : ["  (no chapters)"]),
    problem
      ? `  YouTube will show these as timestamps, not as chapters: ${problem}.`
      : "  YouTube turns these into chapters (first at 0:00, at least three, each 10 s or more).",
    "",
    "6. BUNDLE  (upload to the archive)",
    `  ${dir}.zip`,
    `  Submit it at ${ARCHIVE_URL}/submit/  (check it first at ${ARCHIVE_URL}/verify/ if you like)`,
    "",
  ].join("\n");
  const out = path.join(runDir, UPLOAD_SHEET);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, sheet);
  log(`upload sheet: ${out}`);
  return out;
}
