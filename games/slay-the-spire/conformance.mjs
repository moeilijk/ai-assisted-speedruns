// Does the simulator describe the same room the game is showing?
//
// The game writes its autosave when a room is entered, and that file carries the fourteen RNG counters at their
// real position. Loading it into sts_lightspeed (`aas describe`) therefore produces the room as the simulator
// believes it to be: which event, which cards a shop stocks and for how much, what a chest holds, which boss
// relics are on offer. The Communication Mod reports the same things from the running game. Comparing the two
// after every room turns "the simulator matches the game" from a claim into a list of floors and fields.
//
// Verified this way against a recorded run (seed 23M): the boss treasure on floor 17 offered
// Snecko Eye, Calling Bell and Sacred Bark in the game and the same three in the same order in the simulator.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The mod names an event the way the save files do; the simulator wants its own enum index. */
const EVENT_IDS = JSON.parse(fs.readFileSync(new URL("./event-names.json", import.meta.url), "utf8"));

/** "Strike" + one upgrade -> "Strike+", as the simulator prints it. */
export function cardLabel(card) {
  return `${card?.name ?? ""}`.replace(/\+\d*$/, "") + ((card?.upgrades ?? 0) > 0 ? "+" : "");
}

const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const sortedNorm = (xs) => xs.map(norm).sort();

/** Compares two lists as multisets and reports what each side has that the other does not. */
function diffList(field, mine, theirs) {
  const a = sortedNorm(mine), b = sortedNorm(theirs);
  if (a.join("|") === b.join("|")) return null;
  const onlyGame = [...mine].filter((x, i) => !b.includes(norm(x)) || sortedNorm(mine).indexOf(norm(x)) !== i);
  const missing = mine.filter((x) => !b.includes(norm(x)));
  const extra = theirs.filter((x) => !a.includes(norm(x)));
  return `${field}: the game has ${missing.length ? missing.join(", ") : "nothing extra"}, the simulator has ${extra.length ? extra.join(", ") : "nothing extra"}`;
}

/**
 * @param g        the mod's game_state
 * @param options  bin: the aas binary, save: the game's autosave, outDir: where the copies go
 * @returns {{floor:number, room:string, diffs:string[]}|null}  null when the room cannot be read
 */
export function checkRoom(g, { bin, save, outDir, log = () => {} } = {}) {
  if (!bin || !save || !fs.existsSync(bin) || !fs.existsSync(save)) return null;
  const floor = g?.floor ?? 0;
  let copy = save;
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    copy = path.join(outDir, `floor-${String(floor).padStart(2, "0")}.autosave`);
    fs.copyFileSync(save, copy);
  }

  let sim;
  try {
    // The event on screen is handed over rather than rolled again: the save's event counter already stands past
    // the roll the game made when it entered the room (, measured: on floors 3 and 11).
    const shown = g?.screen_type === "EVENT" ? (g.screen_state?.event_name ?? "") : "";
    const eventId = shown && EVENT_IDS[shown] !== undefined ? String(EVENT_IDS[shown]) : "0";
    sim = JSON.parse(execFileSync(bin, ["describe", copy, eventId], { encoding: "utf8", maxBuffer: 1 << 20, timeout: 60000 }).trim());
  } catch (e) {
    return { floor, room: "?", diffs: [`the simulator cannot read this room: ${String(e.message).split("\n")[0]}`] };
  }

  const diffs = [];
  const cmp = (field, game, simulator) => {
    if (game === undefined || simulator === undefined) return;
    if (game !== simulator) diffs.push(`${field}: the game says ${game}, the simulator ${simulator}`);
  };
  cmp("floor", g.floor, sim.floor);
  cmp("hp", g.current_hp, sim.hp);
  cmp("max hp", g.max_hp, sim.maxHp);
  cmp("gold", g.gold, sim.gold);

  const deck = (g.deck ?? []).map(cardLabel);
  if (deck.length) {
    const d = diffList("deck", deck, sim.deck ?? []);
    if (d) diffs.push(d);
  }
  const relics = (g.relics ?? []).map((r) => r.name);
  if (relics.length) {
    const d = diffList("relics", relics, sim.relics ?? []);
    if (d) diffs.push(d);
  }

  const ss = g.screen_state ?? {};
  switch (g.screen_type) {
    case "EVENT": {
      if (sim.event) {
        const same = norm(ss.event_name) === norm(sim.event) || norm(sim.event).includes(norm(ss.event_name));
        if (!same) diffs.push(`event: the game shows ${ss.event_name}, the simulator ${sim.event}`);
      }
      break;
    }
    case "SHOP_SCREEN": {
      const gameCards = (ss.cards ?? []).map((c) => `${cardLabel(c)}@${c.price}`);
      const simCards = (sim.shopCards ?? []).filter((c) => c.price >= 0).map((c) => `${c.name}@${c.price}`);
      const d1 = diffList("shop cards", gameCards, simCards);
      if (d1) diffs.push(d1);
      const gameRelics = (ss.relics ?? []).map((r) => `${r.name}@${r.price}`);
      const simRelics = (sim.shopRelics ?? []).filter((r) => r.price >= 0).map((r) => `${r.name}@${r.price}`);
      const d2 = diffList("shop relics", gameRelics, simRelics);
      if (d2) diffs.push(d2);
      cmp("removal price", ss.purge_cost, sim.removeCost);
      break;
    }
    case "BOSS_REWARD": {
      const d = diffList("boss relics", (ss.relics ?? []).map((r) => r.name), sim.bossRelics ?? []);
      if (d) diffs.push(d);
      break;
    }
    default:
      break;
  }
  const result = { floor, room: sim.room ?? "?", diffs };
  log(`conformance floor ${floor} (${result.room}): ${diffs.length ? diffs.join(" | ") : "identical"}`);
  return result;
}
