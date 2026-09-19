// Game plugin: Slay the Spire through Communication Mod (ForgottenArbiter),
// which hands the full game state to an external process and takes commands
// back. That process is games/slay-the-spire/bridge.mjs (started by the mod
// with the game), reachable on 127.0.0.1:27183 as a line protocol; this
// plugin is the client. Turn-based: game time only passes while the game
// resolves a command, so IGT = the game's own processing time per command and
// everything else is thinking. Splits: one per act boss (and the Heart).
import { existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { readZipEntry } from "../../packages/core/src/zip-read.mjs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.AAS_STS_HOST || "127.0.0.1";
const PORT = process.env.AAS_STS_PORT ? Number(process.env.AAS_STS_PORT) : 27183;
const GAME_ROOT = process.env.AAS_STS_GAME_ROOT ? resolve(process.env.AAS_STS_GAME_ROOT) : null;
const CLASS = (process.env.AAS_STS_CLASS || "IRONCLAD").toUpperCase();
const ASCENSION = Number(process.env.AAS_STS_ASCENSION || 0);
// The seed: configuration of the run (aas configure --seed, brief.seed, handed to prepareRun); AAS_STS_SEED is the default.
const SEED = process.env.AAS_STS_SEED || "";
export const MOD_VERSION = "1.2.1";
export const ALL_SEGMENTS = ["Act 1 boss", "Act 2 boss", "Act 3 boss", "Heart"];
export const SEGMENTS = ALL_SEGMENTS;
/** The game's ends, for the harness's goal logic: no goal means act3, the game's own victory; act1 and act2 are earlier ends, the Heart a later one. */
export const ENDS = [
  { id: "act1", label: "Act 1 boss", split: "Act 1 boss" },
  { id: "act2", label: "Act 2 boss", split: "Act 2 boss" },
  { id: "act3", label: "Act 3 boss", split: "Act 3 boss", final: true },
  { id: "heart", label: "Heart", split: "Heart" },
];
export const COMMAND_TIMEOUT_MS = Number(process.env.AAS_STS_COMMAND_TIMEOUT_MS || 90000);

/** Line-protocol client to the bridge. `send(line)` resolves with the next state that is ready for a command. */
export function connectBridge({ host = HOST, port = PORT, timeoutMs = 5000, onState = () => {} } = {}) {
  return new Promise((resolveConn, rejectConn) => {
    const sock = net.connect(port, host);
    let buf = "";
    let last = null;
    const waiters = [];
    let greeted;
    const greeting = new Promise((r) => { greeted = r; });
    const timer = setTimeout(() => { sock.destroy(); rejectConn(new Error(`Timed out connecting to the Slay the Spire bridge at ${host}:${port}. Is the game running with Communication Mod (npm run sts:launch)?`)); }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => { clearTimeout(timer); resolveConn(api); });
    sock.on("error", (e) => { clearTimeout(timer); rejectConn(e); for (const w of waiters.splice(0)) w.reject(e); });
    sock.on("close", () => { for (const w of waiters.splice(0)) w.reject(new Error("bridge connection closed")); });
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        // The seed is a 64-bit long; as a JSON number it loses digits in JavaScript, so it is kept as a string.
        try { msg = JSON.parse(line.replace(/"seed"\s*:\s*(-?\d{15,})/g, '"seed":"$1"')); } catch { continue; }
        if (msg.aas === "hello") { greeted(); continue; }
        if (msg.aas) { const kind = msg.aas === "state" ? "state-request" : msg.aas; const w = waiters.find((x) => x.kind === kind); if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); } continue; }
        last = msg;
        greeted();
        onState(msg);
        if (msg.ready_for_command || msg.error) {
          const w = waiters.find((x) => x.kind === "state");
          if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
        }
      }
    });
    const wait = (kind, ms) => new Promise((res, rej) => {
      const w = { kind, resolve: res, reject: rej };
      waiters.push(w);
      const t = setTimeout(() => { const at = waiters.indexOf(w); if (at !== -1) waiters.splice(at, 1); rej(new Error(`no ${kind} from the game within ${ms} ms`)); }, ms);
      const done = w.resolve; w.resolve = (v) => { clearTimeout(t); done(v); };
      const fail = w.reject; w.reject = (e) => { clearTimeout(t); fail(e); };
    });
    const api = {
      get last() { return last; },
      /** Send a Communication Mod command line and wait for the state that follows it. */
      async send(line, ms = COMMAND_TIMEOUT_MS) { await Promise.race([greeting, new Promise((r) => setTimeout(r, 3000))]); const p = wait("state", ms); sock.write(`${line}\n`); return p; },
      /** The latest state (asks the bridge when none was received yet). */
      async state(ms = 10000) { if (last) return last; const p = wait("state-request", ms); sock.write('{"aas":"state"}\n'); const r = await p; if (r.state) { last = r.state; return r.state; } return api.send("STATE", ms); },
      /** A real mouse click on the game window at 1920x1080 game coordinates (for the main menu, where the mod refuses CLICK). */
      async click(x, y, ms = 15000) { const p = wait("click", ms); sock.write(`${JSON.stringify({ aas: "click", x, y })}\n`); const r = await p; if (r.error) throw new Error(`click failed: ${r.error}`); return r; },
      async screenshot(ms = 20000) { const p = wait("screenshot", ms); sock.write('{"aas":"screenshot"}\n'); return p; },
      /** Wait until a state satisfies `pred` (checks the latest first). */
      async until(pred, ms = COMMAND_TIMEOUT_MS) { if (last && pred(last)) return last; const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await wait("state", ms - (Date.now() - t0)); if (pred(s)) return s; } throw new Error("condition not reached"); },
      close() { sock.destroy(); },
    };
  });
}

