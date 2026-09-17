// The suggested title and description of each video a runner may upload, from the bundle's summary. The tooling
// writes them into the bundle (summary.recording.videos[].title/description) and an archive may make them for a
// bundle that has none, with this same module. Imports only modules without imports, so an archive can carry it.
//
// Written for a viewer, in plain sentences: who plays what and how it ended first (YouTube shows only the first
// lines before "more"), then which video this is, what the picture shows, and what happens in this video as
// "m:ss what happens". How a person restarted the run is the archive's to show, not the description's (owner
// 16-09). No links: the archive's domain and the run id are plain text. The code that binds the video to the bundle
// is the last line.
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

/**
 * A duration as it stands in a description: YouTube makes every m:ss and h:mm:ss within the video's length a link to
 * that place, also inside a sentence. A word joiner (U+2060) before each colon stops that and looks the same
 * (measured by the owner on 2026-09-17 on the cut of portal-02). Places in the video ("2:10 The run is resumed.") keep
 * plain colons.
 */
export const WORD_JOINER = "\u2060";
export const durationText = (text) => String(text).replace(/:/g, `${WORD_JOINER}:`);

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
  const real = formatDuration(reached ? ttc.rta_seconds : s.recording?.wall_clock_seconds ?? s.recording?.duration_seconds, { whole: true });
  // The title is not linked by YouTube; the description writes the same durations through durationText.
  return { game, goal, models, several: names.length > 1, reached, igt, real };
};

/**
 * The moments of a video that belong to this run: for a run that reached its goal, nothing after the goal (owner
 * 2026-09-17, the cut of the act 1 run: after the Act 1 boss the video shows the game's main menu of a later session,
 * and "the run is resumed, the goal is extended" belongs to an extension that is not published). A segment that
 * starts after the goal (its first moment is a resume after completion) has none.
 */
function runChapters(chapters, f) {
  const sorted = [...(chapters ?? [])].sort((a, b) => a.at - b.at);
  if (!f.reached) return sorted;
  const out = [];
  for (const c of sorted) {
    if (/^Human: resumed after completed/.test(String(c.label))) break;
    out.push(c);
    if (String(c.label) === f.goal) break;
  }
  return out;
}
const afterGoal = (video, f) => f.reached && /^Human: resumed after completed/.test(String([...(video.chapters ?? [])].sort((a, b) => a.at - b.at)[0]?.label ?? ""));

/** The suggested title: who plays what, which video, and how it ended. */
export function videoTitle(summary, video) {
  const f = facts(summary);
  const which = video.kind === "cut" ? " (cut)" : video.kind === "segment" ? ` (part ${video.part} of ${video.parts})` : "";
  const result = f.reached ? `reached ${goalPhrase(f.goal)} in ${f.igt}` : `stopped before ${goalPhrase(f.goal)}`;
  return `${f.models} ${f.several ? "play" : "plays"} ${f.game}${which}: ${result}`;
}

/** What happens at a moment of this video, in a few words; null for the start. How a person restarted is the archive's. */
function momentText(labels, summary, f) {
  const parts = [];
  for (const l of labels.map(String)) {
    const extended = /^Human: goal extended from \S+ to (\S+)$/.exec(l);
    if (l === "Start") continue;
    if (l === f.goal) parts.push(`The run reaches ${goalPhrase(f.goal)}.`);
    else if (extended) parts.push(`The goal is extended to ${goalPhrase(endLabel(summary, extended[1]))}.`);
    else if (/^Human: resumed after /.test(l)) parts.push("The run is resumed.");
    else if (/^Human: /.test(l)) parts.push("A person steps in.");
    else parts.push(`${l}.`);
  }
  return [...new Set(parts)].join(" ") || null;
}

/**
 * The suggested description, in plain sentences, about this video only. `archiveUrl` is the archive's address (only
 * its domain is shown); `note` is the publisher's own sentence, or null. The wording is the one the owner approved
 * on 2026-09-16 for the cut of portal-02.
 */
