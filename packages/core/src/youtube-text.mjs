// The suggested title and description of each video a runner may upload, from the bundle's summary. The tooling
// writes them into the bundle (summary.recording.videos[].title/description) and an archive may make them for a
// bundle that has none, with this same module. Imports only modules without imports, so an archive can carry it.
//
// Written for a viewer, in plain sentences: who plays what and how it ended first (YouTube shows only the first
// lines before "more"), then what the picture shows, then what happens in this video and nothing it does not show.
// No links: a link in a description is not clickable on every channel and is shortened in view, so the archive's
// domain and the run id are plain text. Timestamps are called chapters only when YouTube makes chapters of them. The
// line that binds the video to the bundle is the last line.
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

/**
 * The moments of a video for its description: labels for viewers, moments less than ten seconds apart on one line
 * (a sentence the harness wrote goes on in lower case there; a game's own name keeps its capital). A video whose only
 * moment is its start has none worth listing.
 */
export function videoMoments(chapters, summary = {}) {
  const out = [];
  for (const c of [...chapters].sort((a, b) => a.at - b.at)) {
    const label = momentLabel(c.label, summary);
    const sentence = label !== String(c.label);
    const last = out.at(-1);
    if (last && c.at - last.at < 10) {
      const joined = sentence ? label.charAt(0).toLowerCase() + label.slice(1) : label;
      if (!last.labels.includes(label) && !last.labels.includes(joined)) last.labels.push(joined);
    } else out.push({ at: c.at, labels: [label] });
  }
  const moments = out.map((m) => ({ at: m.at, label: m.labels.join("; ") }));
  return moments.length === 1 && moments[0].label === "Start" ? [] : moments;
}

/** A goal's label as it reads in a sentence: "the end credits", "the Act 1 boss". */
const goalPhrase = (label) => `the ${/^[A-Z][a-z]* \d/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1)}`;

const facts = (s) => {
  const game = s.game?.game ?? s.category?.game ?? "the game";
  const goal = s.category?.goal_end?.label ?? s.category?.goal ?? "its goal";
  const names = [...new Set((s.models ?? []).map((m) => m.model))].map(modelDisplayName);
  const models = names.join(" and ") || "A language model";
  const ttc = s.totals_to_completion;
  const reached = Boolean(s.completed_at && ttc);
  const igt = formatDuration(reached ? ttc.igt_seconds : s.recording?.igt_seconds);
  const real = formatDuration(reached ? ttc.rta_seconds : s.recording?.wall_clock_seconds ?? s.recording?.duration_seconds);
  return { game, goal, models, several: names.length > 1, reached, igt, real };
};

/** The suggested title: who plays what, which video, and how it ended. */
export function videoTitle(summary, video) {
  const f = facts(summary);
  const which = video.kind === "cut" ? " (cut)" : video.kind === "segment" ? ` (part ${video.part} of ${video.parts})` : "";
  const result = f.reached ? `reached ${goalPhrase(f.goal)} in ${f.igt}` : `stopped before ${goalPhrase(f.goal)}`;
  return `${f.models} ${f.several ? "play" : "plays"} ${f.game}${which} — ${result}`;
}

/** What happened at a moment of this video, as a sentence; null for the start. */
function momentSentence(moment, summary, video, f) {
  const at = youtubeTime(moment.at);
  const labels = moment.raw.map((l) => String(l));
  const extended = labels.map((l) => /^Human: goal extended from \S+ to (\S+)$/.exec(l)?.[1]).find(Boolean);
  const resumed = labels.map((l) => /^Human: resumed after (.+)$/.exec(l)?.[1]).find(Boolean);
  const goalHere = labels.includes(f.goal);
  const others = labels.filter((l) => l !== "Start" && l !== f.goal && !/^Human: /.test(l));
  const parts = [];
  if (goalHere) parts.push(`At ${at} it reached ${goalPhrase(f.goal)}${video.seconds - moment.at > 10 && !extended ? "; what follows does not count toward the run's time" : ""}.`);
  if (extended) parts.push(`${goalHere ? "Then" : `At ${at}`} a person started the model again with a new goal, ${goalPhrase(endLabel(summary, extended))}, which it did not reach. This part does not count toward the run's time.`);
  else if (resumed) {
    const help = summary.category?.human === "assisted" ? `The person helped: ${summary.category?.human_notes ?? "see the run in the archive"}.` : "The person did not help with the game.";
    const had = { failed: "stopped on an error", "a runtime error": "stopped on an error", completed: "reached its goal" }[resumed] ?? "stopped";
    parts.push(`At ${at} the model had ${had} and a person started it again. ${help}`);
  }
  for (const l of labels.filter((x) => /^Human: /.test(x) && !/^Human: (resumed after|goal extended)/.test(x))) parts.push(`At ${at} a person stepped in: ${l.slice(7)}.`);
  if (others.length) parts.push(`At ${at}: ${others.join("; ")}.`);
  return parts.join(" ") || null;
}

