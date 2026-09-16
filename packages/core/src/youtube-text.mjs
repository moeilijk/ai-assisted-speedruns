// The suggested title and description of each video a runner may upload, from the bundle's summary. The tooling
// writes them into the bundle (summary.recording.videos[].title/description) and an archive may make them for a
// bundle that has none, with this same module. Imports only modules without imports, so an archive can carry it.
//
// What a viewer sees decides the order: YouTube shows the first lines before "more", and a link in a description is
// not clickable on every channel and is shortened in view, so the result comes first, then the archive's domain and
// the run id as plain text. Timestamps are called chapters only when YouTube makes chapters of them. The line that
// binds the video to the bundle is the last line.
import { formatDuration, youtubeTime } from "./videos.mjs";
import { modelDisplayName } from "./models.mjs";

/**
 * Whether YouTube turns these timestamps into chapters: at least three, the first at 0:00, and every chapter at least
 * ten seconds long, the last one up to the end of the video.
 */
export function youtubeChapters(chapters, seconds) {
  if (chapters.length < 3 || youtubeTime(chapters[0].at) !== "0:00") return false;
  const ends = [...chapters.slice(1).map((c) => c.at), seconds ?? Infinity];
  return chapters.every((c, i) => ends[i] - c.at >= 10);
}

const endLabel = (summary, id) => summary.ends?.find((e) => e.id === id)?.label ?? id;

/** A moment's label in words a viewer knows: the harness's event names become sentences, goal ids their labels. */
export function momentLabel(label, summary = {}) {
  const text = String(label);
  const resumed = /^Human: resumed after (.+)$/.exec(text);
  if (resumed) {
    const why = { stopped: "it stopped", "a stop": "it stopped", failed: "a runtime error", "a runtime error": "a runtime error", completed: "it reached its goal" }[resumed[1]] ?? resumed[1];
    return `A human restarted the agent after ${why}`;
  }
  const extended = /^Human: goal extended from (\S+) to (\S+)$/.exec(text);
  if (extended) return `Goal extended from ${endLabel(summary, extended[1])} to ${endLabel(summary, extended[2])}`;
  if (/^Human: /.test(text)) return `A human intervened: ${text.slice(7)}`;
  return text;
}

/** The moments of a video for its description: labels for viewers, moments less than ten seconds apart on one line. */
export function videoMoments(chapters, summary = {}) {
  const out = [];
  for (const c of [...chapters].sort((a, b) => a.at - b.at)) {
    const label = momentLabel(c.label, summary);
    const last = out.at(-1);
    if (last && c.at - last.at < 10) { if (!last.labels.includes(label)) last.labels.push(label); }
    else out.push({ at: c.at, labels: [label] });
  }
  return out.map((m) => ({ at: m.at, label: m.labels.join("; ") }));
}

const facts = (s) => {
  const game = s.game?.game ?? s.category?.game ?? "the game";
  const goal = s.category?.goal_end?.label ?? s.category?.goal ?? "its goal";
  const models = [...new Set((s.models ?? []).map((m) => m.model))].map(modelDisplayName).join(", ") || "a model";
  const runtime = s.harness?.plugins?.runtime?.name ?? s.harness?.plugins?.runtime?.id ?? "its runtime";
  const ttc = s.totals_to_completion;
  const reached = Boolean(s.completed_at && ttc);
  const igt = formatDuration(reached ? ttc.igt_seconds : s.recording?.igt_seconds);
  const real = formatDuration(reached ? ttc.rta_seconds : s.recording?.wall_clock_seconds ?? s.recording?.duration_seconds);
  return { game, goal, models, runtime, reached, igt, real };
};

/** The suggested title: game, goal and result, model; a part of a resumed run says which part. */
export function videoTitle(summary, video) {
  const f = facts(summary);
  const base = f.reached ? `${f.game} · ${f.goal} in ${f.igt} · ${f.models}` : `${f.game} · ${f.goal}, not reached · ${f.models}`;
  return video.kind === "segment" ? `${base} · part ${video.part} of ${video.parts}` : base;
}

/**
 * The suggested description. `archiveUrl` is the archive's address (only its domain is shown); `note` is the
 * publisher's own sentence, or null; `videos` are all videos of the run (default summary.recording.videos), so every
 * one of them names what happened in the run, such as a goal extension, wherever its moment is.
 */
export function videoDescription(summary, video, { archiveUrl, note = null, videos = summary.recording?.videos ?? [video] }) {
  const s = summary;
  const f = facts(s);
  const whole = (x) => formatDuration(x, { whole: true });
  const full = whole(s.recording?.duration_seconds);
  const domain = String(archiveUrl).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const moments = videoMoments(video.chapters ?? [], s);
  const extension = videos.flatMap((v) => v.chapters ?? []).map((c) => /Goal extended from .+ to (.+)$/.exec(momentLabel(c.label, s))?.[1]).find(Boolean);
  const human = s.category?.human === "restart-only"
    ? "A human restarted the agent after it stopped; no game help was given."
    : s.category?.human === "assisted" ? `A human assisted: ${s.category?.human_notes ?? "see the run's page in the archive"}.` : null;
  const after = f.reached && extension
    ? `After reaching ${f.goal}, the goal was extended to ${extension}, which was not reached: that part is in the recording, not in the run's time.`
    : f.reached && (s.recording?.igt_seconds ?? 0) > (s.totals_to_completion?.igt_seconds ?? 0) + 0.05
      ? "The recording goes on after the goal was reached; what was played after it is not part of the run's time."
      : null;
  const which = video.kind === "cut"
    ? `This is the cut version (${whole(video.seconds)}): the pauses while the model was thinking are removed. The full recording runs ${full}.`
    : video.kind === "segment"
      ? `This is part ${video.part} of ${video.parts} of the full recording (${whole(video.seconds)} of ${full}): the run was resumed${video.part < video.parts ? ` and continues in part ${video.part + 1}` : ""}.`
      : `This is the full recording (${full}).`;
  return [
    f.reached
      ? `${f.models} played ${f.game} in ${f.runtime} and reached the goal "${f.goal}" in ${f.igt} in-game time (${f.real} real time).`
      : `${f.models} played ${f.game} in ${f.runtime} and did not reach the goal "${f.goal}": the run stopped after ${f.igt} in-game time (${f.real} real time).`,
    `AAS Archive: ${domain} — run ${s.run_id}`,
    "",
    "An AI Assisted Speedrun: a language model plays the game on its own, timed in-game and in real time.",
    ...(human ? [human] : []),
    ...(after ? [after] : []),
    ...(note ? [note] : []),
    "",
    which,
    ...(moments.length ? ["", youtubeChapters(moments, video.seconds) ? "Chapters" : "Moments", ...moments.map((m) => `${youtubeTime(m.at)} ${m.label}`)] : []),
    "",
    "Verification line for the AAS Archive:",
    video.line,
  ].join("\n");
}

/** The videos with their suggested title and description, as the bundle carries them. */
export const withVideoTexts = (videos, summary, { archiveUrl, note = null }) =>
  videos.map((v) => ({ ...v, title: videoTitle(summary, v), description: videoDescription(summary, v, { archiveUrl, note, videos }) }));
