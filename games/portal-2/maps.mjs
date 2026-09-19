// Which map a Portal 2 run is in, and which of the game's ends that map is.
//
// SAR's TAS protocol says the location once, when the controller connects, and never again (docs/tas_proto.txt),
// so a map change is not something the protocol reports. The engine does report it: Portal 2 started with
// `-condebug` writes `portal2/console.log`, and every level load prints its map there. Reading the game's own
// console log is how the plugin follows the campaign — the game's own record, no patch to SAR.
import fs from "node:fs";
import path from "node:path";

const data = JSON.parse(fs.readFileSync(new URL("./maps.json", import.meta.url), "utf8"));
/** Every single-player map in campaign order, as SAR's own table has them. */
export const MAPS = data.maps;
export const MAP_SOURCE = data.source;
export const mapIndex = (map) => MAPS.findIndex((m) => m.map === map);
export const mapName = (map) => MAPS.find((m) => m.map === map)?.name ?? null;

// "Loading map \"sp_a2_bts1\"" and the `map`/`changelevel` echo are what the engine prints on a level load. Both
// forms are matched, and nothing else is read from the log.
const LOAD = /(?:Loading map "([a-z0-9_]+)")|(?:^(?:map|changelevel)\s+([a-z0-9_]+)\s*$)/gim;

/** Every map named in a piece of console log, in the order it named them. */
export function mapsInLog(text) {
  const out = [];
  for (const m of String(text).matchAll(LOAD)) {
    const name = m[1] ?? m[2];
    if (mapIndex(name) !== -1 && out.at(-1) !== name) out.push(name);
  }
  return out;
}

/**
 * Follows `portal2/console.log` from where it was, and reports each map the run moves into. Only forward progress
 * counts: a `map` command back to an earlier chamber is not a split.
 *
 * `read()` returns the maps entered since the previous call, each `{ map, name, index }`.
 */
export function createMapTracker({ logFile, from = null } = {}) {
  let offset = 0;
  let highest = from ? mapIndex(from) : -1;
  return {
    get current() { return highest === -1 ? null : MAPS[highest].map; },
    read() {
      if (!logFile || !fs.existsSync(logFile)) return [];
      const size = fs.statSync(logFile).size;
      // A game that was restarted writes a shorter log: start over rather than read from a stale offset.
      if (size < offset) offset = 0;
      if (size === offset) return [];
      const fd = fs.openSync(logFile, "r");
      const buffer = Buffer.alloc(size - offset);
      try { fs.readSync(fd, buffer, 0, buffer.length, offset); } finally { fs.closeSync(fd); }
      offset = size;
      const entered = [];
      for (const map of mapsInLog(buffer.toString("utf8"))) {
        const i = mapIndex(map);
        if (i > highest) { highest = i; entered.push({ map, name: MAPS[i].name, index: i }); }
      }
      return entered;
    },
  };
}

/** Where the engine writes its console log when the game is started with `-condebug`. */
export const consoleLogPath = (gameRoot) => (gameRoot ? path.join(gameRoot, "portal2", "console.log") : null);
