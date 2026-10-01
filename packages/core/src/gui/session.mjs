// What the GUI's Start and Stop do. Every step is one of the harness's own commands, run as a child process and
// shown in the log with the command line, so whatever the GUI does can be done (and continued) from a shell.
// One session at a time: start the game, its recorder and its timer, run `aas run` (which makes the timeline and the cut), then
// `aas publish`.
import { checkEffort, checkInside, checkModel, checkName, checkNumber, checkSeed } from "../validate.mjs";
import crypto from "node:crypto";
import { AAS_KEY_FILE, resolveSignKey } from "../publish.mjs";
import { publicInfo, readKey } from "../sign.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeEnv } from "./env-file.mjs";
import { readSettings as readEnv } from "../settings.mjs";
import { guiGames, onPath, shownScript } from "./checks.mjs";
import { loadRecorder, loadRuntime } from "../plugins.mjs";
import { recordersFor, runtimes, setupPlugins, timers } from "./tools.mjs";
import { OVERLAY_PORT } from "../overlay-server.mjs";
import { aasToolsDir } from "./detect.mjs";
import { toLocal, toWindows } from "./windows-paths.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CLI = path.join(REPO, "packages", "core", "src", "cli.mjs");
const rel = (p) => path.relative(REPO, p) || p;
/** "a, b and c": the steps name what they really start and close, which follows the choices. */
const andList = (parts) => (parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);
const shortName = (plugin) => String(plugin.name ?? plugin.id).replace(/ \(.*/, "");

/** The agents on this machine that can be checked against a game's tools without a model call (a mock run does). */
export const agentsPresent = async () => (await runtimes()).filter((r) => r.ai && r.present);

/**
 * The key `aas publish --sign` would use without a path (publish.mjs resolves it: AAS_SIGN_KEY, the key of `aas key`,
 * an SSH key): its file and public line, or null when there is none yet.
 */
export function signingKey() {
  let file;
  try { file = resolveSignKey(null); } catch { return null; }
  try { return { file, ...publicInfo(crypto.createPublicKey(readKey(file).privateKey)), own: file === AAS_KEY_FILE() }; }
  catch (e) { return { file, error: e.message }; }
}

/** A prompt as `--prompt` takes it: text, at most 4000 characters, no control characters but newlines. */
const checkPrompt = (v) => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 4000 || /[^\P{Cc}\n\t]/u.test(v)) throw new Error("A prompt is text of at most 4000 characters.");
  return v;
};

