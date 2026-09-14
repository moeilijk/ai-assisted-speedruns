// `aas timeline <run-dir>`: speedrun timers, sections and the cut list from
// the private run.jsonl. Game time advances only during `game.playback`
// events (the TAS playbacks), so everything between them is thinking time
// that can be cut from the video.
//
// Writes into <run-dir>/timeline/: timeline.json, chapters.txt (raw recording
// time), chapters.cut.txt (after the cuts), cut.ffmpeg.txt + cut.sh (ffmpeg
// filter that keeps only the playbacks with a margin), timers.srt (RTA / IGT
// per playback, in cut-video time).
import fs from "node:fs";
import path from "node:path";
import { readRunLog } from "./events.mjs";

const hms = (s, ms = false) => {
  const sign = s < 0 ? "-" : "";
  s = Math.abs(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const base = `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(Math.floor(sec)).padStart(2, "0")}`;
  return ms ? `${base},${String(Math.round((sec % 1) * 1000)).padStart(3, "0")}` : base;
};

export function computeTimeline(runDir, options = {}) {
  // Cut margins: the plugin's defaults (brief.cut, e.g. a turn-based game keeps a few seconds after
  // every command so the result is visible), overridden by --margin-before/--margin-after.
  const briefFile = path.join(runDir, "brief.json");
  const briefCut = fs.existsSync(briefFile) ? JSON.parse(fs.readFileSync(briefFile, "utf8")).cut ?? {} : {};
  const marginBefore = Number(options.marginBefore ?? briefCut.marginBefore ?? 0.5);
  const marginAfter = Number(options.marginAfter ?? briefCut.marginAfter ?? 0.5);
  const log = readRunLog(runDir);
  const events = log.filter((r) => r.kind === "event");
  const recordingFile = path.join(runDir, "recording.json");
  const recording = fs.existsSync(recordingFile) ? JSON.parse(fs.readFileSync(recordingFile, "utf8")) : null;
  // Segments: one per recording (a resumed run has several). Run time (RTA)
  // is the sum of the segments; the downtime between them is not part of the run.
  const segments = (recording?.segments ?? (recording ? [{ t0: recording.t0, ended_at: recording.ended_at, files: recording.files }] : [])).map((sg, i) => ({
    index: i,
    t0: Date.parse(sg.t0),
    end: Date.parse(sg.ended_at ?? recording.ended_at),
    file: (sg.files ?? []).find((f) => /\.(mp4|mkv|mov|flv|ts)$/i.test(f)) ?? null,
  }));
  if (!segments.length) {
    const first = events.find((e) => e.event === "run.started") ?? log[0];
    const last = events.findLast((e) => e.event === "run.ended") ?? log.at(-1);
    if (!first) throw new Error("No t0: no recording.json, run.started event or records in run.jsonl.");
    segments.push({ index: 0, t0: Date.parse(first.timestamp), end: Date.parse(last.timestamp), file: null });
  }
  const t0ms = segments[0].t0;
  const segmentOf = (ms) => segments.findLast((sg) => ms >= sg.t0) ?? segments[0];
  // Run time of an absolute instant: elapsed within its segment plus the full length of the earlier ones.
  const rel = (ts) => {
    const ms = Date.parse(ts);
    const sg = segmentOf(ms);
    return segments.slice(0, sg.index).reduce((n, x) => n + (x.end - x.t0), 0) / 1000 + Math.min(Math.max(0, ms - sg.t0), sg.end - sg.t0) / 1000;
  };
  const endMs = segments.at(-1).end;

  // Playbacks: pair start/end by index.
  const playbacks = [];
  const open = new Map();
  for (const e of events) {
    if (e.event !== "game.playback") continue;
    if (e.data?.phase === "start") open.set(e.data.index, e);
    else if (e.data?.phase === "end") {
      const start = open.get(e.data.index);
      open.delete(e.data.index);
      const ticks = e.data.ticks ?? (typeof e.data.seconds === "number" ? Math.round(e.data.seconds / 0.015) : 0);
      playbacks.push({
        index: e.data.index,
        steps: start?.data?.steps ?? [],
        start: start ? rel(start.timestamp) : rel(e.timestamp) - (e.data.wall_ms ?? 0) / 1000,
        end: rel(e.timestamp),
        ticks,
        igt: Math.round(ticks * 15) / 1000,
        aborted: e.data.aborted === true,
        reason: e.data.reason ?? null,
        error: e.data.error ?? null,
      });
    }
  }
  const rta = segments.reduce((n, sg) => n + (sg.end - sg.t0), 0) / 1000;
  const segmentOffsets = segments.map((sg, i) => segments.slice(0, i).reduce((n, x) => n + (x.end - x.t0), 0) / 1000);
  const playbackWall = playbacks.reduce((n, p) => n + (p.end - p.start), 0);
  const igt = playbacks.reduce((n, p) => n + p.igt, 0);
  const toolCalls = log.filter((r) => r.kind === "tool_call").length;
  // The run up to its completion (options.completedAt: the published goal's victory, or the completion marker):
  // what came after it (credits, or a goal extension that is not published yet) is post-completion time. The
  // totals above stay the whole recording; these are the run's times to its goal.
  // The playback that won is still running when the victory is logged, so a playback counts when it started before completion.
  const done = options.completedAt ? rel(options.completedAt) : null;
  const upTo = done === null ? null : playbacks.filter((p) => p.start <= done + 0.001);
  const wallTo = done === null ? 0 : upTo.reduce((n, p) => n + (Math.min(p.end, done) - p.start), 0);
  const totalsToCompletion = done === null ? null : {
    rta: done,
    igt: upTo.reduce((n, p) => n + p.igt, 0),
    playback_wall: wallTo,
    thinking: done - wallTo,
    tool_calls: log.filter((r) => r.kind === "tool_call" && rel(r.timestamp) <= done + 0.001).length,
    playbacks: upTo.length,
  };

  // Runs (attempts) inside the session: a death ends a run, `game.attempt start` begins the next one from the
  // beginning; the death that ended the previous run is the cut point for the next one.
  const attemptStarts = events.filter((e) => e.event === "game.attempt" && e.data?.phase === "start").map((e) => ({ at: rel(e.timestamp), n: Number(e.data.attempt) || 0 }));
  // A victory followed by a goal extension (game.goal at a resume) that was reached later did not end the attempt:
  // the run went on to that victory. An extension that was not reached leaves the earlier victory as the end.
  const goalChanges = events.filter((e) => e.event === "game.goal").map((e) => rel(e.timestamp));
  const overs = events.filter((e) => e.event === "game.over").map((e) => ({ at: rel(e.timestamp), victory: e.data?.victory === true, label: e.data?.label ?? null, floor: e.data?.floor ?? null })).filter((o, _, all) => !(o.victory && goalChanges.some((g) => g > o.at && all.some((x) => x.victory && x.at > g))));
  // The seed of every run, when the game has one: attempt 1 from game.ready (prepareRun), the next ones from game.attempt.
  const ready = events.find((e) => e.event === "game.ready");
  const seedOf = (d) => (d?.seed === undefined || d?.seed === null ? null : String(d.seed));
  const attemptStartEvents = events.filter((e) => e.event === "game.attempt" && e.data?.phase === "start");
  const attempts = [{ n: 1, start: 0, card_at: 0, seed: seedOf(ready?.data), seed_code: ready?.data?.seed_code ?? null }, ...attemptStarts.map((a, i) => ({ n: a.n || i + 2, start: a.at, card_at: overs.filter((o) => !o.victory && o.at <= a.at).at(-1)?.at ?? a.at, seed: seedOf(attemptStartEvents[i]?.data), seed_code: attemptStartEvents[i]?.data?.seed_code ?? null }))].map((a, i, all) => {
    const end = all[i + 1]?.card_at ?? rta;
    const over = overs.find((o) => o.at >= a.start && o.at <= end + 0.001);
    const inside = playbacks.filter((p) => p.end > a.start && p.end <= end + 0.001);
    return { attempt: a.n, start_rta: a.start, end_rta: end, card_at: a.card_at, rta: end - a.start, igt: inside.reduce((n, p) => n + p.igt, 0), playbacks: inside.length, outcome: over ? (over.victory ? "victory" : "death") : "stopped", ended: over?.label ?? null, floor: over?.floor ?? null, seed: a.seed, seed_code: a.seed_code };
  });
  // Sections: from t0, split at chapter milestones and at every next run, end at run.ended.
  const bounds = [{ at: 0, label: "Start" }];
  for (const e of events) {
    if (e.event === "game.milestone" && e.data?.chapter) bounds.push({ at: rel(e.timestamp), label: String(e.data.label ?? "milestone") });
    if (e.event === "game.attempt" && e.data?.phase === "start") bounds.push({ at: rel(e.timestamp), label: `Attempt ${e.data.attempt ?? "?"}` });
    if (e.event === "run.human") bounds.push({ at: rel(e.timestamp), label: `Human: ${e.data?.note ?? "intervention"}` });
  }
  // Where the run's sections end: at completion, or at the milestone that reached the goal when nothing of the run (a
  // tool call, a playback starting) lies between that milestone and the victory it caused.
  const lastBound = done === null ? null : bounds.filter((b) => b.at <= done + 0.001).at(-1);
  const busy = (from) => log.some((r) => (r.kind === "tool_call" || (r.kind === "event" && r.event === "game.playback" && r.data?.phase === "start")) && rel(r.timestamp) > from + 0.0005 && rel(r.timestamp) <= done + 0.001);
  const completionBound = done === null ? null : lastBound && lastBound.at > 0 && !busy(lastBound.at) ? lastBound.at : done;
  // --attempt last|N: the cut keeps only that run, from the death that ended the run before to its end.
  const selected = options.attempt === undefined || options.attempt === null ? null : options.attempt === "last" ? attempts.at(-1) : attempts.find((a) => a.attempt === Number(options.attempt));
  if (options.attempt !== undefined && options.attempt !== null && !selected) throw new Error(`No attempt ${options.attempt}; the session has ${attempts.length}.`);
  const sections = bounds.map((b, i) => {
    const end = bounds[i + 1]?.at ?? rta;
    const inside = playbacks.filter((p) => p.end > b.at && p.end <= end);
    return {
      label: b.label,
      start_rta: b.at,
      end_rta: end,
      rta: end - b.at,
      igt: inside.reduce((n, p) => n + p.igt, 0),
      playback_wall: inside.reduce((n, p) => n + (p.end - p.start), 0),
      playbacks: inside.length,
      split_igt: playbacks.filter((p) => p.end <= end).reduce((n, p) => n + p.igt, 0),
      post_completion: done !== null && b.at >= completionBound - 0.001,
    };
  });

  // Keep intervals (video time in the raw recording), merged with margins.
  const keep = [];
  const cutPlaybacks = selected ? playbacks.filter((p) => p.end > selected.card_at && p.start < selected.end_rta + 0.001) : playbacks;
  for (const p of cutPlaybacks.sort((a, b) => a.start - b.start)) {
    const a = Math.max(0, selected ? Math.max(selected.card_at, p.start - marginBefore) : p.start - marginBefore), b = Math.min(selected ? selected.end_rta : rta, p.end + marginAfter);
    if (keep.length && a <= keep.at(-1)[1]) keep.at(-1)[1] = Math.max(keep.at(-1)[1], b);
    else keep.push([a, b]);
  }
  // The cut opens where the run opens: everything from the recording's first frame (the game's own title
  // screen, the run being started) up to the first playback stays in, so the cut shows a run from its start.
  if (keep.length) keep[0][0] = selected ? selected.card_at : 0;
  const kept = keep.reduce((n, [a, b]) => n + (b - a), 0);
  // Map a raw time to cut-video time.
  const toCut = (t) => {
    let acc = 0;
    for (const [a, b] of keep) {
      if (t <= a) return acc;
      if (t <= b) return acc + (t - a);
      acc += b - a;
    }
    return acc;
  };
  // Keep intervals per recording file (video time within that file).
  const keepByFile = segments.map((sg, i) => ({
    file: sg.file,
    keep: keep.map(([a, b]) => [a - segmentOffsets[i], b - segmentOffsets[i]]).map(([a, b]) => [Math.max(0, a), Math.min((sg.end - sg.t0) / 1000, b)]).filter(([a, b]) => b > a),
  }));
  return {
    t0: new Date(t0ms).toISOString(),
    recorder: recording?.recorder ?? null,
    segments: segments.map((sg, i) => ({ index: i, t0: new Date(sg.t0).toISOString(), ended_at: new Date(sg.end).toISOString(), seconds: (sg.end - sg.t0) / 1000, offset: segmentOffsets[i], file: sg.file })),
    keep_by_file: keepByFile,
    completed_rta: done,
    totals_to_completion: totalsToCompletion,
    totals: { rta, igt, playback_wall: playbackWall, thinking: rta - playbackWall, tool_calls: toolCalls, playbacks: playbacks.length, cut_video: kept, attempts: attempts.length, deaths: overs.filter((o) => !o.victory).length },
    attempts,
    cut_attempt: selected ? selected.attempt : null,
    sections,
    playbacks,
    keep,
    cut_chapters: sections.map((s) => ({ at: toCut(s.start_rta), label: s.label })),
    timers: playbacks.map((p, i) => ({
      cut_start: toCut(p.start),
      cut_end: toCut(p.end),
      rta_at_end: p.end,
      igt_at_end: playbacks.slice(0, i + 1).reduce((n, q) => n + q.igt, 0),
      section: sections.findLast((s) => s.start_rta <= p.end)?.label ?? "Start",
    })),
  };
}

export function writeTimeline(runDir, timeline, { video = "recording/recording.mkv", output = "recording/recording.cut.mp4" } = {}) {
  const dir = path.join(runDir, "timeline");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "chapters.txt"), `${timeline.sections.map((s) => `${hms(s.start_rta)} ${s.label}`).join("\n")}\n`);
  fs.writeFileSync(path.join(dir, "chapters.cut.txt"), `${timeline.cut_chapters.map((c) => `${hms(c.at)} ${c.label}`).join("\n")}\n`);
  const expr = timeline.keep.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+") || "0";
  fs.writeFileSync(path.join(dir, "cut.ffmpeg.txt"), `[0:v]select='${expr}',setpts=N/FRAME_RATE/TB[v];\n[0:a]aselect='${expr}',asetpts=N/SR/TB[a]\n`);
  fs.writeFileSync(path.join(dir, "cut.sh"), `#!/bin/sh\n# Keep only the playbacks (thinking pauses removed). Generated by aas timeline; use \`aas render\` for resumed runs with several files.\nffmpeg -i "${video}" -filter_complex_script "timeline/cut.ffmpeg.txt" -map "[v]" -map "[a]" "${output}"\n`, { mode: 0o755 });
  const srt = timeline.timers.map((t, i) => `${i + 1}\n${hms(t.cut_start, true)} --> ${hms(t.cut_end, true)}\nRTA ${hms(t.rta_at_end)}  IGT ${hms(t.igt_at_end)}  ${t.section}\n`).join("\n");
  fs.writeFileSync(path.join(dir, "timers.srt"), `${srt}\n`);
  // Input display: one cue per plan step with the keys held, in cut-video time.
  const cues = [];
  for (const p of timeline.playbacks) {
    const started = timeline.timers.find((x) => x.rta_at_end === p.end);
    let at = started?.cut_start ?? 0;
    for (const step of p.steps ?? []) {
      const dur = step.ticks * 0.015;
      const keys = [...(step.keys ?? []), ...(step.yaw ? [`yaw ${step.yaw > 0 ? "←" : "→"}${Math.abs(step.yaw)}°`] : []), ...(step.pitch ? [`pitch ${step.pitch > 0 ? "↓" : "↑"}${Math.abs(step.pitch)}°`] : [])];
      cues.push(`${cues.length + 1}\n${hms(at, true)} --> ${hms(at + dur, true)}\n${keys.length ? keys.join("  ") : "(wait)"}\n`);
      at += dur;
    }
  }
  fs.writeFileSync(path.join(dir, "inputs.srt"), `${cues.join("\n")}\n`);
  return dir;
}

export function formatTimeline(t) {
  const lines = [
    `t0 ${t.t0}  recorder ${t.recorder ?? "-"}`,
    `RTA ${hms(t.totals.rta)}   IGT ${hms(t.totals.igt)} (${t.totals.playbacks} playbacks, ${t.totals.tool_calls} tool calls)   thinking ${hms(t.totals.thinking)}   cut video ${hms(t.totals.cut_video)}`,
    "sections:",
  ];
  for (const s of t.sections) lines.push(`  ${hms(s.start_rta)}  ${s.label.padEnd(40)}  section IGT ${hms(s.igt)}  split IGT ${hms(s.split_igt)}  RTA ${hms(s.rta)}`);
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("timeline.mjs")) {
  const dir = process.argv[2];
  if (!dir) throw new Error("Usage: timeline <run-dir>");
  const t = computeTimeline(path.resolve(dir));
  writeTimeline(path.resolve(dir), t);
  console.log(formatTimeline(t));
}
