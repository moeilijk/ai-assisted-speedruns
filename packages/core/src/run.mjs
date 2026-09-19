// `aas run`: one complete run. Configures the run directory if needed, starts
// the recorder, starts the runtime (the agent), forwards game events to the
// recorder, stops the recorder and collects the recording.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { closeAll } from "./close-all.mjs";
import { resolveGoal, goalReached } from "./goal.mjs";
import path from "node:path";
import { configure } from "./configure.mjs";
import { createEventLog, followEvents } from "./events.mjs";
import { loadGamePlugin, loadRecorder, loadRuntime, loadTimer, runtimeIdentity, toolingIdentity } from "./plugins.mjs";
import { witnessSegment } from "./witness.mjs";
import { formatDuration } from "./videos.mjs";
import { startOverlayServer } from "./overlay-server.mjs";

/**
 * Autosave: a save state after every chapter milestone and every
 * `autosaveMinutes` while no playback is running. Returns a handler for the
 * event follower plus stop(). Saves are copied into <run>/saves/.
 */
export function createAutosave({ plugin, runDir, brief, events, log, autosaveMinutes = 10 }) {
  let playing = false;
  let pendingInterval = false;
  let index = countSaves(runDir);
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
      index += 1;
      const name = `aas_${brief.id.replace(/[^A-Za-z0-9]/g, "_")}_${String(index).padStart(3, "0")}`;
      const r = await plugin.saveState({ name });
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
      } else if (ev.event === "game.milestone" && ev.data?.chapter) await save(`milestone ${ev.data.label ?? ""}`.trim());
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

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
/** The sha256 of a file in the run directory, null when it is not there (nothing is guessed). */
export function fileDigest(runDir, name) {
  const file = path.join(runDir, name);
  return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
}

/** The run log as it stands: its sha256 and how many records are in it. */
export function runLogState(runDir) {
  const file = path.join(runDir, "run.jsonl");
  if (!fs.existsSync(file)) return { logSha256: null, records: null };
  const data = fs.readFileSync(file);
  return { logSha256: sha256(data), records: data.toString("utf8").split("\n").filter((l) => l.trim()).length };
}

/**
 * What a start statement says about the segment it is about to run (SPEC §8.9): the runtime with its own hash,
 * the hash of the instructions the model gets, and the goal with the hash of the prompt that names it. The
 * archive counter-signs these before the run, so none of them can be swapped for another afterwards.
 */
export function startFields({ runtime, runtimeId, runDir, brief, goal }) {
  return {
    runtime: runtimeIdentity(runtime, runtimeId),
    instructionsSha256: fileDigest(runDir, "AGENTS.md"),
    goal: goal ?? brief.category?.goal ?? null,
    goalPromptSha256: brief.goalPrompt ? sha256(Buffer.from(brief.goalPrompt, "utf8")) : null,
  };
}

/** The archive witnesses the end of a segment: its end, its length and the run log it produced. */
export async function witnessEnd(events, { runUid, segment, tooling, recorded, runDir, log }) {
  const seconds = (Date.parse(recorded.ended_at) - Date.parse(recorded.t0)) / 1000;
  const ended = await witnessSegment({ phase: "end", runUid, segment, tooling, endedAt: recorded.ended_at, seconds, ...(runDir ? runLogState(runDir) : {}) });
  events.append(ended.event, ended.data);
  if (ended.event === "run.unwitnessed") log(`the end of this segment is not witnessed: ${ended.data.reason}`);
}

