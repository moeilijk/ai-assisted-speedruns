// A scripted Ironclad for the "scripted" runtime: the baseline that must win the reference
// seed (seed-criteria.md, criterion 9) and the end-to-end test of the chain (victory ->
// game.over -> completed -> publish). Deterministic on a fixed seed. Plain heuristics only:
// block what is coming, kill what attacks, take a short list of good cards, rest when hurt,
// avoid elites on the map, leave events and the Secret Portal alone.
export const GOOD_CARDS = ["Bludgeon", "Carnage", "Whirlwind", "Immolate", "Inflame", "Feel No Pain", "Shrug It Off", "Pommel Strike", "Uppercut", "Cleave", "Thunderclap", "Iron Wave", "Battle Trance", "Impervious", "Flame Barrier", "Metallicize", "Demon Form", "Disarm", "Twin Strike", "Headbutt", "Clothesline"];
export const BOSS_RELICS = ["Black Star", "Astrolabe", "Runic Cube", "Tiny House", "Calling Bell", "Empty Cage", "Fusion Hammer", "Mark of Pain"];
// Second choice: harmless for a bot that rests, blocks and reads intents. Everything else (Runic Dome hides intents,
// Snecko Eye randomises costs, Velvet Choker / Busted Crown / Philosopher's Stone / Cursed Key / Coffee Dripper / Sozu hurt this play) is skipped.
export const GOOD_RELICS = ["Bag of Marbles", "Vajra", "Anchor", "Red Skull", "Bronze Scales", "Oddly Smooth Stone", "Blood Vial", "Lantern", "Orichalcum", "Strawberry", "Pear", "Mango", "Bag of Preparation", "Horn Cleat", "Meat on the Bone", "Kunai", "Shuriken", "Ornamental Fan", "Letter Opener", "Pen Nib", "Paper Frog", "Self-Forming Clay", "Torii", "Tungsten Rod", "Girya"];
export const BOSS_RELICS_OK = ["Sacred Bark", "Ectoplasm", "Slaver's Collar", "Pandora's Box"];
const BLOCK = { Defend: 5, "Shrug It Off": 8, "Iron Wave": 5, "Flame Barrier": 12, Impervious: 30, "Ghostly Armor": 10, "Power Through": 15, Sentinel: 5, "True Grit": 7, "Second Wind": 5, Entrench: 10, Metallicize: 0, "Body Slam": 0 };
const DAMAGE = { Strike: 6, Bash: 8, "Pommel Strike": 9, "Twin Strike": 10, Clothesline: 12, Cleave: 8, Thunderclap: 4, "Iron Wave": 5, Uppercut: 13, Carnage: 20, Bludgeon: 32, Whirlwind: 15, Immolate: 21, "Heavy Blade": 14, Headbutt: 9, "Sword Boomerang": 9, Anger: 6, "Perfected Strike": 8, "Wild Strike": 12, "Reckless Charge": 7, Hemokinesis: 15, Dropkick: 5, Clash: 14, Rampage: 8, "Sever Soul": 16, Pummel: 8, Feed: 10, Reaper: 4, "Fiend Fire": 7 };
const AOE = new Set(["Cleave", "Thunderclap", "Whirlwind", "Immolate", "Reaper"]);
const HITS = { "Twin Strike": 2, "Sword Boomerang": 3, Pummel: 4 };
const APPLIES_VULN = new Set(["Bash", "Thunderclap", "Uppercut"]);
const APPLIES_WEAK = new Set(["Clothesline", "Uppercut", "Disarm", "Intimidate"]);
const STRENGTH = { Inflame: 2, "Inflame+": 3, Flex: 2, "Flex+": 4, "Spot Weakness": 3 };
const DRAW = { "Pommel Strike": 1, "Shrug It Off": 1, "Battle Trance": 3 };
const POWERS_FIRST = ["Inflame", "Feel No Pain", "Metallicize", "Demon Form", "Barricade", "Juggernaut", "Rupture", "Combust"];
const BAD_TO_PLAY = new Set(["Bloodletting", "Combust", "Havoc", "Warcry", "Seeing Red", "Burning Pact", "Second Wind", "Exhume", "Dual Wield", "Infernal Blade", "Limit Break", "Berserk", "Brutality", "Corruption", "Dark Embrace", "Evolve", "Fire Breathing", "Rage", "Spot Weakness", "Intimidate"]);
const base = (name) => String(name ?? "").replace(/\+\d*$/, "");
const GOOD_LOWER = GOOD_CARDS.map((x) => x.toLowerCase());
const rank = (name) => { const i = GOOD_LOWER.indexOf(base(name).toLowerCase()); return i === -1 ? GOOD_CARDS.length : i; };

import { loadTape, tapeMatches } from "./tape.mjs";
import { checkRoom } from "./conformance.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The combat oracle: gamerpuppy's sts_lightspeed (`test mcts_save <autosave> <simulations>`), an RNG-accurate
 * simulator that loads the game's own autosave (written when the room is entered) and searches the best line for
 * the whole fight. Its printed actions are mapped onto Communication Mod commands and verified against the live
 * hand before every play; on any mismatch the bot falls back to its own turn planner.
 */
export function createLightspeedOracle({ bin = process.env.AAS_BOT_ORACLE, save = process.env.AAS_STS_GAME_ROOT ? path.join(process.env.AAS_STS_GAME_ROOT, "saves", `${(process.env.AAS_STS_CLASS || "IRONCLAD").toUpperCase()}.autosave`) : null, simulations = Number(process.env.AAS_BOT_ORACLE_SIMS) || 200000 } = {}) {
  if (!bin || !save) return null;
  return {
    /** The autosave as the game wrote it (floor, room, post_combat), to check it belongs to this fight. */
    saveInfo() {
      try {
        const raw = fs.readFileSync(save);
        const bytes = Buffer.from(raw.toString("utf8").trim(), "base64");
        const key = Buffer.from("key");
        const d = JSON.parse(Buffer.from(bytes.map((b, i) => b ^ key[i % 3])).toString("utf8"));
        return { floor: d.floor_num, room: String(d.current_room ?? "").split(".").pop(), postCombat: d.post_combat === true, hp: d.current_health };
      } catch { return null; }
    },
    run({ steps = simulations, keep = null } = {}) {
      const tmp = path.join(os.tmpdir(), `aas-oracle-${process.pid}.autosave`);
      fs.copyFileSync(save, tmp);
      if (keep) { try { fs.mkdirSync(path.dirname(keep), { recursive: true }); fs.copyFileSync(save, keep); } catch { /* evidence only */ } }
      const r = spawnSync(bin, ["mcts_save", tmp, String(steps)], { encoding: "utf8", timeout: 300000 });
      fs.rmSync(tmp, { force: true });
      if (r.status !== 0) throw new Error(`oracle failed: ${(r.stderr || r.stdout || "").slice(0, 200)}`);
      return r.stdout;
    },
  };
}
/** Parse the searcher's best action lines: `{ use card (1) (Carnage+,9,2,2) -> (0) SPHERIC_GUARDIAN }`, `{ end turn }`, `{ drink potion (0) Flex Potion -> (1) CULTIST }`.
 * A card prints as (name[+], uniqueId, cost, costForTurn, ...) (sts_lightspeed CardInstance::operator<<), and
 * costForTurn is what the card costs right now: Liquid Memories and Madness make a copy in hand cost 0 while an
 * identical card next to it still costs its price. Matching on the name alone then plays the wrong one. */
