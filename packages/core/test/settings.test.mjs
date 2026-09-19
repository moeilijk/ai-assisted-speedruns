// Two files, one order: a game's own settings win over the machine's, and the shell wins over both.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-settings-"));
process.env.AAS_ENV_FILE = path.join(dir, ".env");
process.env.AAS_GAME_ENV_DIR = path.join(dir, "games");
fs.mkdirSync(process.env.AAS_GAME_ENV_DIR, { recursive: true });
const { ENV_FILE, GAME_ENV_DIR, gameEnvFile, gameName, loadSettings, readSettings } = await import("../src/settings.mjs");

test("a game's settings file is named after the folder its plugin is in", () => {
  assert.equal(gameName("games/portal/plugin.mjs"), "portal");
  assert.equal(gameName("games/slay-the-spire/launch-game.mjs"), "slay-the-spire");
  assert.equal(gameName("file:///repo/games/balatro/plugin.mjs"), "balatro");
  assert.equal(gameEnvFile("games/portal/plugin.mjs"), path.join(GAME_ENV_DIR, "portal.env"));
});

test("the game's own value wins over the machine's, and the shell wins over both", () => {
  fs.writeFileSync(ENV_FILE, "AAS_SHARED=from-env\nAAS_ONLY_MACHINE=machine\n");
  fs.writeFileSync(gameEnvFile("portal"), "AAS_SHARED=from-game\nAAS_ONLY_GAME=game\n");
  for (const k of ["AAS_SHARED", "AAS_ONLY_MACHINE", "AAS_ONLY_GAME"]) delete process.env[k];
  process.env.AAS_SHARED = undefined;
  delete process.env.AAS_SHARED;
  const loaded = loadSettings("games/portal/plugin.mjs");
  assert.equal(loaded.length, 2, "both files were read");
  assert.equal(process.env.AAS_SHARED, "from-game", "the game's file is loaded first, so its value stands");
  assert.equal(process.env.AAS_ONLY_MACHINE, "machine");
  assert.equal(process.env.AAS_ONLY_GAME, "game");
});

test("without a game only the machine's file is read", () => {
  for (const k of ["AAS_SHARED", "AAS_ONLY_GAME"]) delete process.env[k];
  loadSettings(null);
  assert.equal(process.env.AAS_SHARED, "from-env");
  assert.equal(process.env.AAS_ONLY_GAME, undefined, "a game's file is not read when no game is named");
});

test("readSettings shows what a run would see, from every game at once", () => {
  fs.writeFileSync(gameEnvFile("balatro"), "AAS_BALATRO_GAME_ROOT=/games/balatro\n");
  const all = readSettings();
  assert.equal(all.AAS_ONLY_MACHINE, "machine");
  assert.equal(all.AAS_BALATRO_GAME_ROOT, "/games/balatro");
  assert.equal(all.AAS_SHARED, "from-game", "a game's file wins here too");
});