/**
 * The suggested description, in plain sentences, about this video only. `archiveUrl` is the archive's address (only
 * its domain is shown); `note` is the publisher's own sentence, or null.
 */
export function videoDescription(summary, video, { archiveUrl, note = null }) {
  const s = summary;
  const f = facts(s);
  const domain = String(archiveUrl).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const goal = goalPhrase(f.goal);
  const intro = [
    `${f.models}, ${f.several ? "language models, play" : "a language model, plays"} ${f.game} by ${f.several ? "themselves" : "itself"}.`,
    f.reached
      ? `Its goal was ${goal}; it got there in ${f.igt} of game time (${f.real} of real time).`
      : `Its goal was ${goal}; it stopped after ${f.igt} of game time (${f.real} of real time) without reaching that goal.`,
  ].join(" ");
  // What the picture shows: the game, LiveSplit when the OBS recorder recorded it next to the LiveSplit timer, and the
  // harness's overlay (recorder-obs and overlay-server.mjs place them).
  const plugins = s.harness?.plugins ?? {};
  const liveSplit = plugins.recorder?.id === "obs" && plugins.timer?.id === "livesplit";
  const overlay = s.recording?.overlay;
  const full = formatDuration(s.recording?.duration_seconds);
  const view = [
    "What you see: the game as the model played it.",
    ...(liveSplit ? ["Top left is LiveSplit, the speedrun timer with its splits."] : []),
    ...(overlay?.shown ? [`Bottom left are the name of the current section, two clocks, real time (RTA) and game time (IGT)${overlay.keys ? ", the keys the model pressed" : ""}, and the last command the model sent.`] : []),
    video.kind === "cut"
      ? `In this cut the pauses while the model was thinking are left out, so ${full} of recording becomes ${formatDuration(video.seconds)}.`
      : video.kind === "segment"
        ? `This is part ${video.part} of ${video.parts} of the recording (${formatDuration(video.seconds)} of ${full}): the run was paused${video.part < video.parts ? ` and continues in part ${video.part + 1}` : " and continued here"}.`
        : `This is the whole recording (${full}).`,
  ].join(" ");
  // Only what this video shows: its own moments, in order, merged when less than ten seconds apart.
  const moments = [];
  for (const c of [...(video.chapters ?? [])].sort((a, b) => a.at - b.at)) {
    const last = moments.at(-1);
    if (last && c.at - last.at < 10) { if (!last.raw.includes(c.label)) last.raw.push(c.label); } else moments.push({ at: c.at, raw: [c.label] });
  }
  const told = moments.map((m) => momentSentence(m, s, video, f)).filter(Boolean);
  const listed = videoMoments(video.chapters ?? [], s);
  const chapters = youtubeChapters(listed, video.seconds) ? ["Chapters", ...listed.map((m) => `${youtubeTime(m.at)} ${m.label}`)] : [];
  const about = `This is an AI Assisted Speedrun: a language model plays the game and no person touches the controls; the run is timed in game time and in real time. Run ${s.run_id} is in the AAS Archive: ${domain}`;
  return [
    intro,
    "",
    view,
    ...(told.length ? ["", told.join(" ")] : []),
    ...(chapters.length ? ["", ...chapters] : []),
    "",
    about,
    ...(note ? ["", note] : []),
    "",
    "Verification line for the AAS Archive:",
    video.line,
  ].join("\n");
}

/** The videos with their suggested title and description, as the bundle carries them. */
export const withVideoTexts = (videos, summary, { archiveUrl, note = null }) =>
  videos.map((v) => ({ ...v, title: videoTitle(summary, v), description: videoDescription(summary, v, { archiveUrl, note }) }));