export function parseOracle(text) {
  const out = { actions: [], endingHp: null, value: null };
  for (const line of text.split("\n")) {
    let m;
    if ((m = /^\{ use card \((\d+)\) \(([^,]+),(\d+),(\d+),(-?\d+)[^)]*\)(?: -> \((\d+)\) (\S+))? \}/.exec(line))) out.actions.push({ type: "card", index: Number(m[1]), name: m[2], cost: Number(m[5]), target: m[6] === undefined ? null : Number(m[6]), targetName: m[7] ?? null });
    else if ((m = /^\{ (drink|discard) potion \((\d+)\) ([^}>]+?)(?: -> \((\d+)\) (\S+))? \}/.exec(line))) out.actions.push({ type: "potion", use: m[1] === "drink", index: Number(m[2]), name: m[3].trim(), target: m[4] === undefined ? null : Number(m[4]), targetName: m[5] ?? null });
    else if (/^\{ end turn \}/.test(line)) out.actions.push({ type: "end" });
    else if ((m = /^\{ ([A-Z_]+) none \}/.exec(line))) out.actions.push({ type: "select", task: m[1], cards: [] });
    else if ((m = /^\{ ([A-Z_]+) \((\d+)\) ((?:hand|discard|draw|exhaust)=.*)\}/.exec(line))) {
      // "{ HEADBUTT (1) hand=Defend+ discard=Defend+ draw=Thunderclap+ }": the card at that index in each pile (INVALID = out of range)
      const piles = {}; for (const pm of m[3].matchAll(/(hand|discard|draw|exhaust)=(.*?)(?= (?:hand|discard|draw|exhaust)=|\s*$)/g)) if (pm[2] && pm[2] !== "INVALID") piles[pm[1]] = pm[2].trim();
      out.actions.push({ type: "select", task: m[1], index: Number(m[2]), piles });
    } else if ((m = /^\{ ([A-Z_]+)((?: \(\d+\) [^,}]+,?)+) \}/.exec(line))) {
      // "{ GAMBLE (1) Strike, (2) Defend }"
      const cards = [...m[2].matchAll(/\((\d+)\) ([^,}]+)/g)].map((cm) => ({ index: Number(cm[1]), name: cm[2].trim() }));
      out.actions.push({ type: "select", task: m[1], cards });
    }
    else if ((m = /^ending hp: (\d+)/.exec(line))) out.endingHp = Number(m[1]);
    else if ((m = /^best search value: (-?\d+)/.exec(line))) out.value = Number(m[1]);
    else if (/^\{ /.test(line)) out.actions.push({ type: "other", text: line });
  }
  return out;
}
const norm = (n) => String(n ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""); // "Gambler's Brew" == "Gamblers Brew", "Two Louse" == "TWO_LOUSE"
/** A whole-run line from the aas planner (lightspeed/aas.cpp): one JSON object per decision, battles included. */
export function loadLine(file) {
  // A line that does not parse is refused, never skipped: a dropped line is a decision the game still asks for,
  // and the plan would silently replay one step out of phase from there on.
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`${file}: line ${i + 1} is not valid JSON (${e.message}): ${l.slice(0, 120)}`); }
  }).filter((x) => x && x.screen);
}

/**
 * options.tape: a recorded command list (tape.mjs) or a path to one (AAS_BOT_TAPE). Replayed verbatim
 * while the game shows what the tape expects; from the first mismatch or the tape's end the heuristics decide.
 */
/** The expert card ratings of sts_lightspeed (expert-weights.json, generated from its ExpertKnowledge.cpp).
 * Upgraded counts 1.5 times, as in the simulator; a card that is not in the table is rated 0, as there. */
const EXPERT = JSON.parse(fs.readFileSync(new URL("./expert-weights.json", import.meta.url), "utf8"));
/** The mod names an event the way the save files do ("Mushrooms"); the simulator wants its own enum index. */
const EVENT_IDS = JSON.parse(fs.readFileSync(new URL("./event-names.json", import.meta.url), "utf8"));
export function expertWeight(name, upgrades = 0) {
  const plain = String(name ?? "").replace(/\+\d*$/, "").trim();
  const upgraded = upgrades > 0 || /\+\d*$/.test(String(name ?? ""));
  const key = Object.keys(EXPERT).find((k) => k.toLowerCase() === plain.toLowerCase());
  const w = key ? EXPERT[key] : 0;
  return upgraded ? w * 1.5 : w;
}

