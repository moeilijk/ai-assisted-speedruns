// Which test chamber a Portal run is in, from the player's position. Portal's
// maps hold one or two chambers each (chambers 00 and 01 share testchmb_a_00);
// SPT reports level changes but not chambers, so the second chamber of a map is
// recognised from the game's own markers (games/portal/chambers.json, generated
// from the map files by extract-chambers.mjs): the chamber's number sign at its
// entrance, or the top of the elevator that leads to it.
import fs from "node:fs";

const data = JSON.parse(fs.readFileSync(new URL("./chambers.json", import.meta.url), "utf8"));
export const CHAMBER_MAPS = data.maps;
/** Every chamber in order: the split names. */
export const CHAMBERS = CHAMBER_MAPS.flatMap((m) => m.chambers.map((c) => c.id));
export const SIGN_RADIUS = 320; // horizontal units from the sign
export const SIGN_HEIGHT = 220; // vertical tolerance (signs hang above eye height)
export const ELEVATOR_RADIUS = 160;
export const ELEVATOR_HEIGHT = 160; // the player's eye is ~70 units below the elevator's top track

const horizontal = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function chamberIndex(id) { return CHAMBERS.indexOf(id); }

/** The chamber a position in `map` belongs to by its markers, or null when no marker is near. */
export function chamberAt(map, pos) {
  const m = CHAMBER_MAPS.find((x) => x.map === map);
  if (!m || !pos || !Number.isFinite(pos.x)) return null;
  for (const c of [...m.chambers].reverse()) {
    if (c.sign && horizontal(pos, c.sign) <= SIGN_RADIUS && Math.abs(pos.z - c.sign.z) <= SIGN_HEIGHT) return c.id;
  }
  const e = m.middleElevatorTop;
  if (e && horizontal(pos, e.at) <= ELEVATOR_RADIUS && pos.z >= e.at.z - ELEVATOR_HEIGHT) return e.target;
  return null;
}

/**
 * Tracks chamber progress: `enterMap(map)` at a level load (the map's first
 * chamber), `observe(pos)` for every known position. Both return the chamber
 * entered (only forward progress counts) or null.
 */
export function createChamberTracker({ map = CHAMBER_MAPS[0].map, chamber = null } = {}) {
  const state = { map, chamber: chamber ?? CHAMBER_MAPS.find((x) => x.map === map)?.chambers[0].id ?? null };
  const advance = (id) => {
    if (!id || chamberIndex(id) <= chamberIndex(state.chamber)) return null;
    state.chamber = id;
    return id;
  };
  return {
    get map() { return state.map; },
    get chamber() { return state.chamber; },
    enterMap(nextMap) {
      const m = CHAMBER_MAPS.find((x) => x.map === nextMap);
      if (!m) return null;
      state.map = nextMap;
      return advance(m.chambers[0].id);
    },
    /** The map after the current one (campaign order), for a level change SPT reports without a name. */
    nextMap() { return CHAMBER_MAPS.find((x) => x.map === state.map)?.next ?? null; },
    observe(pos) { return advance(chamberAt(state.map, pos)); },
  };
}
