// Game plugin: games on the BizHawk emulator, through bizhawk-mcp-native (StealthC, MIT), an external tool inside
// EmuHawk that serves the emulator over HTTP on 127.0.0.1:8767. The emulator is paused between the agent's moves: game
// time advances only while its buttons play, frame by frame, so IGT is frames divided by the system's frame rate.
//
// One plugin, many games: a profile (profiles/<id>.json, chosen with AAS_BIZHAWK_PROFILE) names the ROM by its SHA-1,
// with its maker, license and source, the game's ends as memory conditions (from a published RAM map, a disassembly or
// the game's own source, and measured in BizHawk), what the agent is told, and the mock run's inputs.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readZipEntries } from "../../packages/core/src/zip-read.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, rpc } from "./mcp.mjs";
import { bizhawkDir, hostPath } from "./paths.mjs";
import { trustState } from "./trust.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const UPSTREAM = JSON.parse(readFileSync(join(here, "UPSTREAM.json"), "utf8"));

/** Every profile in this folder, by id. */
export const PROFILES = Object.fromEntries(readdirSync(join(here, "profiles")).filter((f) => f.endsWith(".json")).map((f) => { const p = JSON.parse(readFileSync(join(here, "profiles", f), "utf8")); return [p.id, p]; }));
export const PROFILE = PROFILES[process.env.AAS_BIZHAWK_PROFILE || "nes15"] ?? null;
/** The ROMs folder: AAS_BIZHAWK_ROMS, else .local/roms in this repository (never in git). */
export const romsDir = () => resolve(process.env.AAS_BIZHAWK_ROMS || join(REPO, ".local", "roms"));
/** The ROM of the run: AAS_BIZHAWK_ROM, else the profile's file in the ROMs folder. */
export const romPath = (profile = PROFILE) => (process.env.AAS_BIZHAWK_ROM ? resolve(process.env.AAS_BIZHAWK_ROM) : profile ? join(romsDir(), profile.rom.file) : null);
const sha1 = (file) => createHash("sha1").update(readFileSync(file)).digest("hex").toUpperCase();
const sha1Of = (buf) => createHash("sha1").update(buf).digest("hex").toUpperCase();

/**
 * The ROM as a file BizHawk can open: the file itself, or for a zip the member the profile names (by file name, or the
 * one whose SHA-1 is the profile's), written once into <BizHawk>/aas-roms/. Returns the path to open.
 */
export function playableRom(given, dir = bizhawkDir(), profile = PROFILE) {
  if (!/\.zip$/i.test(given)) return given;
  const entries = readZipEntries(given);
  if (!entries) throw new Error(`${given} is not a zip BizHawk's ROM can be taken from`);
  const want = profile?.rom?.file_sha1 ?? profile?.rom?.sha1;
  const entry = entries.find((e) => sha1Of(e.data) === want) ?? entries.find((e) => profile?.rom?.member && e.name === profile.rom.member) ?? (entries.length === 1 ? entries[0] : null);
  if (!entry) throw new Error(`no ROM in ${given} matches the profile ${profile?.id ?? ""}`);
  const out = join(dir, "aas-roms", entry.name.split("/").pop());
  if (!existsSync(out) || sha1(out) !== sha1Of(entry.data)) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, entry.data); }
  return out;
}
/** The SHA-1 of the ROM file itself, also inside a zip: what the profile's `file_sha1` names. */
export function romFileSha1(given, profile = PROFILE) {
  if (!/\.zip$/i.test(given)) return sha1(given);
  const entries = readZipEntries(given) ?? [];
  const want = profile?.rom?.file_sha1 ?? profile?.rom?.sha1;
  return (entries.find((e) => sha1Of(e.data) === want) ?? entries[0]) ? sha1Of((entries.find((e) => sha1Of(e.data) === want) ?? entries[0]).data) : null;
}

/**
 * Frames per second of each system, as BizHawk itself counts them (src/BizHawk.Client.Common/movie/PlatformFrameRates.cs,
 * 2.11.1). A profile may give its own `fps` for a system BizHawk does not list there.
 */
export const FPS = {
  NES: 60.098813897440515, SNES: 21477272.0 / (4 * 341 * 262 - 2), GB: 262144.0 / 4389.0, GBC: 262144.0 / 4389.0,
  GBA: 262144.0 / 4389.0, GEN: 53693175 / (3420.0 * 262), SMS: 3579545 / 262.0 / 228.0, PSX: 502813668.0 / 8388608.0,
};
const fpsOf = (profile) => profile?.fps ?? FPS[profile?.system] ?? null;

