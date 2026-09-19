// Game plugin: Balatro through balatrobot (coder/balatrobot), a Steamodded mod loaded by Lovely that serves
// the game as JSON-RPC over HTTP. The controller talks to games/balatro/bridge.mjs, which passes the game
// actions through to balatrobot and refuses the rest (`add`, `set`, and the harness's `start`, `menu`,
// `save`, `load`). Turn-based: every action answers once the game has settled, so IGT = the time the game
// spends on each action and everything else is thinking. Splits: one per ante; the win is the end of ante 8.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonRpcClient } from "../../packages/core/src/json-rpc-http.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.AAS_BALATRO_HOST || "127.0.0.1";
const PORT = process.env.AAS_BALATRO_PORT ? Number(process.env.AAS_BALATRO_PORT) : 12347;
const GAME_ROOT = process.env.AAS_BALATRO_GAME_ROOT ? resolve(process.env.AAS_BALATRO_GAME_ROOT) : null;
const DECK = (process.env.AAS_BALATRO_DECK || "RED").toUpperCase();
const STAKE = (process.env.AAS_BALATRO_STAKE || "WHITE").toUpperCase();
export const ACTION_TIMEOUT_MS = Number(process.env.AAS_BALATRO_ACTION_TIMEOUT_MS || 120000);
export const SEGMENTS = ["Ante 1", "Ante 2", "Ante 3", "Ante 4", "Ante 5", "Ante 6", "Ante 7", "Ante 8"];
/** The game's ends: winning the run (the boss blind of ante 8) is the game's own end and the Random Seed and Set Seed
 *  goal; each earlier ante is a shorter end (owner 2026-09-17), for tests and first runs, as act1 is for Slay the Spire. */
export const ENDS = [
  ...SEGMENTS.slice(0, 7).map((label, i) => ({ id: `ante${i + 1}`, label, split: label })),
  { id: "win", label: "Win", split: "Ante 8", final: true },
];

/** The folder next to the game where install-mod.mjs puts the mods, and where the harness keeps its saves. */
export const toolsDir = (root = GAME_ROOT) => (process.env.AAS_BALATRO_TOOLS_DIR ? resolve(process.env.AAS_BALATRO_TOOLS_DIR) : root ? join(root, "aas") : null);

