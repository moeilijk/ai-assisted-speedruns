// `aas resume --run-dir <dir> [--save <name>] [--max-turns N]`: continue a
// stopped run where it left off. Starts the recorder (a new segment), starts
// the game side and restores the last save state, resumes the agent's own
// session (Claude Code --resume), then ends like `aas run`. The resume is a
// `run.human` record, so the category becomes `restart-only`.
import { checkName, checkProofMode, checkSessionId } from "./validate.mjs";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { closeAll } from "./close-all.mjs";
import { resolveGoal, laterGoal } from "./goal.mjs";
import { applyRunEnv } from "./settings.mjs";
import path from "node:path";
import { createEventLog, readRunLog } from "./events.mjs";
import { loadGamePlugin, loadRecorder, loadRuntime, loadTimer, toolingIdentity } from "./plugins.mjs";
import { startOverlayServer } from "./overlay-server.mjs";
import { brokerSpec } from "./configure.mjs";
import { earlyStop, writePidFile } from "./run.mjs";
import { session } from "./session.mjs";
import { playbackSeconds } from "./igt.mjs";
import { startSegmentProof } from "./proof-run.mjs";
import { resumeToolingCheck } from "./tooling-check.mjs";

export async function resume(opts, { log = (t) => process.stderr.write(`[aas resume] ${t}\n`) } = {}) {
  if (!opts["run-dir"]) throw new Error("--run-dir is required");
  checkProofMode(opts.proof); checkSessionId(opts.session);
  const runDir = path.resolve(opts["run-dir"]);
  const brief = JSON.parse(fs.readFileSync(path.join(runDir, "brief.json"), "utf8"));
  if (opts["ignore-budget"]) brief.ignoreBudget = true;
  const outcome = fs.existsSync(path.join(runDir, "outcome.json")) ? JSON.parse(fs.readFileSync(path.join(runDir, "outcome.json"), "utf8")) : {};
  const gameModule = opts.game ?? brief.gameModule;
  for (const k of applyRunEnv(brief)) log(`${k}: the run's own value (${brief.gameEnv[k]}), not the shell's`);
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
  // A save's name reaches a game's console (Portal: `load <name>`) and file names: only a plain name, also from the log.
  checkName("--save", save, { max: 128 });
  const sessionId = checkSessionId(opts.session ?? outcome.sessionId ?? previous.findLast((r) => r.kind === "event" && r.event === "run.ended")?.data?.sessionId ?? null);
  const runtime = await loadRuntime(opts.runtime ?? brief.runtimeModule ?? brief.runtime);
  const recorder = await loadRecorder(opts.recorder ?? "null");
  const timer = opts.timer ? await loadTimer(opts.timer) : null;
  if (opts["max-turns"]) brief.budget = { ...(brief.budget ?? {}), toolCalls: Number(opts["max-turns"]) };
  if (opts["max-minutes"]) brief.budget = { ...(brief.budget ?? {}), minutes: Number(opts["max-minutes"]) };
  if (opts.headless) brief.headless = true;
  // The tooling may have been updated since the last session: forward within a release line, never back, and past a
  // breaking release only when the runner says so (that choice goes into run.started).
  const tooling = toolingIdentity();
  const earlier = previous.filter((r) => r.kind === "event" && r.event === "run.started").map((r) => r.data?.tooling?.version ?? null);
  const verdict = resumeToolingCheck({ earlier, installed: tooling.version, allowBreaking: opts["allow-breaking"] === true });
  if (!verdict.ok) throw new Error(`This run cannot be resumed with the installed tooling: ${verdict.problem}.`);
  if (verdict.breaking.length) tooling.allowed_breaking = verdict.breaking;
  if (earlier.some(Boolean) && earlier.filter(Boolean).at(-1) !== tooling.version) log(`this run's last session ran tooling ${earlier.filter(Boolean).at(-1)}; this session runs ${tooling.version}`);
  const spec = await brokerSpec({ gameModule, runDir, timeZone: process.env.AAS_TIME_ZONE });
  // The agent continues its own session, so it must get the tools and documentation it had: tooling or a game plugin
  // updated between two sessions may not change them. Checked before anything starts.
  const check = spawnSync(process.execPath, [...spec.nodeArgs, "--check-interface"], { cwd: runDir, env: spec.env, input: "", encoding: "utf8" });
  if (check.status !== 0) {
    const reason = String(check.stderr ?? "").split("\n").find((l) => l.includes("would serve"))?.replace(/^\[aas-broker\] /, "")
      ?? `the broker check failed (${(check.error?.message ?? check.stderr ?? `exit ${check.status}`).trim().split("\n").at(-1)})`;
    throw new Error(`This run cannot be resumed with the installed tooling: ${reason}. ` +
      "The agent would see other tools than in its earlier sessions. Resume with the tooling version the run started with (git checkout of that release).");
  }
  const goalEnd = resolveGoal(plugin, brief.category?.goal).end;
  brief.resume = { sessionId, save, prompt: opts.prompt ?? (goalExtended
    ? `The harness has resumed this run with a larger goal: ${goalEnd?.label ?? goalExtended.to}. The game was restored to your last save state, in the same paused condition. Continue from there.`
    : "The harness paused this run and has now resumed it: the game was restored to your last save state, in the same paused condition. Continue towards the goal from there.") };
  fs.writeFileSync(path.join(runDir, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);

  // The runtime config carries absolute paths; regenerate it if the run directory moved.
  if (runtime.reconfigure) await runtime.reconfigure(runDir, spec, brief);

  const events = createEventLog(runDir);
  const early = earlyStop(log);
  const pidFile = writePidFile(runDir);
  try {
    return await startAndPlay();
  } finally {
    fs.rmSync(pidFile, { force: true });
  }

  async function startAndPlay() {
  // Runs on the Claude plan may only use part of the weekly limit (AAS_BUDGET_WEEKLY_MAX).
  // A runtime that runs on a plan knows its own stand (`budget()`): a run may only use part of it.
  if (runtime.budget && !opts["ignore-budget"]) {
    const b = await runtime.budget();
    log(`budget: ${b.detail}`);
    events.append("budget.checked", { runtime: runtime.id, ok: b.ok, percent: b.percent, max_percent: b.max, ...(b.data ?? {}) });
    if (!b.ok) early.release();
    if (!b.ok) throw new Error(`${runtime.id} plan budget reached: ${b.detail}. Not starting; raise the runtime's budget setting or pass --ignore-budget.`);
  }
  const segment = (fs.existsSync(path.join(runDir, "recording.json")) ? JSON.parse(fs.readFileSync(path.join(runDir, "recording.json"), "utf8")).segments?.length ?? 1 : 0) + 1;
  // Proof, before anything is recorded: every segment has its own ticket, and the chain goes on from the last head.
  const proof = await startSegmentProof({ runDir, segment, runtime, events, opts, log });
  const overlay = opts["overlay-port"] !== undefined ? await startOverlayServer(runDir, { port: Number(opts["overlay-port"]) || 0 }) : null;
  const ctx = { runDir, game: plugin, overlayUrl: overlay?.url ?? null };
  // A failed preflight (OBS already recording, LiveSplit not reachable) stops the run before it starts; the overlay
  // server and the recorder's connection are closed too, or they keep the process alive after the error.
  try {
    await recorder.preflight(brief, plugin);
    early.check();
    await timer?.preflight?.(brief, plugin);
  } catch (error) {
    early.release();
    await recorder.disconnect?.();
    await overlay?.close();
    throw error;
  }
  let t0 = null;
  let ready = null;
  try {
    // As in run.mjs: the recorder may refuse after it began recording (the game capture shows nothing), the game
    // may not come up, and the timer may refuse; in each case what was started is stopped and closed below.
    ({ t0 } = await recorder.start(brief, ctx));
    events.append("recording.started", { recorder: recorder.id, t0: t0.toISOString(), segment });
    early.check();
    if (plugin.prepareRun) ready = await plugin.prepareRun({ runDir, log, resume: true, save, seed: brief.seed ?? null, goal: brief.category?.goal ?? null });
    if (plugin.loadState) ready = (await plugin.loadState({ name: save, log, runDir, seed: brief.seed ?? null })) ?? ready;
    events.append("game.ready", { at: new Date().toISOString(), restored: save, seed: ready?.seed ?? null, seed_code: ready?.seed_code ?? null });
    early.check();
    // In-game time already played before this resume, as the timer counts it (igt.mjs), so LiveSplit continues from it.
    const igtSoFar = previous.filter((r) => r.kind === "event" && r.event === "game.playback" && r.data?.phase === "end").reduce((acc, r) => acc + playbackSeconds(r.data), 0);
    await timer?.start(brief, { igt: igtSoFar });
    log(`timer continues from IGT ${igtSoFar.toFixed(3)} s`);
    early.check();
  } catch (error) {
    early.release();
    // Stop the recording again and discard its file, so that no recording keeps running and no stray segment lands
    // in the run directory.
    const aborted = await recorder.stop().catch(() => ({ files: [] }));
    for (const f of aborted.files ?? []) fs.rmSync(f, { force: true });
    events.append("recording.stopped", { files: [], aborted: String(error?.message ?? error) });
    events.append("run.error", { message: `${t0 ? "game start" : "recording start"} failed: ${String(error?.message ?? error)}` });
    await overlay?.close();
    // As at the start of a run: what was started is closed, or it stays open after the error.
    if (!opts["keep-open"]) await closeAll({ plugin, recorder, timer, log });
    throw error;
  }
  // A short note (it becomes a section label in chapters and splits); the runtime's detail stays apart.
  events.append("run.human", { note: `resumed after ${outcome.status === "failed" ? "a runtime error" : outcome.status === "stopped" ? "a stop" : (outcome.status ?? "a stop")}`, detail: outcome.notes ?? null, save, segment });
  if (goalExtended) {
    events.append("run.human", { note: `goal extended from ${goalExtended.from} to ${goalExtended.to}`, segment });
    events.append("game.goal", { from: goalExtended.from, to: goalExtended.to, segment });
  }
  events.append("run.started", { id: brief.id, game: plugin.id, runtime: runtime.id, recorder: recorder.id, timer: timer?.id ?? null, model: brief.model ?? null, goal: brief.category?.goal ?? null, resumed: true, segment, tooling, overlay: Boolean(overlay) });
  await proof.start();
  const goal = resolveGoal(plugin, brief.category?.goal);
  const { outcome: result, recording } = await session({ runDir, brief, opts, log, plugin, runtime, recorder, timer, overlay, events, early, proof, goal, ready, t0, segment, sessionId, deathsBefore: outcome.deaths ?? 0, outcomeExtra: { resumedFrom: save, segment } });
  return { runDir, outcome: result, recording, segment };
  }
}
