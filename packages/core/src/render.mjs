// `aas render <run-dir>`: make the YouTube-style video from the recording:
// keep only the playbacks (the agent's thinking pauses are cut, per the
// timeline), optionally burn in timers.srt and/or inputs.srt for runs where
// LiveSplit or the overlay were not captured. Needs ffmpeg on the PATH.
//
//   aas render <run-dir> [--video <file>] [--out <file>] [--burn timers,inputs] [--no-cut] [--crf 18]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { computeTimeline, writeTimeline } from "./timeline.mjs";
import { formatDuration, writeUploadSheet } from "./upload-sheet.mjs";

const VIDEO_RE = /\.(mp4|mkv|mov|flv|ts)$/i;

export function findRecording(runDir) {
  const dir = path.join(runDir, "recording");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => VIDEO_RE.test(f) && !/\.cut\./.test(f)).map((f) => path.join(dir, f));
  return files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] ?? null;
}

export function ffmpegArgs({ video, videos, out, keep, keepByFile, burn = [], timelineDir, crf = 18, cut = true }) {
  const filters = [];
  const inputs = videos?.length ? videos : [video];
  let v = "[0:v]", a = "[0:a]";
  if (inputs.length > 1) {
    // One recording per segment: cut each, then concatenate in order.
    const parts = inputs.map((_, i) => {
      const k = keepByFile?.[i]?.keep ?? [];
      const expr = k.length && cut ? k.map(([s, e]) => `between(t,${s.toFixed(3)},${e.toFixed(3)})`).join("+") : "1";
      filters.push(`[${i}:v]select='${expr}',setpts=N/FRAME_RATE/TB[v${i}]`, `[${i}:a]aselect='${expr}',asetpts=N/SR/TB[a${i}]`);
      return `[v${i}][a${i}]`;
    });
    filters.push(`${parts.join("")}concat=n=${inputs.length}:v=1:a=1[vc][ac]`);
    v = "[vc]";
    a = "[ac]";
  } else if (cut && keep.length) {
    const expr = keep.map(([s, e]) => `between(t,${s.toFixed(3)},${e.toFixed(3)})`).join("+");
    filters.push(`${v}select='${expr}',setpts=N/FRAME_RATE/TB[vc]`, `${a}aselect='${expr}',asetpts=N/SR/TB[ac]`);
    v = "[vc]";
    a = "[ac]";
  }
  const esc = (p) => p.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
  let i = 0;
  for (const name of burn) {
    const srt = path.join(timelineDir, `${name}.srt`);
    if (!fs.existsSync(srt)) throw new Error(`${srt} not found; run aas timeline first`);
    const style = name === "inputs" ? "Alignment=2,FontSize=22,Outline=2" : "Alignment=7,FontSize=20,Outline=2,MarginV=20";
    filters.push(`${v}subtitles='${esc(srt)}':force_style='${style}'[vs${i}]`);
    v = `[vs${i++}]`;
  }
  const args = ["-y", ...inputs.flatMap((f) => ["-i", f])];
  if (filters.length) args.push("-filter_complex", filters.join(";"), "-map", v, "-map", a);
  // No chapters and no data streams: ffmpeg copies the recording's chapter marks into the cut by default, and
  // the MP4 muxer writes them as a text track at the recording's full length. A player then reports that
  // length for the cut and stops when the picture ends (, measured: in VLC: 22:48 shown, playback over
  // at 11:18; ffprobe: a bin_data stream of 1368 s next to 678 s of video). -dn alone did not remove it, the
  // track comes from the chapters, so -map_chapters -1 (verified on a 10 s cut). The cut's own chapters are in
  // chapters.cut.txt.
  args.push("-map_chapters", "-1", "-dn", "-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out);
  return args;
}

export function render(runDir, { video, out, burn = [], cut = true, crf, marginBefore, marginAfter, attempt, log = console.log } = {}) {
  runDir = path.resolve(runDir);
  const timeline = computeTimeline(runDir, { marginBefore, marginAfter, attempt });
  const timelineDir = writeTimeline(runDir, timeline);
  const segmentVideos = (timeline.segments ?? []).map((sg) => (sg.file ? path.join(runDir, sg.file) : null));
  const videos = !video && segmentVideos.length > 1 && segmentVideos.every((f) => f && fs.existsSync(f)) ? segmentVideos : null;
  video = video ? path.resolve(video) : videos ? videos[0] : findRecording(runDir);
  if (!video || !fs.existsSync(video)) throw new Error("No video recording found under <run>/recording/; pass --video.");
  out = out ? path.resolve(out) : video.replace(VIDEO_RE, "") + ".cut.mp4";
  const args = ffmpegArgs({ video, videos, out, keep: timeline.keep, keepByFile: timeline.keep_by_file, burn, timelineDir, crf, cut });
  log(`ffmpeg ${args.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(" ").slice(0, 400)}${args.join(" ").length > 400 ? " …" : ""}`);
  const r = spawnSync("ffmpeg", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.split("\n").filter((l) => l.trim()).slice(-5).join(" | ")}`);
  const kept = timeline.keep.reduce((n, [s, e]) => n + (e - s), 0);
  log(`written ${out}: ${formatDuration(kept, { whole: true })} kept of ${formatDuration(timeline.totals.rta, { whole: true })} (${timeline.playbacks.length} playbacks); chapters in ${path.join(timelineDir, "chapters.cut.txt")}`);
  // A published run gets its upload sheet again, now naming the cut video and its chapters.
  const uploadSheet = writeUploadSheet(runDir, { log });
  return { out, kept, timeline, uploadSheet };
}

/**
 * The cut after a run or a resume, so a run directory holds its whole package: the recording and the video without
 * the thinking pauses (with the timeline it is made from). Until 2026-09-25 only a hand-run `aas render` made it, and
 * after the GUI (0.18.4) left that step out no run had one. Without a video there is nothing to cut; a failure is
 * logged with the command that makes the cut, and the run's own result stands.
 */
export function renderAfterRun(runDir, { log = console.log } = {}) {
  if (!findRecording(runDir)) {
    log("no video recording, so no cut");
    return null;
  }
  try {
    return render(runDir, { log });
  } catch (e) {
    log(`the cut could not be made: ${e.message}; \`aas render ${runDir}\` makes it`);
    return null;
  }
}

export function probeDuration(file) {
  try {
    return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}

if (process.argv[1]?.endsWith("render.mjs")) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
  const dir = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
  render(dir, { video: opt("--video"), out: opt("--out"), burn: (opt("--burn") ?? "").split(",").filter(Boolean), cut: !args.includes("--no-cut"), crf: opt("--crf") });
}
