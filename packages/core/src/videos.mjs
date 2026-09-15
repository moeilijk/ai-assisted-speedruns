// The videos a runner may upload for one run, as `summary.recording.videos` (schema 8): the whole recording (one file),
// or one video per segment of a resumed run, and the cut. Each with its length, the line its description carries and
// its chapters on its own clock. No imports, so an archive can take this module as it is.

/**
 * A chapter label for viewers: the log keeps the harness's details (the save's name, the runtime's exit code, turns and
 * cost of a resumed session), which say nothing to someone watching the video.
 */
export const viewerLabel = (label) => String(label).replace(/\s*\([^)]*\)\s*$/, "").replace(/ from save \S+/, "");

/** The line a video's description carries: the run, the bundle's fingerprint, and that video's length in whole seconds. */
export const videoLine = (runId, fingerprint, seconds) => `AAS ${runId} · fingerprint ${String(fingerprint ?? "").slice(0, 16)} · ${Math.round(seconds)} s`;

const ms = (x) => Math.round(x * 1000) / 1000;

/**
 * @param runId the bundle's run_id
 * @param fingerprint summary.recording.fingerprint
 * @param durationSeconds summary.recording.duration_seconds, the whole recording
 * @param files summary.recording.files, the raw recording files relative to the run directory
 * @param timeline the published timeline.json (segments, sections, keep, cut_chapters, totals.cut_video)
 */
export function recordingVideos({ runId, fingerprint, durationSeconds, files = [], timeline = null }) {
  const raw = files.filter((f) => !/\.cut\.mp4$/i.test(f));
  const segments = timeline?.segments?.length ? timeline.segments : raw.map((file, index) => ({ index, file, offset: 0, seconds: null }));
  const sections = timeline?.sections ?? [];
  const chapters = (list) => list.map((c) => ({ at: ms(Math.max(0, c.at)), label: viewerLabel(c.label) }));
  const videos = [];
  if (segments.length === 1) {
    const seconds = durationSeconds ?? segments[0].seconds;
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
