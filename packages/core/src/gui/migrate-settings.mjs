#!/usr/bin/env node
// Moves the settings of a game out of .env into that game's own file (.local/games/<game>.env).
//
// Which setting belongs to which game is what the plugins say (their `env` list, their settings, their display and
// resolution): nothing is guessed here. Run twice and the second run moves nothing — what is already in the game's
// file is not in .env any more.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_FILE, gameEnvFile } from "../settings.mjs";
import { settingOwners } from "./checks.mjs";
import { readEnv, writeEnv } from "./env-file.mjs";

export async function migrateSettings({ log = console.log } = {}) {
  const owners = await settingOwners();
  const env = readEnv(ENV_FILE);
  const moved = [];
  for (const [key, value] of Object.entries(env)) {
    const game = owners[key];
    if (!game) continue;
    const file = gameEnvFile(game);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeEnv({ [key]: value }, file);
    writeEnv({ [key]: "" }, ENV_FILE);     // an empty value removes the line
    process.env[key] = value;              // writeEnv("") deleted it from this process
    moved.push([key, game]);
    log(`${key} -> ${file}`);
  }
  if (!moved.length) log("nothing to move: every game setting is already in its own file");
  return moved;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await migrateSettings({});
