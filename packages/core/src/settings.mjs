// Where the machine's settings live, and in which order they win.
//
// `.env` in the repository holds what is true for the whole machine: OBS, LiveSplit, the output location, budgets,
// sound and screens. Everything that belongs to one game — its folder, its window, its own variables — lives in
// `.local/games/<game>.env`, one file per game, next to the other machine state the GUI keeps (`.local/` is never
// published, so nothing machine-specific ends up in `games/`, which is the plugin as everyone else gets it).
//
// Precedence, highest first: the shell, then the game's own file, then `.env`. That falls out of the loading order,
// because `process.loadEnvFile` never overwrites a variable that is already set.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const ENV_FILE = process.env.AAS_ENV_FILE || path.join(REPO, ".env");
export const GAME_ENV_DIR = process.env.AAS_GAME_ENV_DIR || path.join(REPO, ".local", "games");

/** The name a game's settings file has: the folder of its plugin (games/<name>/plugin.mjs). */
export function gameName(gameModule) {
  if (!gameModule) return null;
  const file = gameModule.startsWith("file:") ? fileURLToPath(gameModule) : gameModule;
  const dir = /\.m?js$/.test(file) ? path.dirname(path.resolve(file)) : path.resolve(file);
  return path.basename(dir) || null;
}

/** The settings file of one game, whether it exists or not. */
export const gameEnvFile = (game) => path.join(GAME_ENV_DIR, `${gameName(game) ?? game}.env`);

/** The settings of every game and of the machine, merged as a run sees them: a game's own file wins. */
export function readSettings() {
  const out = {};
  const one = (file) => {
    if (!fs.existsSync(file)) return {};
    const values = {};
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
      if (m) values[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
    }
    return values;
  };
  Object.assign(out, one(ENV_FILE));
  try { for (const f of fs.readdirSync(GAME_ENV_DIR)) if (f.endsWith(".env")) Object.assign(out, one(path.join(GAME_ENV_DIR, f))); } catch { /* no game settings yet */ }
  return out;
}

/**
 * Loads the settings for a command. `game` is a plugin path, a game folder or a game name; without it only the
 * machine's own `.env` is loaded. Call it before anything reads process.env.
 */
export function loadSettings(game = null) {
  const loaded = [];
  const file = game ? gameEnvFile(game) : null;
  // The game's own file first: what is loaded first wins.
  for (const f of [file, ENV_FILE]) {
    if (f && fs.existsSync(f)) { process.loadEnvFile(f); loaded.push(f); }
  }
  return loaded;
}
