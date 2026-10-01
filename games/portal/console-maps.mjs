// The map a Portal run is in, from the engine's own console log. SPT's protocol reports that a level change aborted a
// playback, not which map loaded, so a reload of the same map (a death, a `load`) looked like the next map and counted
// as progress (2026-10-02, found by reading the flow). Started with -condebug, the engine writes portal/console.log,
// and the SPT build of this setup prints `spt_pause_on_portal_start: level init <map>` at every level load.
import fs from "node:fs";
import path from "node:path";

/** Where the engine writes its console log when the game is started with `-condebug`. */
export const consoleLogPath = (gameRoot) => (gameRoot ? path.join(gameRoot, "portal", "console.log") : null);

const LOAD = /(?:level init ([a-z0-9_]+))|(?:Loading map "([a-z0-9_]+)")/gi;

/** Every map a piece of console log names as loaded, in order. */
export function mapsInLog(text) {
  return [...String(text).matchAll(LOAD)].map((m) => (m[1] ?? m[2]).toLowerCase());
}

/**
 * Follows the console log from where it ends now: `read()` gives the maps loaded since the last read. `available` is
 * false when the game writes no log (started without -condebug): then nothing can be said about the map.
 */
export function createConsoleMaps(logFile) {
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
      return mapsInLog(buffer.toString("utf8"));
    },
  };
}