export function createBot({ log = () => {}, tape = process.env.AAS_BOT_TAPE || null, oracle = createLightspeedOracle(), runDir = process.env.AAS_RUN_DIR || null, line = process.env.AAS_BOT_LINE || null } = {}) {
  let queue = null; // oracle actions for the current fight, { floor, actions, pos }
  // The planner's line: followed step by step while the game shows what the line expects; a mismatch switches it off
  // for good (the heuristics and the live oracle continue). Battles come from the line first, the live oracle second.
  let lineSteps = typeof line === "string" ? loadLine(line) : Array.isArray(line) ? line : [];
  let linePos = 0, lineOn = lineSteps.length > 0;
  if (lineOn) log(`line: ${lineSteps.length} planned decisions to follow`);

  // Per room planning (AAS_BOT_ROOM=1). The fourteen RNG streams each carry a counter of how far they have been
  // drawn and those counters live only in the game's own save, which the game writes when a room is entered.
  // So instead of playing a whole run computed up front, the simulator is asked for this room and this room only
  // (`aas room`), from that save. Nothing the simulator assumes can then survive longer than a single room, and a
  // difference in one room cannot drift into the next. The steps it returns are the same shape as a whole-run
  // plan, so everything below reads them unchanged.
  const roomPlanning = process.env.AAS_BOT_ROOM === "1";
  const aasBin = process.env.AAS_BOT_ORACLE ? path.join(path.dirname(process.env.AAS_BOT_ORACLE), "aas") : null;
  const saveFile = process.env.AAS_STS_GAME_ROOT
    ? path.join(process.env.AAS_STS_GAME_ROOT, "saves", `${(process.env.AAS_STS_CLASS || "IRONCLAD").toUpperCase()}.autosave`)
    : null;
  let plannedFloor = -1;

  /** The game's autosave is base64 with a one byte repeating XOR ("key"); this reads the floor it describes. */
  function saveFloor(file) {
    try {
      const raw = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
      const key = Buffer.from("key");
      const out = Buffer.alloc(raw.length);
      for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] ^ key[i % key.length];
      return JSON.parse(out.toString("utf8")).floor_num ?? null;
    } catch {
      return null;
    }
  }

  /** The game writes its autosave when a room is entered, but the mod reports the new state first. Planning from a
   *  save that still describes the previous room silently plans the wrong floor (, measured: the simulator
   *  said floor 6 while the game was on 7), so the file has to catch up before it is read. */
  function waitForSave(file, floor, waitMs = 5000) {
    const deadline = Date.now() + waitMs;
    const shared = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      if (saveFloor(file) === floor) return true;
      if (Date.now() >= deadline) return false;
      Atomics.wait(shared, 0, 0, 100);
    }
  }

  function planRoom(g) {
    const floor = g?.floor;
    if (!roomPlanning || typeof floor !== "number" || floor === plannedFloor) return false;
    if (!aasBin || !saveFile || !fs.existsSync(aasBin) || !fs.existsSync(saveFile)) return false;
    if (!waitForSave(saveFile, floor)) {
      broken = `the game's save still describes floor ${saveFloor(saveFile)} while the run is on floor ${floor}`;
      log(`room: ${broken}`);
      return false;
    }
    const sims = Number(process.env.AAS_BOT_ROOM_SIMS) || Number(process.env.AAS_BOT_ORACLE_SIMS) || 50000;
    let copy = saveFile;
    if (runDir) {
      const dir = path.join(runDir, "rooms");
      fs.mkdirSync(dir, { recursive: true });
      copy = path.join(dir, `floor-${String(floor).padStart(2, "0")}.autosave`);
      fs.copyFileSync(saveFile, copy);
    }
    // The event the game is showing is handed over instead of rolled: the save's event counter already stands
    // past the roll the game made on entering the room.
    const shown = g.screen_type === "EVENT" ? (g.screen_state?.event_name ?? "") : "";
    const eventId = shown && EVENT_IDS[shown] !== undefined ? String(EVENT_IDS[shown]) : "0";
    if (shown && eventId === "0") log(`room: floor ${floor}: the game calls this event "${shown}", which the simulator does not know by that name`);
    // The agent's own rng decides its weighted card picks. Handing it the same seed for every room made it draw the
    // same quantile at every card reward, which skews a whole run's draft one way; the floor keeps it deterministic
    // and still varied, the way a single whole-run playout advances that stream.
    const r = spawnSync(aasBin, ["room", copy, String(sims), String(floor), eventId], { encoding: "utf8", maxBuffer: 1 << 24, timeout: 300000 });
    if (r.status !== 0 || !r.stdout) {
      broken = `the simulator cannot plan floor ${floor}: ${(r.stderr || "").split("\n")[0] || `exit ${r.status}`}`;
      log(`room: ${broken}`);
      return false;
    }
    const rows = r.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const steps = rows.filter((x) => x && x.screen);
    plannedFloor = floor;
    lineSteps = steps;
    linePos = 0;
    lineOn = steps.length > 0;
    const end = rows.find((x) => x && x.endOfRoom);
    log(`room: floor ${floor} planned, ${steps.length} decisions${end ? `, ends at floor ${end.floor} hp ${end.hp} gold ${end.gold}` : ""}`);
    return lineOn;
  }
  // A plan is binding (AAS_BOT_STRICT, default on when a plan is given): the first mismatch ends the session with a
  // diagnosis instead of improvising, so the translation between simulator and game gets fixed and replayed.
  const strict = (lineSteps.length > 0 || roomPlanning) && process.env.AAS_BOT_STRICT !== "0";
  let broken = null;
  const lineOff = (why) => {
    if (!lineOn) return;
    lineOn = false;
    if (strict) { broken = `plan broken at step ${linePos + 1}: ${why}`; log(`line: ${broken}; stopping (strict)`); }
    else log(`line: off at step ${linePos + 1} (${why}); deciding live from here`);
  };
  // The plan records the state it saw before every battle action (hp, turn, energy). Those are kept next to the
  // actions so the replay can check that the game is still in the same run, instead of only checking that the card
  // it wants happens to be in hand.
  const lineBattle = (floor) => { const out = [], rows = []; let i = linePos; while (i < lineSteps.length && (lineSteps[i].screen === "BATTLE" || lineSteps[i].screen === "BATTLE_END") && lineSteps[i].floor === floor) { if (lineSteps[i].screen === "BATTLE") { out.push(lineSteps[i].desc); rows.push(lineSteps[i]); } i += 1; } return { descs: out, rows, next: i }; };
  const tapeSteps = typeof tape === "string" ? loadTape(tape) : Array.isArray(tape) ? tape : [];
  let tapePos = 0, tapeLive = tapeSteps.length > 0;
  if (tapeLive) log(`tape: ${tapeSteps.length} recorded commands to replay first`);
  let state = null;
  let errors = 0;
  let turnPlays = 0, lastTurnKey = "";
  let skippedCardAt = null; // floor where a card reward was skipped: the reward stays listed, do not open it again
  const recent = []; // loop guard: the same screen with the same choices too often within the last 20 decisions -> leave it
  let bossSkippedAt = null;
  const shopVisited = new Set(); // floors whose shop was entered once
  const bought = new Set();
  const gridDone = new Set(); // floors where the removal grid was answered // "floor:item" bought or purged, so a refused purchase is not retried // floor where the boss relics were all skipped: leave the chest instead of reopening it
  const cmd = (code, note) => ({ code, note });
  const stateCall = () => cmd("return await sts.state()", "state");
  // A death is not the end of the session (no ironman): the plugin's own restart() starts a new run on the same
  // seed, the session clock keeps running and LiveSplit resets. Everything the bot remembers is per run, so it is
  // cleared here; a plan is replayed from its first step. The session stays bounded by the run's tool-call budget.
  let attempt = 1;
  function newAttempt(why) {
    attempt += 1;
    log(`${why}: restarting on the same seed (attempt ${attempt})`);
    queue = null;
    if (lineOn) linePos = 0;
    recent.length = 0;
    skippedCardAt = null;
    bossSkippedAt = null;
    shopVisited.clear();
    bought.clear();
    gridDone.clear();
    turnPlays = 0;
    lastTurnKey = "";
    return cmd("return await sts.restart()", `restart: attempt ${attempt}, same seed`);
  }

  // Once per floor the room the game is showing is held against the room the simulator builds from the game's own
  // autosave (conformance.mjs). It changes no decision; it records whether the two still describe the same game.
  let conformanceFloor = -1;
  function conformance(g) {
    if (process.env.AAS_STS_CONFORMANCE !== "1") return;
    const floor = g?.floor;
    if (typeof floor !== "number" || floor === conformanceFloor || g.combat_state) return;
    if (!["EVENT", "SHOP_SCREEN", "BOSS_REWARD", "CHEST", "REST", "MAP", "COMBAT_REWARD"].includes(g.screen_type)) return;
    conformanceFloor = floor;
    const root = process.env.AAS_STS_GAME_ROOT;
    const cls = (process.env.AAS_STS_CLASS || "IRONCLAD").toUpperCase();
    try {
      if (!waitForSave(root ? path.join(root, "saves", `${cls}.autosave`) : "", floor, 3000)) {
        log(`conformance floor ${floor}: the save has not caught up, skipped`);
        return;
      }
      const r = checkRoom(g, {
        bin: process.env.AAS_BOT_ORACLE ? path.join(path.dirname(process.env.AAS_BOT_ORACLE), "aas") : null,
        save: root ? path.join(root, "saves", `${cls}.autosave`) : null,
        outDir: runDir ? path.join(runDir, "rooms") : null,
        log,
      });
      if (r && runDir) fs.appendFileSync(path.join(runDir, "conformance.jsonl"), JSON.stringify(r) + "\n");
    } catch (e) {
      log(`conformance floor ${floor}: check failed (${e.message})`);
    }
  }

  function decide(s) {
    const g = s.game_state ?? {};
    const c = s.available_commands ?? [];
    const names = (g.choice_list ?? []).map((x) => String(x).toLowerCase());
    if (!s.in_game) return null;
    conformance(g);
    if (g.screen_type === "GAME_OVER") {
      const victory = g.screen_state?.victory === true;
      log(`game over: ${victory ? "victory" : "defeat"} at floor ${g.floor}`);
      if (victory) return null;
      // A death while following a plan means the plan is not valid on this game: replaying it from the start would
      // repeat the same loss, so the session ends with a diagnosis. Without a plan a death is not the end of the
      // session (no ironman): restart on the same seed and keep playing.
      if (lineSteps.length) { broken = `died at floor ${g.floor} on step ${linePos + 1} of the plan`; log(`line: ${broken}; stopping`); return null; }
      return newAttempt("defeat");
    }
    if (roomPlanning && !g.combat_state && !broken && (linePos >= lineSteps.length || g.floor !== plannedFloor)) {
      planRoom(g);
    }
    if (lineOn && !g.combat_state) {
      const step = lineStep(g, c, names);
      if (step) return step;
      if (broken) return null;
      // lineStep handles the screens the plan lists and the few it deliberately does not (confirm a grid, leave an
      // event). Anything else means the game is somewhere the plan never went. Under a binding plan that ends the
      // session, so the difference gets fixed rather than hidden; with AAS_BOT_STRICT=0 the run carries on with the
      // heuristics, which is what a measuring run wants: every later room is still compared against the game.
      lineOff(`no plan step for ${g.screen_type} at floor ${g.floor} (choices: ${names.join(", ") || "none"})`);
      if (strict) return null;
    }
    const cs = g.combat_state;
    // In combat "play" disappears from the commands when no card is playable (no energy); the turn still has to be
    // ended here, by the oracle's line or the planner, never by the generic branch below.
    if (cs && (c.includes("play") || c.includes("end") || g.screen_type === "HAND_SELECT" || g.screen_type === "GRID")) return combat(g, cs, c);
    if (g.screen_type === "EVENT") return event(g, names, c);
    if (g.screen_type === "MAP" && c.includes("choose")) return map(g, names);
    // Loop guard: the same screen with the same choices more than six times in a row -> leave it.
    const key = `${g.screen_type}|${g.floor}|${names.join(",")}`;
    recent.push(key); if (recent.length > 20) recent.shift();
    if (recent.filter((k) => k === key).length > 6) {
      if (c.includes("proceed")) return cmd("return await sts.proceed()", `loop guard: proceed ${g.screen_type}`);
      if (c.includes("skip")) return cmd("return await sts.skip()", `loop guard: skip ${g.screen_type}`);
      if (c.includes("cancel")) return cmd("return await sts.cancel()", `loop guard: cancel ${g.screen_type}`);
    }
    if (g.screen_type === "CARD_REWARD" && c.includes("choose")) {
      // The card reward is decided by the ratings the simulator drafts with (expert-weights.json, read out of
      // sts_lightspeed's ExpertKnowledge.cpp) and by its own rule: weight^1.2, attacks count 1.4 times in act 1,
      // take the best card when it beats 0.6 times the average rating of the deck, otherwise skip. The simulator
      // rolls that comparison at random; the bot takes the likelier side of it, so the same drafting without dice.
      const cards = g.screen_state?.cards ?? [];
      const weigh = (name, type) => {
        const w = expertWeight(name);
        const scaled = Math.pow(w, 1.2);
        return (g.act ?? 1) === 1 && String(type ?? "").toUpperCase() === "ATTACK" ? scaled * 1.4 : scaled;
      };
      const deck = g.deck ?? [];
      const deckWeight = deck.length ? deck.reduce((sum, card) => sum + expertWeight(card.name, card.upgrades), 0) / deck.length : 0;
      const offered = names.map((n, k) => ({ n, k, w: weigh(n, cards[k]?.type) }));
      const best = offered.slice().sort((a, b) => b.w - a.w)[0];
      if (best && best.w > deckWeight * 0.6) return cmd(`return await sts.choose(${best.k})`, `card ${best.n} (rating ${best.w.toFixed(0)} against deck ${(deckWeight * 0.6).toFixed(0)})`);
      skippedCardAt = g.floor ?? null;
      const why = best ? `best is ${best.n} at ${best.w.toFixed(0)}, deck asks ${(deckWeight * 0.6).toFixed(0)}` : "nothing offered";
      if (c.includes("skip")) return cmd("return await sts.skip()", `skip card (${why})`);
      if (c.includes("proceed")) return cmd("return await sts.proceed()", `proceed, no card (${why})`);
      return cmd(`return await sts.choose(${best?.k ?? 0})`, `card ${best?.n ?? names[0]}`);
    }
    if (g.screen_type === "COMBAT_REWARD" && c.includes("choose") && names.length) {
      const potionsFull = (g.potions ?? []).every((p) => p?.id && p.id !== "Potion Slot");
      // A skipped card reward stays in the list; potions with full slots too: take what is left, then proceed.
      const k = names.findIndex((n) => !(potionsFull && /potion/.test(n)) && !(skippedCardAt === (g.floor ?? null) && /card/.test(n)));
      if (k >= 0) return cmd(`return await sts.choose(${k})`, `reward ${names[k]}`);
      if (c.includes("proceed")) return cmd("return await sts.proceed()", "rewards done");
    }
    if (g.screen_type === "BOSS_REWARD" && c.includes("choose")) {
      const pick = [...BOSS_RELICS, ...BOSS_RELICS_OK].map((r) => names.indexOf(r.toLowerCase())).find((k) => k >= 0);
      if (pick !== undefined) return cmd(`return await sts.choose(${pick})`, `boss relic ${names[pick]}`);
      bossSkippedAt = g.floor ?? null;
      if (c.includes("skip")) return cmd("return await sts.skip()", "skip boss relics (none acceptable)");
    }
    if (g.screen_type === "CHEST" && c.includes("proceed") && bossSkippedAt === (g.floor ?? null)) return cmd("return await sts.proceed()", "leave the chest (relics skipped)");
    if (g.screen_type === "REST" && c.includes("choose")) {
      const hp = (g.current_hp ?? 0) / (g.max_hp || 1);
      const want = hp < 0.65 ? "rest" : "smith";
      const k = names.indexOf(want) >= 0 ? names.indexOf(want) : names.indexOf("rest");
      return cmd(`return await sts.choose(${k >= 0 ? k : 0})`, `rest site: ${names[k >= 0 ? k : 0]}`);
    }
    if (g.screen_type === "GRID" && names.length) {
      // Grid screens (Communication Mod flags): for_purge / for_transform remove Strikes and Defends first; for_upgrade and
      // pick screens take the best card by our list (not already upgraded). Multi-card grids: select num_cards distinct
      // cards (choosing a selected card again would deselect it), then confirm.
      const ss = g.screen_state ?? {};
      const selected = (ss.selected_cards ?? []).map((x) => String(x.name ?? "").toLowerCase());
      const need = Number(ss.num_cards) || 1;
      if (selected.length >= need && c.includes("confirm")) return cmd("return await sts.confirm()", `grid confirm (${selected.join(", ")})`);
      const removal = ss.for_purge === true || ss.for_transform === true || bought.has(`${g.floor}:purge`) && !gridDone.has(g.floor);
      const taken = new Set(); for (const n of selected) taken.add(n);
      const order = removal
        ? names.map((n, k) => ({ n, k, r: n === "strike" ? 0 : n === "defend" ? 1 : /curse|ascender|clumsy|decay|doubt|injury|normality|pain|parasite|regret|shame|writhe|necronomicurse/.test(n) ? -1 : 5 + rank(n) })).sort((a, b) => a.r - b.r)
        : names.map((n, k) => ({ n, k, r: rank(n) + (/\+\d*$/.test(n) ? 100 : 0) })).sort((a, b) => a.r - b.r);
      const pick = order.find((o) => { if (taken.has(o.n)) { taken.delete(o.n); return false; } return true; }) ?? order[0];
      if (!c.includes("choose")) { if (c.includes("confirm")) return cmd("return await sts.confirm()", "grid confirm"); if (c.includes("cancel")) return cmd("return await sts.cancel()", "grid cancel"); }
      if (removal) gridDone.add(g.floor);
      return cmd(`return await sts.choose(${pick.k})`, `grid ${removal ? "remove" : "pick"} ${pick.n}`);
    }
    if (g.screen_type === "HAND_SELECT" && c.includes("choose") && names.length) return cmd("return await sts.choose(0)", "hand select 0");
    if (g.screen_type === "SHOP_ROOM" && c.includes("choose") && names.includes("shop") && (g.gold ?? 0) >= 50 && !shopVisited.has(g.floor)) { shopVisited.add(g.floor); return cmd(`return await sts.choose(${names.indexOf("shop")})`, "enter shop"); }
    if (g.screen_type === "SHOP_ROOM" && c.includes("proceed")) return cmd("return await sts.proceed()", "leave shop room");
    if (g.screen_type === "SHOP_SCREEN") return shop(g, names, c);
    if (g.screen_type === "CHEST" && c.includes("choose")) return cmd("return await sts.choose(0)", "open chest");
    if (c.includes("proceed")) return cmd("return await sts.proceed()", `proceed ${g.screen_type}`);
    if (c.includes("confirm")) return cmd("return await sts.confirm()", `confirm ${g.screen_type}`);
    if (c.includes("choose") && names.length) return cmd("return await sts.choose(0)", `choose 0 ${g.screen_type}`);
    if (c.includes("end")) return cmd("return await sts.end()", "end");
    if (c.includes("cancel")) return cmd("return await sts.cancel()", `cancel ${g.screen_type}`);
    return cmd("return await sts.wait(30)", `wait ${g.screen_type}`);
  }

  /** One decision from the planner's line for the current screen, or null (line off / nothing to do here). */
  function lineStep(g, c, names) {
    const t = lineSteps[linePos];
    if (!t) { lineOff("end of the plan"); return null; }
    const st = g.screen_type;
    const advance = (code, note) => { linePos += 1; return cmd(code, `line ${linePos}/${lineSteps.length}: ${note}`); };
    // Names as the game lists them may differ from the simulator's ("boot" vs "The Boot"): compare without punctuation and case,
    // and accept a leading article dropped on either side.
    const same = (a, b) => { const x = norm(a), y = norm(b); return x === y || (x.startsWith("THE") && x.slice(3) === y) || (y.startsWith("THE") && y.slice(3) === x); };
    const pick = (name, ordinal = 0) => { let seen = 0; for (let k = 0; k < names.length; k += 1) if (same(names[k], name)) { if (seen === ordinal) return k; seen += 1; } return -1; };
    // Screens that are not decisions. An event can put one option in front of the player that only continues:
    // Neow's "talk" before the blessings, the "fight" that starts an event's battle, the "leave" that closes one.
    // The simulator counts none of these as a step, so pressing them must not spend one either. Handled as a class
    // rather than screen by screen: a lone option is never a choice, and when the plan really does want this event
    // option the switch below takes it first.
    if (st === "EVENT" && names.length === 1 && c.includes("choose")) {
      const planWantsThisScreen = t.screen === "EVENT" && t.floor === g.floor
        && (Number(t.option) === 0 || (t.label && same(names[0], String(t.label))));
      if (!planWantsThisScreen) return cmd("return await sts.choose(0)", `line: event "${names[0]}" is not a decision`);
    }
    if (t.screen === "BATTLE" || t.screen === "BATTLE_END") { if (st === "COMBAT_REWARD" || st === "MAP") { /* the fight is over already (line's battle skipped) */ while (lineSteps[linePos] && (lineSteps[linePos].screen === "BATTLE" || lineSteps[linePos].screen === "BATTLE_END")) linePos += 1; return lineStep(g, c, names); } return null; }
    if (typeof t.floor === "number" && t.floor !== g.floor && !(t.screen === "MAP" && t.floor === (g.floor ?? 0))) { lineOff(`floor ${g.floor} on ${st}, plan expects floor ${t.floor} ${t.screen}`); return null; }
    // Screens that need a step the plan does not list.
    if (st === "GRID" && c.includes("confirm") && !c.includes("choose")) return cmd("return await sts.confirm()", "line: confirm grid");
    if (st === "GRID" && (g.screen_state?.selected_cards ?? []).length >= (Number(g.screen_state?.num_cards) || 1) && c.includes("confirm")) return cmd("return await sts.confirm()", "line: confirm grid");
    if (st === "CHEST" && t.screen === "BOSS_RELIC" && c.includes("choose")) return cmd("return await sts.choose(0)", "line: open the boss chest");
    if (st === "COMBAT_REWARD" && t.screen === "MAP" && c.includes("proceed")) return cmd("return await sts.proceed()", "line: rewards done");
    if (t.screen === "MAP" && st !== "MAP" && (!names.length || st === "SHOP_ROOM" || st === "CHEST") && c.includes("proceed")) return cmd("return await sts.proceed()", `line: proceed from ${st}`);
    if (st === "SHOP_ROOM" && t.screen === "SHOP" && t.kind !== "leave" && names.includes("shop")) return cmd(`return await sts.choose(${names.indexOf("shop")})`, "line: enter shop");
    if (st === "SHOP_ROOM" && t.screen === "SHOP" && t.kind === "leave" && c.includes("proceed")) { linePos += 1; return cmd("return await sts.proceed()", `line ${linePos}/${lineSteps.length}: leave shop`); }
    switch (t.screen) {
      case "EVENT": {
        if (st !== "EVENT") break;
        const opts = g.screen_state?.options ?? [];
        // The simulator numbers an event's options in its own action space, not the game's: Golden Idol's "Hide" is
        // option 4 there and choice 2 in the game. The label the plan records is the identity of the choice, so it
        // decides; the index only serves where the two use different words for the same option (Neow names the
        // blessing, the game describes its effect).
        const byLabel = t.label ? pick(t.label) : -1;
        const k = byLabel >= 0 ? byLabel : Number(t.option);
        if (k < 0 || (opts.length && k >= opts.length)) { lineOff(`event option ${k} of ${opts.length}${t.label ? ` (plan: ${String(t.label).trim()}; game: ${names.join(", ")})` : ""}`); return null; }
        return advance(`return await sts.choose(${k})`, `event ${t.event}: option ${k} (${names[k] ?? "?"})`);
      }
      case "MAP": {
        if (st !== "MAP") break;
        // The act boss is a map step in the plan (symbol BOSS with the simulator's coordinates), but the game offers
        // it as the choice "boss" with no coordinates and an empty next_nodes: match it by name.
        if (t.symbol === "BOSS" || (names.length === 1 && names[0] === "boss")) {
          const b = names.indexOf("boss");
          if (b < 0) { lineOff(`plan goes to the boss, the map offers (${names.join(" ")})`); return null; }
          return advance(`return await sts.choose(${b})`, "map boss");
        }
        const k = names.findIndex((n) => new RegExp(`^x=${t.x}(,|$)`).test(n)) >= 0 ? names.findIndex((n) => new RegExp(`^x=${t.x}(,|$)`).test(n)) : (g.screen_state?.next_nodes ?? []).findIndex((n) => n.x === t.x);
        if (k < 0) { lineOff(`map node x=${t.x} not offered (${names.join(" ")})`); return null; }
        return advance(`return await sts.choose(${k})`, `map x=${t.x} ${t.symbol ?? ""}`);
      }
      case "REWARDS": {
        if (st === "CARD_REWARD" && t.kind === "card") {
          if (t.name === "singing bowl") { if (names.includes("bowl")) return advance(`return await sts.choose(${names.indexOf("bowl")})`, "singing bowl"); if (c.includes("skip")) return advance("return await sts.skip()", "skip the card"); }
          const k = pick(t.name);
          if (k < 0) { lineOff(`card ${t.name} not offered (${names.join(", ")})`); return null; }
          return advance(`return await sts.choose(${k})`, `card ${t.name}`);
        }
        if (st !== "COMBAT_REWARD") break;
        if (t.kind === "proceed") { if (c.includes("proceed")) return advance("return await sts.proceed()", "rewards done"); break; }
        if (t.kind === "card") { const k = pick("card", Number(t.reward) || 0) >= 0 ? pick("card", Number(t.reward) || 0) : pick("card"); if (k < 0) { lineOff("no card reward listed"); return null; } return cmd(`return await sts.choose(${k})`, `line: open card reward ${t.reward ?? 0}`); }
        const want = { gold: "gold", potion: "potion", relic: "relic", key: "sapphire_key", card_remove: "card_remove" }[t.kind] ?? t.kind;
        const k = names.findIndex((n) => n.includes(want));
        if (k < 0) { log(`line: reward ${t.kind} not listed here (${names.join(", ")}); step skipped`); linePos += 1; return lineStep(g, c, names); }
        if (t.kind === "potion" && (g.potions ?? []).every((p) => p?.id && p.id !== "Potion Slot")) { log("line: potion slots full; reward skipped"); linePos += 1; return lineStep(g, c, names); }
        return advance(`return await sts.choose(${k})`, `reward ${names[k]}`);
      }
      case "BOSS_RELIC": {
        if (st !== "BOSS_REWARD") break;
        if (t.name === "skip") { if (c.includes("skip")) return advance("return await sts.skip()", "skip boss relics"); break; }
        const k = pick(t.name);
        if (k < 0) { lineOff(`boss relic ${t.name} not offered (${names.join(", ")})`); return null; }
        return advance(`return await sts.choose(${k})`, `boss relic ${t.name}`);
      }
      case "CARD_SELECT": {
        if (st !== "GRID" && st !== "HAND_SELECT") break;
        const k = pick(t.name, Number(t.ordinal) || 0) >= 0 ? pick(t.name, Number(t.ordinal) || 0) : pick(t.name);
        if (k < 0) { lineOff(`card ${t.name} not in the grid (${names.join(", ")})`); return null; }
        return advance(`return await sts.choose(${k})`, `select ${t.name}`);
      }
      case "TREASURE": {
        if (st !== "CHEST") break;
        if (t.kind === "open") return advance("return await sts.choose(0)", "open chest");
        if (c.includes("proceed")) return advance("return await sts.proceed()", "leave chest");
        break;
      }
      case "REST": {
        if (st !== "REST") break;
        const k = names.indexOf(String(t.name));
        if (k < 0) { lineOff(`rest option ${t.name} not offered (${names.join(", ")})`); return null; }
        return advance(`return await sts.choose(${k})`, `rest: ${t.name}`);
      }
      case "SHOP": {
        if (st !== "SHOP_SCREEN") break;
        if (t.kind === "leave") { if (c.includes("leave")) return advance("return await sts.leave()", "leave shop"); if (c.includes("cancel")) return advance("return await sts.cancel()", "leave shop"); break; }
        const k = t.kind === "purge" ? names.indexOf("purge") : pick(t.name);
        // An item the game does not offer (or cannot afford): skip that purchase, the plan goes on.
        if (k < 0) { log(`line: shop item ${t.kind} ${t.name ?? ""} not offered here (${names.join(", ")}); purchase skipped`); linePos += 1; return lineStep(g, c, names); }
        return advance(`return await sts.choose(${k})`, `shop: ${t.kind} ${t.name ?? ""} (${t.price ?? ""})`);
      }
      case "POTION": {
        const p = (g.potions ?? [])[Number(t.idx)];
        if (!p || !c.includes("potion")) break;
        return advance(`return await sts.potion("${t.kind === "discard" ? "discard" : "use"}", ${Number(t.idx)})`, `${t.kind} potion ${p.name}`);
      }
      default: break;
    }
    // Nothing matched: a screen the plan does not list here (animations, intermediate screens): proceed/confirm when offered, else off.
    if (st === "COMBAT_REWARD" && c.includes("proceed") && !names.length) return cmd("return await sts.proceed()", "line: proceed (empty rewards)");
    lineOff(`game shows ${st} [${names.slice(0, 6).join(", ")}], plan expects ${t.screen} ${t.kind ?? t.name ?? t.x ?? ""}`);
    return null;
  }

  function combat(g, cs, c) {
    if (g.screen_type === "HAND_SELECT" || g.screen_type === "GRID") return combatSelect(g, cs, c);
    const fromOracle = oracleStep(g, cs, c);
    if (!fromOracle && broken) return null; // the plan broke: no planner, no improvising
    if (fromOracle) return fromOracle;
    const turnKey = `${g.floor}:${cs.turn}`;
    if (turnKey !== lastTurnKey) { lastTurnKey = turnKey; turnPlays = 0; }
    const mons = (cs.monsters ?? []).map((m, k) => ({ ...m, k })).filter((m) => !m.is_gone && !m.is_dead && (m.current_hp ?? 0) > 0);
    const attackers = mons.filter((m) => /ATTACK/.test(m.intent ?? ""));
    const incoming = attackers.reduce((n, m) => n + Math.max(0, m.move_adjusted_damage ?? 0) * (m.move_hits || 1), 0);
    const player = cs.player ?? {};
    const block = player.block ?? 0, hp = player.current_hp ?? g.current_hp ?? 0;
    const hand = (cs.hand ?? []).map((x, k) => ({ ...x, k, name: base(x.name) })).filter((x) => x.is_playable);
    if (turnPlays > 40 && c.includes("end")) return cmd("return await sts.end()", "end (play cap)");
    // Potions when the turn could be lethal or HP is low.
    const potions = (g.potions ?? []).map((p, k) => ({ ...p, k })).filter((p) => p?.can_use && !/Smoke Bomb|Entropic|Snecko|Gambler|Distilled/.test(p.name));
    const bigFight = mons.reduce((n, m) => n + (m.max_hp ?? m.current_hp ?? 0), 0) >= 90; // elite or boss
    const danger = incoming - block >= hp || (hp <= 0.5 * (g.max_hp || 1) && incoming > block);
    if (potions.length && (danger || (bigFight && cs.turn <= 2))) {
      const target = mons.slice().sort((a, b) => b.current_hp - a.current_hp)[0];
      const p = (danger ? potions.find((x) => /Block/.test(x.name)) : null) ?? potions.find((x) => /Fire|Explosive|Poison/.test(x.name)) ?? potions.find((x) => /Strength|Flex|Fear|Weak|Speed|Dexterity/.test(x.name)) ?? (danger ? potions[0] : null);
      if (p) { turnPlays += 1; return cmd(`return await sts.potion("use", ${p.k}${p.requires_target ? `, ${target?.k ?? 0}` : ""})`, `potion ${p.name}`); }
    }
    const play = (card, target, note) => { turnPlays += 1; return cmd(`return await sts.play(${card.k + 1}${target !== undefined ? `, ${target}` : ""})`, note); };
    // Targets: a kill if there is one, else the weakest attacker (fewer attackers next turn), else the weakest monster.
    const targetFor = (card) => (card.has_target ? (killable(card) ?? attackers.slice().sort((a, b) => a.current_hp - b.current_hp)[0] ?? mons.slice().sort((a, b) => a.current_hp - b.current_hp)[0])?.k : undefined);
    const dmg = (card) => (DAMAGE[card.name] ?? 0) + (card.upgrades ? 3 : 0) + (card.name === "Body Slam" ? block : 0);
    const killable = (card) => mons.filter((m) => m.current_hp + (m.block ?? 0) <= dmg(card)).sort((a, b) => b.move_adjusted_damage - a.move_adjusted_damage)[0];
    // A plan for the turn: every subset of the hand that fits the energy, played in a fixed sensible order
    // (powers, then cards that apply Vulnerable or Strength, then attacks, then block); scored on kills, damage,
    // block against what is coming, and a heavy penalty for damage that would land while HP is low.
    if (!c.includes("play")) return cmd("return await sts.end()", "end turn (nothing playable)");
    const plan = planTurn({ hand, mons, attackers, incoming, block, hp, maxHp: g.max_hp || 80, energy: player.energy ?? 3, strength: (player.powers ?? []).find((pw) => /Strength/i.test(pw.name ?? pw.id ?? ""))?.amount ?? 0 });
    if (plan && plan.first) {
      const card = plan.first;
      return play(card, card.has_target ? plan.target(card) : undefined, `${plan.note} -> ${card.name}`);
    }
    if (c.includes("end")) return cmd("return await sts.end()", "end turn");
    return cmd("return await sts.wait(30)", "wait in combat");
  }

  /** A card-select screen inside a fight (Armaments, Headbutt, Gambler's Brew, True Grit...): the oracle's choice by name, else the best card by our list. */
  function combatSelect(g, cs, c) {
    const names = (g.choice_list ?? []).map((x) => String(x).toLowerCase());
    const ss = g.screen_state ?? {};
    const selected = (ss.selected_cards ?? ss.selected ?? []).map((x) => String(x.name ?? "").toLowerCase());
    const need = Number(ss.num_cards ?? ss.max_cards) || 1;
    const a = queue && !queue.off && queue.pos < queue.actions.length ? queue.actions[queue.pos] : null;
    if (a && a.type === "select") {
      const wanted = a.cards ? a.cards.map((x) => x.name) : [a.piles?.[g.screen_type === "HAND_SELECT" ? "hand" : "discard"] ?? a.piles?.draw ?? a.piles?.hand ?? a.piles?.exhaust].filter(Boolean);
      const left = wanted.filter((w) => { const i = selected.indexOf(w.toLowerCase()); if (i >= 0) { selected.splice(i, 1); return false; } return true; });
      if (!left.length) { queue.pos += 1; if (c.includes("confirm")) return cmd("return await sts.confirm()", `oracle: ${a.task} confirm`); if (c.includes("choose") && !wanted.length && names.length) { /* nothing to select and no confirm: leave */ } }
      else {
        const k = names.indexOf(left[0].toLowerCase());
        if (k >= 0 && c.includes("choose")) { if (left.length === 1 && !(need > 1 || a.cards)) queue.pos += 1; return cmd(`return await sts.choose(${k})`, `oracle: ${a.task} ${left[0]}`); }
        if (queue.fromLine) { lineOff(`${a.task} wants ${left[0]}, the screen offers [${names.join(", ")}]`); queue.off = true; return null; }
        log(`oracle: ${a.task} wants ${left[0]} but the screen offers [${names.join(", ")}]; choosing by rank`); queue.off = true;
      }
    }
    if (c.includes("confirm") && (selected.length >= need || !c.includes("choose"))) return cmd("return await sts.confirm()", "select confirm");
    if (c.includes("choose") && names.length) { const best = names.map((n, k) => ({ n, k, r: rank(n) })).sort((x, y) => x.r - y.r)[0]; return cmd(`return await sts.choose(${best.k})`, `select ${best.n} (by rank)`); }
    if (c.includes("cancel")) return cmd("return await sts.cancel()", "select cancel");
    return cmd("return await sts.wait(30)", "select wait");
  }

  /** The oracle's next action for this fight, verified against the live state; null when the bot must decide itself. */
  function oracleStep(g, cs, c) {
    const floor = g.floor ?? null;
    if (queue && queue.floor !== floor) queue = null;
    // The planner's line has this fight: replay its actions (same verification as the oracle's); the line's cursor moves past the fight.
    // The plan's battles are used only on request (AAS_BOT_LINE_BATTLES=1): the simulator's own shuffle can differ from
    // the game's, so by default every fight is solved live by the oracle from the game's autosave; the plan's cursor
    // just moves past the fight.
    if (!queue && lineOn && lineSteps[linePos]?.screen === "BATTLE" && lineSteps[linePos].floor === floor) {
      const b = lineBattle(floor);
      linePos = b.next;
      if (process.env.AAS_BOT_LINE_BATTLES === "1" || !oracle) {
        const parsed = parseOracle(b.descs.join("\n"));
        queue = { floor, actions: parsed.actions, rows: b.rows, pos: 0, off: parsed.actions.length === 0, fromLine: true };
        log(`line: floor ${floor}: ${parsed.actions.length} battle actions from the plan`);
      } else log(`line: floor ${floor}: fight solved live (plan had ${b.descs.length} actions)`);
    }
    if (!oracle && !queue) return null;
    if (!queue) {
      // Only at the start of a fight (turn 1, nothing played yet), and only when the game's autosave is this room.
      const fresh = (cs.turn ?? 1) === 1 && (cs.player?.energy ?? 0) === (cs.player?.max_energy ?? cs.player?.energy ?? 0) && (cs.discard_pile ?? []).length === 0 && (cs.exhaust_pile ?? []).length === 0;
      if (!fresh) return null;
      const info = oracle.saveInfo();
      if (!info || info.floor !== floor || info.postCombat || !/Monster|Event/.test(info.room)) { log(`oracle: autosave is not this fight (${JSON.stringify(info)}); planner`); queue = { floor, actions: [], pos: 0, off: true }; return null; }
      let parsed;
      const keep = runDir ? path.join(runDir, "oracle", `floor-${String(floor).padStart(2, "0")}.autosave`) : null;
      try {
        parsed = parseOracle(oracle.run({ keep }));
        // A losing line (ending HP 0): search five times deeper once before accepting it.
        if (parsed.endingHp === 0 || parsed.actions.length === 0) { log(`oracle: floor ${floor}: best line loses (value ${parsed.value}); searching 5x deeper`); parsed = parseOracle(oracle.run({ steps: (Number(process.env.AAS_BOT_ORACLE_SIMS) || 200000) * 5 })); }
      } catch (e) { log(`oracle: ${e.message}; planner`); queue = { floor, actions: [], pos: 0, off: true }; return null; }
      log(`oracle: floor ${floor}: ${parsed.actions.length} actions, ending hp ${parsed.endingHp}, value ${parsed.value}`);
      queue = { floor, actions: parsed.actions, pos: 0, off: parsed.actions.length === 0 };
    }
    if (queue.off || queue.pos >= queue.actions.length) return null;
    const a = queue.actions[queue.pos];
    const hand = cs.hand ?? [];
    const mons = cs.monsters ?? [];
    const alive = (m) => m && !m.is_gone && !m.is_dead && (m.current_hp ?? 0) > 0;
    const targetIdx = (a) => {
      if (a.target === null) return undefined;
      const m = mons[a.target];
      if (alive(m) && norm(m.name) === norm(a.targetName)) return a.target;
      const same = mons.findIndex((x) => alive(x) && norm(x.name) === norm(a.targetName));
      if (same >= 0) return same;
      const any = mons.findIndex(alive);
      return any >= 0 ? any : undefined;
    };
    // A plan is only valid while the game is in the state the plan was made for. Checking that the wanted card is in
    // hand is not enough: the run can drift (a fight that costs more hp) and still play on for twenty floors before it
    // dies. The plan's own hp and energy at this action are the anchor; the first difference ends the replay, naming
    // the floor and the step, so the cause can be found instead of guessed.
    const anchor = queue.fromLine ? queue.rows?.[queue.pos] : null;
    if (anchor) {
      const liveHp = g.current_hp, liveEnergy = cs.player?.energy;
      // A card the game generated itself (Discovery, Liquid Memories, a Skill Potion) is not the card the simulator
      // rolled, so a fight can legitimately come out one energy or a few hit points apart. That is corrected and
      // reported, not treated as a broken plan; once a fight has been corrected it is no longer identical to the
      // plan, so its hp is only reported from there on. A larger difference still ends the replay.
      if (typeof anchor.energy === "number" && typeof liveEnergy === "number" && anchor.energy !== liveEnergy) {
        const off = Math.abs(anchor.energy - liveEnergy);
        if (off > 1) { lineOff(`state differs at floor ${floor} step ${queue.pos + 1}: plan has ${anchor.energy} energy, the game has ${liveEnergy}`); queue.off = true; return null; }
        if (!queue.corrected) log(`line: correction at floor ${floor} step ${queue.pos + 1}: ${liveEnergy} energy against the plan's ${anchor.energy}; playing on`);
        queue.corrected = true;
      }
      if (typeof anchor.hp === "number" && typeof liveHp === "number" && anchor.hp !== liveHp) {
        if (!queue.corrected) { lineOff(`state differs at floor ${floor} step ${queue.pos + 1}: plan has ${anchor.hp} hp, the game has ${liveHp}`); queue.off = true; return null; }
        log(`line: floor ${floor} step ${queue.pos + 1}: ${liveHp} hp against the plan's ${anchor.hp} (corrected fight)`);
      }
    }
    if (a.type === "end") { queue.pos += 1; return cmd("return await sts.end()", `oracle: end turn`); }
    // A plan is followed or it is stopped; it is never partly improvised. Every surprise below ends the replay with
    // a diagnosis when the actions came from a plan. Only a live oracle line may hand over to the planner.
    const giveUp = (why) => { if (queue.fromLine) { lineOff(why); queue.off = true; return null; } log(`oracle: ${why}; planner takes over`); queue.off = true; return null; };
    if (a.type === "card" && !c.includes("play")) { if (queue.fromLine) return giveUp(`no card playable but the plan continues with ${a.name}`); log(`oracle: no card playable but the line continues with ${a.name}; ending the turn, planner takes over`); queue.off = true; return cmd("return await sts.end()", "end turn (nothing playable)"); }
    if (a.type === "potion" && !c.includes("potion")) return giveUp(`potion ${a.name} not usable now`);
    if (a.type === "card") {
      // The simulator keeps its hand in another order than the game after a play (swap-remove), so a card is matched by
      // name and upgrade, not by slot: the slot only breaks the tie between identical cards.
      const wanted = norm(a.name);
      const candidates = hand.map((x, k) => ({ x, k })).filter(({ x }) => norm(x.name) === wanted && x.is_playable);
      // Same name, different price: the plan says what the card cost when it was played, so pick that copy.
      const byCost = typeof a.cost === "number" ? candidates.filter(({ x }) => Number(x.cost) === a.cost) : candidates;
      const pool = byCost.length ? byCost : candidates;
      const chosen = pool.find(({ k }) => k === a.index) ?? pool[0];
      const live = chosen?.x;
      const liveIdx = chosen?.k ?? a.index;
      if (!live) {
        return giveUp(`desync at floor ${floor} step ${queue.pos + 1}: wanted a playable ${a.name}${typeof a.cost === "number" ? ` costing ${a.cost}` : ""}, hand is [${hand.map((x) => `${x.name}(${x.cost})${x.is_playable ? "" : "!"}`).join(", ")}]`);
      }
      queue.pos += 1;
      const t = live.has_target ? targetIdx(a) : undefined;
      return cmd(`return await sts.play(${liveIdx + 1}${t !== undefined ? `, ${t}` : ""})`, `${queue.fromLine ? "line" : "oracle"}: ${a.name}${t !== undefined ? ` -> ${mons[t]?.name ?? t}` : ""}`);
    }
    if (a.type === "potion") {
      const pots = (g.potions ?? []).map((p, k) => ({ p, k })).filter(({ p }) => p && norm(p.name) === norm(a.name) && (p.can_use || !a.use));
      const chosen = pots.find(({ k }) => k === a.index) ?? pots[0];
      if (!chosen) return giveUp(`potion ${a.name} not held: [${(g.potions ?? []).map((p) => p?.name).join(", ")}]`);
      queue.pos += 1;
      const t = a.target === null ? undefined : targetIdx(a);
      return cmd(`return await sts.potion("${a.use ? "use" : "discard"}", ${chosen.k}${t !== undefined ? `, ${t}` : ""})`, `${queue.fromLine ? "line" : "oracle"}: ${a.use ? "drink" : "discard"} ${a.name}`);
    }
    if (a.type === "select") return null; // the select screen has not appeared yet (or was implicit): let the next state decide
    return giveUp(`unsupported action ${a.text ?? a.type}`);
  }

  /** The best set of cards for this turn; returns { first, target(card), note } or null when nothing is worth playing. */
  function planTurn({ hand, mons, attackers, incoming, block, hp, maxHp, energy, strength }) {
    const cards = hand.filter((x) => !BAD_TO_PLAY.has(x.name) && x.type !== "CURSE" && x.type !== "STATUS").slice(0, 10);
    const cost = (x) => (x.name === "Whirlwind" ? Math.max(1, energy) : Number.isFinite(x.cost) && x.cost >= 0 ? x.cost : 1);
    const order = (x) => (x.type === "POWER" ? 0 : STRENGTH[x.name] !== undefined ? 1 : APPLIES_VULN.has(x.name) ? 2 : x.type === "ATTACK" ? 3 : 4);
    const blockOf = (x) => BLOCK[x.name] ?? Number(/gain (\d+) block/i.exec(x.description ?? "")?.[1] ?? 0);
    const low = hp <= 0.45 * maxHp;
    let best = null;
    const n = cards.length;
    for (let mask = 1; mask < 1 << n; mask += 1) {
      const set = cards.filter((_, i) => mask & (1 << i)).sort((a, b) => order(a) - order(b));
      const e = set.reduce((t, x) => t + cost(x), 0);
      if (e > energy) continue;
      // simulate
      const m = mons.map((x) => ({ k: x.k, hp: x.current_hp, block: x.block ?? 0, vuln: (x.powers ?? []).some((pw) => /Vulnerable/i.test(pw.name ?? pw.id ?? "")), dmg: /ATTACK/.test(x.intent ?? "") ? Math.max(0, x.move_adjusted_damage ?? 0) * (x.move_hits || 1) : 0 }));
      let str = strength, blk = block, dealt = 0, kills = 0, weakened = 0;
      const alive = () => m.filter((x) => x.hp > 0);
      const pick = (card) => alive().find((x) => x.hp <= (DAMAGE[card.name] ?? 0)) ?? alive().sort((a, b) => (b.dmg - a.dmg) || (a.hp - b.hp))[0];
      for (const card of set) {
        if (card.type === "POWER" && STRENGTH[card.name] !== undefined) { str += STRENGTH[card.name]; continue; }
        if (STRENGTH[card.name] !== undefined) { str += STRENGTH[card.name]; continue; }
        const b = blockOf(card);
        if (b) blk += b + (card.name === "Body Slam" ? 0 : 0);
        if (card.type === "ATTACK" || card.name === "Body Slam") {
          const hits = HITS[card.name] ?? 1;
          const base = card.name === "Body Slam" ? blk : card.name === "Whirlwind" ? 5 * Math.max(1, energy) / hits : (DAMAGE[card.name] ?? 0) / hits + (card.upgrades ? 3 / hits : 0);
          const targets = AOE.has(card.name) ? alive() : [pick(card)].filter(Boolean);
          for (const t of targets) {
            for (let h = 0; h < hits; h += 1) {
              if (t.hp <= 0) break;
              let d = Math.floor((base + str) * (t.vuln ? 1.5 : 1));
              const through = Math.max(0, d - t.block); t.block = Math.max(0, t.block - d);
              t.hp -= through; dealt += through;
              if (t.hp <= 0) { kills += 1; t.dmg = 0; }
            }
            if (APPLIES_VULN.has(card.name)) t.vuln = true;
            if (APPLIES_WEAK.has(card.name) && t.dmg) { weakened += Math.floor(t.dmg * 0.25); t.dmg = Math.floor(t.dmg * 0.75); }
          }
        }
      }
      const coming = m.reduce((t, x) => t + x.dmg, 0);
      const unblocked = Math.max(0, coming - blk);
      const score = kills * 120 + dealt * 3 + Math.min(blk, coming) * 2.5 + weakened * 2 - unblocked * (low ? 12 : unblocked >= hp ? 50 : 1.5) - e * 0.1 + set.reduce((t, x) => t + (DRAW[x.name] ?? 0), 0);
      if (!best || score > best.score) best = { score, set, kills, dealt, blk, unblocked };
    }
    if (!best || best.set.length === 0) return null;
    const first = best.set[0];
    // Target for the first card: a kill if one exists, else the weakest attacker, else the weakest monster.
    const target = (card) => {
      const d = (DAMAGE[card.name] ?? 0) + (card.upgrades ? 3 : 0) + strength;
      const kill = mons.find((x) => x.current_hp + (x.block ?? 0) <= d * (HITS[card.name] ?? 1));
      return (kill ?? attackers.slice().sort((a, b) => a.current_hp - b.current_hp)[0] ?? mons.slice().sort((a, b) => a.current_hp - b.current_hp)[0])?.k ?? 0;
    };
    return { first, target, note: `plan ${best.set.map((x) => x.name).join("+")} (kills ${best.kills}, dmg ${best.dealt}, block ${best.blk} vs ${incoming})` };
  }

  function shop(g, names, c) {
    const ss = g.screen_state ?? {};
    const gold = g.gold ?? 0;
    const key = (item) => `${g.floor}:${item}`;
    const canBuy = (item, price) => item && price <= gold && names.includes(item.toLowerCase()) && !bought.has(key(item));
    // 1. remove a Strike (thinner deck) when affordable, 2. a good card, 3. a plain relic, 4. a potion for a free slot.
    if (ss.purge_available && ss.purge_cost <= gold && !bought.has(key("purge")) && (g.deck ?? []).some((x) => base(x.name) === "Strike") && names.includes("purge")) { bought.add(key("purge")); return cmd(`return await sts.choose(${names.indexOf("purge")})`, `shop: purge (${ss.purge_cost})`); }
    const card = (ss.cards ?? []).filter((x) => rank(x.name) < GOOD_CARDS.length).sort((a, b) => rank(a.name) - rank(b.name)).find((x) => canBuy(x.name, x.price ?? 9999));
    if (card) { bought.add(key(card.name)); return cmd(`return await sts.choose(${names.indexOf(card.name.toLowerCase())})`, `shop: buy ${card.name} (${card.price})`); }
    const relic = (ss.relics ?? []).find((x) => GOOD_RELICS.includes(x.name) && canBuy(x.name, x.price ?? 9999));
    if (relic) { bought.add(key(relic.name)); return cmd(`return await sts.choose(${names.indexOf(relic.name.toLowerCase())})`, `shop: buy ${relic.name} (${relic.price})`); }
    const freeSlot = (g.potions ?? []).some((p) => !p?.id || p.id === "Potion Slot");
    const potion = freeSlot ? (ss.potions ?? []).find((x) => /Block|Fire|Explosive|Strength|Fruit|Regen/.test(x.name) && canBuy(x.name, x.price ?? 9999)) : null;
    if (potion) { bought.add(key(potion.name)); return cmd(`return await sts.choose(${names.indexOf(potion.name.toLowerCase())})`, `shop: buy ${potion.name} (${potion.price})`); }
    if (c.includes("leave")) return cmd("return await sts.leave()", "shop: leave");
    if (c.includes("cancel")) return cmd("return await sts.cancel()", "shop: cancel");
    if (c.includes("proceed")) return cmd("return await sts.proceed()", "shop: proceed");
    return cmd("return await sts.wait(30)", "shop: wait");
  }

  function event(g, names, c) {
    const ss = g.screen_state ?? {};
    if (/neow/i.test(String(ss.event_name ?? ""))) {
      if (names.length === 1 && names[0] === "talk") return cmd("return await sts.choose(0)", "neow: talk");
      const k = names.findIndex((n) => /1 hp|three combats/.test(n));
      return cmd(`return await sts.choose(${k >= 0 ? k : 0})`, `neow: ${names[k >= 0 ? k : 0]}`);
    }
    if (ss.event_id === "SecretPortal" || /secret portal/i.test(String(ss.event_name ?? ""))) { const k = names.findIndex((n) => /leave/.test(n)); return cmd(`return await sts.choose(${k >= 0 ? k : 0})`, "secret portal: leave"); }
    const safe = names.findIndex((n) => /leave|ignore|refuse|walk away|nothing|decline/.test(n));
    if (safe >= 0 && c.includes("choose")) return cmd(`return await sts.choose(${safe})`, `event ${ss.event_name ?? ""}: ${names[safe]}`);
    if (c.includes("choose") && names.length) return cmd("return await sts.choose(0)", `event ${ss.event_name ?? ""}: ${names[0]}`);
    if (c.includes("proceed")) return cmd("return await sts.proceed()", `event ${ss.event_name ?? ""}: proceed`);
    return cmd("return await sts.wait(30)", "event wait");
  }

  function map(g, names) {
    // The cheapest route to the top of the act (elites 3, fights 1, shops 0.7, rests and treasure 0), first step.
    // Hurt: rest sites become attractive and elites dearer; rich: shops become attractive.
    const hp = (g.current_hp ?? 0) / (g.max_hp || 1);
    const W = { E: hp < 0.6 ? 6 : 3, M: 1, "?": 1, $: (g.gold ?? 0) >= 150 && hp >= 0.7 ? 0.2 : 0.9, T: 0, R: hp < 0.5 ? -5 : hp < 0.8 ? -3 : -1 };
    const nodes = new Map((g.map ?? []).map((n) => [`${n.x},${n.y}`, n]));
    const memo = new Map();
    const cost = (n) => { const key = `${n.x},${n.y}`; if (memo.has(key)) return memo.get(key); const kids = (n.children ?? []).map((ch) => nodes.get(`${ch.x},${ch.y}`)).filter(Boolean); const v = (W[n.symbol] ?? 1) + (kids.length ? Math.min(...kids.map(cost)) : 0); memo.set(key, v); return v; };
    const next = (g.screen_state?.next_nodes ?? []).map((nn) => nodes.get(`${nn.x},${nn.y}`) ?? nn);
    const ranked = next.map((n) => ({ n, cost: n.symbol ? cost(n) : 0 })).sort((a, b) => a.cost - b.cost);
    const best = ranked[0]?.n;
    let k = -1;
    if (best) { k = names.findIndex((nm) => new RegExp(`x=${best.x}\\b.*y=${best.y}\\b`).test(nm)); if (k < 0) k = next.indexOf(best); }
    return cmd(`return await sts.choose(${k >= 0 ? k : 0})`, best ? `map ${best.symbol}@${best.x},${best.y} (cost ${ranked[0].cost})` : "map 0");
  }

  return {
    get broken() { return broken; },
    next(result) {
      if (broken) return null;
      if (result === null || result === undefined) return stateCall();
      if (result.error) {
        errors += 1;
        if (/you died/.test(result.error)) {
          if (lineSteps.length) { broken = `died on step ${linePos + 1} of the plan`; log(`line: ${broken}; stopping`); return null; }
          return newAttempt("death reported by the controller");
        }
        if (/run is over|no further commands/.test(result.error)) return null;
        if (queue && !queue.off && /cannot be played|refused/.test(result.error)) { log(`oracle: the game refused an action (${result.error.slice(0, 80)}); planner takes over this fight`); if (queue.fromLine) lineOff("refused action"); queue.off = true; }
        if (errors > 20) { log(`too many errors: ${result.error}`); return null; }
        return stateCall();
      }
      if (typeof result.in_game !== "boolean") return stateCall();
      errors = 0;
      state = result;
      if (tapeLive) {
        const t = tapeSteps[tapePos];
        if (!t) { tapeLive = false; log(`tape done after ${tapePos} commands; deciding live from floor ${state.game_state?.floor}`); }
        else if (tapeMatches(t, state)) { tapePos += 1; return cmd(t.code, `tape ${tapePos}/${tapeSteps.length}: ${t.code.replace(/^return await /, "")}`); }
        else { tapeLive = false; log(`tape diverged at command ${tapePos + 1} (expected floor ${t.floor} ${t.screen} turn ${t.turn}, game shows floor ${state.game_state?.floor} ${state.game_state?.screen_type} turn ${state.game_state?.combat_state?.turn ?? null}); deciding live`); }
      }
      const step = decide(state);
      // A plan that broke ends the session here: no step is returned after a diagnosis, ever.
      return broken ? null : step;
    },
  };
}
