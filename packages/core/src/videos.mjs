// The videos a runner may upload for one run, as `summary.recording.videos`: the whole recording (one file), or one video
// per segment of a resumed run, and the cut. Each with its length, the line its description must carry, its chapters on
// its own clock, and a suggested title and description that end on that line. No imports, so an archive can take this
// module as it is.

/**
 * A chapter label for viewers: the log keeps the harness's details (the save's name, the runtime's exit code, turns and
 * cost of a resumed session), which say nothing to someone watching the video.
 */
export const viewerLabel = (label) => String(label).replace(/\s*\([^)]*\)\s*$/, "").replace(/ from save \S+/, "");

/** The line a video's description carries up to schema 13: the run, the bundle's fingerprint, and that video's length in whole seconds. */
export const videoLine = (runId, fingerprint, seconds) => `AAS ${runId} · fingerprint ${String(fingerprint ?? "").slice(0, 16)} · ${Math.round(seconds)} s`;

/** From schema 14: one code for every video of a revision, "aas" and the fingerprint's first 16 hex, one word to copy (owner 16-09). */
export const CODE_SCHEMA = 14;
export const videoCode = (fingerprint) => `aas${String(fingerprint ?? "").slice(0, 16).toLowerCase()}`;
/** What a video of a bundle with this schema carries: the code from schema 14, the line before it. */
export const bindingLine = (schema, runId, fingerprint, seconds) => (schema >= CODE_SCHEMA ? videoCode(fingerprint) : videoLine(runId, fingerprint, seconds));
/** Whether a description holds the code as a word of its own. */
export const hasCode = (text, code) => new RegExp(`(^|[^a-z0-9])${code}($|[^a-z0-9])`, "i").test(String(text ?? ""));

const ms = (x) => Math.round(x * 1000) / 1000;

/**
 * A duration in ISO 8601's extended format, hh:mm:ss, every part two digits, as the archive shows it (owner 16-09):
 * game time with tenths (00:02:02.0), real time `whole` (00:10:32). Hours past 24 go on counting (25:03:00).
 */
export function formatDuration(seconds, { whole = false } = {}) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "?";
  const tenths = Math.floor(seconds * 10 + 1e-6);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = (tenths % 600) / 10;
  const sec = whole ? String(Math.floor(s)).padStart(2, "0") : s.toFixed(1).padStart(4, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec}`;
}

/** A chapter time as YouTube reads it: 0:00, 11:15, 1:02:03. */
export const youtubeTime = (seconds) => {
  const t = Math.floor(seconds);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};

/**
 * @param runId the bundle's run_id
 * @param fingerprint summary.recording.fingerprint
 * @param durationSeconds summary.recording.duration_seconds, the whole recording
 * @param files summary.recording.files, the raw recording files relative to the run directory
 * @param timeline the published timeline.json (segments, sections, keep, cut_chapters, totals.cut_video)
 * @param schema the bundle's summary schema, which decides between the line and the code
 */
export function recordingVideos({ runId, fingerprint, durationSeconds, files = [], timeline = null, schema = 0 }) {
  const videoLine = (id, fp, seconds) => bindingLine(schema, id, fp, seconds);
  const raw = files.filter((f) => !/\.cut\.mp4$/i.test(f));
  const segments = timeline?.segments?.length ? timeline.segments : raw.map((file, index) => ({ index, file, offset: 0, seconds: null }));
  const sections = timeline?.sections ?? [];
  const chapters = (list) => list.map((c) => ({ at: ms(Math.max(0, c.at)), label: viewerLabel(c.label) }));
  const videos = [];
  if (segments.length === 1) {
    // The whole recording is listed only with its measured length (ffprobe at publish): that is the length a
    // checker holds its line against.
    const seconds = durationSeconds;
    if (typeof seconds === "number") {
      videos.push({ kind: "whole", part: null, parts: null, file: segments[0].file ?? raw[0] ?? null, seconds: ms(seconds), line: videoLine(runId, fingerprint, seconds),
        chapters: chapters(sections.map((s) => ({ at: s.start_rta, label: s.label }))) });
    }
  } else {
    segments.forEach((sg, k) => {
      if (typeof sg.seconds !== "number") return;
      const start = sg.offset ?? 0;
      const end = segments[k + 1]?.offset ?? Infinity;
      videos.push({ kind: "segment", part: k + 1, parts: segments.length, file: sg.file ?? raw[k] ?? null, seconds: ms(sg.seconds), line: videoLine(runId, fingerprint, sg.seconds),
        chapters: chapters(sections.filter((s) => s.start_rta >= start && s.start_rta < end).map((s) => ({ at: s.start_rta - start, label: s.label }))) });
    });
  }
  const cut = timeline?.totals?.cut_video;
  if (typeof cut === "number" && cut > 0 && raw.length) {
    videos.push({ kind: "cut", part: null, parts: null, file: raw[0].replace(/\.(mp4|mkv|mov)$/i, "") + ".cut.mp4", seconds: ms(cut), line: videoLine(runId, fingerprint, cut),
      chapters: chapters(timeline.cut_chapters ?? []) });
  }
  return videos;
}
