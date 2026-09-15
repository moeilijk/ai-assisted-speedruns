// `aas upload-sheet <run-dir>`: what it takes to upload the run's videos to a video site, in one plain-text file next to
// them: <run-dir>/recording/UPLOAD.txt. The runner uploads the cut, the full recording (one video per segment of a
// resumed run), or both; per video the file, its length, the line its description must contain, and its chapters; then
// an example title and description. `aas publish` and `aas render` write it.
import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_URL } from "./plugins.mjs";
import { recordingVideos } from "./videos.mjs";

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
  const fullSeconds = s.recording?.duration_seconds ?? null;
  // The videos the runner may upload, as the bundle lists them (schema 8), or as the tooling would list them for an
  // older bundle: the whole recording or one per segment, and the cut. Each with its own length, line and chapters.
  const videos = (s.recording?.videos ?? recordingVideos({ runId: id, fingerprint: s.recording?.fingerprint, durationSeconds: fullSeconds, files: s.recording?.files ?? [], timeline }))
    .map((v) => ({ ...v, abs: v.file ? path.join(runDir, v.file) : null }));
  const cut = videos.find((v) => v.kind === "cut");
  const full = videos.filter((v) => v.kind !== "cut");
  const hasCut = Boolean(cut?.abs && fs.existsSync(cut.abs));

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
    `  ${v.number ?? ""}${shownPath(v.abs ?? "")}`,
    `  ${whole(v.seconds)}${v.part ? `, part ${v.part} of ${v.parts}` : ""}`,
    `  line:  ${v.line}`,
    ...(v.chapters.length ? ["  chapters:", ...v.chapters.map((c) => `    ${youtubeTime(c.at)} ${c.label}`)] : []),
  ])];
  const cutBlock = !cut
    ? ["CUT VIDEO", "", "  None: the timeline has no cut list."]
    : hasCut
      ? block("CUT VIDEO  (one file: the recording with the thinking pauses removed)", [cut])
      : ["CUT VIDEO", "", `  Not made yet: aas render ${runDir} makes it (${whole(cut.seconds)}) and writes this sheet again.`, `  line when it is:  ${cut.line}`];
  const fullBlock = block(
    full.length > 1
      ? `FULL RECORDING  (${full.length} files: the run and its continuation after a resume; each file is its own video)`
      : "FULL RECORDING  (one file)",
    full.map((v) => ({ ...v, number: v.part ? `${v.part}. ` : "" })),
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
