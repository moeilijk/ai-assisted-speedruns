// The videos a runner may upload for one run, as `summary.recording.videos`: the whole recording (one file), or one video
// per segment of a resumed run, and the cut. Each with its length, the line its description must carry, its chapters on
// its own clock, and a suggested title and description that end on that line. No imports, so an archive can take this
// module as it is.

/**
 * A chapter label for viewers: the log keeps the harness's details (the save's name, the runtime's exit code, turns and
 * cost of a resumed session), which say nothing to someone watching the video.
 */
export const viewerLabel = (label) => String(label).replace(/\s*\([^)]*\)\s*$/, "").replace(/ from save \S+/, "");

/** The line a video's description carries: the run, the bundle's fingerprint, and that video's length in whole seconds. */
export const videoLine = (runId, fingerprint, seconds) => `AAS ${runId} · fingerprint ${String(fingerprint ?? "").slice(0, 16)} · ${Math.round(seconds)} s`;

const ms = (x) => Math.round(x * 1000) / 1000;

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

/**
 * Whether YouTube turns these timestamps into chapters: at least three, the first at 0:00, and every chapter at least
 * ten seconds long, the last one up to the end of the video.
 */
export function youtubeChapters(chapters, seconds) {
  if (chapters.length < 3 || youtubeTime(chapters[0].at) !== "0:00") return false;
  const ends = [...chapters.slice(1).map((c) => c.at), seconds ?? Infinity];
  return chapters.every((c, i) => ends[i] - c.at >= 10);
}

/**
 * The suggested title and description of each video, from the bundle's own summary. YouTube shows only the first
 * lines before "more" and shortens long links, so the run's page comes first with the run id in plain text, then
 * the model, the game and the result in one sentence; then which video this is, its moments (as chapters when
 * YouTube makes chapters of them), and at the end the line. `note` is the publisher's sentence (for the example runs: that they
 * are examples). The runner may use, change or drop them; the line is the only requirement.
 */
export function withVideoTexts(videos, summary, { archiveUrl, note = null } = {}) {
  const s = summary;
  const game = s.game?.game ?? s.category?.game ?? "the game";
  const goal = s.category?.goal_end?.label ?? s.category?.goal ?? "its goal";
  const models = [...new Set((s.models ?? []).map((m) => m.model))].join(", ") || "a model";
  const runtime = s.harness?.plugins?.runtime?.name ?? s.harness?.plugins?.runtime?.id ?? "its runtime";
  const ttc = s.totals_to_completion;
  const reached = Boolean(s.completed_at && ttc);
  const whole = (x) => formatDuration(x, { whole: true });
  const igt = formatDuration(reached ? ttc.igt_seconds : s.recording?.igt_seconds);
  const real = whole(reached ? ttc.rta_seconds : s.recording?.wall_clock_seconds ?? s.recording?.duration_seconds);
  const full = whole(s.recording?.duration_seconds);
  const base = reached ? `${game} · ${goal} in ${igt} · ${models}` : `${game} · ${goal}, not reached · ${models}`;
  const human = s.category?.human === "restart-only"
    ? "A human resumed the agent after it stopped; no game help was given."
    : s.category?.human === "assisted" ? `A human assisted: ${s.category?.human_notes ?? "see the run page"}.` : null;
  const after = reached && (s.recording?.igt_seconds ?? 0) > (ttc.igt_seconds ?? 0) + 0.05
    ? "The recording goes on after the goal was reached; what was played after it is not part of the run's time."
    : null;
  return videos.map((v) => {
    const which = v.kind === "cut"
      ? `This is the cut version (${whole(v.seconds)}): the pauses while the model was thinking are removed. The full recording runs ${full}.`
      : v.kind === "segment"
        ? `This is part ${v.part} of ${v.parts} of the full recording (${whole(v.seconds)} of ${full}): the run was resumed${v.part < v.parts ? ` and continues in part ${v.part + 1}` : ""}.`
        : `This is the full recording (${full}).`;
    const description = [
      `${s.run_id} in the AAS Archive: ${archiveUrl}/runs/${s.run_id}/`,
      reached
        ? `${models} played ${game} through ${runtime} and reached "${goal}" in ${igt} in-game time (${real} real time).`
        : `${models} played ${game} through ${runtime} and did not reach "${goal}": the session stopped after ${igt} in-game time (${real} real time).`,
      ...(after ? [after] : []),
      ...(human ? [human] : []),
      ...(note ? [note] : []),
      "",
      which,
      ...(v.chapters.length ? ["", youtubeChapters(v.chapters, v.seconds) ? "Chapters" : "Moments", ...v.chapters.map((c) => `${youtubeTime(c.at)} ${c.label}`)] : []),
      "",
      v.line,
    ].join("\n");
    return { ...v, title: v.kind === "segment" ? `${base} · part ${v.part} of ${v.parts}` : base, description };
  });
}
