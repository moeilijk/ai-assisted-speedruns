// What the GUI's Start and Stop do. Every step is one of the harness's own commands, run as a child process and
// shown in the log with the command line, so whatever the GUI does can be done (and continued) from a shell.
// One session at a time: start the game, OBS and LiveSplit, run `aas run` (which makes the timeline and the cut), then
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
import { aasToolsDir, obsWebsocketConfig } from "./detect.mjs";
import { toLocal, toWindows } from "./windows-paths.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CLI = path.join(REPO, "packages", "core", "src", "cli.mjs");
const rel = (p) => path.relative(REPO, p) || p;
/** "a, b and c": the steps name what they really start and close, which follows the choices. */
const andList = (parts) => (parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);
const shortName = (plugin) => String(plugin.name ?? plugin.id).replace(/ \(.*/, "");

export const RUNTIMES = [
  { id: "scripted", label: "Mock run (script, no AI)", prefix: "mock" },
  { id: "claude-code", label: "Claude Code (AI run)", prefix: "claude", cli: "claude" },
  { id: "codex", label: "Codex (AI run)", prefix: "codex", cli: "codex" },
];

/** The recorders a game plugin says fit it (default: OBS), each named by its own plugin. */
export async function recorderOptions(setup) {
  const out = [];
  for (const id of [...(setup.recorders ?? ["obs"]), "null"]) { const r = await loadRecorder(id); out.push({ id, name: r.name ?? id }); }
  return out;
}

/** The agents installed on this machine. Testing an agent that is not here proves nothing, and is not a failure. */
export const agentsPresent = () => RUNTIMES.filter((r) => r.cli && onPath(r.cli));

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
    const runtime = RUNTIMES.find((r) => r.id === opts.runtime);
    if (!runtime) throw new Error(`Unknown run type: ${opts.runtime}`);
    const run = checkName("Run name", String(opts.run || nextRunName(setup.folder, runtime.prefix)).trim());
    const runDir = output ? path.join(output, setup.folder, run) : `<output>/${setup.folder}/${run}`;
    const pub = output ? path.join(output, setup.folder, "public", run) : `<output>/${setup.folder}/public/${run}`;
    // Without a goal from the page: the game's own end for an AI run, its first end for a mock run, which is a
    // test of the machine and not an attempt (owner, 2026-09-19). The runtime plugin says which of the two it is.
    const runtimePlugin = await loadRuntime(runtime.id).catch(() => null);
    if (opts.goal && !g.plugin.ends.some((e) => e.id === opts.goal)) throw new Error(`Goal ${JSON.stringify(String(opts.goal)).slice(0, 60)} is not one of ${g.plugin.name}'s ends: ${g.plugin.ends.map((e) => e.id).join(", ")}`);
    const goal = opts.goal || (runtimePlugin?.ai === true ? g.plugin.ends.find((e) => e.final)?.id : g.plugin.ends[0]?.id);
    const livesplit = Boolean(env.AAS_LIVESPLIT_EXE) && fs.existsSync(toLocal(env.AAS_LIVESPLIT_EXE));
    const splits = setup.splits?.[goal];
    const choices = await recorderOptions(setup);
    const recorderId = choices.some((r) => r.id === opts.recorder) ? opts.recorder : choices[0].id;
    const recorder = await loadRecorder(recorderId);
    const runArgs = ["run", "--runtime", runtime.id, "--game", g.file, "--run-dir", runDir, "--recorder", recorderId, ...(livesplit ? ["--timer", "livesplit"] : []), "--overlay-port", "8765", "--headless", "--goal", goal];
    if (runtime.id === "scripted") runArgs.push("--bot", setup.bot);
    if (opts.maxMinutes) runArgs.push("--max-minutes", String(checkNumber("Time limit (minutes)", opts.maxMinutes, { min: 0.01 })));
    if (opts.maxTurns) runArgs.push("--max-turns", String(checkNumber("Turn limit", opts.maxTurns, { integer: true, min: 1 })));
    // The autosave: every N minutes (the CLI's own default when empty), or off.
    if (opts.autosave === "off") runArgs.push("--no-autosave");
    else if (opts.autosave) runArgs.push("--autosave-minutes", String(checkNumber("Autosave (minutes)", opts.autosave, { min: 0.001 })));
    if (opts.keepOpen) runArgs.push("--keep-open");
    // The model and its effort go to an AI run only, as `aas run` takes them (--model, --effort); empty is the AI's
    // own default. A mock run asks no model anything. So do the prompt and the instructions: a mock plays its script.
    if (runtime.id !== "scripted" && opts.model) runArgs.push("--model", checkModel(String(opts.model)));
    if (runtime.id !== "scripted" && opts.effort) runArgs.push("--effort", checkEffort(opts.effort));
    const prompt = runtime.id !== "scripted" ? checkPrompt(opts.prompt) : null;
    if (prompt) runArgs.push("--prompt", prompt);
    // The instructions file: a file on this machine, read by `aas configure` into the brief (and so into the bundle).
    const instructions = runtime.id !== "scripted" && opts.instructions ? toLocal(String(opts.instructions)) : null;
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
    const agents = runtime.id === "scripted" ? agentsPresent() : [];
    const agentStep = (a) => {
      const args = ["check-agent", "--runtime", a.id, "--game", g.file];
      return { id: `agent-${a.id}`, title: `Does ${a.label.replace(" (AI run)", "")} reach the game's tools? (no model call, so no tokens)`, args: [CLI, ...args], shown: `${CLI_SHOWN} ${shownArgs(args)}` };
    };
    const steps = [
      ...agents.map(agentStep),
      { id: "game", title: `Start ${g.plugin.name} with its mods and bridge (a game that is already up is left alone)`, args: [setup.launch], shown: shownScript(setup.launch) },
      ...(recorder.launch ? [{ id: "recorder", title: `Start ${shortName(recorder)} (the recording)`, args: [recorder.launch], shown: shownScript(recorder.launch) }] : []),
      ...(livesplit ? [{ id: "livesplit", title: "Start LiveSplit with the splits for this goal", args: [path.join(REPO, "packages", "timer-livesplit", "launch-livesplit.mjs"), ...(splits ? [splits] : [])], shown: `npm run livesplit:launch${splits ? ` -- ${rel(splits)}` : ""}` }] : []),
      { id: "run", title: `The run, played by ${runtime.id === "scripted" ? "the script" : "the AI"}; it closes ${andList(["the game", ...(livesplit ? ["LiveSplit"] : []), ...(recorder.launch ? [shortName(recorder)] : [])])} at the end, then makes the timeline and the cut (the video without the thinking pauses)`, args: [CLI, ...runArgs], shown: `${CLI_SHOWN} ${shownArgs(runArgs)}` },
      { id: "publish", title: `The bundle (a folder, a public zip to share and an upload zip for the Archive)${key && !key.error ? `, signed with ${key.own ? "your key from aas key" : toWindows(key.file)}` : ", unsigned: no signing key on this machine yet (Signing, on the Run tab)"}`, args: [CLI, ...publishArgs], shown: `${CLI_SHOWN} ${shownArgs(publishArgs)}` },
    ];
    return { game: g, setup, runtime, run, runDir, pub, goal, livesplit, output, steps, recorder: recorderId, recorders: choices, signed: Boolean(key && !key.error), stop: setup.stop ? { args: [setup.stop], shown: shownScript(setup.stop) } : null };
  }

  /** Runs a session's steps in order: the checks, the game, the recorder, LiveSplit, the run (with its timeline and cut), the bundle. */
  function execute(p, { runDir, pub }) {
    const { runtime } = p;
    const byId = Object.fromEntries(p.steps.map((st) => [st.id, st]));
    (async () => {
      try {
        const step = async (st) => {
          if (cancelled) throw new Error("stopped");
          set({ step: st.id });
          const code = await node(st.args, st.shown);
          if (code !== 0) throw new Error(`${st.title} failed (exit ${code})`);
        };
        const agentSteps = p.steps.filter((st) => st.id.startsWith("agent-"));
        for (const st of agentSteps) await step(st);
        if (runtime.id === "scripted" && !agentSteps.length) log("No agent CLI is installed, so a mock run cannot check one; everything else is tested.", "note");
        await step(byId.game);
        if (byId.recorder) await step(byId.recorder);
        if (byId.livesplit) await step(byId.livesplit);
        else log("LiveSplit is not set up: the run has no timer on screen (the splits are still published).", "note");
        if (cancelled) throw new Error("stopped");
        set({ phase: "running", step: "run" });
        const runCode = await node(byId.run.args, byId.run.shown);
        set({ phase: "finishing", step: "publish" });
        let outcome = null;
        try { outcome = JSON.parse(fs.readFileSync(path.join(runDir, "outcome.json"), "utf8")); } catch { /* the run did not get that far */ }
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
        set({ phase: "idle", step: null, result });
        log(`Session ended: ${result.status}${result.bundle ? `; bundle ${result.bundle}` : ""}`, "head");
      } catch (error) {
        log(String(error.message ?? error), "err");
        if (p.stop) { log("Closing what was started.", "note"); await node(p.stop.args, p.stop.shown); }
        set({ phase: "idle", step: null, result: { status: cancelled ? "stopped" : "failed", notes: String(error.message ?? error), runDir: toWindows(runDir) } });
      }
    })();
  }

  async function start(opts) {
    if (state.phase !== "idle") throw new Error("A session is already running.");
    const p = await plan(opts);
    const { game: g, setup, runtime, run, runDir, pub, output } = p;
    if (!output || !fs.existsSync(output)) throw new Error("Choose an output location first (Setup).");
    if (runtime.id === "scripted" && !setup.bot) throw new Error(`${g.plugin.name} has no scripted player for a mock run.`);
    if (fs.existsSync(runDir)) throw new Error(`${toWindows(runDir)} already exists; choose another run name.`);
    cancelled = false;
    set({ phase: "starting", step: "game", game: g.plugin.id, run, runDir: toWindows(runDir), runtime: runtime.id, startedAt: new Date().toISOString(), result: null });
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
    return { runDir: toWindows(runDir), game: g?.plugin.id ?? null, runtime: brief.runtime, goal, ends: ends.map((e) => ({ id: e.id, label: e.label, later: at >= 0 && ends.indexOf(e) > at })), saves, lastSave: saves.at(-1) ?? null, ai: brief.runtime !== "scripted" };
  }

  async function resume(runDirShown, opts = {}) {
    if (state.phase !== "idle") throw new Error("A session is already running.");
    const runDir = toLocal(runDirShown ?? "");
    // Only a run in the output location: a run directory names the modules `aas resume` loads.
    await checkInside("Run folder", runDir, toLocal(readEnv().AAS_OUTPUT_DIR ?? ""));
    if (!runDir || !fs.existsSync(path.join(runDir, "run.jsonl"))) throw new Error("Not a run that has started.");
    const outcome = JSON.parse(fs.readFileSync(path.join(runDir, "outcome.json"), "utf8"));
    if (outcome.status === "completed") throw new Error("This run reached its goal; there is nothing to continue.");
    const brief = JSON.parse(fs.readFileSync(path.join(runDir, "brief.json"), "utf8"));
    const started = fs.readFileSync(path.join(runDir, "run.jsonl"), "utf8").split("\n").filter((l) => l.includes('"run.started"')).map((l) => JSON.parse(l).data).at(-1) ?? {};
    const games = await guiGames();
    const g = games.find((x) => x.plugin.id === (started.game ?? brief.category?.game));
    if (!g) throw new Error("The game of this run is not in this tooling.");
    const setup = g.plugin.setup;
    const runtime = RUNTIMES.find((r) => r.id === brief.runtime);
    if (!runtime) throw new Error(`This run was made with ${JSON.stringify(String(brief.runtime)).slice(0, 60)}, which the GUI does not run; continue it with aas resume.`);
    const recorderId = started.recorder ?? "obs";
    const recorder = await loadRecorder(recorderId);
    const livesplit = started.timer === "livesplit";
    const revision = (() => { try { return Number(JSON.parse(fs.readFileSync(path.join(runDir, "publish-revision.json"), "utf8")).revision) + 1 || 2; } catch { return 1; } })();
    const run = path.basename(runDir);
    const pub = path.join(path.dirname(runDir), "public", revision > 1 ? `${run}-r${revision}` : run);
    const args = ["resume", "--run-dir", runDir, "--recorder", recorderId, ...(livesplit ? ["--timer", "livesplit"] : []), "--overlay-port", "8765", "--headless"];
    // The choices Continue offers, as `aas resume` takes them: a later end, the save to start from, the limits, a
    // prompt for the next segment, and going on past a breaking release of the tooling.
    if (opts.goal) { if (!g.plugin.ends.some((e) => e.id === opts.goal)) throw new Error(`Goal ${JSON.stringify(String(opts.goal)).slice(0, 60)} is not one of ${g.plugin.name}'s ends.`); args.push("--goal", opts.goal); }
    if (opts.save) args.push("--save", checkName("Save", String(opts.save), { max: 128 }));
    if (opts.maxMinutes) args.push("--max-minutes", String(checkNumber("Time limit (minutes)", opts.maxMinutes, { min: 0.01 })));
    if (opts.maxTurns) args.push("--max-turns", String(checkNumber("Turn limit", opts.maxTurns, { integer: true, min: 1 })));
    if (opts.keepOpen) args.push("--keep-open");
    const prompt = runtime.id !== "scripted" ? checkPrompt(opts.prompt) : null;
    if (prompt) args.push("--prompt", prompt);
    if (opts.allowBreaking) args.push("--allow-breaking");
    const key = signingKey();
    const publishArgs = ["publish", runDir, pub, ...(key && !key.error ? ["--sign"] : [])];
    const steps = [
      { id: "game", title: `Start ${g.plugin.name} with its mods and bridge (a game that is already up is left alone)`, args: [setup.launch], shown: shownScript(setup.launch) },
      ...(recorder.launch ? [{ id: "recorder", title: `Start ${shortName(recorder)} (the recording)`, args: [recorder.launch], shown: shownScript(recorder.launch) }] : []),
      ...(livesplit ? [{ id: "livesplit", title: "Start LiveSplit", args: [path.join(REPO, "packages", "timer-livesplit", "launch-livesplit.mjs")], shown: "npm run livesplit:launch" }] : []),
      { id: "run", title: "The run goes on as its next segment, then the timeline and the cut are made again", args: [CLI, ...args], shown: `${CLI_SHOWN} ${args.map((a) => q(a)).join(" ")}` },
      { id: "publish", title: `The bundle again, as a new revision${key && !key.error ? ", signed" : ", unsigned"}`, args: [CLI, ...publishArgs], shown: `${CLI_SHOWN} ${publishArgs.map((a) => q(a)).join(" ")}` },
    ];
    const p = { game: g, setup, runtime, run, runDir, pub, steps, stop: setup.stop ? { args: [setup.stop], shown: shownScript(setup.stop) } : null };
    cancelled = false;
    set({ phase: "starting", step: "game", game: g.plugin.id, run, runDir: toWindows(runDir), runtime: runtime.id, startedAt: new Date().toISOString(), result: null });
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
    set({ phase: "stopping", step: "close" });
    const p = await plan({ game: g.plugin.id, runtime: "scripted" }).catch(() => null);
    await node([g.plugin.setup.stop], p?.stop?.shown ?? `node ${rel(g.plugin.setup.stop)}`);
    set({ phase: "idle", step: null });
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
      set({ phase: "idle", step: null });
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
      set({ phase: "idle", step: null });
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
      set({ phase: "idle", step: null });
    }
  }

  /** What an AI's CLI names today (`aas options`): the models and efforts the Run tab offers for it. */
  async function options(runtimeId) {
    const runtime = RUNTIMES.find((r) => r.id === runtimeId && r.cli);
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
      const runtime = RUNTIMES.find((r) => r.id === arg.runtime);
      const env = readEnv();
      const livesplit = Boolean(env.AAS_LIVESPLIT_EXE) && fs.existsSync(toLocal(env.AAS_LIVESPLIT_EXE));
      if (action === "doctor") {
        const recorders = await recorderOptions(g.plugin.setup);
        const rec = recorders.some((r) => r.id === arg.recorder) ? arg.recorder : recorders[0].id;
        args = ["doctor", "--game", g.file, "--recorder", rec, ...(livesplit ? ["--timer", "livesplit"] : []), ...(runtime?.cli ? ["--runtime", runtime.id] : [])];
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
      set({ phase: "idle", step: null });
    }
  }

  /** One-click fixes named by the set-up checks. */
  async function fix(id) {
    if (state.phase !== "idle") throw new Error("Wait until the session has ended.");
    set({ phase: "working", step: id });
    try {
      if (id === "obs-password") {
        const ws = obsWebsocketConfig();
        if (!ws) throw new Error("OBS's WebSocket settings were not found.");
        writeEnv({ AAS_OBS_URL: `ws://127.0.0.1:${ws.server_port}`, AAS_OBS_PASSWORD: ws.auth_required ? ws.server_password : "" });
        log("OBS's WebSocket address and password copied into the settings.", "note");
      } else if (id === "install-livesplit") {
        const dir = path.join(aasToolsDir(), "LiveSplit");
        const code = await node([path.join(REPO, "packages", "timer-livesplit", "install-livesplit.mjs"), dir], `node packages/timer-livesplit/install-livesplit.mjs "${toWindows(dir)}"`);
        if (code !== 0) throw new Error("LiveSplit could not be installed.");
        writeEnv({ AAS_LIVESPLIT_EXE: path.join(dir, "LiveSplit.exe") });
        log("Windows asks for permission once: LiveSplit gets no network (no update questions) and owns its file types.", "note");
        const setupCode = await node([path.join(REPO, "packages", "timer-livesplit", "windows-setup.mjs"), path.join(dir, "LiveSplit.exe")], `node packages/timer-livesplit/windows-setup.mjs "${toWindows(path.join(dir, "LiveSplit.exe"))}"`);
        if (setupCode !== 0) log("Not done (permission refused?): LiveSplit will ask about updates and file types at its starts.", "note");
      } else if (id === "livesplit-windows") {
        const exe = toLocal(readEnv().AAS_LIVESPLIT_EXE ?? "");
        log("Windows asks for permission once.", "note");
        const code = await node([path.join(REPO, "packages", "timer-livesplit", "windows-setup.mjs"), exe], `node packages/timer-livesplit/windows-setup.mjs "${toWindows(exe)}"`);
        if (code !== 0) throw new Error("Not done: the permission was refused or the rule could not be made.");
      } else if (id === "install-svv") {
        const dir = path.join(aasToolsDir(), "SoundVolumeView");
        const code = await node([path.join(REPO, "packages", "core", "src", "windows", "install-soundvolumeview.mjs"), dir], `node packages/core/src/windows/install-soundvolumeview.mjs "${toWindows(dir)}"`);
        if (code !== 0) throw new Error("SoundVolumeView could not be installed.");
        writeEnv({ AAS_SOUNDVOLUMEVIEW: path.join(dir, "SoundVolumeView.exe") });
      } else if (id === "livesplit-server") {
        const { enableServerStartup } = await import("../../../timer-livesplit/install-livesplit.mjs");
        log(enableServerStartup(path.join(path.dirname(toLocal(readEnv().AAS_LIVESPLIT_EXE)), "settings.cfg")), "note");
        log("LiveSplit reads this when it starts; close it first if it is open.", "note");
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
      set({ phase: "idle", step: null });
    }
  }

  return {
    get state() { return state; },
    get lines() { return lines; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    plan, start, resume, runInfo, stop, fix, archive, key, budget, options, tool, nextRunName, log,
  };
}
