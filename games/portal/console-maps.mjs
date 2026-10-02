// The map a Portal run is in, from the engine's own console log. SPT's protocol reports that a level change aborted a
// playback, not which map loaded, so a reload of the same map (a death, a `load`) looked like the next map and counted
// as progress (2026-10-02, found by reading the flow). Started with -condebug, the engine writes portal/console.log, and
// portal-agent's demo autorecord starts a demo at every level load, named after the map. Measured on the real game
// (2026-10-02 02:10, Source Unpack build 5135): a new map prints `Recording to .\agent_runs\<time>\testchmb_a_01.dem...`;
// a reload of the same map (a `load`, the autosave after a death) prints `…\testchmb_a_01_1.dem...`, the map's name with
// a number after it.
import fs from "node:fs";
import path from "node:path";

/** Where the engine writes its console log when the game is started with `-condebug`. */
export const consoleLogPath = (gameRoot) => (gameRoot ? path.join(gameRoot, "portal", "console.log") : null);

const RECORDING = /Recording to [^\n]*?[\\/]([a-z0-9_]+)\.dem/gi;

/**
 * Every map a piece of console log shows loading, in order. `known` are the campaign's map names: a demo named
 * `<map>_<n>` is a reload of `<map>`, but map names end in digits themselves (testchmb_a_01), so the number is taken
 * off only when what remains is a known map.
 */
export function mapsInLog(text, known = []) {
  const names = new Set(known);
  return [...String(text).matchAll(RECORDING)].map((m) => {
    const name = m[1].toLowerCase();
    if (names.has(name)) return name;
    const base = name.replace(/_\d+$/, "");
    return names.has(base) ? base : name;
  });
}

/**
 * Follows the console log from where it ends now: `read()` gives the maps loaded since the last read. `available` is
 * false when the game writes no log (started without -condebug): then nothing can be said about the map.
 */
export function createConsoleMaps(logFile, known = []) {
  let offset = logFile && fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  return {
    get available() { return Boolean(logFile && fs.existsSync(logFile)); },
    read() {
      if (!logFile || !fs.existsSync(logFile)) return [];
      const size = fs.statSync(logFile).size;
      if (size < offset) offset = 0; // a new game session started a new log
      if (size === offset) return [];
      const fd = fs.openSync(logFile, "r");
      const buffer = Buffer.alloc(size - offset);
      try { fs.readSync(fd, buffer, 0, buffer.length, offset); } finally { fs.closeSync(fd); }
      offset = size;
      return mapsInLog(buffer.toString("utf8"), known);
    },
  };
}
