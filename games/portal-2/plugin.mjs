// Portal 2 game plugin for the AAS broker, on SourceAutoRecord's own TAS protocol (p2sr/SourceAutoRecord, MIT,
// pinned in UPSTREAM.json). SAR is not vendored: install-mod.mjs downloads the pinned release, checks its sha256
// and writes this plugin's own config next to the game, so the player's autoexec.cfg stays theirs.
//
// What the protocol gives, and what it does not (docs/tas_proto.txt): playback of an inline .p2tas script, pause,
// play, advance one tick, pause at a tick, fast-forward, and the position, angles and velocity of any entity. It
// does not give a screenshot and it names the map only once, when the controller connects. Both of those are
// answered with the engine's own facilities instead of a patch to SAR: the console log for the map (maps.mjs) and
// the engine's `jpeg` command for the picture.
//
// Environment (AAS_* survives the broker's hardening scrub):
//   AAS_PORTAL2_GAME_ROOT   the folder with portal2.exe
//   AAS_PORTAL2_HOST        SAR TAS protocol host (default 127.0.0.1)
//   AAS_PORTAL2_PORT        SAR TAS protocol port (default 6555, sar_tas_protocol_server)
import fs, { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectSar } from "./sar-client.mjs";
import { MAPS, consoleLogPath, createMapTracker, mapName } from "./maps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const UPSTREAM = JSON.parse(fs.readFileSync(join(here, "UPSTREAM.json"), "utf8"));
const GAME_ROOT = process.env.AAS_PORTAL2_GAME_ROOT ? resolve(process.env.AAS_PORTAL2_GAME_ROOT) : null;
const HOST = process.env.AAS_PORTAL2_HOST || "127.0.0.1";
const PORT = process.env.AAS_PORTAL2_PORT ? Number(process.env.AAS_PORTAL2_PORT) : 6555;
const TICK = 1 / 60; // Portal 2 runs at 60 ticks per second
// The .p2tas version this tooling writes; SAR's docs/p2tas.md names the newest one.
const SCRIPT_VERSION = UPSTREAM.sar.script_version ?? 9;

/** The campaign's maps are the splits: one per map, named as the game names them. */
export const SEGMENTS = MAPS.map((m) => m.name);
/** The game's ends: every map after the first, and the credits, which is the game's own end. */
export const ENDS = [
  ...MAPS.slice(1).map((m) => ({ id: m.map, label: m.name, split: m.name })),
  { id: "credits", label: "Credits", split: "Finale 4", final: true },
];