const gs = (s) => s?.game_state ?? null;
/** The game's own seed code (what the HUD shows and what START accepts) from its 64-bit seed: unsigned, base 35 without the letter O. */
export function seedString(seed) {
  if (seed === null || seed === undefined || seed === "") return "";
  if (!/^-?\d+$/.test(String(seed))) return String(seed); // already a seed code
  const alphabet = "0123456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
  let n = BigInt.asUintN(64, BigInt(seed));
  if (n === 0n) return "0";
  let out = "";
  while (n > 0n) { out = alphabet[Number(n % 35n)] + out; n /= 35n; }
  return out;
}
/** The 64-bit seed behind a seed code (the inverse of seedString): base 35 without the letter O. */
export function seedNumber(code) {
  const alphabet = "0123456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
  let n = 0n;
  for (const ch of String(code).toUpperCase()) {
    const i = alphabet.indexOf(ch);
    if (i < 0) throw new Error(`not a seed code: ${code}`);
    n = n * 35n + BigInt(i);
  }
  return BigInt.asUintN(64, n);
}
const atMainMenu = (s) => s && s.in_game === false;
/** The game's autosave is base64 with a one-byte repeating XOR ("key"); this reads the floor it describes. */
export function saveFloor(file) {
  try {
    const raw = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    const key = Buffer.from("key");
    const out = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] ^ key[i % key.length];
    return JSON.parse(out.toString("utf8")).floor_num ?? null;
  } catch { return null; }
}
/** Puts the named harness save (from <run>/saves/ or <game>/saves/aas/) in place as the game's autosave; null when there is nothing to restore. */
function restoreSave(name, runDir) {
  if (!name || !GAME_ROOT) return null;
  const candidates = [runDir ? join(runDir, "saves", `${name}.autosave`) : null, join(GAME_ROOT, "saves", "aas", `${name}.autosave`)].filter(Boolean);
  const src = candidates.find((f) => existsSync(f));
  if (!src) return null;
  const dst = join(GAME_ROOT, "saves", `${CLASS}.autosave`);
  mkdirSync(join(GAME_ROOT, "saves"), { recursive: true });
  copyFileSync(src, dst);
  return { src, dst, floor: saveFloor(src) };
}
/** The seed of the run so far, from the events the controller logged (game.over carries it). */
function lastSeed(runDir) {
  if (!runDir) return null;
  try {
    const rows = readFileSync(join(runDir, "run.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
    return rows.reverse().find((r) => r?.kind === "event" && (r.event === "game.over" || r.event === "game.milestone") && r.data?.seed)?.data.seed ?? null;
  } catch { return null; }
}

export default {
  id: "slay_the_spire",
  name: "Slay the Spire",
  version: "0.1.0",
  scopeName: "sts",
  capabilities: { turnBased: true, canPause: true, stateAccess: "full", inputRoute: "api", igt: true },
  processName: process.env.AAS_STS_PROCESS || "java.exe",
  windowTitle: "Modded Slay the Spire",
  endpoints: [{ host: HOST, port: PORT }],
  /** The variables the controller reads inside the broker; nothing else of the environment reaches it. */
  env: ["AAS_STS_HOST", "AAS_STS_PORT", "AAS_STS_GAME_ROOT", "AAS_STS_CLASS", "AAS_STS_ASCENSION", "AAS_STS_SEED", "AAS_STS_PROCESS", "AAS_STS_CONTINUE_XY", "AAS_STS_DEATH_CONTINUE_XY", "AAS_STS_COMMAND_TIMEOUT_MS"],
  ends: ENDS,
  /** What the GUI (`aas gui`) needs to set the game up and start it; see docs/plugins.md. */
  setup: {
    folder: "SlayTheSpire",
    settings: [{ env: "AAS_STS_GAME_ROOT", label: "Slay the Spire folder", kind: "dir", expect: "SlayTheSpire.exe", find: { steam: 646570 } }],
    install: join(here, "install-mod.mjs"),
    installs: "Install Communication Mod next to the game and point it at this harness's bridge",
    launch: join(here, "launch-game.mjs"),
    stop: join(here, "stop-all.mjs"),
    splits: { act1: join(here, "splits", "sts-act1.lss"), act3: join(here, "splits", "sts-act3.lss") },
    bot: join(here, "bot.mjs"),
    seed: { placeholder: "the game picks one (AAS_STS_SEED when set)" },
    displayEnv: "AAS_STS_WINDOW_POS",
  },
  readable: [here],
  segments: SEGMENTS,
  // Turn-based: a command itself takes milliseconds; the cut video keeps a few seconds after each one so the result is seen.
  cutDefaults: { marginBefore: 0.2, marginAfter: 2.5 },
  gameConfig: [join(here, "UPSTREAM.json")],
  documentation: readFileSync(join(here, "documentation.md"), "utf8"),
  instructions: readFileSync(join(here, "AGENTS.md"), "utf8"),
  goalPrompt: (end) => `You are playing Slay the Spire as the ${CLASS} at ascension ${ASCENSION}; the run has been started. Read sts_documentation, then play ${end?.id === "heart" ? "until the Heart is defeated" : end && !end.final ? `until the ${end.label} is defeated` : "until the run is won: the boss of Act 3, and the Heart if the run allows it"}. Do not look up information about the game online.`,
  category: {
    build: `Slay the Spire (Steam) + ModTheSpire + BaseMod + Communication Mod ${MOD_VERSION}`,
    observation: "state",
    input: "api",
    timing: "paused-think",
    human: "none",
  },
  execDescription:
    "Run async JavaScript against Slay the Spire through Communication Mod; `sts` is in scope. Use `return <value>` for results. " +
    "Read the state (`await sts.state()`), then act: `sts.play(i, target)`, `sts.end()`, `sts.choose(x)`, `sts.proceed()`, `sts.cancel()`, `sts.potion(...)`, `sts.key(...)`, `sts.wait(n)`, or `sts.command('<raw>')`. Every action returns the state the game settled in.",

  /** The controller the broker exposes as `sts`; every command is a `game.playback` (IGT = the game's processing time). */
  async connect() {
    let floor = null;
    let act = null;
    let seed = SEED || null;
    let deaths = 0;
    let dead = false; // at the death screen: only restart() is allowed
    let over = false; // the game's own victory screen: nothing more is sent
    let index = 0;
    const emit = (event, data) => globalThis.aas?.event?.(event, data);
    const track = (s) => {
      const g = gs(s);
      if (!g || !s.in_game) return;
      if (g.seed !== undefined && g.seed !== null) seed = g.seed;
      if (typeof g.floor === "number" && g.floor !== floor) { floor = g.floor; emit("game.milestone", { label: `Floor ${floor}`, floor, act: g.act, chapter: false }); }
      if (typeof g.act === "number" && act !== null && g.act > act) {
        // The act's boss fell: the split of that end. Whether it is the goal is the harness's decision (its ends list).
        emit("game.milestone", { label: `Act ${act} boss`, split: ALL_SEGMENTS[act - 1] ?? `Act ${act} boss`, end: `act${act}`, act: g.act, floor: g.floor, seed, seed_code: seedString(seed), chapter: true });
      }
      if (typeof g.act === "number") act = g.act;
      if (g.screen_type === "GAME_OVER" && !over && !dead) {
        const victory = Boolean(g.screen_state?.victory);
        if (victory) {
          over = true;
          emit("game.milestone", { label: "Victory", split: act >= 4 ? "Heart" : ALL_SEGMENTS[act - 1], victory: true, floor: g.floor, act, chapter: true });
          // The goal is reached: the harness ends the session on this event.
          emit("game.over", { victory: true, label: "Victory", floor: g.floor, act, deaths, seed, seed_code: seedString(seed), score: g.screen_state?.score ?? null });
        } else {
          // A death ends this run, not the session: the agent restarts from the beginning with the same seed; the session clock keeps running.
          dead = true; deaths += 1;
          emit("game.milestone", { label: `Death ${deaths}`, floor: g.floor, act, deaths, chapter: false });
          emit("game.over", { victory: false, label: "Defeat", floor: g.floor, act, deaths, seed, seed_code: seedString(seed), score: g.screen_state?.score ?? null });
        }
      }
    };
    const bridge = await connectBridge({ onState: track });
    // The Secret Portal (act 3 event, offered when the game's clock is long, always the case for an AI) skips to the
    // act 3 boss and would make runs incomparable: entering it is refused; only leaving is allowed.
    let portalSeen = false;
    const portalGuard = (line) => {
      const g = gs(bridge.last);
      const ss = g?.screen_state;
      if (g?.screen_type !== "EVENT" || !ss || !(ss.event_id === "SecretPortal" || /secret portal/i.test(String(ss.event_name ?? "")))) return;
      if (!portalSeen) { portalSeen = true; emit("game.milestone", { label: "Secret Portal offered (not allowed)", floor: g.floor, act: g.act, chapter: false }); }
      const m = /^CHOOSE\s+(.+)$/i.exec(line.trim());
      if (!m) return;
      const pick = m[1].trim();
      const options = ss.options ?? [];
      const names = Array.isArray(g.choice_list) ? g.choice_list : [];
      const chosen = /^\d+$/.test(pick) ? (names[Number(pick)] ?? options[Number(pick)]?.label ?? options[Number(pick)]?.text ?? pick) : pick;
      const text = `${chosen} ${options.find((o) => String(o.label ?? "").toLowerCase() === String(chosen).toLowerCase())?.text ?? ""}`.toLowerCase();
      if (!/leave/.test(text)) throw new Error(`Secret Portal: entering the portal is not allowed in an AI Assisted Speedrun (it skips the rest of act 3); choose "leave"`);
    };
    const command = async (line, { allowDead = false } = {}) => {
      if (over) throw new Error("the run is over (Victory); no further commands, the session ends");
      if (dead && !allowDead) throw new Error(`you died (death ${deaths}); call sts.restart() for a new run with the same seed`);
      portalGuard(line);
      const i = ++index;
      const started = Date.now();
      emit("game.playback", { phase: "start", index: i, command: line });
      try {
        const s = await bridge.send(line);
        const seconds = Math.round((Date.now() - started)) / 1000;
        emit("game.playback", { phase: "end", index: i, seconds, wall_ms: Date.now() - started, command: line, floor: gs(s)?.floor ?? null, act: gs(s)?.act ?? null, error: s.error ?? null });
        if (s.error) throw new Error(`Slay the Spire refused "${line}": ${s.error}`);
        return s;
      } catch (error) {
        if (!/refused/.test(String(error?.message))) emit("game.playback", { phase: "end", index: i, error: String(error?.message ?? error), wall_ms: Date.now() - started, command: line });
        throw error;
      }
    };
    return {
      state: () => bridge.state(),
      observe: () => bridge.state(),
      command,
      play: (card, target) => command(`PLAY ${card}${target === undefined ? "" : ` ${target}`}`),
      end: () => command("END"),
      potion: (action, slot, target) => command(`POTION ${action} ${slot}${target === undefined ? "" : ` ${target}`}`),
      choose: (x) => command(`CHOOSE ${x}`),
      proceed: () => command("PROCEED"),
      confirm: () => command("CONFIRM"),
      cancel: () => command("CANCEL"),
      skip: () => command("SKIP"),
      leave: () => command("LEAVE"),
      back: () => command("RETURN"),
      key: (name, timeout) => command(`KEY ${name}${timeout === undefined ? "" : ` ${timeout}`}`),
      /** A mouse click in the game's own 1920x1080 space ((0,0) top left), whatever the window resolution. */
      click: (x, y, button = "left") => command(`CLICK ${button} ${x} ${y}`),
      wait: (frames) => command(`WAIT ${frames}`),
      /** After a death: Continue on the death screen (a real click, the mod has no command for it), then START with the same seed. One playback. */
      async restart() {
        if (over) throw new Error("the run is over (Victory)");
        if (!dead) throw new Error("restart() is only for after a death (screen_type GAME_OVER)");
        const i = ++index;
        const started = Date.now();
        emit("game.playback", { phase: "start", index: i, command: "RESTART" });
        try {
          // The mod's PROCEED presses the death screen's return button (clickGameOverReturnButton); a real
          // click at AAS_STS_DEATH_CONTINUE_XY is the fallback when the mod does not offer it.
          const now = await bridge.send("STATE", 10000);
          if ((now.available_commands ?? []).includes("proceed")) {
            const r = await bridge.send("PROCEED", 30000);
            if (r.error) throw new Error(`PROCEED on the death screen refused: ${r.error}`);
          } else {
            const [x, y] = (process.env.AAS_STS_DEATH_CONTINUE_XY || "960,918").split(",").map(Number);
            const clicked = await bridge.click(x, y);
            if (clicked.error) throw new Error(`Continue click failed: ${clicked.error}`);
          }
          let menu = null;
          for (let n = 0; n < 30 && !menu; n += 1) {
            const st = await bridge.send("STATE", 10000).catch(() => null);
            if (st && st.in_game === false) menu = st; else await new Promise((r) => setTimeout(r, 1000));
          }
          if (!menu) throw new Error("the game did not return to the main menu within 30 s after Continue (AAS_STS_DEATH_CONTINUE_XY)");
          const r = await bridge.send(`START ${CLASS} ${ASCENSION}${seed ? ` ${seedString(seed)}` : ""}`);
          if (r.error) throw new Error(`START refused: ${r.error}`);
          const ready = await bridge.until((s) => s.in_game === true && s.ready_for_command, 60000);
          dead = false; floor = null; act = null;
          const seconds = Math.round(Date.now() - started) / 1000;
          // The next run: its own attempt (LiveSplit resets, the timeline gets a new run).
          emit("game.attempt", { phase: "start", attempt: deaths + 1, seed: gs(ready)?.seed ?? seed, seed_code: seedString(gs(ready)?.seed ?? seed), deaths });
          emit("game.milestone", { label: `Attempt ${deaths + 1}`, seed: gs(ready)?.seed ?? seed, deaths, chapter: false });
          emit("game.playback", { phase: "end", index: i, seconds, wall_ms: Date.now() - started, command: "RESTART", floor: gs(ready)?.floor ?? null, act: gs(ready)?.act ?? null, error: null });
          track(ready);
          return ready;
        } catch (error) {
          emit("game.playback", { phase: "end", index: i, error: String(error?.message ?? error), wall_ms: Date.now() - started, command: "RESTART" });
          throw error;
        }
      },
      async screenshot() {
        const r = await bridge.screenshot();
        if (r.error) throw new Error(`screenshot failed: ${r.error}`);
        const url = `data:image/png;base64,${r.png}`;
        globalThis.aas?.emitImage?.(url);
        return { screenshots: [{ url, width: r.width ?? null }] };
      },
      close() { bridge.close(); },
    };
  },

  /** Starts the run for the agent (character, ascension, seed from AAS_STS_*), so that the recording begins at the first choice.
   *  On a resume the game's own save is continued instead (never START, which would replace it). */
  async prepareRun({ log = () => {}, resume = false, runDir = null, seed: wantedSeed = null } = {}) {
    const SEED = wantedSeed || process.env.AAS_STS_SEED || "";
    if (resume) return this.loadState({ log, runDir });
    const bridge = await connectBridge();
    try {
      let s = await bridge.state();
      // A death screen left behind is not a run: leave it (the mod's PROCEED presses its return button) and start fresh.
      if (s.in_game && gs(s)?.screen_type === "GAME_OVER") {
        log(`the game shows a finished run (${gs(s)?.screen_state?.victory ? "victory" : "death"} at floor ${gs(s)?.floor}); leaving it`);
        const r = await bridge.send("PROCEED", 30000);
        if (r.error) throw new Error(`PROCEED on the game-over screen refused: ${r.error}`);
        s = null;
        for (let n = 0; n < 30 && !s; n += 1) { const st = await bridge.send("STATE", 10000).catch(() => null); if (st && st.in_game === false) s = st; else await new Promise((r2) => setTimeout(r2, 1000)); }
        if (!s) throw new Error("the game did not return to the main menu within 30 s after the game-over screen");
      }
      if (s.in_game) { log(`a run is already in progress (floor ${gs(s)?.floor}); continuing it`); return { readyAt: new Date(), seed: gs(s)?.seed ?? null, seed_code: seedString(gs(s)?.seed) || null }; }
      if (!atMainMenu(s)) throw new Error(`not at the main menu: ${JSON.stringify(s).slice(0, 200)}`);
      const started = await bridge.send(`START ${CLASS} ${ASCENSION}${SEED ? ` ${SEED}` : ""}`);
      if (started.error) throw new Error(`START refused: ${started.error}`);
      const ready = await bridge.until((x) => x.in_game === true && x.ready_for_command);
      log(`run started: ${CLASS} ascension ${ASCENSION}, seed ${seedString(gs(ready)?.seed) || "?"} (${gs(ready)?.seed ?? "?"}), floor ${gs(ready)?.floor}`);
      return { readyAt: new Date(), seed: gs(ready)?.seed ?? null, seed_code: seedString(gs(ready)?.seed) || null };
    } finally {
      bridge.close();
    }
  },
  /** The game autosaves after every room; the save is copied with the run as evidence. */
  async saveState({ name }) {
    if (!GAME_ROOT) return { name, file: null };
    const src = join(GAME_ROOT, "saves", `${CLASS}.autosave`);
    if (!existsSync(src)) return { name, file: null };
    const dir = join(GAME_ROOT, "saves", "aas");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.autosave`);
    copyFileSync(src, file);
    return { name, file };
  },
  /** Resume: the game must be running again at the main menu with its autosave; "Continue" is clicked with a real mouse click (coordinates in the game's 1920x1080 space, AAS_STS_CONTINUE_XY). */
  async loadState({ name = null, log = () => {}, runDir = null, seed: wantedSeed = null } = {}) {
    const SEED = wantedSeed || process.env.AAS_STS_SEED || "";
    // The named save (the harness's copy) becomes the game's autosave before Continue is clicked. Without this the
    // game continued whatever autosave it had, which was another run's (a Codex run on the same seed
    // had played on this install in between): the resumed segment played floor 7 of that run instead of act 2 of its own.
    const restored = restoreSave(name, runDir);
    if (restored) log(`save ${name} restored as the game's autosave (floor ${restored.floor ?? "?"})`);
    const verify = (state, how) => {
      const floor = gs(state)?.floor;
      if (restored?.floor != null && typeof floor === "number" && floor !== restored.floor) throw new Error(`the game ${how} at floor ${floor}, but save ${name} is floor ${restored.floor}: not this run's game`);
    };
    const bridge = await connectBridge();
    try {
      const s = await bridge.state();
      if (s.in_game) { verify(s, "is already in a run"); log(`run already in progress (floor ${gs(s)?.floor}, seed ${seedString(gs(s)?.seed)})`); return { readyAt: new Date(), floor: gs(s)?.floor ?? null, seed: gs(s)?.seed ?? null, seed_code: seedString(gs(s)?.seed) || null }; }
      // Died before the session ended: the game deleted its save, so a resume is a new run with the same seed.
      if (GAME_ROOT && !existsSync(join(GAME_ROOT, "saves", `${CLASS}.autosave`)) && atMainMenu(s)) {
        const seed = SEED || lastSeed(runDir);
        const r = await bridge.send(`START ${CLASS} ${ASCENSION}${seed ? ` ${seedString(seed)}` : ""}`);
        if (r.error) throw new Error(`START refused: ${r.error}`);
        const ready = await bridge.until((x) => x.in_game === true && x.ready_for_command, 60000);
        log(`no save to continue (the last attempt ended in a death): new run with seed ${seedString(gs(ready)?.seed ?? seed) || "?"}`);
        return { readyAt: new Date(), floor: gs(ready)?.floor ?? null, seed: gs(ready)?.seed ?? seed ?? null, seed_code: seedString(gs(ready)?.seed ?? seed) || null };
      }
      // The mod accepts only START and STATE at the main menu, so "Continue" is a real click on the window.
      const [x, y] = (process.env.AAS_STS_CONTINUE_XY || "184,610").split(",").map(Number);
      const clicked = await bridge.click(x, y);
      log(`clicked Continue: ${clicked.detail ?? "ok"}`);
      let ready = null;
      for (let i = 0; i < 30 && !ready; i += 1) {
        const st = await bridge.send("STATE", 10000).catch(() => null);
        if (st?.in_game && st.ready_for_command) ready = st;
        else await new Promise((r) => setTimeout(r, 1000));
      }
      if (!ready) throw new Error("the game did not continue the saved run within 30 s after clicking Continue (AAS_STS_CONTINUE_XY)");
      verify(ready, "continued");
      log(`continued at floor ${gs(ready)?.floor}, act ${gs(ready)?.act}, seed ${seedString(gs(ready)?.seed)}`);
      return { readyAt: new Date(), floor: gs(ready)?.floor ?? null, seed: gs(ready)?.seed ?? null, seed_code: seedString(gs(ready)?.seed) || null };
    } finally {
      bridge.close();
    }
  },
  /** The game writes a run-history file (plain JSON: seed, path per floor, its own clock, victory/defeat) when a run ends; copy the ones from this run into <run>/history/ as ground truth (never published). */
  /**
   * Everything someone needs to reproduce this run: the game's own build, the mods with their pins, and the
   * settings of the run itself. The game writes its build, character, ascension and seed into the run-history file
   * when a run ends, and `endRun` copies that file into the run directory, so these are the game's own words.
   */
  async build({ runDir = null } = {}) {
    const upstream = JSON.parse(readFileSync(join(here, "UPSTREAM.json"), "utf8"));
    let played = null;
    try {
      const dir = join(runDir, "history");
      const files = readdirSync(dir).filter((f) => f.endsWith(".run")).sort();
      if (files.length) played = JSON.parse(readFileSync(join(dir, files.at(-1)), "utf8"));
    } catch { /* no history file: the game writes one only when a run ends inside the game */ }
    // No history file (a category that ends before the game does): the game's own autosave carries the same
    // build and seed under its metric_ fields.
    if (!played) {
      try {
        const dir = join(runDir, "saves");
        const file = readdirSync(dir).filter((x) => x.endsWith(".autosave")).sort().at(-1);
        const raw = Buffer.from(readFileSync(join(dir, file), "utf8").trim(), "base64");
        const key = Buffer.from("key");
        const out = Buffer.alloc(raw.length);
        for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] ^ key[i % key.length];
        const save = JSON.parse(out.toString("utf8"));
        played = { build_version: save.metric_build_version ?? null, seed_played: save.metric_seed_played ?? save.seed ?? null, ascension_level: save.ascension_level ?? null, chose_seed: save.seed_set ?? null, character_chosen: save.class_name ?? null };
      } catch { /* no save either */ }
    }
    // The mods that were really loaded: ModTheSpire prints its "Mod list:" into the launch log, and the launcher
    // passes `--mods basemod,CommunicationMod` when there is no log. A jar in <game>/mods that was not in that list
    // (SeedSearch, used only to pick a seed) was not loaded and is not reported. Every ModTheSpire mod carries its
    // id and version in ModTheSpire.json inside its jar, and the jar's sha256 pins the exact file. The loader
    // prints its own version into the same log, because its jar does not carry a usable one.
    const mods = [];
    if (GAME_ROOT) {
      let launchLog = "";
      try { launchLog = readFileSync(join(GAME_ROOT, "aas-launch.log"), "utf8"); } catch { /* no launch log */ }
      const listed = (launchLog.match(/^Mod list:\r?\n((?:\s+- .*\r?\n?)+)/m)?.[1] ?? "").split(/\r?\n/).map((l) => l.match(/^\s+- (\S+)/)?.[1]).filter(Boolean);
      const loaded = new Set((listed.length ? listed : ["basemod", "CommunicationMod"]).map((id) => id.toLowerCase()));
      const modsDir = join(GAME_ROOT, "mods");
      for (const jar of existsSync(modsDir) ? readdirSync(modsDir).filter((x) => x.endsWith(".jar")).sort() : []) {
        const file = join(modsDir, jar);
        let info = null;
        try { info = JSON.parse(readZipEntry(file, "ModTheSpire.json").toString("utf8").replace(/^\uFEFF/, "")); } catch { /* not a ModTheSpire mod */ }
        if (!loaded.has(String(info?.modid ?? "").toLowerCase())) continue;
        const pinned = info?.modid === "CommunicationMod" ? upstream.communication_mod : null;
        mods.push({
          name: info?.name ?? info?.modid ?? jar.replace(/\.jar$/, ""),
          version: info?.version ?? null,
          sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
          source: pinned?.jar ?? `installed in <game>/mods/${jar}`,
        });
      }
      const loader = launchLog.match(/ModTheSpire \(([^)]+)\)/)?.[1] ?? null;
      mods.unshift({ name: "ModTheSpire", version: loader, source: `Steam Workshop ${upstream.modthespire?.workshop_id}` });
    }
    return {
      game: "Slay the Spire",
      version: played?.build_version ? `build ${played.build_version}` : null,
      platform: "Steam",
      mods,
      settings: {
        character: played?.character_chosen ?? CLASS,
        ascension: played?.ascension_level ?? ASCENSION,
        seed: played?.seed_played ? seedString(played.seed_played) : null,
        chose_seed: played?.chose_seed ?? null,
        fast_mode: true,
        profile_name: process.env.AAS_STS_PLAYER_NAME || "AAS",
        display: "windowed 1920x1080",
      },
    };
  },
  /** Read-only checks for `aas doctor` and the GUI: what `npm run sts:install` puts in place, and the Workshop mods the
   *  launcher needs. */
  async doctor() {
    const rows = [];
    const add = (ok, what, detail = "") => rows.push({ ok: Boolean(ok), what, detail });
    add(GAME_ROOT && existsSync(join(GAME_ROOT, "SlayTheSpire.exe")), "Slay the Spire folder", GAME_ROOT ?? "AAS_STS_GAME_ROOT is not set");
    if (!GAME_ROOT) return rows;
    const upstream = JSON.parse(readFileSync(join(here, "UPSTREAM.json"), "utf8")).communication_mod;
    const jar = join(GAME_ROOT, "mods", "CommunicationMod.jar");
    add(existsSync(jar) && createHash("sha256").update(readFileSync(jar)).digest("hex") === upstream.sha256, `Communication Mod ${upstream.version}`, jar);
    add(existsSync(join(GAME_ROOT, "mods", "BaseMod.jar")), "BaseMod", join(GAME_ROOT, "mods", "BaseMod.jar"));
    const workshop = process.env.AAS_STS_WORKSHOP ?? resolve(GAME_ROOT, "..", "..", "workshop", "content", "646570");
    add(existsSync(join(workshop, "1605060445", "ModTheSpire.jar")), "ModTheSpire (Steam Workshop)", join(workshop, "1605060445"));
    const tools = process.env.AAS_STS_TOOLS_DIR ?? join(GAME_ROOT, "aas");
    add(existsSync(join(tools, "bridge.mjs")) && readFileSync(join(tools, "bridge.mjs"), "utf8") === readFileSync(join(here, "bridge.mjs"), "utf8"), "bridge (current copy)", join(tools, "bridge.mjs"));
    // Communication Mod starts the bridge named in its own config (written by install-mod.mjs).
    try {
      const { spawnSync } = await import("node:child_process");
      const local = spawnSync("cmd.exe", ["/c", "echo %LOCALAPPDATA%"], { encoding: "utf8", cwd: "/mnt/c" }).stdout.trim();
      const file = join(spawnSync("wslpath", ["-u", local], { encoding: "utf8" }).stdout.trim(), "ModTheSpire", "CommunicationMod", "config.properties");
      const bridgeWin = spawnSync("wslpath", ["-w", join(tools, "bridge.mjs")], { encoding: "utf8" }).stdout.trim();
      const command = (readFileSync(file, "utf8").match(/^command=(.*)$/m)?.[1] ?? "").replace(/\\(.)/g, "$1");
      add(command.includes(bridgeWin), "Communication Mod starts this bridge", command || file);
    } catch (e) { add(false, "Communication Mod config", e.message); }
    return rows;
  },
  /** Closes the game and undoes the launcher's set-up; the harness calls this when a run ends. */
  async close({ log = () => {} } = {}) {
    const { closeGame } = await import("./close-game.mjs");
    return closeGame({ log });
  },
  async endRun({ runDir } = {}) {
    if (!runDir || !GAME_ROOT) return [];
    const dir = join(GAME_ROOT, "runs", CLASS);
    if (!existsSync(dir)) return [];
    const since = (() => { try { return new Date(JSON.parse(readFileSync(join(runDir, "run.jsonl"), "utf8").split("\n")[0]).timestamp).getTime(); } catch { return 0; } })();
    const copied = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".run"))) {
      if (statSync(join(dir, f)).mtimeMs < since) continue;
      mkdirSync(join(runDir, "history"), { recursive: true });
      copyFileSync(join(dir, f), join(runDir, "history", f));
      copied.push(f);
    }
    return copied;
  },
  exercise: [
    { label: "state", code: "const s = await sts.state(); return { in_game: s.in_game, commands: s.available_commands };" },
  ],
};
