// Game plugin: NES games on the FCEUX emulator, through fceux-mcp's bridge (IngvarKofoed, MIT; our fork
// moeilijk/fceux-mcp), a Lua script inside FCEUX that answers on 127.0.0.1:9999. FCEUX is paused between the agent's
// moves: game time advances only while its buttons play, frame by frame, so IGT is frames divided by FCEUX's own NTSC
// frame rate.
//
// One plugin, many games: a profile (profiles/<id>.json, chosen with AAS_FCEUX_PROFILE) names the ROM by its SHA-1 (and
// the MD5 FCEUX itself reports), with its maker, license and source, the game's ends as memory conditions (from a
// published RAM map, a disassembly or the game's own source, and measured in FCEUX), what the agent is told, and the
// mock run's inputs.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { readZipEntries } from "../../packages/core/src/zip-read.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { batch, call, HOST as BRIDGE_HOST, PORT as BRIDGE_PORT } from "./bridge.mjs";
import { fceuxDir, hostPath } from "./paths.mjs";
import { rgbToPng } from "./png.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const UPSTREAM = JSON.parse(readFileSync(join(here, "UPSTREAM.json"), "utf8"));

/** Every profile in this folder, by id. */
export const PROFILES = Object.fromEntries(readdirSync(join(here, "profiles")).filter((f) => f.endsWith(".json")).map((f) => { const p = JSON.parse(readFileSync(join(here, "profiles", f), "utf8")); return [p.id, p]; }));
export const PROFILE = PROFILES[process.env.AAS_FCEUX_PROFILE || "nes15"] ?? null;
/** The ROMs folder: AAS_FCEUX_ROMS, else .local/roms in this repository (never in git). */
export const romsDir = () => resolve(process.env.AAS_FCEUX_ROMS || join(REPO, ".local", "roms"));
/** The ROM of the run: AAS_FCEUX_ROM, else the profile's file in the ROMs folder. FCEUX opens a zip itself. */
export const romPath = (profile = PROFILE) => (process.env.AAS_FCEUX_ROM ? resolve(process.env.AAS_FCEUX_ROM) : profile ? join(romsDir(), profile.rom.file) : null);
const sha1Of = (buf) => createHash("sha1").update(buf).digest("hex").toUpperCase();
/** The SHA-1 of the ROM file itself, also inside a zip: what the profile's `sha1` names. */
export function romFileSha1(given, profile = PROFILE) {
  if (!/\.zip$/i.test(given)) return sha1Of(readFileSync(given));
  const entries = readZipEntries(given) ?? [];
  const hit = entries.find((e) => sha1Of(e.data) === profile?.rom?.sha1) ?? entries.find((e) => /\.nes$/i.test(e.name)) ?? null;
  return hit ? sha1Of(hit.data) : null;
}

/** NTSC frames per second as FCEUX counts them: FCEUI_GetDesiredFPS() is 1008307711 / 2^24 (src/fceu.cpp, 2.6.6). */
export const FPS = { NES: 1008307711 / 16777216 };
const fpsOf = (profile) => profile?.fps ?? FPS[profile?.system] ?? null;

const ENDS = PROFILE?.ends ?? [{ id: "end", label: "End", final: true }];
const SEGMENTS = ENDS.map((e) => e.split ?? e.label);
/** The controller's buttons as the agent names them, and as the bridge's joypad.set names them. */
export const BUTTONS = { Up: "up", Down: "down", Left: "left", Right: "right", Start: "start", Select: "select", B: "B", A: "A" };
const BY_LOWER = Object.fromEntries(Object.keys(BUTTONS).map((b) => [b.toLowerCase(), b]));
/** Buttons as the agent may give them: ["A", "Right"] or { A: true, Right: true }; Reset is the console's own button. */
function parseButtons(buttons) {
  const names = Array.isArray(buttons) ? buttons.map(String) : Object.entries(buttons ?? {}).filter(([, v]) => v).map(([k]) => k);
  const out = { buttons: {}, reset: false };
  for (const n of names) {
    if (n.toLowerCase() === "reset") { out.reset = true; continue; }
    const b = BY_LOWER[n.toLowerCase()];
    if (!b) throw new Error(`unknown button ${JSON.stringify(n)}: the buttons are ${Object.keys(BUTTONS).join(", ")}`);
    out.buttons[BUTTONS[b]] = true;
  }
  return out;
}
/** Frames per call to the bridge: FCEUX stands still between calls, and the game's sound with it. */
export const CHUNK = 600;