export default {
  id: "portal_2",
  name: "Portal 2",
  version: "0.33.8",
  scopeName: "portal2",
  segments: SEGMENTS,
  ends: ENDS,
  processName: "portal2.exe",
  capabilities: { turnBased: false, canPause: true, stateAccess: "none", inputRoute: "input", igt: false },
  endpoints: [{ host: HOST, port: PORT }],
  env: ["AAS_PORTAL2_GAME_ROOT", "AAS_PORTAL2_HOST", "AAS_PORTAL2_PORT", "AAS_PORTAL2_TIMEOUT_MS"],
  readable: [here, ...(GAME_ROOT ? [GAME_ROOT] : [])],
  setup: {
    folder: "Portal2",
    settings: [{ env: "AAS_PORTAL2_GAME_ROOT", label: "Portal 2 folder", kind: "dir", expect: "portal2.exe", find: { steam: 620 }, what: "Where Steam installed Portal 2: the folder with portal2.exe in it, usually steamapps\\common\\Portal 2." }],
    install: join(here, "install-mod.mjs"),
    installs: "Download SourceAutoRecord (pinned, sha256 checked) and write its config next to the game",
    launch: join(here, "launch-game.mjs"),
    stop: join(here, "stop-all.mjs"),
    // One splits file per end, made by make-splits.mjs from the campaign in maps.json.
    splits: Object.fromEntries(ENDS.map((e) => [e.id, join(here, "splits", `portal2-${e.id}.lss`)])),
    recorders: ["obs"],
    displayEnv: "AAS_PORTAL2_WINDOW_POS",
    resolutionEnv: "AAS_PORTAL2_RESOLUTION",
  },
  category: {
    build: `Portal 2 + SourceAutoRecord ${UPSTREAM.sar.version}`,
    observation: "vision",
    input: "input",
    timing: "paused-think",
    human: "none",
  },
  goalPrompt: (end) =>
    `You are controlling Portal 2. Your goal is to progress through the game and reach ${end && !end.final ? `the chamber "${end.label}"` : "the end credits"}. ` +
    "Do not cheat/look up information about the game online.",
  /** Everything someone needs to reproduce this run: the game, the mod with its pin, and the settings. */
  async build() {
    return {
      game: "Portal 2",
      version: null, // the engine's build is read from the game; unknown until a run has been made
      platform: "Steam",
      mods: [{ name: UPSTREAM.sar.name, details: "loaded with plugin_load sar; TAS protocol server", version: UPSTREAM.sar.version, source: UPSTREAM.sar.url, sha256: UPSTREAM.sar.sha256 }],
      settings: { resolution: process.env.AAS_PORTAL2_RESOLUTION ?? "1920x1080", cvars: `portal2/cfg/aas_portal2.cfg (plugin_load sar; sar_tas_protocol_server ${PORT})` },
    };
  },
  /** Read-only checks for `aas doctor`: the game, SAR with its pin, this plugin's config, the console log. */
  async doctor() {
    const rows = [];
    const add = (ok, what, detail = "") => rows.push({ ok, what, detail });
    add(Boolean(GAME_ROOT && fs.existsSync(join(GAME_ROOT, "portal2.exe"))), "AAS_PORTAL2_GAME_ROOT (portal2.exe)", GAME_ROOT ?? "not set");
    if (!GAME_ROOT) return rows;
    const sar = join(GAME_ROOT, UPSTREAM.sar.file);
    if (!fs.existsSync(sar)) add(false, `${UPSTREAM.sar.file} next to the game`, "run games/portal-2/install-mod.mjs");
    else {
      const { createHash } = await import("node:crypto");
      const sha = createHash("sha256").update(fs.readFileSync(sar)).digest("hex");
      add(sha === UPSTREAM.sar.sha256, `${UPSTREAM.sar.file} is the pinned ${UPSTREAM.sar.version}`, sha === UPSTREAM.sar.sha256 ? sha.slice(0, 16) : `sha256 ${sha.slice(0, 16)}…, expected ${UPSTREAM.sar.sha256.slice(0, 16)}…`);
    }
    add(fs.existsSync(join(GAME_ROOT, "portal2", "cfg", "aas_portal2.cfg")), "portal2/cfg/aas_portal2.cfg", "written by install-mod.mjs");
    add(fs.existsSync(consoleLogPath(GAME_ROOT)), "portal2/console.log (-condebug)", "the map a run is in is read from the engine's own console log; it appears once the game has run with -condebug");
    return rows;
  },
  documentation: fs.readFileSync(join(here, "documentation.md"), "utf8"),
  /** What the model is told before it starts; `aas publish` carries it into the bundle as AGENTS.md, verbatim. */
  instructions: fs.readFileSync(join(here, "AGENTS.md"), "utf8"),
  execDescription:
    "Run async JavaScript against Portal 2 through SourceAutoRecord's TAS protocol; `portal2` is in scope. Use `return <value>` for text results.\n" +
    "TAS: `await portal2.tas(script)` plays an inline .p2tas script from the state the game is in (`start now` is added when the script has no header). " +
    "A tickbulk is `tick>movement|angles|buttons|commands|tools`, ticks absolute (`120>`) or relative (`+10>`); buttons J/D/U/Z/B/O (uppercase presses, lowercase releases, a number holds for that many ticks).\n" +
    "Stepping: `portal2.advance(ticks)` plays exactly that many ticks and returns the tick the game is on; `portal2.pause()`, `portal2.play()`, `portal2.pauseAtTick(t)`, `portal2.fastForward(t)`, `portal2.rate(r)`.\n" +
    "Observing: `portal2.position()` and `portal2.entity(selector)` give position, angles and velocity; `portal2.map()` is the map the run is in; `portal2.screenshot()` returns a picture.",

  /** A short connection of its own, for the harness's own calls: they run outside the agent's session. */
  async withSar(fn) {
    const sar = await connectSar({ host: HOST, port: PORT });
    try { return await fn(sar); } finally { sar.close(); }
  },

  /**
   * Called by `aas run` once the recorder is going and before the agent starts: load the map the run begins on and
   * leave the game standing still on it. `start map <name>` is SAR's own way to begin a script on a map
   * (docs/p2tas.md), and the script this sends does nothing else, so what it leaves behind is a loaded, paused
   * game — not a game that has already been played for a tick.
   */
  async prepareRun({ log = () => {}, goal = null } = {}) {
    const map = MAPS[0].map;
    return this.withSar(async (sar) => {
      log(`loading ${map} (${MAPS[0].name})${goal ? ` for goal ${goal}` : ""}`);
      await sar.script(`version ${SCRIPT_VERSION}\nstart map ${map}\n+0>||||\n`, "aas_start");
      await sar.pause();
      const { position } = await sar.entity("player");
      log(`Portal 2 is ready: paused in ${map} at ${JSON.stringify(position)}`);
      return { readyAt: new Date(), map, position };
    });
  },

  /**
   * The engine's own save, run from a one-tick script's commands column — the only channel the TAS protocol has
   * for a console command. The file the engine writes is what `aas run` copies next to the run.
   */
  async saveState({ name, log = () => {} }) {
    // The name goes into the game's console: a plain name only, never a second command (";", a newline, a quote).
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(name))) throw new Error(`save name ${JSON.stringify(String(name)).slice(0, 60)} is not a plain name (letters, digits, _ and -)`);
    await this.withSar(async (sar) => {
      await sar.script(`version ${SCRIPT_VERSION}\nstart now\n+0>|||save ${name}|\n`, "aas_save");
      log(`save ${name} sent`);
    });
    const file = GAME_ROOT ? join(GAME_ROOT, "portal2", "SAVE", `${name}.sav`) : null;
    // The engine makes the file first and fills it a moment later: wait until it is there, is not empty, and has
    // stopped growing. A copy taken too early is a save of nothing.
    if (file) {
      const deadline = Date.now() + 15000;
      let last = -1;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (!existsSync(file)) continue;
        const size = statSync(file).size;
        if (size > 0 && size === last) return { name, file };
        last = size;
      }
      log(`the engine wrote no finished save at ${file} within 15 s`);
    }
    return { name, file };
  },

  /** `start save <name>` is SAR's own way to begin on a save (docs/p2tas.md), so the game loads it and stands still. */
  async loadState({ name, log = () => {} }) {
    // The name goes into the game's console: a plain name only, never a second command (";", a newline, a quote).
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(name))) throw new Error(`save name ${JSON.stringify(String(name)).slice(0, 60)} is not a plain name (letters, digits, _ and -)`);
    return this.withSar(async (sar) => {
      await sar.script(`version ${SCRIPT_VERSION}\nstart save ${name}\n+0>||||\n`, "aas_load");
      await sar.pause();
      const { position } = await sar.entity("player");
      log(`restored ${name}: paused at ${JSON.stringify(position)}`);
      return { position };
    });
  },

  /** After the agent stopped: stop whatever script is still playing, so the game is not left running a TAS. */
  async endRun() {
    try { await this.withSar((sar) => sar.stop()); } catch { /* the game may already be gone */ }
  },

  /** Closes the game and undoes the launcher's set-up; the harness calls this when a run ends. */
  async close({ log = () => {} } = {}) {
    const { closeGame } = await import("./close-game.mjs");
    return closeGame({ log });
  },

  /**
   * The controller the agent's code runs against. It is SAR's protocol plus the two things the protocol does not
   * carry: the map (the engine's console log) and a picture (the engine's own `jpeg` command).
   */
  async connect({ runDir } = {}) {
    const sar = await connectSar({ host: HOST, port: PORT });
    const tracker = createMapTracker({ logFile: consoleLogPath(GAME_ROOT), from: sar.state.location?.split("/").pop()?.replace(/\.bsp$/, "") ?? null });
    let playbacks = 0;
    // Every map the run enters is a milestone, and the ends are maps, so the harness declares the victory itself.
    const followMaps = () => {
      for (const entered of tracker.read()) {
        globalThis.aas?.event?.("game.milestone", { label: entered.name, split: entered.name, end: entered.map, map: entered.map, chapter: true });
      }
    };
    const shotDir = GAME_ROOT ? join(GAME_ROOT, "portal2", "screenshots") : null;
    const newestShot = () => {
      if (!shotDir || !fs.existsSync(shotDir)) return null;
      const files = fs.readdirSync(shotDir).filter((f) => /\.(jpe?g|tga)$/i.test(f)).map((f) => ({ f, t: fs.statSync(join(shotDir, f)).mtimeMs }));
      return files.length ? files.sort((a, b) => b.t - a.t)[0] : null;
    };
    return {
      /** The map the run is in, from the engine's console log; null before the game has loaded one. */
      map() { followMaps(); return tracker.current; },
      /** The cheap readings in one call, the way every AAS controller offers them. */
      async observe(what = ["map", "tick", "playback", "player"]) {
        const out = {};
        if (what.includes("map")) { followMaps(); out.map = tracker.current; out.chamber = out.map ? mapName(out.map) : null; }
        if (what.includes("tick")) out.tick = sar.state.tick;
        if (what.includes("playback")) out.playback = sar.state.playback;
        if (what.includes("player")) out.player = await sar.entity("player");
        return out;
      },
      /** Position, angles and velocity of an entity ("player", "#12", a targetname). */
      async entity(selector = "player") { return sar.entity(selector); },
      async position() { return (await sar.entity("player")).position; },
      async advance(ticks = 1) {
        const t0 = sar.state.tick ?? 0;
        globalThis.aas?.event?.("game.playback", { phase: "start", index: ++playbacks, planned_ticks: ticks });
        const tick = await sar.advance(ticks);
        followMaps();
        globalThis.aas?.event?.("game.playback", { phase: "end", index: playbacks, ticks: (tick ?? t0 + ticks) - t0, seconds: ticks * TICK });
        return tick;
      },
      // The protocol documents no answer to a state request (docs/tas_proto.txt): the game sends its state when
      // its state changes. So these report what was asked for, and `playback` is the last state the game itself
      // reported — never a claim that the request has landed.
      async pause() { await sar.pause(); return { requested: "paused", playback: sar.state.playback }; },
      async play() { await sar.play(); return { requested: "playing", playback: sar.state.playback }; },
      async pauseAtTick(tick) { await sar.pauseAtTick(tick); return { requested: `paused at ${tick}`, playback: sar.state.playback }; },
      async fastForward(tick, pauseAfter = true) { await sar.fastForward(tick, pauseAfter); return { requested: `fast-forward to ${tick}`, playback: sar.state.playback }; },
      async rate(value) { await sar.rate(value); return { rate: sar.state.rate }; },
      /**
       * Plays an inline .p2tas script. A script without a `version`/`start` header gets `start now`, which
       * continues from the state the game is in — the only form that makes sense inside a run that is already going.
       */
      async tas(script, { name = "aas" } = {}) {
        const text = /^\s*version\s+\d+/m.test(script) ? script : `version ${SCRIPT_VERSION}\nstart now\n${script}`;
        globalThis.aas?.event?.("game.playback", { phase: "start", index: ++playbacks, script: text });
        const r = await sar.script(text, name);
        followMaps();
        globalThis.aas?.event?.("game.playback", { phase: "end", index: playbacks, slot: r.slot });
        return { slot: r.slot, playback: sar.state.playback, tick: sar.state.tick };
      },
      /**
       * A picture, through the engine's own screenshot command run from a one-tick script: SAR's protocol has no
       * screenshot packet, and patching SAR is not this project's to do. The newest file in portal2/screenshots is
       * the answer.
       */
      async screenshot() {
        const before = newestShot();
        await sar.script(`version ${SCRIPT_VERSION}\nstart now\n+0>|||jpeg|\n`, "aas_shot");
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const shot = newestShot();
          if (shot && shot.f !== before?.f) {
            const file = join(shotDir, shot.f);
            return { image: fs.readFileSync(file).toString("base64"), mimeType: /\.tga$/i.test(shot.f) ? "image/x-tga" : "image/jpeg", file: shot.f };
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`the engine wrote no screenshot into ${shotDir} within 5 s (is the game started with the config of install-mod.mjs?)`);
      },
      seconds: (s) => Math.round(s / TICK),
      close() { sar.close(); },
    };
  },
};
