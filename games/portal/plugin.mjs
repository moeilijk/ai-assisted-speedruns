// Portal game plugin for the AAS broker: a thin adapter around
// cozyblaze's controller from portal-agent (MIT, Copyright (c) 2026 cozyblaze). The
// controller, its API documentation, the agent instructions, the game configuration and the
// in-game SourcePauseTool patch are his and are not vendored; a published bundle carries his
// license text in game-config/LICENSE; `node games/portal/fetch-portal-agent.mjs` clones the pinned
// commit into .local/portal-agent (or AAS_PORTAL_AGENT_DIR).
//
// Environment (AAS_* survives the broker's hardening scrub):
//   AAS_PORTAL_AGENT_DIR   checkout of portal-agent (default: <repo>/.local/portal-agent)
//   AAS_PORTAL_SPT_HOST    SPT IPC host (default 127.0.0.1)
//   AAS_PORTAL_SPT_PORT    SPT IPC port (default 27182, portal-agent's y_spt_ipc_port)
import { readFileSync, existsSync, statSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { CHAMBERS, createChamberTracker } from "./chambers.mjs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sptSession, waitUntilReady } from "./spt-session.mjs";
import { ensureSteam } from "../../packages/core/src/windows/steam.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export const UPSTREAM = JSON.parse(readFileSync(join(here, "UPSTREAM.json"), "utf8"));
export const PORTAL_AGENT_DIR = resolve(process.env.AAS_PORTAL_AGENT_DIR || join(repoRoot, ".local", "portal-agent"));

// The Source Unpack folder (for hl2.exe -hijack and the demo directory).
const GAME_ROOT = process.env.AAS_PORTAL_GAME_ROOT ? resolve(process.env.AAS_PORTAL_GAME_ROOT) : null;
const SPT_HOST = process.env.AAS_PORTAL_SPT_HOST || "127.0.0.1";
const SPT_PORT = process.env.AAS_PORTAL_SPT_PORT ? Number(process.env.AAS_PORTAL_SPT_PORT) : 27182;

const controllerDir = join(PORTAL_AGENT_DIR, "controller");
const controllerModule = join(controllerDir, "index.mjs");
const documentationFile = join(controllerDir, "mcp", "portal-documentation.md");
const instructionsFile = join(PORTAL_AGENT_DIR, "run", "AGENTS.md");

// portal-agent's SPT patch refuses raw console commands over IPC on purpose
// (the agent must not get a console). The harness therefore uses the Source
// engine's own way to talk to a running instance: a second
// `hl2.exe -game portal -hijack +<command>` hands the command over and exits.
// Works from Windows and from WSL (interop). Without AAS_PORTAL_GAME_ROOT the
// command is sent over IPC instead, which only the test fake accepts.
async function consoleCommand(command, session) {
  const exe = GAME_ROOT ? join(GAME_ROOT, "hl2.exe") : null;
  if (exe && existsSync(exe)) {
    await ensureSteam({ log: (t) => process.stderr.write(`[portal] ${t}\n`) });
    await new Promise((res, rej) => {
      const child = spawn(exe, ["-game", "portal", "-hijack", `+${command}`], { cwd: GAME_ROOT, stdio: "ignore" });
      child.on("error", rej);
      child.on("close", (code) => (code === 0 || code === null ? res() : rej(new Error(`hl2.exe -hijack +${command} exited with ${code}`))));
    });
    return "hijack";
  }
  await session.cmd(command);
  return "ipc";
}

function requireCheckout() {
  if (!existsSync(controllerModule)) {
    throw new Error(
      `portal-agent is not checked out at ${PORTAL_AGENT_DIR}. ` +
        `Run: node games/portal/fetch-portal-agent.mjs (or set AAS_PORTAL_AGENT_DIR).`,
    );
  }
}

// Portal's maps in campaign order; every level transition is a split.
// (Chambers 00–19 live in these maps: a_00 = 00–01, a_01 = 02–03, a_02 = 04–05,
// a_03 = 06–07, a_04 = 08, a_05 = 09, a_06 = 10, a_07 = 11–12, a_08 = 13,
// a_09 = 14, a_10 = 15, a_11 = 16, a_13 = 17, a_14 = 18, a_15 = 19.)
export const MAPS = [
  "testchmb_a_00", "testchmb_a_01", "testchmb_a_02", "testchmb_a_03", "testchmb_a_04", "testchmb_a_05",
  "testchmb_a_06", "testchmb_a_07", "testchmb_a_08", "testchmb_a_09", "testchmb_a_10", "testchmb_a_11",
  "testchmb_a_13", "testchmb_a_14", "testchmb_a_15", "escape_00", "escape_01", "escape_02",
];

// Splits: one per test chamber (00 … 19, then the escape maps e00 … e02). The
// community preset splits per map ("00/01", …) because its autosplitter only sees
// level changes; here the chamber comes from the player's position against the
// maps' own markers (chambers.mjs), so a fast run stays measurable per chamber.
export const SPLITS = CHAMBERS;

export default {
  id: "portal",
  // Segment names for the timer / splits file: one per chamber.
  segments: SPLITS,
  /** The game's one end: the credits; the completion marker in the agent's messages marks it for now. */
  ends: [{ id: "credits", label: "Credits", final: true }],
  /** Everything someone needs to reproduce this run: the game build, the in-game tooling with its pin, and the settings. */
  async build() {
    return {
      game: "Portal",
      version: "Source Unpack 2.6 (build 5135)",
      platform: "Source Unpack (not the Steam build)",
      mods: [
        { name: "SourcePauseTool", details: "portal-agent's IPC patch", version: UPSTREAM.commit, source: UPSTREAM.repo ?? "https://github.com/cozyblaze/portal-agent" },
      ],
      settings: { resolution: process.env.AAS_PORTAL_RESOLUTION ?? "1920x1080", cvars: "game-config/ (portal_agent.cfg, agent_run.cfg)" },
    };
  },
  /** Read-only checks for `aas doctor`: the Source Unpack, Steam, the SPT files, the audio routing, the autoexec. */
  async doctor() {
    const rows = [];
    const add = (ok, what, detail = "") => rows.push({ ok, what, detail });
    const root = process.env.AAS_PORTAL_GAME_ROOT;
    add(Boolean(root && existsSync(join(root, "portal", "cfg"))), "AAS_PORTAL_GAME_ROOT (Source Unpack)", root ?? "not set");
    if (!root) return rows;
    try { const { steamRunning } = await import("../../packages/core/src/windows/steam.mjs"); add(steamRunning(), "Steam running and logged in (hl2.exe needs it, also for every -hijack)"); } catch (e) { add(false, "Steam check", e.message); }
    for (const f of ["portal/spt.dll", "portal/addons/spt.vdf", "portal/cfg/agent_run.cfg", "portal/cfg/portal_agent.cfg", "hl2/addons/speedrun_demorecord-2007.dll"]) add(existsSync(join(root, f)), `game file ${f}`);
    try {
      const { audioStatus, CONFIGURED, DEVICE, NOT_CONFIGURED } = await import("../../packages/core/src/windows/audio-route.mjs");
      if (CONFIGURED) { const st = audioStatus({ processName: "hl2.exe" }); add(st.ok, `quiet audio device "${DEVICE}" active (game audio away from the speakers)`, st.detail); }
      else add(true, "game audio: default playback device", NOT_CONFIGURED);
    } catch (e) { add(false, "game audio routing", e.message); }
    const autoexec = join(root, "portal", "cfg", "autoexec.cfg");
    add(existsSync(autoexec) && /^\s*exec\s+portal_agent/m.test(readFileSync(autoexec, "utf8")), "autoexec.cfg execs portal_agent");
    return rows;
  },
  name: "Portal",
  version: "0.1.0",
  scopeName: "portal",
  capabilities: { turnBased: false, canPause: true, stateAccess: "none", inputRoute: "input", igt: false },
  // Source Unpack runs Portal as hl2.exe; used by the OBS recorder for window match and application audio.
  processName: "hl2.exe",
  endpoints: [{ host: SPT_HOST, port: SPT_PORT }],
  /** The variables the controller reads inside the broker; nothing else of the environment reaches it. */
  env: ["AAS_PORTAL_GAME_ROOT", "AAS_PORTAL_AGENT_DIR", "AAS_PORTAL_SPT_HOST", "AAS_PORTAL_SPT_PORT"],
  readable: [PORTAL_AGENT_DIR],
  // Published as game-config/ by `aas publish`.
  // His license travels with his files: game-config/LICENSE.
  gameConfig: [join(PORTAL_AGENT_DIR, "game-config"), join(PORTAL_AGENT_DIR, "spt", "UPSTREAM.json"), join(PORTAL_AGENT_DIR, "controller", "LICENSE")],
  // The goal the original run was given; `aas run` hands it to the agent as its first prompt.
  goalPrompt:
    "You are controlling Portal. Your goal is to progress through the game and reach the end credits. " +
    "Do not cheat/look up information about the game online.",
  category: {
    build: `Source Unpack 2.6 (build 5135) + portal-agent SPT patch ${UPSTREAM.commit.slice(0, 7)}`,
    observation: "vision",
    input: "input",
    timing: "paused-think",
    human: "none",
  },
  execDescription:
    "Run async JavaScript against Portal through SPT; `portal` is in scope. Use `return <value>` for text results. " +
    "Screenshots are returned as images.\n" +
    "TAS: `const t = portal.tas()`, queue inputs, then `await t.run(options)` (~67 ticks/s). " +
    "`t.hold(ticks, keys, angles?)` holds the exact key set; keys are forward, back, left, right, jump, duck, use, attack, attack2 " +
    "(aliases: crouch, blue, orange). Helpers: wait, tap, jump, use, fire, and look. Angles use relative up/down/left/right or absolute pitchTo/yawTo.\n" +
    "A run returns `{ ticks, aborted?, reason?, facing?, position? }` plus a 360p screenshot. Run options include `{ screenshot: false, position: false, fullRes: true }`.\n" +
    "While paused: `portal.look.left/right/up/down(degrees)`, `portal.facing()`, `portal.position()`, `portal.observe(['facing', 'position'])`, and `portal.screenshot()`. " +
    "Also available: `portal.run(steps)`, `portal.seconds(s)`, and `portal.abort()`.",

  // Called by `aas run` after the recorder started and before the agent
  // starts: portal-agent's `start_run` (new game + in-game demo recording,
  // then TAS-pause), then wait until SPT reports the run is ready.
  async prepareRun({ log = () => {} } = {}) {
    const session = await sptSession({ host: SPT_HOST, port: SPT_PORT });
    try {
      const via = await consoleCommand("start_run", session);
      log(`start_run sent (${via}); waiting for Portal to load and TAS-pause`);
      const { position } = await waitUntilReady(session);
      log(`Portal is ready: TAS-paused at ${JSON.stringify(position)}`);
    } finally {
      session.close();
    }
    return { readyAt: new Date() };
  },
  // Save states (the Source engine's own `save`/`load`), used by aas run's
  // autosave and by aas resume. The demo recording continues across loads
  // and the game stays TAS-paused afterwards (, verified:).
  async saveState({ name }) {
    const session = await sptSession({ host: SPT_HOST, port: SPT_PORT });
    try {
      await consoleCommand(`save ${name}`, session);
    } finally {
      session.close();
    }
    const file = GAME_ROOT ? join(GAME_ROOT, "portal", "SAVE", `${name}.sav`) : null;
    // The engine creates the file first and fills it a moment later: wait until it exists,
    // is not empty and its size has stopped changing (a copy taken too early is 0 bytes).
    if (file) {
      let last = -1;
      let stable = 0;
      for (let i = 0; i < 100 && stable < 3; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const size = existsSync(file) ? statSync(file).size : 0;
        stable = size > 0 && size === last ? stable + 1 : 0;
        last = size;
      }
      if (!existsSync(file) || statSync(file).size === 0) throw new Error(`save ${name} did not appear (or stayed empty) at ${file}`);
    }
    return { name, file };
  },
  async loadState({ name, log = () => {} }) {
    const session = await sptSession({ host: SPT_HOST, port: SPT_PORT });
    try {
      await consoleCommand(`load ${name}`, session);
      log(`load ${name} sent; waiting for the game`);
      await new Promise((r) => setTimeout(r, 1500));
      const { position } = await waitUntilReady(session);
      log(`restored: TAS-paused at ${JSON.stringify(position)}`);
      return { position };
    } finally {
      session.close();
    }
  },
  // Called after the agent stopped: end the in-game demo recording and keep the
  // demos with the run (<run>/demos/): the exact position track per tick, the
  // ground truth for chamber progress (demo-track.mjs).
  async endRun({ runDir } = {}) {
    try { await this.stopRun(); } finally { if (runDir) copyDemos(runDir); }
  },
  /** Closes the game and undoes the launcher's set-up; the harness calls this when a run ends. */
  async close({ log = () => {} } = {}) {
    const { closeGame } = await import("./close-game.mjs");
    return closeGame({ log });
  },
  async stopRun() {
    const session = await sptSession({ host: SPT_HOST, port: SPT_PORT });
    try {
      await consoleCommand("stop_run", session);
    } finally {
      session.close();
    }
  },

  documentation() {
    requireCheckout();
    return readFileSync(documentationFile, "utf8");
  },

  instructions() {
    requireCheckout();
    return readFileSync(instructionsFile, "utf8");
  },

  async connect() {
    requireCheckout();
    const { createPortalController } = await import(pathToFileURL(controllerModule).href);
    const controller = await createPortalController({ spt: { host: SPT_HOST, port: SPT_PORT } });
    // The AAS Controller contract lets observe() be called without arguments;
    // portal-agent requires a field list. Default to both fields. The
    // instance property shadows the prototype method and leaves TasBuilder,
    // which calls the controller's run() internally, untouched.
    // Chamber progress from every position the game reports (playback results,
    // observations): a new chamber is a `game.milestone` with `chapter: true`.
    const chambers = createChamberTracker(lastChamber(process.env.AAS_RUN_DIR));
    const entered = (id, extra = {}) => {
      if (id) globalThis.aas?.event?.("game.milestone", { label: `Chamber ${id}`, chamber: id, map: chambers.map, chapter: true, ...extra });
    };
    const observe = controller.observe.bind(controller);
    controller.observe = async (fields = ["facing", "position"], options) => {
      const result = await observe(fields, options);
      entered(chambers.observe(result?.position));
      return result;
    };
    const position = controller.position?.bind(controller);
    if (position) controller.position = async (...a) => { const r = await position(...a); entered(chambers.observe(r?.position ?? r)); return r; };
    // Every TAS playback is a `game.playback` event (the only time game time
    // advances); an aborted playback with a load/transition reason is a
    // `game.milestone` (map change). `aas timeline` turns these into timers,
    // splits and the cut list for the pauses.
    const run = controller.run.bind(controller);
    let playbacks = 0;
    let transitions = 0;
    controller.run = async (steps, options = {}) => {
      const ticks = Array.isArray(steps) ? steps.reduce((n, s) => n + (Number(s?.ticks) || 0), 0) : 0;
      const started = Date.now();
      // The steps are the ground truth for an input display: SPT presses no
      // real keys, it plays these exact key sets per tick.
      const plan = Array.isArray(steps) ? steps.map((s) => ({ ticks: Number(s?.ticks) || 0, keys: Object.keys(s?.keys ?? {}).filter((k) => s.keys[k]), ...(s?.yaw ? { yaw: s.yaw } : {}), ...(s?.pitch ? { pitch: s.pitch } : {}) })) : [];
      globalThis.aas?.event?.("game.playback", { phase: "start", index: ++playbacks, planned_ticks: ticks, steps: plan });
      try {
        // Always ask for the position: the chamber tracker and the timeline need it.
        const result = await run(steps, { ...options, position: true });
        const data = { phase: "end", index: playbacks, ticks: result.ticks, seconds: Math.round(result.ticks * 15) / 1000, wall_ms: Date.now() - started };
        if (result.position) data.position = result.position;
        if (result.aborted) {
          data.aborted = true;
          data.reason = result.reason ?? null;
        }
        globalThis.aas?.event?.("game.playback", data);
        if (result.aborted && /transition|load|level|map/i.test(result.reason ?? "")) {
          // SPT does not report the map name; assume the campaign order (a reload
          // of the same map cannot advance the chamber, so it is harmless here).
          transitions += 1;
          const map = chambers.nextMap() ?? MAPS[transitions] ?? `transition ${transitions}`;
          entered(chambers.enterMap(map), { index: transitions, reason: result.reason ?? null });
        } else entered(chambers.observe(result.position));
        return result;
      } catch (error) {
        globalThis.aas?.event?.("game.playback", { phase: "end", index: playbacks, error: String(error?.message ?? error), wall_ms: Date.now() - started });
        throw error;
      }
    };
    return controller;
  },

  exercise: [
    {
      label: "camera turn and restore",
      code:
        "const before = await portal.facing(); await portal.look.right(15); let turned; " +
        "try { turned = await portal.facing(); } finally { await portal.look.left(15); } " +
        "return { before, turned, restored: await portal.facing() };",
      verify(value) {
        const diff = (a, b) => ((a - b + 540) % 360) - 180;
        if (Math.abs(diff(value.turned.yaw, value.before.yaw) + 15) > 0.1 || Math.abs(diff(value.restored.yaw, value.before.yaw)) > 0.1) {
          throw new Error("Camera did not turn 15 degrees and restore its original yaw.");
        }
      },
    },
    {
      label: "ten simulation ticks",
      code: "return await portal.tas().wait(10).run({ screenshot: false });",
      verify(value) {
        if (value.ticks !== 10 || value.aborted) throw new Error("Ten-tick playback did not complete normally.");
      },
    },
  ],
};

/** Copy the demos of the latest agent run (the folder speedrun_demorecord made at start_run) into <run>/demos/. */
export function copyDemos(runDir) {
  if (!GAME_ROOT) return [];
  const dir = join(GAME_ROOT, "portal", "agent_runs");
  if (!existsSync(dir)) return [];
  const latest = readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory()).sort().at(-1);
  if (!latest) return [];
  const dest = join(runDir, "demos");
  mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const f of readdirSync(join(dir, latest)).filter((f) => f.endsWith(".dem"))) {
    const target = join(dest, `${latest}_${f}`);
    copyFileSync(join(dir, latest, f), target);
    copied.push(target);
  }
  return copied;
}

/** Where the run was (map, chamber) according to its log, so a resumed session continues the count. */
export function lastChamber(runDir) {
  const start = { map: MAPS[0], chamber: CHAMBERS[0] };
  let lines;
  try {
    if (!runDir || !existsSync(join(runDir, "run.jsonl"))) return start;
    lines = readFileSync(join(runDir, "run.jsonl"), "utf8").split("\n");
  } catch {
    return start; // not readable under the broker's permissions: count from the first chamber
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"game.milestone"')) continue;
    try {
      const r = JSON.parse(lines[i]);
      if (r.event === "game.milestone" && r.data?.chamber) return { map: r.data.map ?? start.map, chamber: r.data.chamber };
    } catch { /* not JSON */ }
  }
  return start;
}