const ENDS = PROFILE?.ends ?? [{ id: "end", label: "End", final: true }];
const SEGMENTS = ENDS.map((e) => e.split ?? e.label);
const upper = (b) => Object.fromEntries(Object.entries(b ?? {}).filter(([, v]) => v).map(([k]) => [k, true]));
/** Buttons as the agent may give them: ["A", "Right"] or { A: true, Right: true }. */
/**
 * Buttons go with the frames they are held for: the tool's frame_advance sets them before each of those frames
 * (bizhawk-mcp-native v0.3.2). A console button (Reset, Power) is given by its own name. Measured 2026-09-23 on
 * 600 frames of TASVideos 3728M, which presses Reset on frame 0: Mario at x 916, as in the movie.
 */

const buttonMap = (buttons) => (Array.isArray(buttons) ? Object.fromEntries(buttons.map((b) => [String(b), true])) : upper(buttons));

const documentation = () => `${readFileSync(join(here, "documentation.md"), "utf8")}\n## This game\n\n${PROFILE ? `${PROFILE.name} (${PROFILE.system}).\n\nControls: ${PROFILE.controls}\n\nGoal: ${PROFILE.goal}\n` : "No profile chosen (AAS_BIZHAWK_PROFILE).\n"}`;

export default {
  id: "bizhawk",
  name: "BizHawk",
  version: "0.33.5",
  scopeName: "emu",
  capabilities: { turnBased: false, canPause: true, stateAccess: "full", inputRoute: "input", igt: true },
  processName: "EmuHawk.exe",
  windowTitle: "BizHawk",
  /** EmuHawk has a second window (the tool's own form): the game is in the one whose title ends with " - BizHawk". */
  windowTitlePattern: " - BizHawk$",
  endpoints: [{ host: "127.0.0.1", port: 8767 }],
  env: ["AAS_BIZHAWK_PROFILE", "AAS_BIZHAWK_MCP_URL"],
  runEnv: ["AAS_BIZHAWK_PROFILE"],
  ends: ENDS,
  profile: PROFILE,
  setup: {
    folder: "BizHawk",
    settings: [
      { env: "AAS_BIZHAWK_DIR", label: "BizHawk folder", kind: "dir", expect: "EmuHawk.exe", default: bizhawkDir, what: "Where BizHawk is: the folder with EmuHawk.exe in it. The install puts it in %LOCALAPPDATA%\\aas\\BizHawk." },
      { env: "AAS_BIZHAWK_ROM", label: "ROM of the game", kind: "file", what: "The game's ROM. The profile checks it by its SHA-1, so it has to be the exact dump the profile names." },
    ],
    install: join(here, "install-bizhawk.mjs"),
    installs: "Download BizHawk 2.11.1 and bizhawk-mcp-native v0.3.2 (our fork; both pinned), then let BizHawk ask once whether it may load the tool",
    fixes: { allow: { script: join(here, "allow-tool.mjs"), label: "Let BizHawk ask whether it may load the tool (once per version)" } },
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
  goalPrompt: (end) => `You are playing ${PROFILE?.name ?? "a game"} on BizHawk; the game has been started and is paused. Read bizhawk_documentation, then play ${end && !end.final ? `until you reach: ${end.label}` : `until the goal is reached: ${PROFILE?.goal ?? "the game's end"}`}. Do not look up information about the game online.`,
  category: {
    build: `BizHawk ${UPSTREAM.bizhawk.version} + bizhawk-mcp-native ${UPSTREAM.bizhawk_mcp_native.version}${PROFILE ? ` + ${PROFILE.name} (ROM SHA-1 ${PROFILE.rom.sha1})` : ""}`,
    observation: "full",
    input: "input",
    timing: "paused-think",
    human: "none",
  },
  execDescription:
    "Run async JavaScript against the emulator; `emu` is in scope. Use `return <value>` for results. The game is paused between calls. " +
    "`await emu.info()` (system, ROM, frame), `await emu.buttons()` (the button names), " +
    "`await emu.press(['A', 'Right'], frames)` (hold buttons for a number of frames), `await emu.sequence([{ buttons: ['A'], frames: 3 }, { frames: 30 }])`, " +
    "`await emu.wait(frames)` (no input), `await emu.read(address, { domain, width })`, `await emu.readRange(address, length, domain)`, `await emu.domains()`.",

  /** The controller the broker exposes as `emu`. Every call that runs frames is one `game.playback`. */
  async connect() {
    const emit = (event, data) => globalThis.aas?.event?.(event, data);
    const fps = fpsOf(PROFILE);
    const reached = new Set();
    let index = 0;
    let over = false;
    // The run's goal, from its brief: the harness declares the victory when that end goes by, but it reads the event
    // log up to half a second later, and the next input may come before that (measured 2026-09-23: 100 frames after
    // World 2, counted in the game time). So after the goal's end the plugin takes no more input itself.
    const goal = (() => { try { return JSON.parse(readFileSync(join(process.env.AAS_RUN_DIR, "brief.json"), "utf8")).category?.goal ?? null; } catch { return null; } })();
    // After every playback: has the game reached one of its ends? The harness declares the victory for the goal.
    // A condition of the profile: one value (`equals` or `atLeast`), or `all` / `any` of such conditions.
    const holds = async (w) => {
      if (w.all) { for (const c of w.all) if (!(await holds(c))) return false; return true; }
      if (w.any) { for (const c of w.any) if (await holds(c)) return true; return false; }
      const v = await call("read_memory", { address: w.address, domain: w.domain, width: w.width ?? 8 });
      const value = Number(typeof v === "object" ? v.value : v);
      return w.equals !== undefined ? value === w.equals : w.atLeast !== undefined ? value >= w.atLeast : false;
    };
    const checkEnds = async () => {
      for (const end of ENDS) {
        if (!end.when || reached.has(end.id)) continue;
        if (await holds(end.when)) {
          reached.add(end.id);
          emit("game.milestone", { label: end.label, split: end.split ?? end.label, end: end.id, chapter: true });
          if (end.final) { over = true; emit("game.over", { victory: true, label: end.label }); }
          else if (end.id === goal) over = true;
        }
      }
    };
    const play = async (label, steps) => {
      if (over) throw new Error("the game has reached its end; no further input");
      const i = ++index;
      const frames = steps.reduce((n, s) => n + Math.max(0, Math.floor(s.frames ?? 1)), 0);
      if (frames < 1 || frames > 36000) throw new Error("frames must be between 1 and 36000 per call");
      const started = Date.now();
      emit("game.playback", { phase: "start", index: i, command: label, frames });
      try {
        // All steps go in as few calls as the tool takes (600 frames each): between calls the emulator stands still,
        // and a call per short step cut the game's sound up (measured 2026-09-23: 15.2 silences a second with calls
        // of one frame, 2.3 with calls of 600, as many as running freely).
        let batch = [], inBatch = 0;
        const flush = async () => { if (batch.length) await call("frame_advance", { steps: batch }); batch = []; inBatch = 0; };
        for (const s of steps) {
          const buttons = buttonMap(s.buttons);
          let left = Math.max(0, Math.floor(s.frames ?? 1));
          while (left > 0) {
            const n = Math.min(left, 600 - inBatch);
            batch.push(Object.keys(buttons).length ? { buttons, frames: n } : { frames: n });
            inBatch += n; left -= n;
            if (inBatch === 600) await flush();
          }
        }
        await flush();
      } catch (error) {
        emit("game.playback", { phase: "end", index: i, error: String(error?.message ?? error), wall_ms: Date.now() - started, command: label });
        throw error;
      }
      const info = await call("get_info");
      emit("game.playback", { phase: "end", index: i, command: label, frames, seconds: fps ? frames / fps : null, framecount: info.framecount ?? null, wall_ms: Date.now() - started, error: null });
      await checkEnds();
      return { frames, framecount: info.framecount ?? null };
    };
    return {
      async info() { const i = await call("get_info"); return { system: i.system_id, rom: i.rom_name, rom_sha1: i.rom_hash, framecount: i.framecount, paused: i.paused, profile: PROFILE?.id ?? null }; },
      async observe() { return this.info(); },
      async buttons() { const j = await call("get_joypad"); return Object.keys(j.buttons ?? j).map((b) => b.replace(/^P1 /, "")).filter((b) => !["Power", "Reset"].includes(b)); },
      press: (buttons, frames = 1) => play(`press ${Object.keys(buttonMap(buttons)).join("+") || "nothing"} ${frames}`, [{ buttons, frames }]),
      sequence: (steps) => play(`sequence of ${steps.length}`, steps),
      wait: (frames) => play(`wait ${frames}`, [{ frames }]),
      async read(address, { domain, width = 8 } = {}) { return call("read_memory", { address, domain, width }); },
      async readRange(address, length, domain) { return call("read_range", { address, length, domain }); },
      async domains() { return call("list_memory_domains"); },
      /** The frame as the tool renders it, read back as its own MCP resource: no file passes through the broker. */
      async screenshot() {
        const shot = await call("screenshot", {});
        const res = await rpc("resources/read", { uri: shot.resource });
        const blob = res?.contents?.[0]?.blob;
        if (!blob) throw new Error("the screenshot came back without an image");
        const url = `data:${res.contents[0].mimeType ?? "image/png"};base64,${blob}`;
        globalThis.aas?.emitImage?.(url);
        return { screenshots: [{ url }] };
      },
      close() {},
    };
  },

  /** The profile's ROM, checked by its SHA-1, from power-on and paused, so the recording begins at the first frame. */
  async prepareRun({ log = () => {}, resume = false } = {}) {
    if (resume) return { readyAt: new Date() };
    const info = await call("get_info");
    if (PROFILE && String(info.rom_hash).toUpperCase() !== PROFILE.rom.sha1) throw new Error(`the loaded ROM is not ${PROFILE.name}: SHA-1 ${info.rom_hash}, the profile names ${PROFILE.rom.sha1}`);
    await call("pause");
    await call("reboot");
    log(`${info.rom_name} (${info.system_id}) from power-on, paused`);
    return { readyAt: new Date() };
  },
  /** A savestate of the emulator, next to BizHawk; the harness copies it into the run. */
  async saveState({ name }) {
    const dir = join(bizhawkDir(), "aas-saves");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.State`);
    await call("save_state", { path: hostPath(file) });
    return { name, file };
  },
  async loadState({ name = null, runDir = null, log = () => {} } = {}) {
    const candidates = [runDir && name ? join(runDir, "saves", `${name}.State`) : null, name ? join(bizhawkDir(), "aas-saves", `${name}.State`) : null].filter(Boolean);
    const file = candidates.find((f) => existsSync(f));
    if (!file) throw new Error(`save ${name ?? "(none)"} not found (looked in ${candidates.join(", ")})`);
    await call("pause");
    await call("load_state", { path: hostPath(file) });
    const info = await call("get_info");
    log(`save ${name} loaded at frame ${info.framecount}`);
    return { readyAt: new Date() };
  },
  /** What someone needs to play the same thing: BizHawk and the tool with their pins, and the ROM by its SHA-1. */
  async build() {
    // The core the game ran on: BizHawk's own preference for the system, which the launcher sets when a profile names one.
    let core = null;
    try { core = JSON.parse(readFileSync(join(bizhawkDir(), "config.ini"), "utf8").replace(/^\uFEFF/, "")).PreferredCores?.[PROFILE?.system] ?? null; } catch { /* no config */ }
    return {
      game: PROFILE?.name ?? null,
      version: PROFILE ? `ROM SHA-1 ${PROFILE.rom.sha1}` : null,
      platform: PROFILE ? `${PROFILE.system} on BizHawk ${UPSTREAM.bizhawk.version}` : `BizHawk ${UPSTREAM.bizhawk.version}`,
      mods: [
        { name: "BizHawk", version: UPSTREAM.bizhawk.version, source: UPSTREAM.bizhawk.url, sha256: UPSTREAM.bizhawk.sha256 },
        { name: "bizhawk-mcp-native", version: UPSTREAM.bizhawk_mcp_native.version, source: UPSTREAM.bizhawk_mcp_native.url, sha256: UPSTREAM.bizhawk_mcp_native.sha256 },
      ],
      settings: { profile: PROFILE?.id ?? null, core, rom: PROFILE ? { title: PROFILE.rom.title, sha1: PROFILE.rom.sha1, author: PROFILE.rom.author, license: PROFILE.rom.license, source: PROFILE.rom.source } : null, paused_between_moves: true },
    };
  },
  async close({ log = () => {} } = {}) {
    const { closeGame } = await import("./close-game.mjs");
    return closeGame({ log });
  },
  async doctor() {
    const rows = [];
    const dir = bizhawkDir();
    rows.push({ ok: Boolean(dir && existsSync(join(dir, "EmuHawk.exe"))), what: "EmuHawk.exe", detail: dir ? join(dir, "EmuHawk.exe") : "no BizHawk folder" });
    const trust = dir ? trustState(dir) : { trusted: false, detail: "no BizHawk folder" };
    // An older build of the tool is replaced by installing, not allowed: the row then offers the install step.
    rows.push({ ok: trust.trusted, what: "BizHawk trusts bizhawk-mcp-native", detail: trust.detail, fix: trust.outdated ? null : "allow" });
    const rom = romPath();
    const okRom = Boolean(rom && existsSync(rom));
    rows.push({ ok: okRom, what: `ROM of ${PROFILE?.name ?? "the profile"}`, detail: rom ?? "no ROM set (AAS_BIZHAWK_ROM)" });
    if (okRom && PROFILE) { const got = romFileSha1(rom); rows.push({ ok: got === PROFILE.rom.sha1, what: "the ROM is the dump the profile names", detail: `SHA-1 ${got}; the profile names ${PROFILE.rom.sha1}` }); }
    return rows;
  },
  exercise: [
    { label: "info", code: "return await emu.info();", verify: (v) => { if (!v?.system) throw new Error("no system"); } },
  ],
};
