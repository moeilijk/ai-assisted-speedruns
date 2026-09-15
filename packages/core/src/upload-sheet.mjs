// `aas upload-sheet <run-dir>`: what it takes to upload the run's videos to a video site, in one plain-text file next to
// them: <run-dir>/recording/UPLOAD.txt. The runner uploads the cut, the full recording (one video per segment of a
// resumed run), or both; per video the file, its length, the line its description must contain, and its chapters; then
// an example title and description. `aas publish` and `aas render` write it.
import fs from "node:fs";
import path from "node:path";
import { probeDuration } from "./render.mjs";
import { ARCHIVE_URL } from "./plugins.mjs";

export const UPLOAD_SHEET = path.join("recording", "UPLOAD.txt");

/** A path as the publisher's file dialog shows it: a WSL drive mount (/mnt/g/...) as its Windows drive (G:\\...). */
export const shownPath = (p) => (/^\/mnt\/[a-z]\//.test(p) ? p.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replaceAll("/", "\\") : p);
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

/**
 * A chapter label for viewers: the bundle keeps the harness's details (the save's name, the runtime's exit code, turns
 * and cost of a resumed session), which say nothing to someone watching the video, so they are left out here.
 */
export const viewerLabel = (label) => label.replace(/\s*\([^)]*\)\s*$/, "").replace(/ from save \S+/, "");

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
  const lineFor = (seconds) => `AAS ${id} · fingerprint ${fp} · ${seconds ?? "?"} s`;
  let timeline = null;
  try { timeline = JSON.parse(fs.readFileSync(path.join(dir, "timeline.json"), "utf8")); } catch { /* an older bundle */ }
  const raw = (s.recording?.files ?? []).filter((f) => !/\.cut\.mp4$/.test(f));
  const fullSeconds = s.recording?.duration_seconds ?? null;
  const lengthOf = (file, fallback) => {
    const d = file && fs.existsSync(file) ? probeDuration(file) : null;
    return typeof d === "number" && d > 0 ? d : fallback;
  };

  // The videos the runner may upload, any or all of them: the cut (one file, the thinking pauses removed) and the
  // full recording (one file per segment when the run was resumed). Each gets its own line with its own length.
  const chaptersCut = readChapters(path.join(runDir, "timeline", "chapters.cut.txt"));
  const chaptersFull = readChapters(path.join(runDir, "timeline", "chapters.txt"));
  const segments = (timeline?.segments?.length ? timeline.segments : raw.map((file, index) => ({ index, file, offset: 0, seconds: raw.length === 1 ? fullSeconds : null })))
    .map((sg, k, all) => {
      const abs = sg.file ? path.join(runDir, sg.file) : null;
      const seconds = lengthOf(abs, sg.seconds);
      const end = all[k + 1]?.offset ?? Infinity;
      const chapters = chaptersFull.filter((c) => c.at >= (sg.offset ?? 0) && c.at < end).map((c) => ({ at: c.at - (sg.offset ?? 0), label: c.label }));
      return { abs, seconds, chapters };
    });
  const cutAbs = raw.length ? path.join(runDir, raw[0].replace(/\.(mp4|mkv|mov)$/i, "") + ".cut.mp4") : null;
  const hasCut = Boolean(cutAbs && fs.existsSync(cutAbs));
  const keepSeconds = timeline?.keep?.length ? timeline.keep.reduce((n, [a, b]) => n + (b - a), 0) : null;
  const cutSeconds = hasCut ? lengthOf(cutAbs, keepSeconds) : keepSeconds;

  const game = s.game?.game ?? s.category?.game ?? "the game";
  const goal = s.category?.goal_end?.label ?? s.category?.goal ?? "its goal";
  const models = [...new Set((s.models ?? []).map((m) => m.model))].join(", ") || "a model";
  const runtime = s.harness?.plugins?.runtime?.name ?? s.harness?.plugins?.runtime?.id ?? "its runtime";
  const ttc = s.totals_to_completion;
  const reached = Boolean(s.completed_at && ttc);
  const igt = formatDuration(reached ? ttc.igt_seconds : s.recording?.igt_seconds);
  const real = formatDuration(reached ? ttc.rta_seconds : s.recording?.wall_clock_seconds ?? fullSeconds, { whole: true });
  const runPage = `${ARCHIVE_URL}/runs/${id}/`;
  const whole = (x) => formatDuration(x, { whole: true });
  const secs = (x) => (typeof x === "number" ? Math.round(x) : null);

  const title = reached ? `${game} · ${goal} in ${igt} · ${models}` : `${game} · ${goal}, not reached · ${models}`;
  const human = s.category?.human === "restart-only"
    ? "A human resumed the agent after it stopped; no game help was given."
    : s.category?.human === "assisted" ? `A human assisted: ${s.category?.human_notes ?? "see the run page"}.` : null;
  const after = reached && (s.recording?.igt_seconds ?? 0) > (ttc.igt_seconds ?? 0) + 0.05
    ? "The recording goes on after the goal was reached; what was played after it is not part of the run's time."
    : null;
  const description = [
    `${models} plays ${game} through ${runtime}, with the goal "${goal}".`,
    reached
      ? `Result: ${goal} reached in ${igt} in-game time, ${real} real time.`
      : `Result: ${goal} not reached. The session stopped after ${igt} in-game time and ${real} real time.`,
    ...(after ? [after] : []),
    ...(human ? [human] : []),
    ...(uploadNote ? [uploadNote] : []),
    "",
    `The run in the AAS Archive: ${runPage}`,
    `Check a bundle in the browser: ${ARCHIVE_URL}/verify/`,
  ].join("\n");

  const block = (heading, items) => [heading, ...items.flatMap((v) => [
    "",
    `  ${v.label}${shownPath(v.abs ?? "")}`,
    `  ${v.what}`,
    `  line:  ${lineFor(secs(v.seconds))}`,
    ...(v.chapters.length ? ["  chapters:", ...v.chapters.map((c) => `    ${youtubeTime(c.at)} ${viewerLabel(c.label)}`)] : []),
  ])];
  const cutBlock = hasCut
    ? block("CUT VIDEO  (one file: the recording with the thinking pauses removed)", [{ label: "", abs: cutAbs, seconds: cutSeconds, what: `${whole(cutSeconds)}`, chapters: chaptersCut }])
    : ["CUT VIDEO", "", `  Not made yet: aas render ${runDir} makes it${keepSeconds ? ` (${whole(keepSeconds)})` : ""} and writes this sheet again.`];
  const fullBlock = block(
    segments.length > 1
      ? `FULL RECORDING  (${segments.length} files: the run and its continuation after a resume; each file is its own video)`
      : "FULL RECORDING  (one file)",
    segments.map((v, k) => ({ ...v, label: segments.length > 1 ? `${k + 1}. ` : "", what: `${whole(v.seconds)}${segments.length > 1 ? `, part ${k + 1} of ${segments.length}` : ""}` })),
  );

  const sheet = [
    `Video upload: ${id}`,
    "",
    "Upload the cut video, the full recording, or both: that is the runner's choice.",
    "REQUIRED: the description of every uploaded video contains that video's line below (or its title, where a site",
    "has no description). That is the only requirement. A line of its own keeps it easy to find.",
    "The fingerprint is the start of the sha256 of the run's published timeline; the seconds are that video's length.",
    "",
    ...cutBlock,
    "",
    ...fullBlock,
    "",
    "EXAMPLE  (not required: a title and a description to use, change or leave out; add the video's chapters and its line)",
    "",
    `  Title: ${title}`,
    "",
    "-".repeat(78),
    description,
    "-".repeat(78),
    "",
  ].join("\n");
  const out = path.join(runDir, UPLOAD_SHEET);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, sheet);
  log(`upload sheet: ${out}`);
  return out;
}
