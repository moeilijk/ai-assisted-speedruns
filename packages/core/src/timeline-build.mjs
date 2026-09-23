// The public timeline of a run from its own logs: the session log exported and sanitised, the harness's events merged
// in, and timeline.json. `aas publish` makes a bundle's timeline with it, and an archive runs the same module to make
// it again from an upload's private part. It imports only what that takes, so an archive can take it over as it is.
import fs from "node:fs";
import path from "node:path";
import { exportClaudeSession } from "./export-claude-session.mjs";
import { exportRollout } from "../../runtime-codex/export-rollout.mjs";
import { goalHistory } from "./goal.mjs";
import { createSanitizer } from "./sanitize.mjs";
import { computeTimeline } from "./timeline.mjs";

/** The exporter of each runtime's own session log; a runtime not named here writes the harness's shape (Claude's). */
export const EXPORTERS = { "claude-code": exportClaudeSession, codex: exportRollout };

export const readRunEvents = (runDir) => { const f = path.join(runDir, "run.jsonl"); if (!fs.existsSync(f)) return []; return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.kind === "event"); };

/**
 * The public timeline of a run, made from its own logs alone: session.sanitized.jsonl (the runtime's session log,
 * sanitised, with the harness's events merged in) and timeline.json. `aas publish` makes a bundle's timeline with it,
 * and an archive makes it again from the private part of an upload (regenerate below), so the two are the same
 * function and a timeline that was edited afterwards does not come out equal.
 * Reads from `runDir` only run.jsonl, recording.json and brief.json.
 */
export async function buildTimeline({ runDir, outDir, brief, runtimeId = null, exportSession = null, session, completionMarker = null, log = () => {} }) {
  const savedMarker = process.env.AAS_COMPLETION_MARKER;
  // The marker is an argument here, never the environment of whoever runs this: the archive runs it too.
  if (completionMarker) process.env.AAS_COMPLETION_MARKER = completionMarker; else delete process.env.AAS_COMPLETION_MARKER;
  try {
    return await buildTimelineWith({ runDir, outDir, brief, exportSession: exportSession ?? EXPORTERS[runtimeId] ?? exportClaudeSession, session, completionMarker, log });
  } finally {
    if (savedMarker === undefined) delete process.env.AAS_COMPLETION_MARKER; else process.env.AAS_COMPLETION_MARKER = savedMarker;
  }
}

async function buildTimelineWith({ runDir, outDir, brief, exportSession, session, completionMarker, log }) {
  // Every goal the run had, from its own events: a resume may extend the goal, and a victory reaches only the goal
  // that held at that moment. An extension is published only once it is reached: until then the bundle keeps the
  // last goal that was reached, completed at its victory, and what came after is post-completion time on the
  // timeline. A run that reached no goal publishes the goal it had (the completion marker is the fallback).
  const history = goalHistory(readRunEvents(runDir), brief.category.goal);
  const lastReached = history.findLastIndex((g) => g.reached_at);
  const goals = lastReached >= 0 ? history.slice(0, lastReached + 1) : history;
  const won = lastReached >= 0 ? { timestamp: history[lastReached].reached_at } : null;
  const publishedGoal = goals.at(-1)?.id ?? brief.category.goal;
  // The runtime exports its own private log; a runtime without an exporter keeps the harness's own session
  // shape (session.jsonl in the run directory, as the scripted and stub runtimes write it).
  await exportSession(session, outDir, { completionMarker, completionTime: won?.timestamp ?? null });
  // The harness's own events (run.started, game.playback, game.milestone, game.over, run.human, recording.*) belong
  // in the public timeline: the spec reserves them, and without run.human the human axis cannot be verified. They
  // are merged from run.jsonl on the same clock, sanitised, and the file is renumbered.
  const merged = mergeHarnessEvents(runDir, path.join(outDir, "session.sanitized.jsonl"));
  if (merged) log(`${merged.events} harness event(s) merged into the timeline (${merged.records} records)`);
  let timeline = null;
  try {
    // Completion as the exported summary states it (the published goal's victory, or the completion marker).
    const exportedCompletion = (() => { try { return JSON.parse(fs.readFileSync(path.join(outDir, "summary.json"), "utf8")).completed_at ?? null; } catch { return null; } })();
    timeline = computeTimeline(runDir, { completedAt: exportedCompletion });
    fs.writeFileSync(path.join(outDir, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
  } catch (error) {
    log(`no timeline: ${error.message}`);
  }
  return { history, goals, won, publishedGoal, timeline };
}

/** Events of run.jsonl that are not published: the operator's plan usage. */
const PRIVATE_EVENTS = new Set(["budget.checked"]);
/** Fields of event data that name machine files or session identifiers. */
const PRIVATE_EVENT_FIELDS = new Set(["file", "sessionId", "privateLog"]);

export function mergeHarnessEvents(runDir, publicLog) {
  if (!fs.existsSync(publicLog) || !fs.existsSync(path.join(runDir, "run.jsonl"))) return null;
  const { clean } = createSanitizer();
  const events = readRunEvents(runDir)
    .filter((e) => !PRIVATE_EVENTS.has(e.event))
    .map((e) => ({ timestamp: e.timestamp, kind: "event", event: e.event, source: e.source ?? null, data: clean(Object.fromEntries(Object.entries(e.data ?? {}).filter(([k]) => !PRIVATE_EVENT_FIELDS.has(k)))) }));
  if (!events.length) return null;
  const exported = fs.readFileSync(publicLog, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const all = [...exported.map((r, i) => ({ r, i, at: Date.parse(r.timestamp) })), ...events.map((r, i) => ({ r, i: exported.length + i, at: Date.parse(r.timestamp) }))]
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.r);
  const first = Date.parse(all[0].timestamp);
  const lines = all.map((r, i) => JSON.stringify({ sequence: i + 1, timestamp: r.timestamp, elapsed_seconds: Math.max(0, Math.round((Date.parse(r.timestamp) - first) / 1000)), ...Object.fromEntries(Object.entries(r).filter(([k]) => !["sequence", "timestamp", "elapsed_seconds"].includes(k))) }));
  fs.writeFileSync(publicLog, `${lines.join("\n")}\n`);
  const summaryFile = path.join(path.dirname(publicLog), "summary.json");
  if (fs.existsSync(summaryFile)) {
    const s = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
    // The events are a second source next to the session log: counted on both sides, so source = exported + omitted holds.
    s.source_records = (s.source_records ?? 0) + events.length;
    s.exported_records = (s.exported_records ?? 0) + events.length;
    s.harness_events = events.length;
    fs.writeFileSync(summaryFile, `${JSON.stringify(s, null, 2)}\n`);
  }
  return { events: events.length, records: all.length };
}