export async function run(opts, { log = (t) => process.stderr.write(`[aas run] ${t}\n`) } = {}) {
  for (const k of ["runtime", "game", "run-dir"]) if (!opts[k]) throw new Error(`--${k} is required`);
  const runDir = path.resolve(opts["run-dir"]);
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
  const events = createEventLog(runDir);
  // Runs on the Claude plan may only use part of the weekly limit (AAS_BUDGET_WEEKLY_MAX).
  // A runtime that runs on a plan knows its own stand (`budget()`): a run may only use part of it.
  if (runtime.budget && !opts["ignore-budget"]) {
    const b = await runtime.budget();
    log(`budget: ${b.detail}`);
    events.append("budget.checked", { runtime: runtime.id, ok: b.ok, percent: b.percent, max_percent: b.max, ...(b.data ?? {}) });
    if (!b.ok) throw new Error(`${runtime.id} plan budget reached: ${b.detail}. Not starting; raise the runtime's budget setting or pass --ignore-budget.`);
  }

  const overlay = opts["overlay-port"] !== undefined ? await startOverlayServer(runDir, { port: Number(opts["overlay-port"]) || 0 }) : null;
  if (overlay) log(`overlay at ${overlay.url} (add it as a browser source; the OBS recorder does this itself)`);
  const ctx = { runDir, game: plugin, overlayUrl: overlay?.url ?? null };

  // A failed preflight (OBS already recording, LiveSplit not reachable) stops the run before it starts; the overlay
  // server and the recorder's connection are closed too, or they keep the process alive after the error.
  try {
    await recorder.preflight(brief, plugin);
    await timer?.preflight?.(brief, plugin);
  } catch (error) {
    recorder.disconnect?.();
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
    if (plugin.prepareRun) {
      const ready = await plugin.prepareRun({ runDir, log, seed: brief.seed ?? null, goal: brief.category?.goal ?? null });
      events.append("game.ready", { at: (ready?.readyAt ?? new Date()).toISOString(), seed: ready?.seed ?? null, seed_code: ready?.seed_code ?? null });
    }
    await timer?.start(brief);
  } catch (error) {
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
  // The archive witnesses the start once the game is up, so a start that fails is never witnessed.
  const started = await witnessSegment({ phase: "start", runUid: brief.run_uid, segment: 1, tooling, t0: t0.toISOString(), ...startFields({ runtime, runtimeId: opts.runtime, runDir, brief, goal: goal.id }) });
  events.append(started.event, started.data);
  if (started.event === "run.unwitnessed") log(`the start of this segment is not witnessed: ${started.data.reason}`);
  events.append("run.started", { id: brief.id, game: plugin.id, runtime: runtime.id, recorder: recorder.id, timer: timer?.id ?? null, model: brief.model ?? null, goal: goal.id, tooling, overlay: Boolean(overlay) });
  const autosave = opts["no-autosave"] ? null : createAutosave({ plugin, runDir, brief, events, log, autosaveMinutes: Number(opts["autosave-minutes"]) || 10 });
  // `game.over` from the plugin: the attempt ended inside the game (victory or defeat). The
  // agent session is interrupted; the run's status becomes completed or defeat, not stopped.
  let over = null;
  let deaths = 0; // deaths so far in this session (game.over without victory); a death is not the end of the run
  // The goal: one of the game's ends. The plugin marks its ends with milestones; when the milestone of the goal's
  // end goes by, the harness declares the victory (game.over), which ends the session like the game's own victory.
  const forward = async (ev) => {
    if (goalReached(goal.end, ev) && !over) {
      events.append("game.over", { victory: true, label: `Victory (${goal.end.label ?? goal.id})`, goal: goal.id, deaths, ...Object.fromEntries(Object.entries(ev.data ?? {}).filter(([k]) => ["floor", "act", "chamber", "map", "seed", "seed_code"].includes(k))) });
      return; // the appended game.over comes back through the follower and ends the session below
    }
    if (ev.event === "game.over") {
      if (ev.data?.victory && !over) { over = { victory: true, label: ev.data?.label ?? "Victory", at: ev.timestamp, deaths }; log(`game over: ${over.label}; ending the session`); runtime.interrupt?.(`game over: ${over.label}`); }
      else if (!ev.data?.victory) { deaths += 1; log(`death ${deaths} (${ev.data?.label ?? "defeat"}); the agent may restart, the clock keeps running`); }
    }
    await recorder.onEvent(ev);
    await timer?.onEvent(ev);
    await autosave?.onEvent(ev);
  };
  const follower = followEvents(runDir, forward);

  let outcome;
  // A stop from outside (Ctrl-C, the GUI's Stop) ends the agent session the way a budget does: the session stops, the
  // game is saved, the recording is kept and everything is closed as after any run. A second signal is not caught.
  const stopRequested = (signal) => { log(`${signal}: stopping the session`); runtime.interrupt?.(`stopped by the user (${signal})`); };
  process.once("SIGINT", stopRequested);
  process.once("SIGTERM", stopRequested);
  try {
    outcome = await runtime.start(runDir, brief);
  } catch (error) {
    outcome = { status: "failed", endedAt: new Date().toISOString(), notes: String(error?.message ?? error) };
    events.append("run.error", { message: outcome.notes });
  }
  process.off("SIGINT", stopRequested);
  process.off("SIGTERM", stopRequested);
  autosave?.stop();
  if (outcome.status !== "failed") outcome = { ...outcome, deaths, ...(over ? { status: "completed", over, notes: [outcome.notes, `game over: ${over.label}`].filter(Boolean).join("; ") } : {}) };
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
  await witnessEnd(events, { runUid: brief.run_uid, segment: 1, tooling, recorded: info.segments.at(-1), runDir, log });
  fs.writeFileSync(path.join(runDir, "outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);
  log(`run ${outcome.status}; ${files.length} recording file(s); ${formatDuration(info.wall_clock_seconds, { whole: true })} wall clock`);
  // The run is over: close the game, LiveSplit, OBS and a Steam this harness started, and measure what is
  // still running. Nothing stays open on the machine after a run unless --keep-open asks for it.
  if (!opts["keep-open"]) await closeAll({ plugin, recorder, timer, log });
  return { runDir, outcome, recording: info };
}
