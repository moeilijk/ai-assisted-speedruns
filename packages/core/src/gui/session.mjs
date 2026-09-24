// What the GUI's Start and Stop do. Every step is one of the harness's own commands, run as a child process and
// shown in the log with the command line, so whatever the GUI does can be done (and continued) from a shell.
// One session at a time: start the game, OBS and LiveSplit, run `aas run`, then `aas timeline` and `aas publish`.
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

export function createSession() {
  const lines = [];
  const listeners = new Set();
  let state = { phase: "idle", step: null, game: null, run: null, runDir: null, runtime: null, startedAt: null, result: null };
  let child = null;
  let cancelled = false;
  const emit = (type, data) => { for (const l of listeners) l(type, data); };
  const log = (text, kind = "out") => {
    for (const t of String(text).split(/\r?\n/)) {
      if (!t.trim()) continue;
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

  const q = (a) => (/[\s"'()&;|<>$]/.test(a) ? `"${a}"` : a);
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
    const run = String(opts.run || nextRunName(setup.folder, runtime.prefix)).trim();
    const runDir = output ? path.join(output, setup.folder, run) : `<output>/${setup.folder}/${run}`;
    const pub = output ? path.join(output, setup.folder, "public", run) : `<output>/${setup.folder}/public/${run}`;
    // Without a goal from the page: the game's own end for an AI run, its first end for a mock run, which is a
    // test of the machine and not an attempt (owner, 2026-09-19). The runtime plugin says which of the two it is.
    const runtimePlugin = await loadRuntime(runtime.id).catch(() => null);
    const goal = opts.goal || (runtimePlugin?.ai === true ? g.plugin.ends.find((e) => e.final)?.id : g.plugin.ends[0]?.id);
    const livesplit = Boolean(env.AAS_LIVESPLIT_EXE) && fs.existsSync(toLocal(env.AAS_LIVESPLIT_EXE));
    const splits = setup.splits?.[goal];
    const choices = await recorderOptions(setup);
    const recorderId = choices.some((r) => r.id === opts.recorder) ? opts.recorder : choices[0].id;
    const recorder = await loadRecorder(recorderId);
    const runArgs = ["run", "--runtime", runtime.id, "--game", g.file, "--run-dir", runDir, "--recorder", recorderId, ...(livesplit ? ["--timer", "livesplit"] : []), "--overlay-port", "8765", "--headless", "--goal", goal];
    if (runtime.id === "scripted") runArgs.push("--bot", setup.bot);
    if (opts.maxMinutes) runArgs.push("--max-minutes", String(Number(opts.maxMinutes)));
    // A game without a seed never gets one, whatever the page sends.
    if (opts.seed && setup.seed) runArgs.push("--seed", String(opts.seed));
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
    // A mock run checks the AI of the run: the same agent that would play it live.
    const agents = runtime.id === "scripted" ? agentsPresent().filter((a) => a.id === opts.ai) : [];
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
      { id: "publish", title: "The bundle for the archive (a folder and a zip)", args: [CLI, "publish", runDir, pub], shown: `${CLI_SHOWN} publish ${q(runDir)} ${q(pub)}` },
    ];
    return { game: g, setup, runtime, run, runDir, pub, goal, livesplit, output, steps, recorder: recorderId, recorders: choices, stop: setup.stop ? { args: [setup.stop], shown: shownScript(setup.stop) } : null };
  }

  /** Runs a session's steps in order: the checks, the game, the recorder, LiveSplit, the run, the timeline, the bundle. */
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
        const result = { status: outcome?.status ?? (runCode === 0 ? "unknown" : "failed"), notes: outcome?.notes ?? null, runDir: toWindows(runDir), recording: null, bundle: null };
        try { const rec = fs.readdirSync(path.join(runDir, "recording")).find((f) => /\.(mp4|mkv)$/i.test(f)); if (rec) result.recording = toWindows(path.join(runDir, "recording", rec)); } catch { /* no recording */ }
        // A run that ended before it started (a failed check) has closed nothing: close it here.
        if (!outcome && p.stop) { log("The run did not start; closing what was started.", "note"); await node(p.stop.args, p.stop.shown); }
        if (fs.existsSync(path.join(runDir, "run.jsonl")) && outcome) {
          await node(byId.timeline.args, byId.timeline.shown);
          const code = await node(byId.publish.args, byId.publish.shown);
          if (fs.existsSync(`${pub}.zip`)) result.bundle = toWindows(`${pub}.zip`);
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
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(run)) throw new Error("A run name may only have letters, digits, - and _.");
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
  async function resume(runDirShown) {
    if (state.phase !== "idle") throw new Error("A session is already running.");
    const runDir = toLocal(runDirShown ?? "");
    if (!runDir || !fs.existsSync(path.join(runDir, "run.jsonl"))) throw new Error("Not a run that has started.");
    const outcome = JSON.parse(fs.readFileSync(path.join(runDir, "outcome.json"), "utf8"));
    if (outcome.status === "completed") throw new Error("This run reached its goal; there is nothing to continue.");
    const brief = JSON.parse(fs.readFileSync(path.join(runDir, "brief.json"), "utf8"));
    const started = fs.readFileSync(path.join(runDir, "run.jsonl"), "utf8").split("\n").filter((l) => l.includes('"run.started"')).map((l) => JSON.parse(l).data).at(-1) ?? {};
    const games = await guiGames();
    const g = games.find((x) => x.plugin.id === (started.game ?? brief.category?.game));
    if (!g) throw new Error("The game of this run is not in this tooling.");
    const setup = g.plugin.setup;
    const runtime = RUNTIMES.find((r) => r.id === brief.runtime) ?? { id: brief.runtime, label: brief.runtime };
    const recorderId = started.recorder ?? "obs";
    const recorder = await loadRecorder(recorderId);
    const livesplit = started.timer === "livesplit";
    const revision = (() => { try { return Number(JSON.parse(fs.readFileSync(path.join(runDir, "publish-revision.json"), "utf8")).revision) + 1 || 2; } catch { return 1; } })();
    const run = path.basename(runDir);
    const pub = path.join(path.dirname(runDir), "public", revision > 1 ? `${run}-r${revision}` : run);
    const args = ["resume", "--run-dir", runDir, "--recorder", recorderId, ...(livesplit ? ["--timer", "livesplit"] : []), "--overlay-port", "8765", "--headless"];
    const steps = [
      { id: "game", title: `Start ${g.plugin.name} with its mods and bridge (a game that is already up is left alone)`, args: [setup.launch], shown: shownScript(setup.launch) },
      ...(recorder.launch ? [{ id: "recorder", title: `Start ${shortName(recorder)} (the recording)`, args: [recorder.launch], shown: shownScript(recorder.launch) }] : []),
      ...(livesplit ? [{ id: "livesplit", title: "Start LiveSplit", args: [path.join(REPO, "packages", "timer-livesplit", "launch-livesplit.mjs")], shown: "npm run livesplit:launch" }] : []),
      { id: "run", title: "The run goes on as its next segment, then the timeline and the cut are made again", args: [CLI, ...args], shown: `${CLI_SHOWN} ${args.map((a) => (a === runDir ? q(runDir) : a)).join(" ")}` },
      { id: "publish", title: "The bundle again, as a new revision", args: [CLI, "publish", runDir, pub], shown: `${CLI_SHOWN} publish ${q(runDir)} ${q(pub)}` },
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
    const c = cmds[action];
    if (!c || (action !== "login" && action !== "logout" && !arg)) throw new Error(`Unknown action: ${action}`);
    if (!/^[0-9a-f]{32}$/.test(String(arg)) && ["extend", "revoke", "delete"].includes(action)) throw new Error("Not a ticket.");
    set({ phase: "working", step: action });
    try {
      const code = await node([CLI, ...c[0]], `${CLI_SHOWN} ${c[1]}`);
      if (code !== 0) throw new Error(`${action} did not succeed; see the log.`);
    } finally {
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
    } catch (error) {
      log(error.message, "err");
      throw error;
    } finally {
      set({ phase: "idle", step: null });
    }
  }

  return {
    get state() { return state; },
    get lines() { return lines; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    plan, start, resume, stop, fix, archive, nextRunName, log,
  };
}
