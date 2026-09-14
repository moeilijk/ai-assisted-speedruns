// `aas resume --run-dir <dir> [--save <name>] [--max-turns N]`: continue a
// stopped run where it left off. Starts the recorder (a new segment), starts
// the game side and restores the last save state, resumes the agent's own
// session (Claude Code --resume), then ends like `aas run`. The resume is a
// `run.human` record, so the category becomes `restart-only`.
import fs from "node:fs";
import { closeAll } from "./close-all.mjs";
import { resolveGoal, goalReached, laterGoal } from "./goal.mjs";
import path from "node:path";
import { createEventLog, followEvents, readRunLog } from "./events.mjs";
import { loadGamePlugin, loadRecorder, loadRuntime, loadTimer } from "./plugins.mjs";
import { startOverlayServer } from "./overlay-server.mjs";
import { brokerSpec } from "./configure.mjs";
import { createAutosave, writeRecordingSegment } from "./run.mjs";

export async function resume(opts, { log = (t) => process.stderr.write(`[aas resume] ${t}\n`) } = {}) {
  if (!opts["run-dir"]) throw new Error("--run-dir is required");
  const runDir = path.resolve(opts["run-dir"]);
  const brief = JSON.parse(fs.readFileSync(path.join(runDir, "brief.json"), "utf8"));
  if (opts["ignore-budget"]) brief.ignoreBudget = true;
  const outcome = fs.existsSync(path.join(runDir, "outcome.json")) ? JSON.parse(fs.readFileSync(path.join(runDir, "outcome.json"), "utf8")) : {};
  const gameModule = opts.game ?? brief.gameModule;
  const plugin = await loadGamePlugin(gameModule);
  // A resume may extend the goal to a later end of the game (act 1 to the game's own end); never shorten it.
  // A run that reached its goal is over unless the goal is extended.
  let goalExtended = null;
  if (opts.goal) {
    const from = brief.category?.goal ?? "";
    const to = resolveGoal(plugin, opts.goal).id;
    if (to !== from) {
      if (!laterGoal(plugin, from, to)) throw new Error(`The goal can only be extended to a later end of the game: from ${from} to ${to} is not (ends: ${plugin.ends.map((e) => e.id).join(", ")}).`);
      goalExtended = { from, to };
      brief.category.goal = to;
    }
  }
  if (outcome.status === "completed" && outcome.over && !goalExtended) throw new Error(`This run is over (${outcome.over.label}); nothing to resume, unless the goal is extended (--goal <later end>).`);
  const previous = readRunLog(runDir);
  const saves = previous.filter((r) => r.kind === "event" && r.event === "game.saved");
  const save = opts.save ?? saves.at(-1)?.data?.name;
  if (!save) throw new Error("No save state to resume from (no game.saved event in run.jsonl; pass --save <name>).");
  const sessionId = opts.session ?? outcome.sessionId ?? previous.findLast((r) => r.kind === "event" && r.event === "run.ended")?.data?.sessionId ?? null;
  const runtime = await loadRuntime(opts.runtime ?? brief.runtimeModule ?? brief.runtime);
  const recorder = await loadRecorder(opts.recorder ?? "null");
  const timer = opts.timer ? await loadTimer(opts.timer) : null;
  if (opts["max-turns"]) brief.budget = { ...(brief.budget ?? {}), toolCalls: Number(opts["max-turns"]) };
  if (opts["max-minutes"]) brief.budget = { ...(brief.budget ?? {}), minutes: Number(opts["max-minutes"]) };
  if (opts.headless) brief.headless = true;
  const goalEnd = resolveGoal(plugin, brief.category?.goal).end;
  brief.resume = { sessionId, save, prompt: opts.prompt ?? (goalExtended
    ? `The harness has resumed this run with a larger goal: ${goalEnd?.label ?? goalExtended.to}. The game was restored to your last save state, in the same paused condition. Continue from there.`
    : "The harness paused this run and has now resumed it: the game was restored to your last save state, in the same paused condition. Continue towards the goal from there.") };
  fs.writeFileSync(path.join(runDir, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);

  // The runtime config carries absolute paths; regenerate it if the run directory moved.
  const spec = await brokerSpec({ gameModule, runDir, timeZone: process.env.AAS_TIME_ZONE });
  if (runtime.reconfigure) await runtime.reconfigure(runDir, spec, brief);

  const events = createEventLog(runDir);
  // Runs on the Claude plan may only use part of the weekly limit (AAS_BUDGET_WEEKLY_MAX).
  // A runtime that runs on a plan knows its own stand (`budget()`): a run may only use part of it.
  if (runtime.budget && !opts["ignore-budget"]) {
    const b = await runtime.budget();
    log(`budget: ${b.detail}`);
    events.append("budget.checked", { runtime: runtime.id, ok: b.ok, percent: b.percent, max_percent: b.max, ...(b.data ?? {}) });
    if (!b.ok) throw new Error(`${runtime.id} plan budget reached: ${b.detail}. Not starting; raise the runtime's budget setting or pass --ignore-budget.`);
  }
  const segment = (fs.existsSync(path.join(runDir, "recording.json")) ? JSON.parse(fs.readFileSync(path.join(runDir, "recording.json"), "utf8")).segments?.length ?? 1 : 0) + 1;
  const overlay = opts["overlay-port"] !== undefined ? await startOverlayServer(runDir, { port: Number(opts["overlay-port"]) || 0 }) : null;
  const ctx = { runDir, game: plugin, overlayUrl: overlay?.url ?? null };
  await recorder.preflight(brief, plugin);
  await timer?.preflight?.(brief, plugin);
  const { t0 } = await recorder.start(brief, ctx);
  events.append("recording.started", { recorder: recorder.id, t0: t0.toISOString(), segment });
  try {
    let ready = null;
    if (plugin.prepareRun) ready = await plugin.prepareRun({ runDir, log, resume: true, save, seed: brief.seed ?? null, goal: brief.category?.goal ?? null });
    if (plugin.loadState) ready = (await plugin.loadState({ name: save, log, runDir, seed: brief.seed ?? null })) ?? ready;
    events.append("game.ready", { at: new Date().toISOString(), restored: save, seed: ready?.seed ?? null, seed_code: ready?.seed_code ?? null });
  } catch (error) {
    // The game did not come up: stop the recording again and discard its file, so that
    // no recording keeps running and no stray segment lands in the run directory.
    const aborted = await recorder.stop().catch(() => ({ files: [] }));
    for (const f of aborted.files ?? []) fs.rmSync(f, { force: true });
    events.append("recording.stopped", { files: [], aborted: String(error?.message ?? error) });
    events.append("run.error", { message: `game start failed: ${String(error?.message ?? error)}` });
    await overlay?.close();
    throw error;
  }
  // In-game time already played before this resume (ticks × 15 ms), so LiveSplit continues from it.
  const igtSoFar = previous.filter((r) => r.kind === "event" && r.event === "game.playback" && r.data?.phase === "end" && typeof r.data.ticks === "number").reduce((acc, r) => acc + Math.round(r.data.ticks * 15) / 1000, 0);
  await timer?.start(brief, { igt: igtSoFar });
  log(`timer continues from IGT ${igtSoFar.toFixed(3)} s`);
  // A short note (it becomes a section label in chapters and splits); the runtime's detail stays apart.
  events.append("run.human", { note: `resumed after ${outcome.status === "failed" ? "a runtime error" : outcome.status === "stopped" ? "a stop" : (outcome.status ?? "a stop")}`, detail: outcome.notes ?? null, save, segment });
  if (goalExtended) {
    events.append("run.human", { note: `goal extended from ${goalExtended.from} to ${goalExtended.to}`, segment });
    events.append("game.goal", { from: goalExtended.from, to: goalExtended.to, segment });
  }
  events.append("run.started", { id: brief.id, game: plugin.id, runtime: runtime.id, recorder: recorder.id, timer: timer?.id ?? null, model: brief.model ?? null, goal: brief.category?.goal ?? null, resumed: true, segment });
  const autosave = opts["no-autosave"] ? null : createAutosave({ plugin, runDir, brief, events, log, autosaveMinutes: Number(opts["autosave-minutes"]) || 10 });
  let over = null;
  let deaths = 0;
  const goal = resolveGoal(plugin, brief.category?.goal);
  const follower = followEvents(runDir, async (ev) => {
    if (goalReached(goal.end, ev) && !over) {
      events.append("game.over", { victory: true, label: `Victory (${goal.end.label ?? goal.id})`, goal: goal.id, deaths, ...Object.fromEntries(Object.entries(ev.data ?? {}).filter(([k]) => ["floor", "act", "chamber", "map", "seed", "seed_code"].includes(k))) });
      return;
    }
    if (ev.event === "game.over") {
      if (ev.data?.victory && !over) { over = { victory: true, label: ev.data?.label ?? "Victory", at: ev.timestamp, deaths }; log(`game over: ${over.label}; ending the session`); runtime.interrupt?.(`game over: ${over.label}`); }
      else if (!ev.data?.victory) { deaths += 1; log(`death ${deaths} (${ev.data?.label ?? "defeat"}); the agent may restart, the clock keeps running`); }
    }
    await recorder.onEvent(ev);
    await timer?.onEvent(ev);
    await autosave?.onEvent(ev);
  });
  let result;
  try {
    result = await runtime.start(runDir, brief);
  } catch (error) {
    result = { status: "failed", endedAt: new Date().toISOString(), notes: String(error?.message ?? error) };
    events.append("run.error", { message: result.notes });
  }
  autosave?.stop();
  if (result.status !== "failed") result = { ...result, deaths: (outcome.deaths ?? 0) + deaths, ...(over ? { status: "completed", over, notes: [result.notes, `game over: ${over.label}`].filter(Boolean).join("; ") } : {}) };
  if (plugin.saveState && result.status !== "failed") await autosave?.onEvent({ event: "game.milestone", data: { chapter: true, label: "end of session" } });
  events.append("run.ended", { status: result.status, notes: result.notes ?? null, sessionId: result.sessionId ?? sessionId, segment });
  await follower.stop();
  const timerResult = await timer?.stop();
  if (plugin.endRun) await plugin.endRun({ runDir }).catch((e) => log(`endRun failed: ${e.message}`));
  const recording = await recorder.stop();
  await overlay?.close();
  const dest = path.join(runDir, "recording");
  fs.mkdirSync(dest, { recursive: true });
  const files = [];
  for (const f of recording.files ?? []) {
    const target = path.join(dest, path.basename(f));
    if (!fs.existsSync(f)) {
      files.push(f);
      continue;
    }
    if (path.resolve(f) !== target) fs.copyFileSync(f, target);
    files.push(`recording/${path.basename(f)}`);
  }
  const info = writeRecordingSegment(runDir, { t0: (recording.t0 ?? t0).toISOString(), ended_at: new Date().toISOString(), files, chapters: recording.chapters ?? [] }, { recorder: recorder.id, timer: timer ? { id: timer.id, ...timerResult } : null });
  fs.writeFileSync(path.join(runDir, "outcome.json"), `${JSON.stringify({ ...result, sessionId: result.sessionId ?? sessionId, resumedFrom: save, segment }, null, 2)}\n`);
  log(`resumed run ${result.status}; segment ${segment}; ${files.length} recording file(s)`);
  if (!opts["keep-open"]) await closeAll({ plugin, recorder, timer, log });
  return { runDir, outcome: result, recording: info, segment };
}
