// `aas run`: one complete run. Configures the run directory if needed, starts
// the recorder, starts the runtime (the agent), forwards game events to the
// recorder, stops the recorder and collects the recording.
import fs from "node:fs";
import { closeAll } from "./close-all.mjs";
import { resolveGoal, goalReached } from "./goal.mjs";
import path from "node:path";
import { configure } from "./configure.mjs";
import { createEventLog, followEvents, inOrder } from "./events.mjs";
import { loadGamePlugin, loadRecorder, loadRuntime, loadTimer, toolingIdentity } from "./plugins.mjs";
import { startSegmentProof } from "./proof-run.mjs";
import { formatDuration } from "./videos.mjs";
import { renderAfterRun } from "./render.mjs";
import { startOverlayServer } from "./overlay-server.mjs";
import { COST_TEXT } from "./cost-text.mjs";

/**
 * Autosave: a save state after every chapter milestone and every
 * `autosaveMinutes` while no playback is running. Returns a handler for the
 * event follower plus stop(). Saves are copied into <run>/saves/.
 */
export function createAutosave({ plugin, runDir, brief, events, log, autosaveMinutes = 10 }) {
  let playing = false;
  let pendingInterval = false;
  let busy = false;
  let chain = Promise.resolve();
  // Interval saves are skipped while a save is running; milestone and end-of-session
  // saves wait for it instead (the final save must never be dropped).
  const save = (reason) => {
    if (!plugin.saveState) return Promise.resolve();
    if (busy && reason === "interval") return Promise.resolve();
    chain = chain.then(() => doSave(reason));
    return chain;
  };
  const doSave = async (reason) => {
    busy = true;
    try {
      // Counted from the log each time: a plugin that saves at its own milestones (savesAtMilestones) writes game.saved
      // too, from the broker.
      const index = countSaves(runDir) + 1;
      const name = `aas_${brief.id.replace(/[^A-Za-z0-9]/g, "_")}_${String(index).padStart(3, "0")}`;
      const r = await plugin.saveState({ name, log });
      let copy = null;
      if (r?.file && fs.existsSync(r.file)) {
        fs.mkdirSync(path.join(runDir, "saves"), { recursive: true });
        copy = path.join("saves", path.basename(r.file));
        fs.copyFileSync(r.file, path.join(runDir, copy));
      }
      events.append("game.saved", { name, index, reason, file: copy });
      log(`saved ${name} (${reason})`);
    } catch (error) {
      log(`autosave failed: ${error.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    if (playing) pendingInterval = true;
    else save("interval");
  }, autosaveMinutes * 60000);
  return {
    async onEvent(ev) {
      if (ev.event === "game.playback") {
        playing = ev.data?.phase === "start";
        if (!playing && pendingInterval) {
          pendingInterval = false;
          await save("interval");
        }
      } else if (ev.event === "game.milestone" && ev.data?.chapter) {
        // A plugin with savesAtMilestones has saved this milestone itself, in the broker, right after the playback that
        // reached it and before the agent's next move could run a frame; the session's own end is still saved here.
        if (plugin.savesAtMilestones && ev.data?.end) return;
        await save(`milestone ${ev.data.label ?? ""}`.trim());
      }
    },
    stop() {
      clearInterval(timer);
    },
  };
}

export function countSaves(runDir) {
  const file = path.join(runDir, "run.jsonl");
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"game.saved"')).length;
}

/** Append a recording segment to <run>/recording.json (segments accumulate over resumes). */
export function writeRecordingSegment(runDir, segment, { recorder, timer }) {
  const file = path.join(runDir, "recording.json");
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const segments = [...(previous?.segments ?? (previous ? [{ t0: previous.t0, ended_at: previous.ended_at, files: previous.files, chapters: previous.chapters ?? [] }] : [])), segment];
  const info = {
    recorder,
    t0: segments[0].t0,
    ended_at: segment.ended_at,
    files: segments.flatMap((x) => x.files),
    chapters: segments.flatMap((x) => x.chapters ?? []),
    wall_clock_seconds: segments.reduce((n, x) => n + Math.round((Date.parse(x.ended_at) - Date.parse(x.t0)) / 1000), 0),
    segments,
    timer: timer ?? previous?.timer ?? null,
  };
  fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

/**
 * A stop (the GUI's Stop, Ctrl-C) before the agent session has started: noted, and acted on at the next point where
 * stopping is clean (`check()` throws; the caller stops the recording, discards it and closes everything, as for a
 * game that did not come up). Without it the signal's default ended the process at once and left OBS recording.
 */
export function earlyStop(log) {
  let signal = null;
  const on = (s) => { signal = s; log(`${s}: stopping before the session starts; what was started is closed`); };
  process.once("SIGINT", on);
  process.once("SIGTERM", on);
  return {
    check() { if (signal) throw new Error(`stopped by the user (${signal}) before the session started`); },
    release() { process.off("SIGINT", on); process.off("SIGTERM", on); return signal; },
  };
}

export async function run(opts, { log = (t) => process.stderr.write(`[aas run] ${t}\n`) } = {}) {
  for (const k of ["runtime", "game", "run-dir"]) if (!opts[k]) throw new Error(`--${k} is required`);
  const runDir = path.resolve(opts["run-dir"]);
  // A run that has started is continued, never started again: a second segment 1 in the same log would be two runs
  // in one timeline, and its proof two chains on one ticket list.
  const started = path.join(runDir, "run.jsonl");
  if (fs.existsSync(started) && fs.statSync(started).size > 0) throw new Error(`this run has already started (${started}); continue it with \`aas resume --run-dir ${runDir}\`, or choose another run directory`);
  const briefFile = path.join(runDir, "brief.json");
  if (!fs.existsSync(briefFile)) {
    await configure(opts);
    log(`configured ${runDir}`);
  }
  const brief = JSON.parse(fs.readFileSync(briefFile, "utf8"));
  if (opts["ignore-budget"]) brief.ignoreBudget = true;
  const plugin = await loadGamePlugin(opts.game);
  const runtime = await loadRuntime(opts.runtime);
  const recorder = await loadRecorder(opts.recorder ?? "null");
  const timer = opts.timer ? await loadTimer(opts.timer) : null;
  if (recorder.id === "null") log("warning: recorder null; this run will not be a valid AI Assisted Speedrun");
  if (runtime.ai) log(`what a run costs: ${COST_TEXT}`);
  const events = createEventLog(runDir);
  const early = earlyStop(log);
  // Runs on the Claude plan may only use part of the weekly limit (AAS_BUDGET_WEEKLY_MAX).
  // A runtime that runs on a plan knows its own stand (`budget()`): a run may only use part of it.
  if (runtime.budget && !opts["ignore-budget"]) {
    const b = await runtime.budget();
    log(`budget: ${b.detail}`);
    events.append("budget.checked", { runtime: runtime.id, ok: b.ok, percent: b.percent, max_percent: b.max, ...(b.data ?? {}) });
    if (!b.ok) early.release();
    if (!b.ok) throw new Error(`${runtime.id} plan budget reached: ${b.detail}. Not starting; raise the runtime's budget setting or pass --ignore-budget.`);
  }

  // Proof, before anything is recorded: a run that wants it and cannot get a ticket does not start.
  const proof = await startSegmentProof({ runDir, segment: 1, runtime, events, opts, log });

  const overlay = opts["overlay-port"] !== undefined ? await startOverlayServer(runDir, { port: Number(opts["overlay-port"]) || 0 }) : null;
  if (overlay) log(`overlay at ${overlay.url} (add it as a browser source; the OBS recorder does this itself)`);
  const ctx = { runDir, game: plugin, overlayUrl: overlay?.url ?? null };

  // A failed preflight (OBS already recording, LiveSplit not reachable) stops the run before it starts; the overlay
  // server and the recorder's connection are closed too, or they keep the process alive after the error.
  try {
    await recorder.preflight(brief, plugin);
    await timer?.preflight?.(brief, plugin);
    early.check();
  } catch (error) {
    early.release();
    await recorder.disconnect?.();
    await overlay?.close();
    throw error;
  }
  let t0 = null;
  const tooling = toolingIdentity();
  try {
    // The recorder may refuse after StartRecord (the game capture shows nothing): then the recording it began
    // is stopped and discarded below, like a game that fails to come up.
    ({ t0 } = await recorder.start(brief, ctx));
    events.append("recording.started", { recorder: recorder.id, t0: t0.toISOString() });
    early.check();
    if (plugin.prepareRun) {
      const ready = await plugin.prepareRun({ runDir, log, seed: brief.seed ?? null, goal: brief.category?.goal ?? null });
      events.append("game.ready", { at: (ready?.readyAt ?? new Date()).toISOString(), seed: ready?.seed ?? null, seed_code: ready?.seed_code ?? null });
    }
    await timer?.start(brief);
    early.check();
  } catch (error) {
    early.release();
    // The game did not come up: stop the recording again and discard its file, so that
    // no recording keeps running and no stray segment lands in the run directory.
    const aborted = await recorder.stop().catch(() => ({ files: [] }));
    for (const f of aborted.files ?? []) fs.rmSync(f, { force: true });
    events.append("recording.stopped", { files: [], aborted: String(error?.message ?? error) });
    events.append("run.error", { message: `${t0 ? "game start" : "recording start"} failed: ${String(error?.message ?? error)}` });
    await overlay?.close();
    if (!opts["keep-open"]) await closeAll({ plugin, recorder, timer, log });
    throw error;
  }
  const goal = resolveGoal(plugin, brief.category?.goal);
  events.append("run.started", { id: brief.id, game: plugin.id, runtime: runtime.id, recorder: recorder.id, timer: timer?.id ?? null, model: brief.model ?? null, goal: goal.id, tooling, overlay: Boolean(overlay) });
  await proof.start();
  const autosave = opts["no-autosave"] ? null : createAutosave({ plugin, runDir, brief, events, log, autosaveMinutes: Number(opts["autosave-minutes"]) || 10 });
  // `game.over` from the plugin: the attempt ended inside the game (victory or defeat). The
  // agent session is interrupted; the run's status becomes completed or defeat, not stopped.
  let over = null;
  let deaths = 0; // deaths so far in this session (game.over without victory); a death is not the end of the run
  // The goal: one of the game's ends. The plugin marks its ends with milestones; when the milestone of the goal's
  // end goes by, the harness declares the victory (game.over), which ends the session like the game's own victory.
  // The goal's milestone itself goes on to the recorder, the timer (its final split) and the autosave like any other
  // (measured 2026-09-23: without it LiveSplit never took the last split); the appended game.over comes back through
  // the follower and ends the session below.
  const ordered = inOrder();
  const forward = async (ev) => {
    if (goalReached(goal.end, ev) && !over) {
      // The victory is fixed here, at the milestone, and the session is interrupted at once: the log is read
      // every half second, and a fast player would otherwise play on past its goal until its own game.over came
      // back through the follower (measured 2026-09-25: a mock to act1 played on to the Act 3 victory).
      over = { victory: true, label: `Victory (${goal.end.label ?? goal.id})`, at: ev.timestamp, deaths, goal: goal.id };
      log(`game over: ${over.label}; ending the session`);
      runtime.interrupt?.(`game over: ${over.label}`);
      events.append("game.over", { victory: true, label: `Victory (${goal.end.label ?? goal.id})`, goal: goal.id, reached_at: ev.timestamp, deaths, ...Object.fromEntries(Object.entries(ev.data ?? {}).filter(([k]) => ["floor", "act", "chamber", "map", "seed", "seed_code"].includes(k))) });
    }
    if (ev.event === "game.over") {
      if (ev.data?.victory && !over) { over = { victory: true, label: ev.data?.label ?? "Victory", at: ev.timestamp, deaths }; log(`game over: ${over.label}; ending the session`); runtime.interrupt?.(`game over: ${over.label}`); }
      else if (!ev.data?.victory) { deaths += 1; log(`death ${deaths} (${ev.data?.label ?? "defeat"}); the agent may restart, the clock keeps running`); }
    }
    // The recorder and the timer see the events in the log's order (inOrder); the autosave queues its own saves.
    await ordered(async () => {
      await recorder.onEvent(ev);
      await timer?.onEvent(ev);
    });
    await autosave?.onEvent(ev);
  };
  const follower = followEvents(runDir, forward);

  let outcome;
  // A stop from outside (Ctrl-C, the GUI's Stop) ends the agent session the way a budget does: the session stops, the
  // game is saved, the recording is kept and everything is closed as after any run. A second signal is not caught.
  const stopRequested = (signal) => { log(`${signal}: stopping the session`); runtime.interrupt?.(`stopped by the user (${signal})`); };
  early.release();
  process.once("SIGINT", stopRequested);
  process.once("SIGTERM", stopRequested);
  // `aas stop --run-dir` finds this process by this file, never by a process search.
  fs.writeFileSync(path.join(runDir, "run.pid"), `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
  try {
    outcome = await runtime.start(runDir, brief, { checkpoint: () => follower.flush() });
  } catch (error) {
    outcome = { status: "failed", endedAt: new Date().toISOString(), notes: String(error?.message ?? error) };
    events.append("run.error", { message: outcome.notes });
  }
  process.off("SIGINT", stopRequested);
  process.off("SIGTERM", stopRequested);
  fs.rmSync(path.join(runDir, "run.pid"), { force: true });
  autosave?.stop();
  // What the game said up to the end of the session decides the outcome: a victory in its last frames included.
  await follower.flush();
  if (outcome.status !== "failed") outcome = { ...outcome, deaths, ...(over ? { status: "completed", over, notes: [outcome.notes, `game over: ${over.label}`].filter((n, i, all) => n && !(i > 0 && String(all[0] ?? "").includes(n))).join("; ") } : {}) };
  // A final save state, so a stopped run can be resumed from exactly here.
  if (plugin.saveState && outcome.status !== "failed") await autosave?.onEvent({ event: "game.milestone", data: { chapter: true, label: "end of session" } });
  events.append("run.ended", { status: outcome.status, notes: outcome.notes ?? null, sessionId: outcome.sessionId ?? null });
  await follower.stop(); // delivers run.ended to recorder and timer
  if (plugin.endRun) await plugin.endRun({ runDir }).catch((e) => log(`endRun failed: ${e.message}`));
  const timerResult = await timer?.stop();

  const recording = await recorder.stop();
  await overlay?.close();
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
  const info = writeRecordingSegment(runDir, { t0: (recording.t0 ?? t0).toISOString(), ended_at: new Date().toISOString(), files, chapters: recording.chapters ?? [] }, { recorder: recorder.id, timer: timer ? { id: timer.id, ...timerResult } : null });
  events.append("recording.stopped", { files, wall_clock_seconds: info.wall_clock_seconds });
  await proof.end();
  fs.writeFileSync(path.join(runDir, "outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);
  log(`run ${outcome.status}; ${files.length} recording file(s); ${formatDuration(info.wall_clock_seconds, { whole: true })} wall clock`);
  // The run is over: close the game, LiveSplit, OBS and a Steam this harness started, and measure what is
  // still running. Nothing stays open on the machine after a run unless --keep-open asks for it.
  if (!opts["keep-open"]) await closeAll({ plugin, recorder, timer, log });
  renderAfterRun(runDir, { log });
  return { runDir, outcome, recording: info };
}