export function createSession() {
  const lines = [];
  const listeners = new Set();
  let state = { phase: "idle", step: null, game: null, run: null, runDir: null, runtime: null, startedAt: null, result: null };
  let child = null;
  let cancelled = false;
  const emit = (type, data) => { for (const l of listeners) l(type, data); };
  // The last line a command printed: what an action reports back to the page, or why it failed.
  let lastLine = "";
  // While set, every line a command prints is kept here too (a key's claim, the budget's lines, doctor's rows).
  let capture = null;
  const log = (text, kind = "out") => {
    for (const t of String(text).split(/\r?\n/)) {
      if (!t.trim()) continue;
      if (kind === "out" || kind === "err") lastLine = t.trim();
      if (capture && (kind === "out" || kind === "err")) capture.push(t);
      const line = { at: new Date().toTimeString().slice(0, 8), kind, text: t };
      lines.push(line);
      if (lines.length > 3000) lines.shift();
      emit("line", line);
    }
  };
  const set = (patch) => { state = { ...state, ...patch }; emit("state", state); };

  /** Runs `node <args>` from the repository; resolves with the exit code. `shown` is the command as a person would type it. */
  const node = (args, shown) => new Promise((resolve) => {
    log(`$ ${shown ?? `node ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`}`, "cmd");
    child = spawn(process.execPath, args, { cwd: REPO, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => log(d));
    child.stderr.on("data", (d) => log(d));
    child.on("error", (e) => { log(e.message, "err"); resolve(1); });
    child.on("close", (code) => { child = null; resolve(code ?? 1); });
  });

  /** Runs a program of the machine (not a script of this repository), shown and logged the same way. */
  const program = (cmd, args, shown) => new Promise((resolve) => {
    log(`$ ${shown}`, "cmd");
    child = spawn(cmd, args, { cwd: REPO, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => log(d));
    child.stderr.on("data", (d) => log(d));
    child.on("error", (e) => { log(e.message, "err"); resolve(1); });
    child.on("close", (code) => { child = null; resolve(code ?? 1); });
  });

  const nextRunName = (gameFolder, prefix) => {
    const out = toLocal(readEnv().AAS_OUTPUT_DIR ?? "");
    const dir = out ? path.join(out, gameFolder) : null;
    for (let n = 1; n < 1000; n += 1) {
      const name = `${prefix}-${String(n).padStart(2, "0")}`;
      if (!dir || !fs.existsSync(path.join(dir, name))) return name;
    }
    return `${prefix}-${Date.now()}`;
  };

  // A word for the shown command line: quoted when it has to be, with what a double-quoted bash word cannot hold escaped.
  const q = (a) => (/[\s"'()&;|<>$`\\]/.test(a) ? `"${a.replace(/[\\"$`]/g, "\\$&")}"` : a);
  const CLI_SHOWN = "node packages/core/src/cli.mjs";

  /**
   * The commands a session runs for these choices, in order, exactly as a person would type them in the repository
   * folder: the GUI runs these steps and shows them as a worked example of the CLI.
   */
  async function plan(opts) {
    const env = readEnv();
    const output = toLocal(env.AAS_OUTPUT_DIR ?? "");
    const games = await guiGames();
    const g = games.find((x) => x.plugin.id === opts.game);
    if (!g) throw new Error(`Unknown game: ${opts.game}`);
    const setup = g.plugin.setup;
    const runtime = (await runtimes()).find((r) => r.id === opts.runtime && r.present);
    if (!runtime) throw new Error(`Unknown run type: ${opts.runtime}`);
    const run = checkName("Run name", String(opts.run || nextRunName(setup.folder, runtime.prefix)).trim());
    const runDir = output ? path.join(output, setup.folder, run) : `<output>/${setup.folder}/${run}`;
    const pub = output ? path.join(output, setup.folder, "public", run) : `<output>/${setup.folder}/public/${run}`;
    // Without a goal from the page: the game's own end for an AI run, its first end for a mock run, which is a
    // test of the machine and not an attempt (owner, 2026-09-19). The runtime plugin says which of the two it is.
    if (opts.goal && !g.plugin.ends.some((e) => e.id === opts.goal)) throw new Error(`Goal ${JSON.stringify(String(opts.goal)).slice(0, 60)} is not one of ${g.plugin.name}'s ends: ${g.plugin.ends.map((e) => e.id).join(", ")}`);
    const goal = opts.goal || (runtime.ai ? g.plugin.ends.find((e) => e.final)?.id : g.plugin.ends[0]?.id);
    const splits = setup.splits?.[goal];
    const choices = await recordersFor(setup);
    const recorderId = choices.some((r) => r.id === opts.recorder) ? opts.recorder : choices[0].id;
    const recorder = await loadRecorder(recorderId);
    // The timer: the one chosen, else the first that is set up; "none" runs without a clock on screen.
    const timerChoices = (await timers()).filter((t) => t.ready);
    const timer = opts.timer === "none" ? null : timerChoices.find((t) => t.id === opts.timer) ?? timerChoices[0] ?? null;
    const runArgs = ["run", "--runtime", runtime.id, "--game", g.file, "--run-dir", runDir, "--recorder", recorderId, ...(timer ? ["--timer", timer.id] : []), "--overlay-port", String(OVERLAY_PORT), "--headless", "--goal", goal];
    // A mock plays the game's own script.
    if (!runtime.ai) runArgs.push("--bot", setup.bot);
    if (opts.maxMinutes) runArgs.push("--max-minutes", String(checkNumber("Time limit (minutes)", opts.maxMinutes, { min: 0.01 })));
    if (opts.maxTurns) runArgs.push("--max-turns", String(checkNumber("Turn limit", opts.maxTurns, { integer: true, min: 1 })));
    // The autosave: every N minutes (the CLI's own default when empty), or off.
    if (opts.autosave === "off") runArgs.push("--no-autosave");
    else if (opts.autosave) runArgs.push("--autosave-minutes", String(checkNumber("Autosave (minutes)", opts.autosave, { min: 0.001 })));
    if (opts.keepOpen) runArgs.push("--keep-open");
    // The model and its effort go to an AI run only, as `aas run` takes them (--model, --effort); empty is the AI's
    // own default. A mock run asks no model anything. So do the prompt and the instructions: a mock plays its script.
    if (runtime.ai && opts.model) runArgs.push("--model", checkModel(String(opts.model)));
    if (runtime.ai && opts.effort) runArgs.push("--effort", checkEffort(opts.effort));
    const prompt = runtime.ai ? checkPrompt(opts.prompt) : null;
    if (prompt) runArgs.push("--prompt", prompt);
    // The instructions file: a file on this machine, read by `aas configure` into the brief (and so into the bundle).
    const instructions = runtime.ai && opts.instructions ? toLocal(String(opts.instructions)) : null;
    if (instructions) {
      if (!fs.existsSync(instructions) || !fs.statSync(instructions).isFile()) throw new Error(`Instructions file ${toWindows(instructions)} is not there.`);
      runArgs.push("--instructions", instructions);
    }
    // A game without a seed never gets one, whatever the page sends.
    if (opts.seed && setup.seed) runArgs.push("--seed", checkSeed(String(opts.seed)));
    // The bundle is signed when this machine has a key (`aas key`, AAS_SIGN_KEY, or an SSH key), as `aas publish --sign` would.
    const key = signingKey();
    const publishArgs = ["publish", runDir, pub, ...(key && !key.error ? ["--sign"] : [])];
    // Long command lines are shown one option per line (bash continuation), so they stay readable and still paste.
    const shownArgs = (args) => {
      const words = args.map((a) => (a === g.file || a === setup.bot ? rel(a) : q(a)));
      const parts = [words[0]];
      for (let i = 1; i < words.length; i += 1) {
        if (words[i].startsWith("--") && words[i + 1] !== undefined && !words[i + 1].startsWith("--")) { parts.push(`${words[i]} ${words[i + 1]}`); i += 1; } else parts.push(words[i]);
      }
      return parts.join(" \\\n    ");
    };
    // A mock run is the test of everything this machine has, and it may not cost tokens: so it starts by having
    // every agent that is installed reach the game's tools, without asking the model anything.
    const agents = runtime.ai ? [] : await agentsPresent();
    const agentStep = (a) => {
      const args = ["check-agent", "--runtime", a.id, "--game", g.file];
      return { id: `agent-${a.id}`, title: `Does ${a.name} reach the game's tools? (no model call, so no tokens)`, args: [CLI, ...args], shown: `${CLI_SHOWN} ${shownArgs(args)}` };
    };
    // What the session starts, by name, and so what it closes at the end (or leaves open with --keep-open).
    const programs = [g.plugin.name, ...(recorder.launch ? [shortName(recorder)] : []), ...(timer ? [timer.name] : [])];
    const steps = [
      ...agents.map(agentStep),
      { id: "game", title: `Start ${g.plugin.name} with its mods and bridge (a game that is already up is left alone)`, args: [setup.launch], shown: shownScript(setup.launch) },
      ...(recorder.launch ? [{ id: "recorder", title: `Start ${shortName(recorder)} (the recording)`, args: [recorder.launch], shown: shownScript(recorder.launch) }] : []),
      ...(timer?.launch ? [{ id: "timer", title: `Start ${timer.name}${splits ? " with the splits for this goal" : ""}`, args: [timer.launch, ...(splits ? [splits] : [])], shown: `${shownScript(timer.launch)}${splits ? ` -- ${rel(splits)}` : ""}` }] : []),
      { id: "run", title: `The run, played by ${runtime.ai ? runtime.name : "the game's script"}; it ${opts.keepOpen ? "leaves" : "closes"} ${andList(programs)} ${opts.keepOpen ? "open" : ""} at the end, then makes the timeline and the cut (the video without the thinking pauses)`.replace(/ {2,}/g, " "), args: [CLI, ...runArgs], shown: `${CLI_SHOWN} ${shownArgs(runArgs)}` },
      { id: "publish", title: `The bundle (a folder, a public zip to share and an upload zip for the Archive)${key && !key.error ? `, signed with ${key.own ? "your key from aas key" : toWindows(key.file)}` : ", unsigned: no signing key on this machine yet (Signing, on the Run tab)"}`, args: [CLI, ...publishArgs], shown: `${CLI_SHOWN} ${shownArgs(publishArgs)}` },
    ];
    return { game: g, setup, runtime, run, runDir, pub, goal, timer: timer?.id ?? "none", timers: timerChoices.map(({ id, name }) => ({ id, name })), programs, output, steps, recorder: recorderId, recorders: choices, signed: Boolean(key && !key.error), stop: setup.stop ? { args: [setup.stop], shown: shownScript(setup.stop) } : null };
  }

  /** Runs a session's steps in order: the checks, the game, the recorder, the timer, the run (with its timeline and cut), the bundle. */
  function execute(p, { runDir, pub }) {
    const { runtime } = p;
    const byId = Object.fromEntries(p.steps.map((st) => [st.id, st]));
    (async () => {
      try {
        const step = async (st) => {
          if (cancelled) throw new Error("stopped");
          set({ step: st.id, stepTitle: st.title });
          const code = await node(st.args, st.shown);
          if (code !== 0) throw new Error(`${st.title} failed (exit ${code})`);
        };
        const agentSteps = p.steps.filter((st) => st.id.startsWith("agent-"));
        for (const st of agentSteps) await step(st);
        if (!runtime.ai && !agentSteps.length) log("No agent CLI is installed, so a mock run cannot check one; everything else is tested.", "note");
        await step(byId.game);
        if (byId.recorder) await step(byId.recorder);
        if (byId.timer) await step(byId.timer);
        else log("No timer: the run has no clock on screen (the splits are still published).", "note");
        if (cancelled) throw new Error("stopped");
        set({ phase: "running", step: "run", stepTitle: byId.run.title });
        // The outcome of this session only: a Continue whose start failed left the previous session's outcome.json,
        // which was shown as this one's (2026-10-02, found by reading the flow).
        const outcomeFile = path.join(runDir, "outcome.json");
        const outcomeBefore = fs.existsSync(outcomeFile) ? fs.statSync(outcomeFile).mtimeMs : null;
        const runCode = await node(byId.run.args, byId.run.shown);
        set({ phase: "finishing", step: "publish", stepTitle: byId.publish.title });
        let outcome = null;
        try { if (fs.statSync(outcomeFile).mtimeMs !== outcomeBefore) outcome = JSON.parse(fs.readFileSync(outcomeFile, "utf8")); } catch { /* the run did not get that far */ }
        // A stop before the session started leaves no outcome: that is the user's stop, not a failure.
        const stoppedEarly = !outcome && /before the session started/.test(lastLine);
        const result = { status: outcome?.status ?? (stoppedEarly ? "stopped before the session started" : runCode === 0 ? "unknown" : "failed"), notes: outcome?.notes ?? (stoppedEarly ? "the recording of those seconds was discarded; start again for a new run" : null), runDir: toWindows(runDir), recording: null, bundle: null };
        try { const rec = fs.readdirSync(path.join(runDir, "recording")).find((f) => /\.(mp4|mkv)$/i.test(f)); if (rec) result.recording = toWindows(path.join(runDir, "recording", rec)); } catch { /* no recording */ }
        // A run that ended before it started (a failed check) has closed nothing: close it here.
        if (!outcome && p.stop) { log("The run did not start; closing what was started.", "note"); await node(p.stop.args, p.stop.shown); }
        if (fs.existsSync(path.join(runDir, "run.jsonl")) && outcome) {
          const code = await node(byId.publish.args, byId.publish.shown);
          if (fs.existsSync(`${pub}-upload.zip`)) result.bundle = toWindows(`${pub}-upload.zip`);
          if (fs.existsSync(`${pub}-public.zip`)) result.publicBundle = toWindows(`${pub}-public.zip`);
          if (code !== 0) log("The bundle does not meet every rule yet; see the check above.", "note");
        }
        set({ phase: "idle", step: null, stepTitle: null, result });
        log(`Session ended: ${result.status}${result.bundle ? `; bundle ${result.bundle}` : ""}`, "head");
      } catch (error) {
        log(String(error.message ?? error), "err");
        if (p.stop) { log("Closing what was started.", "note"); await node(p.stop.args, p.stop.shown); }
        set({ phase: "idle", step: null, stepTitle: null, result: { status: cancelled ? "stopped" : "failed", notes: String(error.message ?? error), runDir: toWindows(runDir) } });
      }
    })();
  }

  async function start(opts) {
    if (state.phase !== "idle") throw new Error("A session is already running.");
    const p = await plan(opts);
    const { game: g, setup, runtime, run, runDir, pub, output } = p;
    if (!output || !fs.existsSync(output)) throw new Error("Choose an output location first (Setup).");
    if (!runtime.ai && !setup.bot) throw new Error(`${g.plugin.name} has no scripted player for a mock run.`);
    if (fs.existsSync(runDir)) throw new Error(`${toWindows(runDir)} already exists; choose another run name.`);
    cancelled = false;
    set({ phase: "starting", step: "game", stepTitle: p.steps.find((st) => st.id === "game").title, game: g.plugin.id, run, runDir: toWindows(runDir), runtime: runtime.id, programs: p.programs, startedAt: new Date().toISOString(), result: null });
    log(`Session: ${g.plugin.name}, ${runtime.label}, run ${run} → ${toWindows(runDir)}`, "head");
    execute(p, { runDir, pub });
    return state;
  }

  /**
   * Continue: a run that stopped (a budget, a limit, a Stop) goes on as its next segment with `aas resume`, with the
   * recorder and timer it had, the game and its tools started first like at Start, and a new revision of its bundle.
   */
  /** What a stopped run can be continued with: its game's later ends, its saves, its goal so far. */
  async function runInfo(runDirShown) {
    const runDir = toLocal(runDirShown ?? "");
    await checkInside("Run folder", runDir, toLocal(readEnv().AAS_OUTPUT_DIR ?? ""));
    if (!runDir || !fs.existsSync(path.join(runDir, "run.jsonl"))) throw new Error("Not a run that has started.");
    const brief = JSON.parse(fs.readFileSync(path.join(runDir, "brief.json"), "utf8"));
    const records = fs.readFileSync(path.join(runDir, "run.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const started = records.filter((r) => r.event === "run.started").map((r) => r.data).at(-1) ?? {};
    const g = (await guiGames()).find((x) => x.plugin.id === (started.game ?? brief.category?.game));
    const ends = g?.plugin.ends ?? [];
    const goal = brief.category?.goal ?? "";
    const at = ends.findIndex((e) => e.id === goal);
    const saves = [...new Set(records.filter((r) => r.kind === "event" && r.event === "game.saved").map((r) => r.data?.name).filter(Boolean))];
    // What Continue starts again, by name: the game, the recorder and the timer this run started with.
    const recorder = started.recorder ? await loadRecorder(started.recorder).catch(() => null) : null;
    const timer = started.timer ? (await timers()).find((t) => t.id === started.timer) : null;
    const programs = [g?.plugin.name ?? "the game", ...(recorder?.launch ? [shortName(recorder)] : []), ...(timer ? [timer.name] : [])];
    return { runDir: toWindows(runDir), game: g?.plugin.id ?? null, runtime: brief.runtime, programs, goal, ends: ends.map((e) => ({ id: e.id, label: e.label, later: at >= 0 && ends.indexOf(e) > at })), saves, lastSave: saves.at(-1) ?? null, ai: (await runtimes()).find((r) => r.id === brief.runtime)?.ai === true };
  }

  async function resume(runDirShown, opts = {}) {
    if (state.phase !== "idle") throw new Error("A session is already running.");
    const runDir = toLocal(runDirShown ?? "");
    // Only a run in the output location: a run directory names the modules `aas resume` loads.
    await checkInside("Run folder", runDir, toLocal(readEnv().AAS_OUTPUT_DIR ?? ""));
    if (!runDir || !fs.existsSync(path.join(runDir, "run.jsonl"))) throw new Error("Not a run that has started.");
    let outcome = null;
    try { outcome = JSON.parse(fs.readFileSync(path.join(runDir, "outcome.json"), "utf8")); } catch { /* no session ended in this run yet */ }
    if (!outcome) throw new Error("This run has no ended session to continue: its start did not get as far as the agent. Start it again with Run.");
    // As aas resume: only a run whose goal was reached is over (an agent that ended its own session is not).
    if (outcome.status === "completed" && outcome.over && !opts.goal) throw new Error(`This run reached its goal (${outcome.over.label ?? "victory"}); there is nothing to continue, unless the goal is extended.`);
    const brief = JSON.parse(fs.readFileSync(path.join(runDir, "brief.json"), "utf8"));
    const started = fs.readFileSync(path.join(runDir, "run.jsonl"), "utf8").split("\n").filter((l) => l.includes('"run.started"')).map((l) => JSON.parse(l).data).at(-1) ?? {};
    const games = await guiGames();
    const g = games.find((x) => x.plugin.id === (started.game ?? brief.category?.game));
    if (!g) throw new Error("The game of this run is not in this tooling.");
    const setup = g.plugin.setup;
    const runtime = (await runtimes()).find((r) => r.id === brief.runtime && r.present);
    if (!runtime) throw new Error(`This run was made with ${JSON.stringify(String(brief.runtime)).slice(0, 60)}, which is not on this machine; continue it with aas resume.`);
    // The recorder and the timer the run started with (its run.started event).
    if (!started.recorder) throw new Error("The run's log does not say which recorder it used; continue it with aas resume --recorder <id>.");
    const recorderId = started.recorder;
    const recorder = await loadRecorder(recorderId);
    const timer = started.timer ? (await timers()).find((t) => t.id === started.timer) ?? null : null;
    const revision = (() => { try { return Number(JSON.parse(fs.readFileSync(path.join(runDir, "publish-revision.json"), "utf8")).revision) + 1 || 2; } catch { return 1; } })();
    const run = path.basename(runDir);
    const pub = path.join(path.dirname(runDir), "public", revision > 1 ? `${run}-r${revision}` : run);
    const args = ["resume", "--run-dir", runDir, "--recorder", recorderId, ...(timer ? ["--timer", timer.id] : []), "--overlay-port", String(OVERLAY_PORT), "--headless"];
    // The choices Continue offers, as `aas resume` takes them: a later end, the save to start from, the limits, a
    // prompt for the next segment, and going on past a breaking release of the tooling.
    if (opts.goal) { if (!g.plugin.ends.some((e) => e.id === opts.goal)) throw new Error(`Goal ${JSON.stringify(String(opts.goal)).slice(0, 60)} is not one of ${g.plugin.name}'s ends.`); args.push("--goal", opts.goal); }
    if (opts.save) args.push("--save", checkName("Save", String(opts.save), { max: 128 }));
    if (opts.maxMinutes) args.push("--max-minutes", String(checkNumber("Time limit (minutes)", opts.maxMinutes, { min: 0.01 })));
    if (opts.maxTurns) args.push("--max-turns", String(checkNumber("Turn limit", opts.maxTurns, { integer: true, min: 1 })));
    if (opts.keepOpen) args.push("--keep-open");
    const prompt = runtime.ai ? checkPrompt(opts.prompt) : null;
    if (prompt) args.push("--prompt", prompt);
    if (opts.allowBreaking) args.push("--allow-breaking");
    const key = signingKey();
    const publishArgs = ["publish", runDir, pub, ...(key && !key.error ? ["--sign"] : [])];
    const steps = [
      { id: "game", title: `Start ${g.plugin.name} with its mods and bridge (a game that is already up is left alone)`, args: [setup.launch], shown: shownScript(setup.launch) },
      ...(recorder.launch ? [{ id: "recorder", title: `Start ${shortName(recorder)} (the recording)`, args: [recorder.launch], shown: shownScript(recorder.launch) }] : []),
      ...(timer?.launch ? [{ id: "timer", title: `Start ${timer.name}`, args: [timer.launch], shown: shownScript(timer.launch) }] : []),
      { id: "run", title: "The run goes on as its next segment, then the timeline and the cut are made again", args: [CLI, ...args], shown: `${CLI_SHOWN} ${args.map((a) => q(a)).join(" ")}` },
      { id: "publish", title: `The bundle again, as a new revision${key && !key.error ? ", signed" : ", unsigned"}`, args: [CLI, ...publishArgs], shown: `${CLI_SHOWN} ${publishArgs.map((a) => q(a)).join(" ")}` },
    ];
    const programs = [g.plugin.name, ...(recorder.launch ? [shortName(recorder)] : []), ...(timer ? [timer.name] : [])];
    const p = { game: g, setup, runtime, run, runDir, pub, steps, programs, stop: setup.stop ? { args: [setup.stop], shown: shownScript(setup.stop) } : null };
    cancelled = false;
    set({ phase: "starting", step: "game", stepTitle: steps[0].title, game: g.plugin.id, run, runDir: toWindows(runDir), runtime: runtime.id, programs, startedAt: new Date().toISOString(), result: null });
    log(`Continue: ${g.plugin.name}, run ${run} → ${toWindows(runDir)}`, "head");
    execute(p, { runDir, pub });
    return state;
  }

  /** Stop: a running agent session ends like a budget stop (the run saves, keeps its recording and closes everything);
   *  before that, the start is cancelled after the current step; with nothing running, everything is closed. */
  async function stop(gameId) {
    if (state.phase === "running" && child) { log("Stopping the run (the game is saved and the recording kept).", "note"); set({ phase: "stopping" }); child.kill("SIGINT"); return state; }
    if (state.phase === "starting") { cancelled = true; log("Stopping after this step.", "note"); return state; }
    if (state.phase !== "idle") return state;
    const games = await guiGames();
    const g = games.find((x) => x.plugin.id === (gameId ?? state.game)) ?? games[0];
    set({ phase: "stopping", step: "close", stepTitle: `Close what ${g.plugin.name}'s stop script closes` });
    await node([g.plugin.setup.stop], shownScript(g.plugin.setup.stop));
    set({ phase: "idle", step: null, stepTitle: null });
    return state;
  }

  /**
   * The archive from the page: sign in or out, extend, revoke or delete a ticket, upload a bundle. Each is the CLI's
   * own command, shown in the log as a person would type it.
   */
  async function archive(action, arg = null) {
    if (state.phase !== "idle") throw new Error("Wait until the session has ended.");
    const cmds = {
      login: [["login"], "login"],
      logout: [["logout"], "logout"],
      extend: [["tickets", "extend", arg], `tickets extend ${arg}`],
      revoke: [["tickets", "revoke", arg], `tickets revoke ${arg}`],
      delete: [["tickets", "delete", arg], `tickets delete ${arg}`],
      upload: [["upload", toLocal(arg ?? "")], `upload ${q(toLocal(arg ?? ""))}`],
    };
    // Upload sends a file to the Archive: only the upload zip of a bundle (<run>-upload.zip) from the output location.
    if (action === "upload") {
      if (!/-upload\.zip$/i.test(String(arg ?? ""))) throw new Error("Only the upload zip (<run>-upload.zip) goes to the Archive; the public zip is the bundle to share.");
      await checkInside("Bundle", toLocal(arg), toLocal(readEnv().AAS_OUTPUT_DIR ?? ""));
    }
    const c = cmds[action];
    if (!c || (action !== "login" && action !== "logout" && !arg)) throw new Error(`Unknown action: ${action}`);
    if (!/^[0-9a-f]{32}$/.test(String(arg)) && ["extend", "revoke", "delete"].includes(action)) throw new Error("Not a ticket.");
    set({ phase: "working", step: action });
    try {
      lastLine = "";
      const code = await node([CLI, ...c[0]], `${CLI_SHOWN} ${c[1]}`);
      // The command's own last line says what happened (or, as "FAIL: …", why not): that is the answer.
      const said = lastLine.replace(/^FAIL:\s*/, "");
      if (code !== 0) throw new Error(said || `${action} did not succeed`);
      return said || `${action}: done`;
    } finally {
      set({ phase: "idle", step: null, stepTitle: null });
    }
  }

  /**
   * The publisher's signing key, as `aas key` makes and claims it: create (the key `aas publish --sign` uses without a
   * path), and claim (the signed statement that names the identities the key belongs to; its text comes back).
   */
  async function key(action, identities = []) {
    if (state.phase !== "idle") throw new Error("Wait until the session has ended.");
    const ids = [].concat(identities ?? []).map((x) => String(x).trim()).filter(Boolean);
    for (const id of ids) if (!/^(https?:\/\/|mailto:)[^\s"'`$\\]{3,200}$/.test(id)) throw new Error(`${id.slice(0, 60)} is not an identity: https://… or mailto:…`);
    if (action === "claim" && !ids.length) throw new Error("A claim names at least one identity (https://… or mailto:…).");
    if (action !== "create" && action !== "claim") throw new Error(`Unknown action: ${action}`);
    const args = action === "create" ? ["key"] : ["key", "--claim", ...ids.flatMap((id) => ["--identity", id])];
    set({ phase: "working", step: `key-${action}` });
    try {
      lastLine = ""; capture = [];
      const code = await node([CLI, ...args], `${CLI_SHOWN} ${args.map((a) => q(a)).join(" ")}`);
      const out = capture; capture = null;
      if (code !== 0) throw new Error(lastLine.replace(/^FAIL:\s*/, "") || `${action} did not succeed`);
      if (action === "create") { const k = signingKey(); return { message: `${out[0] ?? "done"}; bundles are signed with it from now on`, key: k }; }
      // The claim is the text after the key's own three lines (file, public line, fingerprint).
      const text = out.slice(3).join("\n").trim();
      return { message: `Claim made for ${ids.join(", ")}; copy it from below and publish it where only you can write`, claim: text };
    } finally {
      capture = null;
      set({ phase: "idle", step: null, stepTitle: null });
    }
  }

  /** The plans' stand, as `aas budget` prints it: one line per AI, and whether a run may start. */
  async function budget() {
    if (state.phase !== "idle") throw new Error("Wait until the session has ended.");
    set({ phase: "working", step: "budget" });
    try {
      capture = [];
      const code = await node([CLI, "budget"], `${CLI_SHOWN} budget`);
      const lines = capture; capture = null;
      return { ok: code === 0, lines, message: code === 0 ? "Runs may start: every plan is under its limit." : "A plan is at its limit for runs: an AI run on it is refused until the window resets (see the lines)." };
    } finally {
      capture = null;
      set({ phase: "idle", step: null, stepTitle: null });
    }
  }

  /** What an AI's CLI names today (`aas options`): the models and efforts the Run tab offers for it. */
  async function options(runtimeId) {
    const runtime = (await runtimes()).find((r) => r.id === runtimeId && r.ai && r.present);
    if (!runtime) throw new Error(`Unknown AI: ${runtimeId}`);
    const plugin = await loadRuntime(runtime.id);
    if (!plugin.options) return { source: null, models: [], efforts: [], freeModel: "a model's full name" };
    const o = await plugin.options();
    return { ...o, shown: `${CLI_SHOWN} options --runtime ${runtime.id}` };
  }

  /**
   * The tools around a run, each the CLI's own command shown in the log: check (a bundle against the rules), render
   * (the cut with burned-in timers), sheet (the YouTube text), doctor (read-only checks for the choices on the Run
   * tab), connection (the game started, the broker against it, everything closed again).
   */
  async function tool(action, arg = {}) {
    if (state.phase !== "idle") throw new Error("Wait until the session has ended.");
    const output = toLocal(readEnv().AAS_OUTPUT_DIR ?? "");
    let args = null, shown = null, steps = null, stop = null;
    if (action === "check") {
      const zip = toLocal(String(arg.path ?? ""));
      await checkInside("Bundle", zip, output);
      if (!fs.existsSync(zip)) throw new Error("The bundle is not there.");
      args = ["check", zip];
    } else if (action === "render" || action === "sheet") {
      const runDir = toLocal(String(arg.runDir ?? ""));
      await checkInside("Run folder", runDir, output);
      if (!fs.existsSync(path.join(runDir, "run.jsonl"))) throw new Error("Not a run that has started.");
      args = action === "render" ? ["render", runDir, ...(arg.burn ? ["--burn", String(arg.burn).replace(/[^a-z,]/g, "")] : [])] : ["upload-sheet", runDir];
    } else if (action === "doctor" || action === "connection") {
      const games = await guiGames();
      const g = games.find((x) => x.plugin.id === arg.game);
      if (!g) throw new Error(`Unknown game: ${arg.game}`);
      const runtime = (await runtimes()).find((r) => r.id === arg.runtime && r.present);
      if (action === "doctor") {
        const recorders = await recordersFor(g.plugin.setup);
        const rec = recorders.some((r) => r.id === arg.recorder) ? arg.recorder : recorders[0].id;
        const ready = (await timers()).filter((t) => t.ready);
        const timer = arg.timer === "none" ? null : ready.find((t) => t.id === arg.timer) ?? ready[0] ?? null;
        args = ["doctor", "--game", g.file, "--recorder", rec, ...(timer ? ["--timer", timer.id] : []), ...(runtime?.ai ? ["--runtime", runtime.id] : [])];
      } else {
        // The connection: the game up as at a start, the broker against it with the plugin's own exercise, then closed.
        if (!output || !fs.existsSync(output)) throw new Error("Choose an output location first (Setup).");
        const dir = path.join(output, g.plugin.setup.folder, "connection-check");
        const cc = ["check-connection", "--game", g.file, "--run-dir", dir, "--exercise"];
        steps = [
          { args: [g.plugin.setup.launch], shown: shownScript(g.plugin.setup.launch) },
          { args: [CLI, ...cc], shown: `${CLI_SHOWN} ${cc.map((a) => (a === g.file ? rel(a) : q(a))).join(" ")}` },
        ];
        stop = g.plugin.setup.stop ? { args: [g.plugin.setup.stop], shown: shownScript(g.plugin.setup.stop) } : null;
      }
    } else throw new Error(`Unknown tool: ${action}`);
    set({ phase: "working", step: action });
    try {
      lastLine = ""; capture = [];
      let code = 0;
      for (const st of steps ?? [{ args: [CLI, ...args], shown: shown ?? `${CLI_SHOWN} ${args.map((a) => q(a)).join(" ")}` }]) {
        code = await node(st.args, st.shown);
        if (code !== 0) break;
      }
      // The command's own last line is the answer, said before the close (whose lines follow in the log).
      const said = lastLine.replace(/^FAIL:\s*/, "");
      const lines = capture; capture = null;
      if (stop) { log("Closing what was started.", "note"); await node(stop.args, stop.shown); }
      // A check's exit code is its verdict (the bundle does not conform, a doctor row failed), not whether the
      // button worked: the report is the answer, and the log says which rows failed.
      const verdict = action === "check" || action === "doctor";
      if (code !== 0 && !verdict) throw new Error(said || `${action} did not succeed`);
      const made = action === "render" ? lines.map((l) => l.match(/^written (.+?): /)?.[1]).find(Boolean) : action === "sheet" ? lines.map((l) => l.match(/^upload sheet: (.+UPLOAD\.txt)$/)?.[1]).find(Boolean) : null;
      return { ok: code === 0, message: verdict ? `${action === "check" ? "Checked" : "Checks done"}: ${said}` : said || `${action}: done`, lines, made: made ? toWindows(made) : null };
    } finally {
      capture = null;
      set({ phase: "idle", step: null, stepTitle: null });
    }
  }

  /** One-click fixes named by the set-up checks. */
  async function fix(id) {
    if (state.phase !== "idle") throw new Error("Wait until the session has ended.");
    set({ phase: "working", step: id });
    try {
      if (id.startsWith("plugin:")) {
        // A runtime's, recorder's or timer's own button (its setup.fixes): a script of the plugin, or a program.
        const [, kind, pluginId, fixId] = id.split(":");
        const t = (await setupPlugins()).find((x) => x.kind === kind && x.id === pluginId);
        const f = t?.setup.fixes?.[fixId];
        if (!f) throw new Error(`Unknown fix: ${id}`);
        const args = typeof f.args === "function" ? f.args().map(String) : [];
        const shownArgs = args.map((a) => q(toWindows(a) || a)).join(" ");
        const code = f.script
          ? await node([f.script, ...args], `${shownScript(f.script)}${args.length ? ` ${shownScript(f.script).startsWith("npm ") ? "-- " : ""}${shownArgs}` : ""}`)
          : await program(f.command[0], [...f.command.slice(1), ...args], f.command.join(" ") + (args.length ? ` ${shownArgs}` : ""));
        if (code !== 0) throw new Error(`${f.label} did not succeed; see the log.`);
        // What the action put somewhere is saved as the plugin's setting (an install's program).
        if (typeof f.sets === "function") { const sets = f.sets(); writeEnv(sets); log(`Saved in the settings: ${Object.keys(sets).join(", ")}`, "note"); }
      } else if (id === "install-svv") {
        const dir = path.join(aasToolsDir(), "SoundVolumeView");
        const code = await node([path.join(REPO, "packages", "core", "src", "windows", "install-soundvolumeview.mjs"), dir], `node packages/core/src/windows/install-soundvolumeview.mjs "${toWindows(dir)}"`);
        if (code !== 0) throw new Error("SoundVolumeView could not be installed.");
        writeEnv({ AAS_SOUNDVOLUMEVIEW: path.join(dir, "SoundVolumeView.exe") });
      } else if (id.startsWith("fix:")) {
        const [, gameId, fixId] = id.split(":");
        const g = (await guiGames()).find((x) => x.plugin.id === gameId);
        const f = g?.plugin.setup.fixes?.[fixId];
        if (!f) throw new Error(`Unknown fix: ${id}`);
        const code = await node([f.script], shownScript(f.script));
        if (code !== 0) throw new Error(`${f.label} did not succeed; see the log.`);
      } else if (id.startsWith("install:")) {
        const g = (await guiGames()).find((x) => x.plugin.id === id.slice(8));
        if (!g?.plugin.setup.install) throw new Error("Nothing to install for this game.");
        const code = await node([g.plugin.setup.install], `node ${rel(g.plugin.setup.install)}`);
        if (code !== 0) throw new Error(`Installing for ${g.plugin.name} failed.`);
      } else throw new Error(`Unknown fix: ${id}`);
    } finally {
      set({ phase: "idle", step: null, stepTitle: null });
    }
  }

  return {
    get state() { return state; },
    get lines() { return lines; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    plan, start, resume, runInfo, stop, fix, archive, key, budget, options, tool, nextRunName, log,
  };
}