export function videoDescription(summary, video, { archiveUrl, note = null }) {
  const s = summary;
  const f = facts(s);
  const domain = String(archiveUrl).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const goal = goalPhrase(f.goal);
  const igt = durationText(f.igt);
  const real = durationText(f.real);
  const intro = [
    `${f.models}, ${f.several ? "language models, play" : "a language model, plays"} ${f.game} by ${f.several ? "themselves" : "itself"}.`,
    `Goal: ${goal}.`,
    f.reached
      ? `The run reached ${goal} after ${igt} of game time and ${real} of real time.`
      : `The run ended before ${goal}, after ${igt} of game time and ${real} of real time.`,
  ].join(" ");
  const full = durationText(formatDuration(s.recording?.duration_seconds, { whole: true }));
  const own = durationText(formatDuration(video.seconds, { whole: true }));
  const which = video.kind === "cut"
    ? `This cut leaves out the pauses while the model was thinking: ${full} of recording in ${own}.`
    : video.kind === "segment"
      ? `This is part ${video.part} of ${video.parts} of the recording: ${own} of ${full}. ${afterGoal(video, f) ? "It was recorded after the run had reached its goal." : video.part < video.parts ? `The run was paused here and continues in part ${video.part + 1}.` : "The run continues here after a pause."}`
      : `This is the whole recording: ${own}.`;
  // What the picture shows: LiveSplit when the OBS recorder recorded it next to the LiveSplit timer, and the harness's
  // overlay (recorder-obs and overlay-server.mjs place them).
  const plugins = s.harness?.plugins ?? {};
  const liveSplit = plugins.recorder?.id === "obs" && plugins.timer?.id === "livesplit";
  const overlay = s.recording?.overlay;
  const shown = [
    ...(liveSplit ? ["Top left: LiveSplit, the speedrun timer."] : []),
    ...(overlay?.shown ? [`Bottom left: the current section, real time (RTA), game time (IGT)${overlay.keys ? ", the keys the model pressed and its last command" : " and the model's last command"}.`] : []),
  ].join(" ");
  // Only what this video shows, as "m:ss what happens", moments less than ten seconds apart on one line. When the
  // moments make YouTube chapters, the start is listed too, at 0:00.
  const own_chapters = afterGoal(video, f) ? [] : runChapters(video.chapters, f);
  const moments = [];
  for (const c of own_chapters) {
    const last = moments.at(-1);
    if (last && c.at - last.at < 10) { if (!last.raw.includes(c.label)) last.raw.push(c.label); } else moments.push({ at: c.at, raw: [c.label] });
  }
  const chapters = youtubeChapters(videoMoments(own_chapters, s), video.seconds);
  const lines = moments
    .map((m) => ({ at: m.at, text: momentText(m.raw, s, f) ?? (chapters && youtubeTime(m.at) === "0:00" ? "Start" : null) }))
    .filter((m) => m.text)
    .map((m) => `${youtubeTime(m.at)} ${m.text}`);
  const about = `An AI Assisted Speedrun (AAS): a language model plays a game by itself, timed in game time and in real time. Run ${s.run_id} in the AAS Archive: ${domain}`;
  const code = /^aas[0-9a-f]+$/.test(String(video.line));
  return [
    intro,
    "",
    which,
    ...(shown ? ["", shown] : []),
    ...(lines.length ? ["", ...lines] : []),
    "",
    about,
    ...(note ? ["", note] : []),
    "",
    code ? "Verification code for the AAS Archive:" : "Verification line for the AAS Archive:",
    video.line,
  ].join("\n");
}

/** The videos with their suggested title and description, as the bundle carries them. */
export const withVideoTexts = (videos, summary, { archiveUrl, note = null }) =>
  videos.map((v) => ({ ...v, title: videoTitle(summary, v), description: videoDescription(summary, v, { archiveUrl, note }) }));
