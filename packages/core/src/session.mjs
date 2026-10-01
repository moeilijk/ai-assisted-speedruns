// The session of a run or a resume, from the moment the game is ready to the end: one copy for both, so that a fix
// lands in both (2026-10-02: the resume had kept faults the run no longer had). It follows the log for the goal and the
// game's own end, starts the agent unless there is no need, ends on a stop at any moment, and always writes the
// outcome, the recording segment and the proof's end, also when the timer or the recorder fails while closing.
import fs from "node:fs";
import path from "node:path";
import { closeAll } from "./close-all.mjs";
import { goalReached } from "./goal.mjs";
import { followEvents, inOrder } from "./events.mjs";
import { endsInLog } from "./logged-ends.mjs";
import { renderAfterRun } from "./render.mjs";
import { AUTOSAVE_MINUTES, createAutosave, writeRecordingSegment } from "./run.mjs";
import { formatDuration } from "./videos.mjs";

export { endsInLog };

/**
 * `session({ ... })` → `{ outcome, recording }`. `segment` is null for a run's first session. `early` is the stop
 * catcher of the start (earlyStop); a stop it caught means no agent session. `ready` is what the game side returned
 * (its `reached` milestones: ends the game already shows).
 */
export async function session({ runDir, brief, opts, log, plugin, runtime, recorder, timer, overlay, events, early, proof, goal, ready, t0, segment = null, sessionId = null, deathsBefore = 0, outcomeExtra = {} }) {
  const seg = segment === null ? {} : { segment };
  const autosave = opts["no-autosave"] ? null : createAutosave({ plugin, runDir, brief, events, log, autosaveMinutes: Number(opts["autosave-minutes"]) || AUTOSAVE_MINUTES });
  // An end an earlier session already told is not told again to the timer and the recorder: a second split would land
  // on the next line of LiveSplit (2026-10-02, a resume with a larger goal).
  const told = endsInLog(runDir);
  let over = null;
  let deaths = 0;
  let stopReason = null;
  const ordered = inOrder();
  const follower = followEvents(runDir, async (ev) => {
    if (ev.event === "game.milestone" && ev.data?.end) {
      if (told.has(ev.data.end)) return;
      told.add(ev.data.end);
    }
    if (goalReached(goal.end, ev) && !over) {
      // The victory is fixed here, at the milestone, and the session is interrupted at once: the log is read every
      // half second, and a fast player would otherwise play on past its goal until its own game.over came back
      // through the follower (measured 2026-09-25: a mock to act1 played on to the Act 3 victory).
      over = { victory: true, label: `Victory (${goal.end.label ?? goal.id})`, at: ev.timestamp, deaths, goal: goal.id };
      log(`game over: ${over.label}; ending the session`);
      runtime.interrupt?.(`game over: ${over.label}`);
      events.append("game.over", { victory: true, label: over.label, goal: goal.id, reached_at: ev.timestamp, deaths, ...Object.fromEntries(Object.entries(ev.data ?? {}).filter(([k]) => ["floor", "act", "chamber", "map", "seed", "seed_code"].includes(k))), ...seg });
    }
    if (ev.event === "game.over") {
      if (ev.data?.victory && !over) { over = { victory: true, label: ev.data?.label ?? "Victory", at: ev.timestamp, deaths }; log(`game over: ${over.label}; ending the session`); runtime.interrupt?.(`game over: ${over.label}`); }
      else if (!ev.data?.victory) { deaths += 1; log(`death ${deaths} (${ev.data?.label ?? "defeat"}); the agent may restart, the clock keeps running`); }
    }
    // The goal's milestone also goes on to the recorder, the timer (its final split) and the autosave like any other
    // (measured 2026-09-23: without it LiveSplit never took the last split).
    await ordered(async () => {
      await recorder.onEvent(ev);
      await timer?.onEvent(ev);
    });
    await autosave?.onEvent(ev);
  });

  // A stop from outside (Ctrl-C, the GUI's Stop, `aas stop`) ends the agent session the way a budget does. The handler
  // is in place before the start's catcher is released, so no signal falls between them; a stop the catcher already
  // took means no session at all. The runtime is also asked whether a stop came before its session existed.
  const stopRequested = (signal) => {
    stopReason = `stopped by the user (${signal})`;
    log(`${signal}: stopping the session`);
    runtime.interrupt?.(stopReason);
  };
  process.once("SIGINT", stopRequested);
  process.once("SIGTERM", stopRequested);
  const caught = early.release();
  if (caught) stopReason = `stopped by the user (${caught}) before the session started`;

  // The furthest end the game already shows when it is ready (a session continued from a save made after it): told
  // unless an earlier session told it. When it is the goal, or an end after the goal in the game's own order, the goal
  // is reached and no agent session is started, so reaching it costs the agent no turn.
  const shown = (ready?.reached ?? []).filter((m) => m?.end);
  for (const m of shown) if (!told.has(m.end)) events.append("game.milestone", m);
  await follower.flush();
  const order = (id) => (plugin.ends ?? []).findIndex((e) => e.id === id);
  const past = shown.find((m) => order(goal.id) >= 0 && order(m.end) >= order(goal.id));
  if (!over && past && goal.end) {
    over = { victory: true, label: `Victory (${goal.end.label ?? goal.id})`, at: new Date().toISOString(), deaths, goal: goal.id };
    events.append("game.over", { victory: true, label: over.label, goal: goal.id, reached_at: over.at, deaths, shown: past.end, ...seg });
    await follower.flush();
  }

  let outcome;
  if (over) {
    outcome = { status: "completed", endedAt: new Date().toISOString(), notes: `the goal was already reached when the game was ready (${over.label}); no agent session was started` };
    log(outcome.notes);
  } else if (stopReason) {
    outcome = { status: "stopped", endedAt: new Date().toISOString(), notes: `${stopReason}; no agent session was started` };
    log(outcome.notes);
  } else {
    try {
      outcome = await runtime.start(runDir, brief, { checkpoint: () => follower.flush(), stopRequested: () => stopReason });
    } catch (error) {
      outcome = { status: "failed", endedAt: new Date().toISOString(), notes: String(error?.message ?? error) };
      events.append("run.error", { message: outcome.notes, ...seg });
    }
  }
  process.off("SIGINT", stopRequested);
  process.off("SIGTERM", stopRequested);
  // While the run closes, a first signal does not cut it off halfway (the outcome, the recording and the proof would be
  // lost); a second one is not caught.
  const closing = (signal) => log(`${signal}: the run is closing already; a second ${signal} ends it at once`);
  process.once("SIGINT", closing);
  process.once("SIGTERM", closing);
  try {
    autosave?.stop();
    // What the game said up to the end of the session decides the outcome: a victory in its last frames included.
    await follower.flush();
    if (outcome.status !== "failed") outcome = { ...outcome, deaths: deathsBefore + deaths, ...(over ? { status: "completed", over, notes: [outcome.notes, `game over: ${over.label}`].filter((n, i, all) => n && !(i > 0 && String(all[0] ?? "").includes(n))).join("; ") } : {}) };
    // A final save state, so a stopped run can be resumed from exactly here; also without the timed autosave.
    if (plugin.saveState && outcome.status !== "failed") {
      if (autosave) await autosave.onEvent({ event: "game.milestone", data: { chapter: true, label: "end of session" } });
      else {
        // --no-autosave: no timed saves, but the session's end is still saved, or the run could not be continued.
        const once = createAutosave({ plugin, runDir, brief, events, log });
        try { await once.onEvent({ event: "game.milestone", data: { chapter: true, label: "end of session" } }); } finally { once.stop(); }
      }
    }
  } catch (error) {
    log(`closing the session: ${error.message}`);
  }
  events.append("run.ended", { status: outcome.status, notes: outcome.notes ?? null, sessionId: outcome.sessionId ?? sessionId, ...seg });
  // From here on every step is tried, and a failing one does not keep the outcome, the recording or the proof unwritten.
  const problems = [];
  const attempt = async (what, fn) => {
    try { return await fn(); } catch (error) { problems.push(`${what}: ${error?.message ?? error}`); log(`${what} failed: ${error?.message ?? error}`); return null; }
  };
  await attempt("follower", () => follower.stop()); // delivers run.ended to recorder and timer
  if (plugin.endRun) await attempt("endRun", () => plugin.endRun({ runDir }));
  const timerResult = timer ? await attempt("timer stop", () => timer.stop()) : null;
  const recording = (await attempt("recorder stop", () => recorder.stop())) ?? { files: [], t0, chapters: [] };
  await attempt("overlay close", () => overlay?.close());
  const dest = path.join(runDir, "recording");
  fs.mkdirSync(dest, { recursive: true });
  const files = [];
  for (const f of recording.files ?? []) {
    const target = path.join(dest, path.basename(f));
    if (!fs.existsSync(f)) {
      log(`warning: recording file not found from here: ${f}`);
      files.push(f);
      continue;
    }
    if (path.resolve(f) !== target) fs.copyFileSync(f, target);
    files.push(`recording/${path.basename(f)}`);
  }
  const info = writeRecordingSegment(runDir, { t0: (recording.t0 ?? t0).toISOString(), ended_at: new Date().toISOString(), files, chapters: recording.chapters ?? [] }, { recorder: recorder.id, timer: timer ? { id: timer.id, ...(timerResult ?? {}) } : null });
  events.append("recording.stopped", { files, wall_clock_seconds: info.wall_clock_seconds, ...seg });
  await attempt("proof end", () => proof.end());
  if (problems.length) outcome = { ...outcome, closing: problems };
  fs.writeFileSync(path.join(runDir, "outcome.json"), `${JSON.stringify({ ...outcome, sessionId: outcome.sessionId ?? sessionId, ...outcomeExtra }, null, 2)}\n`);
  log(`${segment === null ? "run" : "resumed run"} ${outcome.status}${segment === null ? "" : `; segment ${segment}`}; ${files.length} recording file(s); ${formatDuration(info.wall_clock_seconds, { whole: true })} wall clock`);
  // Nothing stays open on the machine after a run unless --keep-open asks for it.
  if (!opts["keep-open"]) await attempt("close", () => closeAll({ plugin, recorder, timer, log }));
  process.off("SIGINT", closing);
  process.off("SIGTERM", closing);
  renderAfterRun(runDir, { log });
  return { outcome, recording: info };
}