/** A compact view of balatrobot's game state for the agent: the full state, with the empty areas left out. */
export function compact(s) {
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (v && typeof v === "object" && !Array.isArray(v) && "cards" in v && Array.isArray(v.cards) && v.cards.length === 0 && !["hand", "jokers", "consumables"].includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The harness's client to the bridge: the token from the bridge's state file lets it start, save and load. */
async function harnessClient() {
  const { readBridgeState } = await import("./bridge.mjs");
  const state = readBridgeState();
  if (!state) throw new Error("the Balatro bridge is not running (npm run balatro:launch)");
  return jsonRpcClient({ host: HOST, port: state.port, timeoutMs: ACTION_TIMEOUT_MS, headers: { "X-AAS-Token": state.token } });
}

const toMenu = async (rpc, log) => {
  let s = await rpc.call("gamestate");
  if (s.state !== "MENU") {
    log(`the game is not at the main menu (${s.state}, ante ${s.ante_num}); going back to it`);
    s = await rpc.call("menu");
  }
  if (s.state !== "MENU") throw new Error(`not at the main menu after menu: ${s.state}`);
  return s;
};

export default {
  id: "balatro",
  name: "Balatro",
  version: "0.1.0",
  scopeName: "bal",
  capabilities: { turnBased: true, canPause: true, stateAccess: "full", inputRoute: "api", igt: true },
  processName: process.env.AAS_BALATRO_PROCESS || "Balatro.exe",
  windowTitle: "Balatro",
  endpoints: [{ host: HOST, port: PORT }],
  /** The variables the controller reads inside the broker; nothing else of the environment reaches it. */
  env: ["AAS_BALATRO_HOST", "AAS_BALATRO_PORT", "AAS_BALATRO_DECK", "AAS_BALATRO_STAKE", "AAS_BALATRO_PROCESS", "AAS_BALATRO_ACTION_TIMEOUT_MS"],
  ends: ENDS,
  /** What the GUI (`aas gui`) needs to set the game up and start it; see docs/plugins.md. */
  setup: {
    folder: "Balatro",
    settings: [{ env: "AAS_BALATRO_GAME_ROOT", label: "Balatro folder", kind: "dir", expect: "Balatro.exe", find: { steam: 2379780, epic: "Balatro" }, what: "Where Balatro is installed: the folder with Balatro.exe in it, from Steam or from the Epic Games Store." }],
    install: join(here, "install-mod.mjs"),
    installs: "Install Lovely, Steamodded and balatrobot into the game's own mod folder for this harness",
    launch: join(here, "launch-game.mjs"),
    stop: join(here, "stop-all.mjs"),
    splits: { ...Object.fromEntries(SEGMENTS.slice(0, 7).map((_, i) => [`ante${i + 1}`, join(here, "splits", `balatro-ante${i + 1}.lss`)])), win: join(here, "splits", "balatro-win.lss") },
    bot: join(here, "bot.mjs"),
    seed: { placeholder: "the game picks one" },
    displayEnv: "AAS_BALATRO_WINDOW_POS",
  },
  readable: [here],
  segments: SEGMENTS,
  // Turn-based: the cut video keeps a few seconds after each action so its result is seen.
  cutDefaults: { marginBefore: 0.2, marginAfter: 2.5 },
  gameConfig: [join(here, "UPSTREAM.json")],
  documentation: readFileSync(join(here, "documentation.md"), "utf8"),
  instructions: readFileSync(join(here, "AGENTS.md"), "utf8"),
  goalPrompt: (end) => `You are playing Balatro with the ${DECK} deck at ${STAKE} stake; the run has been started. Read balatro_documentation, then play ${end && !end.final ? `until you have beaten the boss blind of ${end.label.toLowerCase()}` : "until the run is won: beat the boss blind of ante 8"}. Do not look up information about the game online.`,
  category: {
    build: "Balatro (Steam) + Lovely + Steamodded + balatrobot",
    observation: "state",
    input: "api",
    timing: "paused-think",
    human: "none",
  },
  execDescription:
    "Run async JavaScript against Balatro through balatrobot; `bal` is in scope. Use `return <value>` for results. " +
    "Read the state (`await bal.state()`), then act: `bal.select()`, `bal.skip()`, `bal.play([i, ...])`, `bal.discard([i, ...])`, `bal.cashOut()`, " +
    "`bal.buy({card|voucher|pack: i})`, `bal.sell({joker|consumable: i})`, `bal.reroll()`, `bal.pack({card: i, targets} | {skip: true})`, `bal.use(i, [targets])`, " +
    "`bal.rearrange({hand|jokers|consumables: [order]})`, `bal.nextRound()`, and after a game over `bal.restart()`. Every action returns the state the game settled in.",

  /** The controller the broker exposes as `bal`; every action is a `game.playback` (IGT = the game's time on it). */
  async connect() {
    const rpc = jsonRpcClient({ host: HOST, port: PORT, timeoutMs: ACTION_TIMEOUT_MS });
    const emit = (event, data) => globalThis.aas?.event?.(event, data);
    let last = null;
    let highestAnte = null;
    let round = null;
    let deaths = 0;
    let dead = false; // at the game-over screen: only restart() is allowed
    let over = false; // the run is won: nothing more is sent
    let index = 0;
    const track = (s) => {
      if (!s || typeof s !== "object" || !s.state || s.state === "MENU") return;
      last = s;
      const ante = typeof s.ante_num === "number" ? s.ante_num : null;
      if (typeof s.round_num === "number" && s.round_num !== round) {
        round = s.round_num;
        if (round > 0) emit("game.milestone", { label: `Round ${round}`, round, ante, chapter: false });
      }
      // A boss blind beaten moves the game to the next ante. The Hieroglyph and Petroglyph vouchers move it back
      // one; an ante is split only the first time the game goes past it.
      if (ante !== null && highestAnte === null) highestAnte = ante;
      if (ante !== null && ante > highestAnte) {
        for (let a = highestAnte; a < ante; a += 1) {
          if (a >= 8) continue; // ante 8 ends with the win below
          emit("game.milestone", { label: `Ante ${a}`, split: SEGMENTS[a - 1], end: `ante${a}`, ante: a, round: s.round_num ?? null, seed: s.seed ?? null, chapter: true });
        }
        highestAnte = ante;
      }
      if (s.won === true && !over) {
        over = true;
        emit("game.milestone", { label: "Win", split: "Ante 8", end: "win", ante, round: s.round_num ?? null, seed: s.seed ?? null, chapter: true });
        emit("game.over", { victory: true, label: "Win", ante, round: s.round_num ?? null, deaths, seed: s.seed ?? null, deck: s.deck ?? null, stake: s.stake ?? null });
      } else if (s.state === "GAME_OVER" && !over && !dead) {
        // A game over ends this run, not the session: the agent restarts; the session clock keeps running.
        dead = true; deaths += 1;
        emit("game.milestone", { label: `Game over ${deaths}`, ante, round: s.round_num ?? null, deaths, chapter: false });
        emit("game.over", { victory: false, label: "Game over", ante, round: s.round_num ?? null, deaths, seed: s.seed ?? null, deck: s.deck ?? null, stake: s.stake ?? null });
      }
    };
    const action = async (method, params, label = method) => {
      if (over) throw new Error("the run is won; no further actions, the session ends");
      if (dead && method !== "aas.restart") throw new Error(`game over (${deaths}); call bal.restart() for a new run`);
      const i = ++index;
      const started = Date.now();
      emit("game.playback", { phase: "start", index: i, command: label, params: params ?? null });
      let s;
      try {
        s = await rpc.call(method, params);
      } catch (error) {
        emit("game.playback", { phase: "end", index: i, error: String(error?.message ?? error), wall_ms: Date.now() - started, command: label });
        if (error?.name === "JsonRpcError") throw new Error(`Balatro refused ${label}: ${error.message.replace(/^[^:]+: /, "")}`);
        throw error;
      }
      const seconds = Math.round(Date.now() - started) / 1000;
      emit("game.playback", { phase: "end", index: i, seconds, wall_ms: Date.now() - started, command: label, state: s?.state ?? null, ante: s?.ante_num ?? null, round: s?.round_num ?? null, error: null });
      return s;
    };
    const act = async (method, params) => { const s = await action(method, params); track(s); return compact(s); };
    return {
      async state() { const s = await rpc.call("gamestate"); track(s); return compact(s); },
      async observe() { const s = await rpc.call("gamestate"); track(s); return compact(s); },
      select: () => act("select"),
      skip: () => act("skip"),
      play: (cards) => act("play", { cards }),
      discard: (cards) => act("discard", { cards }),
      cashOut: () => act("cash_out"),
      buy: (what) => act("buy", what),
      sell: (what) => act("sell", what),
      reroll: () => act("reroll"),
      pack: (what) => act("pack", what),
      use: (consumable, cards) => act("use", cards === undefined ? { consumable } : { consumable, cards }),
      rearrange: (order) => act("rearrange", order),
      nextRound: () => act("next_round"),
      /** After a game over: back to the menu and a new run with the same deck and stake (a new random seed, or the set seed). One playback. */
      async restart() {
        if (over) throw new Error("the run is won");
        if (!dead) throw new Error("restart() is only for after a game over (state GAME_OVER)");
        const s = await action("aas.restart", undefined, "restart");
        dead = false; highestAnte = null; round = null;
        emit("game.attempt", { phase: "start", attempt: deaths + 1, seed: s?.seed ?? null, deaths });
        emit("game.milestone", { label: `Attempt ${deaths + 1}`, seed: s?.seed ?? null, deaths, chapter: false });
        track(s);
        return compact(s);
      },
      async screenshot() {
        const r = await rpc.call("aas.screenshot");
        const url = `data:image/png;base64,${r.png}`;
        globalThis.aas?.emitImage?.(url);
        return { screenshots: [{ url }] };
      },
      get last() { return last; },
      close() {},
    };
  },

  /** Starts the run for the agent (deck and stake from AAS_BALATRO_*, the seed when the run has one), so the recording begins at the first choice.
   *  On a resume the harness's save is loaded instead (loadState). */
  async prepareRun({ log = () => {}, resume = false, seed = null } = {}) {
    if (resume) return { readyAt: new Date() };
    const rpc = await harnessClient();
    await toMenu(rpc, log);
    const params = { deck: DECK, stake: STAKE, ...(seed ? { seed: String(seed) } : {}) };
    const s = await rpc.call("start", params);
    if (s.state !== "BLIND_SELECT") throw new Error(`start ended in ${s.state}, expected BLIND_SELECT`);
    log(`run started: ${s.deck ?? DECK} deck, ${s.stake ?? STAKE} stake, seed ${s.seed ?? "?"}${seed ? " (set)" : " (random)"}`);
    return { readyAt: new Date(), seed: s.seed ?? null, seed_code: s.seed ?? null };
  },
  /** balatrobot's `save` writes the running game to a file next to the game; the harness copies it into the run. */
  async saveState({ name }) {
    const dir = toolsDir();
    if (!dir) return { name, file: null };
    const { gamePath } = await import("./bridge.mjs");
    mkdirSync(join(dir, "saves"), { recursive: true });
    const file = join(dir, "saves", `${name}.jkr`);
    const rpc = await harnessClient();
    await rpc.call("save", { path: gamePath(file) });
    return { name, file };
  },
  /** Resume: the named save (from <run>/saves/ or next to the game) is loaded into the running game. */
  async loadState({ name = null, log = () => {}, runDir = null } = {}) {
    const dir = toolsDir();
    const candidates = [runDir && name ? join(runDir, "saves", `${name}.jkr`) : null, dir && name ? join(dir, "saves", `${name}.jkr`) : null].filter(Boolean);
    const src = candidates.find((f) => existsSync(f));
    if (!src) throw new Error(`save ${name ?? "(none)"} not found (looked in ${candidates.join(", ") || "nothing"})`);
    let file = src;
    if (dir && !src.startsWith(dir)) { mkdirSync(join(dir, "saves"), { recursive: true }); file = join(dir, "saves", `${name}.jkr`); copyFileSync(src, file); }
    const { gamePath } = await import("./bridge.mjs");
    const rpc = await harnessClient();
    await rpc.call("load", { path: gamePath(file) });
    const s = await rpc.call("gamestate");
    log(`save ${name} loaded: ${s.state}, ante ${s.ante_num}, round ${s.round_num}, seed ${s.seed ?? "?"}`);
    return { readyAt: new Date(), seed: s.seed ?? null, seed_code: s.seed ?? null };
  },
  /**
   * Everything someone needs to reproduce this run: the game's build, the mods with their pins and hashes as they are
   * installed, and the settings of the run. The seed and deck come from the last save the harness copied into the run.
   */
  async build({ runDir = null } = {}) {
    const upstream = JSON.parse(readFileSync(join(here, "UPSTREAM.json"), "utf8"));
    const mods = [];
    const dir = toolsDir();
    const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
    if (GAME_ROOT && existsSync(join(GAME_ROOT, "version.dll"))) mods.push({ name: "Lovely", version: upstream.lovely.version, sha256: sha(join(GAME_ROOT, "version.dll")), source: upstream.lovely.url });
    for (const [key, name] of [["steamodded", "Steamodded"], ["balatrobot", "balatrobot"]]) {
      const pin = upstream[key];
      const installed = dir && existsSync(join(dir, "Mods", pin.folder));
      if (installed) mods.push({ name, version: pin.version, source: pin.url, sha256: pin.sha256 });
    }
    // The launcher records the game's own version (from its settings file) and the profile it played on.
    let launch = {};
    try { launch = JSON.parse(readFileSync(join(dir, "launch.json"), "utf8")); } catch { /* not launched by launch-game.mjs */ }
    // The seed the game reported when the run started (the run log's game.ready).
    let seed = null;
    try {
      const rows = readFileSync(join(runDir, "run.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
      seed = rows.find((r) => r?.kind === "event" && r.event === "game.ready" && r.data?.seed)?.data.seed ?? null;
    } catch { /* no run log */ }
    return {
      game: "Balatro",
      version: launch.version ?? null,
      platform: "Steam",
      mods,
      settings: {
        deck: DECK,
        stake: STAKE,
        seed,
        profile: launch.profile ?? null,
        balatrobot: { gamespeed: 4, fast: false, headless: false, audio: true, render_on_api: false },
        display: "windowed",
      },
    };
  },
  /** Closes the game and the bridge and undoes the launcher's set-up; the harness calls this when a run ends. */
  async close({ log = () => {} } = {}) {
    const { closeGame } = await import("./close-game.mjs");
    return closeGame({ log });
  },
  async doctor() {
    const rows = [];
    rows.push({ ok: Boolean(GAME_ROOT && existsSync(join(GAME_ROOT, "Balatro.exe"))), what: "Balatro.exe", detail: GAME_ROOT ? join(GAME_ROOT, "Balatro.exe") : "AAS_BALATRO_GAME_ROOT is not set" });
    rows.push({ ok: Boolean(GAME_ROOT && existsSync(join(GAME_ROOT, "version.dll"))), what: "Lovely (version.dll)", detail: "npm run balatro:install" });
    const dir = toolsDir();
    rows.push({ ok: Boolean(dir && existsSync(join(dir, "Mods", "balatrobot", "balatrobot.json"))), what: "balatrobot mod", detail: dir ? join(dir, "Mods", "balatrobot") : "no tools folder" });
    return rows;
  },
  exercise: [
    { label: "state", code: "const s = await bal.state(); return { state: s.state, ante: s.ante_num, deck: s.deck };", verify: (v) => { if (!v?.state) throw new Error("no state"); } },
  ],
};