const documentation = () => `${readFileSync(join(here, "documentation.md"), "utf8")}\n## This game\n\n${PROFILE ? `${PROFILE.name} (${PROFILE.system}).\n\nControls: ${PROFILE.controls}\n\nGoal: ${PROFILE.goal}\n` : "No profile chosen (AAS_FCEUX_PROFILE).\n"}`;

export default {
  id: "fceux",
  name: "FCEUX",
  version: "0.33.8",
  scopeName: "emu",
  capabilities: { turnBased: false, canPause: true, stateAccess: "full", inputRoute: "input", igt: true },
  processName: "fceux64.exe",
  windowTitle: "FCEUX",
  /** FCEUX has a second window (the Lua console of the bridge): the game is in "FCEUX 2.6.6: <game>". */
  windowTitlePattern: "^FCEUX \\d",
  // The one address the agent's side may reach: the bridge's, from the same settings the client uses.
  endpoints: [{ host: BRIDGE_HOST, port: BRIDGE_PORT }],
  /** The milestone's save is made here, in the broker, before the agent's next move (see connect()). */
  savesAtMilestones: true,
  env: ["AAS_FCEUX_PROFILE", "AAS_FCEUX_BRIDGE_HOST", "AAS_FCEUX_BRIDGE_PORT", "AAS_FCEUX_BRIDGE_DIR"],
  runEnv: ["AAS_FCEUX_PROFILE"],
  ends: ENDS,
  profile: PROFILE,
  setup: {
    folder: "FCEUX",
    settings: [
      { env: "AAS_FCEUX_DIR", label: "FCEUX folder", kind: "dir", expect: "fceux64.exe", default: fceuxDir, what: "Where FCEUX is: the folder with fceux64.exe in it. The install puts it in %LOCALAPPDATA%\\aas\\FCEUX." },
      { env: "AAS_FCEUX_PROFILE", label: "Game", kind: "select", options: () => Object.values(PROFILES).map((p) => ({ value: p.id, label: p.name })), value: "nes15", what: "Which game FCEUX plays: one of the profiles in games/fceux/profiles, each naming its ROM, its ends and its splits." },
      { env: "AAS_FCEUX_ROM", label: "ROM of the game", kind: "file", default: () => { const r = romPath(); return r && existsSync(r) ? r : ""; }, what: "The game's ROM (a .nes file, or a zip with one in it). The profile checks it by its SHA-1, so it has to be the exact dump the profile names." },
    ],
    install: join(here, "install-fceux.mjs"),
    installs: `Download FCEUX ${UPSTREAM.fceux.version} and fceux-mcp ${UPSTREAM.fceux_mcp.version} (our fork; both pinned)`,
    launch: join(here, "launch-game.mjs"),
    stop: join(here, "stop-all.mjs"),
    bot: join(here, "bot.mjs"),
    splits: PROFILE ? Object.fromEntries(ENDS.map((e) => [e.id, join(here, "splits", `${PROFILE.id}-${e.id}.lss`)])) : {},
  },
  readable: [here],
  segments: SEGMENTS,
  cutDefaults: { marginBefore: 0.2, marginAfter: 0.5 },
  gameConfig: [join(here, "UPSTREAM.json"), ...(PROFILE ? [join(here, "profiles", `${PROFILE.id}.json`)] : [])],
  documentation: documentation(),
  instructions: readFileSync(join(here, "AGENTS.md"), "utf8"),
  goalPrompt: (end) => `You are playing ${PROFILE?.name ?? "a game"} on FCEUX; the game has been started and is paused. Read fceux_documentation, then play ${end && !end.final ? `until you reach: ${end.label}` : `until the goal is reached: ${PROFILE?.goal ?? "the game's end"}`}. Do not look up information about the game online.`,
  category: {
    build: `FCEUX ${UPSTREAM.fceux.version} + fceux-mcp ${UPSTREAM.fceux_mcp.version}${PROFILE ? ` + ${PROFILE.name} (ROM SHA-1 ${PROFILE.rom.sha1})` : ""}`,
    observation: "full",
    input: "input",
    timing: "paused-think",
    human: "none",
  },
  execDescription:
    "Run async JavaScript against the emulator; `emu` is in scope. Use `return <value>` for results. The game is paused between calls. " +
    "`await emu.info()` (ROM, frame), `emu.buttons()` (the button names), " +
    "`await emu.press(['A', 'Right'], frames)` (hold buttons for a number of frames), `await emu.sequence([{ buttons: ['A'], frames: 3 }, { frames: 30 }])`, " +
    "`await emu.wait(frames)` (no input), `await emu.read(address, { width })`, `await emu.readRange(address, length)`.",

  /** The controller the broker exposes as `emu`. Every call that runs frames is one `game.playback`. */
  async connect() {
    const emit = (event, data) => globalThis.aas?.event?.(event, data);
    const fps = fpsOf(PROFILE);
    const reached = new Set();
    let index = 0;
    let over = false;
    // The run's goal, from its brief: the harness declares the victory when that end goes by, but it reads the event
    // log up to half a second later, and the next input may come before that. So after the goal's end the plugin
    // takes no more input itself (as the BizHawk plugin, measured there 2026-09-23).
    const goal = (() => { try { return JSON.parse(readFileSync(join(process.env.AAS_RUN_DIR, "brief.json"), "utf8")).category?.goal ?? null; } catch { return null; } })();
    // After every playback: has the game reached one of its ends? A condition of the profile: one value (`equals` or
    // `atLeast`) at an address of the CPU's memory, or `all` / `any` of such conditions.
    const addresses = (w, out = new Set()) => { if (w.all || w.any) (w.all ?? w.any).forEach((c) => addresses(c, out)); else out.add(w.address); return out; };
    const holds = (w, mem) => {
      if (w.all) return w.all.every((c) => holds(c, mem));
      if (w.any) return w.any.some((c) => holds(c, mem));
      const value = mem.get(w.address);
      return w.equals !== undefined ? value === w.equals : w.atLeast !== undefined ? value >= w.atLeast : false;
    };
    const checkEnds = async () => {
      const open = ENDS.filter((e) => e.when && !reached.has(e.id));
      if (!open.length) return;
      const list = [...open.reduce((s, e) => addresses(e.when, s), new Set())];
      const values = await batch(list.map((address) => ({ method: "memory.readbyte", params: { address } })));
      const mem = new Map(list.map((a, i) => [a, values[i]]));
      for (const end of open) {
        if (!holds(end.when, mem)) continue;
        reached.add(end.id);
        await saveAt(end);
        emit("game.milestone", { label: end.label, split: end.split ?? end.label, end: end.id, chapter: true });
        if (end.final) { over = true; emit("game.over", { victory: true, label: end.label }); }
        else if (end.id === goal) over = true;
      }
    };
    // The save of a milestone, made before the agent's next move can play a frame: FCEUX writes it into the run's own
    // saves/ folder, and the harness leaves chapter milestones to this plugin (savesAtMilestones). The harness reads a
    // milestone from the run log up to half a second later, and by then the next move may have run.
    const runDir = process.env.AAS_RUN_DIR ?? null;
    const saveAt = async (end) => {
      if (!runDir) return;
      try {
        const brief = JSON.parse(readFileSync(join(runDir, "brief.json"), "utf8"));
        const name = `aas_${String(brief.id).replace(/[^A-Za-z0-9]/g, "_")}_${end.id}`;
        const dir = join(runDir, "saves");
        mkdirSync(dir, { recursive: true });
        const log = existsSync(join(runDir, "run.jsonl")) ? readFileSync(join(runDir, "run.jsonl"), "utf8") : "";
        const index = log.split("\n").filter((l) => l.includes('"game.saved"')).length + 1;
        await call("savestate.savefile", { path: hostPath(join(dir, `${name}.fc0`)) });
        emit("game.saved", { name, index, reason: `milestone ${end.label}`, file: `saves/${name}.fc0` });
      } catch (error) {
        emit("game.save_failed", { end: end.id, error: String(error?.message ?? error) });
      }
    };
    const play = async (label, steps) => {
      if (over) throw new Error("the game has reached its end; no further input");
      const parsed = steps.map((s) => ({ ...parseButtons(s.buttons), frames: Math.max(0, Math.floor(s.frames ?? 1)) }));
      const frames = parsed.reduce((n, s) => n + s.frames, 0);
      if (frames < 1 || frames > 36000) throw new Error("frames must be between 1 and 36000 per call");
      const i = ++index;
      const started = Date.now();
      emit("game.playback", { phase: "start", index: i, command: label, frames });
      let framecount = null;
      try {
        // All steps go in as few calls as possible, 600 frames each: FCEUX stands still between calls, and a call per
        // short step cut the game's sound up (measured 2026-09-23 in an OBS recording: calls of one frame leave 33-43
        // ms of silence every ~51 ms, calls of 600 one gap of ~30 ms per call).
        let chunk = [], inChunk = 0;
        const flush = async () => { if (chunk.length) framecount = await call("emu.step", { steps: chunk }, { timeoutMs: 60000 }); chunk = []; inChunk = 0; };
        for (const s of parsed) {
          let left = s.frames, first = true;
          while (left > 0) {
            const n = Math.min(left, CHUNK - inChunk);
            chunk.push({ ...(Object.keys(s.buttons).length ? { buttons: s.buttons } : {}), frames: n, ...(s.reset && first ? { reset: true } : {}) });
            inChunk += n; left -= n; first = false;
            if (inChunk === CHUNK) await flush();
          }
        }
        await flush();
      } catch (error) {
        emit("game.playback", { phase: "end", index: i, error: String(error?.message ?? error), wall_ms: Date.now() - started, command: label });
        throw error;
      }
      emit("game.playback", { phase: "end", index: i, command: label, frames, seconds: fps ? frames / fps : null, framecount, wall_ms: Date.now() - started, error: null });
      await checkEnds();
      return { frames, framecount };
    };
    return {
      async info() {
        const [rom, md5, framecount, paused] = await batch([{ method: "rom.getfilename" }, { method: "rom.gethash", params: { type: "md5" } }, { method: "emu.framecount" }, { method: "emu.paused" }]);
        return { system: PROFILE?.system ?? "NES", rom, rom_md5: md5, framecount, paused, profile: PROFILE?.id ?? null };
      },
      async observe() { return this.info(); },
      buttons() { return Object.keys(BUTTONS); },
      press: async (buttons, frames = 1) => play(`press ${Object.keys(parseButtons(buttons).buttons).join("+") || "nothing"} ${frames}`, [{ buttons, frames }]),
      sequence: (steps) => play(`sequence of ${steps.length}`, steps),
      wait: (frames) => play(`wait ${frames}`, [{ frames }]),
      async read(address, { width = 8 } = {}) {
        if (width === 8) return call("memory.readbyte", { address });
        if (width === 16) return call("memory.readword", { address });
        throw new Error("width is 8 or 16 bits");
      },
      async readRange(address, length) {
        if (!(length >= 1 && length <= 4096)) throw new Error("length is 1 to 4096 bytes");
        return call("memory.readbyterange", { address, length });
      },
      /**
       * The emulated frame, before FCEUX draws anything over it (gui.gdscreenshot(true) in the bridge): FCEUX's own
       * messages and a "Snapshot Saved." are not in it and do not appear on screen. No frame is played.
       */
      async screenshot() {
        const s = await call("gui.screen");
        const png = rgbToPng(s.width, s.height, Buffer.from(s.rgb, "base64"));
        const url = `data:image/png;base64,${png.toString("base64")}`;
        globalThis.aas?.emitImage?.(url);
        return { screenshots: [{ url }] };
      },
      close() {},
    };
  },

  /** The profile's ROM, checked by the MD5 FCEUX reports, from power-on and paused, so the recording begins at the first frame. */
  async prepareRun({ log = () => {}, resume = false } = {}) {
    if (resume) return { readyAt: new Date() };
    const [rom, md5] = await batch([{ method: "rom.getfilename" }, { method: "rom.gethash", params: { type: "md5" } }]);
    if (PROFILE?.rom?.md5 && String(md5).toUpperCase() !== PROFILE.rom.md5) throw new Error(`the loaded ROM is not ${PROFILE.name}: FCEUX reports MD5 ${md5}, the profile names ${PROFILE.rom.md5}`);
    // From power-on through FCEUX's own reload of the ROM: emu.poweron shows "Power on" over the game, a load clears
    // FCEUX's messages (fceu.cpp FCEUI_LoadGame), and the game's state is the same (2 KB of RAM compared, and again
    // 600 frames on; FCEUX 2.6.6 win64, 2026-09-23).
    await batch([{ method: "emu.pause" }, { method: "emu.reload" }]);
    log(`${rom} (${PROFILE?.system ?? "NES"}) from power-on, paused`);
    return { readyAt: new Date() };
  },
  /** A savestate of the emulator: FCEUX's own file, written next to FCEUX; the harness copies it into the run. */
  async saveState({ name }) {
    const dir = join(fceuxDir(), "aas-saves");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.fc0`);
    await call("savestate.savefile", { path: hostPath(file) });
    return { name, file };
  },
  async loadState({ name = null, runDir = null, log = () => {} } = {}) {
    const candidates = [runDir && name ? join(runDir, "saves", `${name}.fc0`) : null, name ? join(fceuxDir(), "aas-saves", `${name}.fc0`) : null].filter(Boolean);
    const file = candidates.find((f) => existsSync(f));
    if (!file) throw new Error(`save ${name ?? "(none)"} not found (looked in ${candidates.join(", ")})`);
    await call("emu.pause");
    await call("savestate.loadfile", { path: hostPath(file) });
    log(`save ${name} loaded at frame ${await call("emu.framecount")}`);
    return { readyAt: new Date() };
  },
  /** What someone needs to play the same thing: FCEUX and the bridge with their pins, and the ROM by its SHA-1. */
  async build() {
    return {
      game: PROFILE?.name ?? null,
      version: PROFILE ? `ROM SHA-1 ${PROFILE.rom.sha1}` : null,
      platform: PROFILE ? `${PROFILE.system} on FCEUX ${UPSTREAM.fceux.version}` : `FCEUX ${UPSTREAM.fceux.version}`,
      mods: [
        { name: "FCEUX", version: UPSTREAM.fceux.version, source: UPSTREAM.fceux.url, sha256: UPSTREAM.fceux.sha256 },
        { name: "fceux-mcp", version: UPSTREAM.fceux_mcp.version, source: UPSTREAM.fceux_mcp.url, sha256: UPSTREAM.fceux_mcp.sha256 },
      ],
      settings: { profile: PROFILE?.id ?? null, rom: PROFILE ? { title: PROFILE.rom.title, sha1: PROFILE.rom.sha1, author: PROFILE.rom.author, license: PROFILE.rom.license, source: PROFILE.rom.source } : null, paused_between_moves: true },
    };
  },
  async close({ log = () => {} } = {}) {
    const { closeGame } = await import("./close-game.mjs");
    return closeGame({ log });
  },
  async doctor() {
    const rows = [];
    const dir = fceuxDir();
    rows.push({ ok: Boolean(dir && existsSync(join(dir, "fceux64.exe"))), what: "fceux64.exe", detail: dir ? join(dir, "fceux64.exe") : "no FCEUX folder" });
    rows.push({ ok: Boolean(dir && existsSync(join(dir, "fceux-mcp", "bridge.lua"))), what: `fceux-mcp ${UPSTREAM.fceux_mcp.version} bridge`, detail: dir ? join(dir, "fceux-mcp", "bridge.lua") : "no FCEUX folder" });
    const rom = romPath();
    const okRom = Boolean(rom && existsSync(rom));
    rows.push({ ok: okRom, what: `ROM of ${PROFILE?.name ?? "the profile"}`, detail: rom ?? "no ROM set (AAS_FCEUX_ROM)" });
    if (okRom && PROFILE) { const got = romFileSha1(rom); rows.push({ ok: got === PROFILE.rom.sha1, what: "the ROM is the dump the profile names", detail: `SHA-1 ${got}; the profile names ${PROFILE.rom.sha1}` }); }
    return rows;
  },
  exercise: [
    { label: "info", code: "return await emu.info();", verify: (v) => { if (!v?.rom) throw new Error("no ROM"); } },
  ],
};
