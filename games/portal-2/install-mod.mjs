#!/usr/bin/env node
// Puts SourceAutoRecord next to Portal 2 and writes the config that loads it.
//
// SAR is a release file, pinned by version and sha256 in UPSTREAM.json: what is downloaded is compared with that
// hash and refused when it differs. Nothing of the game's own configuration is touched — the config this writes has
// its own name and the launcher runs it with `+exec`.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadSettings } from "../../packages/core/src/settings.mjs";

// This game's own settings, then the machine's: the same two files every command reads (settings.mjs).
loadSettings(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_NAME = "aas_portal2";
const { sar } = JSON.parse(fs.readFileSync(path.join(here, "UPSTREAM.json"), "utf8"));

export async function installSar({ root = process.env.AAS_PORTAL2_GAME_ROOT, port = Number(process.env.AAS_PORTAL2_PORT ?? 6555), log = console.log } = {}) {
  if (!root) throw new Error("AAS_PORTAL2_GAME_ROOT is not set (the folder with portal2.exe).");
  const game = path.resolve(root);
  if (!fs.existsSync(path.join(game, "portal2.exe"))) throw new Error(`portal2.exe is not in ${game}.`);

  const target = path.join(game, sar.file);
  const have = fs.existsSync(target) ? createHash("sha256").update(fs.readFileSync(target)).digest("hex") : null;
  if (have === sar.sha256) log(`${sar.file} is already ${sar.version} (sha256 matches).`);
  else {
    log(`downloading ${sar.name} ${sar.version} from ${sar.url}`);
    const res = await fetch(sar.url);
    if (!res.ok) throw new Error(`${sar.url}: ${res.status} ${res.statusText}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== sar.sha256) throw new Error(`${sar.file} is not the pinned build: sha256 ${got}, expected ${sar.sha256}.`);
    fs.writeFileSync(target, bytes);
    log(`${sar.file}: ${bytes.length} bytes, sha256 ${got.slice(0, 16)}… → ${target}`);
  }

  // The config the launcher runs. Its own file, so the player's autoexec.cfg stays theirs.
  const cfgDir = path.join(game, "portal2", "cfg");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfg = path.join(cfgDir, `${CONFIG_NAME}.cfg`);
  fs.writeFileSync(cfg, [
    "// Written by games/portal-2/install-mod.mjs (AI Assisted Speedruns). Loads SourceAutoRecord and opens its TAS",
    "// protocol server, which is the only way the harness talks to this game.",
    `${sar.commands.load}`,
    `sar_tas_protocol_server ${port}`,
    "",
  ].join("\n"));
  log(`config: ${cfg} (${sar.commands.load}; sar_tas_protocol_server ${port})`);
  return { sar: target, cfg };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await installSar({});
