#!/usr/bin/env node
// Copy portal-agent's game-side files into a Source Unpack folder, exactly as
// portal-agent's setup guide step 2 does by hand: spt.dll, spt.vdf,
// agent_run.cfg, portal_agent.cfg, and `exec portal_agent` in autoexec.cfg.
// Existing files are backed up as <name>.aas-backup once; the exec line is
// added only if missing.
//
// Usage: node games/portal/install-game-files.mjs [--game-root <Source Unpack folder>] [--spt-dll <path>]   (default: AAS_PORTAL_GAME_ROOT)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "../../packages/core/src/settings.mjs";

// This game's own settings, then the machine's: the same two files every command reads (settings.mjs).
loadSettings(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const portalAgent = path.resolve(process.env.AAS_PORTAL_AGENT_DIR || path.join(repoRoot, ".local", "portal-agent"));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const gameRoot = opt("--game-root") ?? process.env.AAS_PORTAL_GAME_ROOT;
if (!gameRoot) throw new Error("Usage: install-game-files --game-root <Source Unpack folder> [--spt-dll <path>] (or AAS_PORTAL_GAME_ROOT)");
const sptDll = opt("--spt-dll") ?? path.join(repoRoot, ".local", "SourcePauseTool", "build", "Release", "spt.dll");
const portalDir = path.join(gameRoot, "portal");
if (!fs.existsSync(path.join(portalDir, "cfg"))) throw new Error(`${portalDir}/cfg not found; is ${gameRoot} a Source Unpack folder?`);
if (!fs.existsSync(sptDll)) throw new Error(`spt.dll not found at ${sptDll}. Build it first (tools/prepare-spt.ps1 + tools/build-spt.ps1 in ${portalAgent}) or pass --spt-dll.`);

function install(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) {
    if (fs.readFileSync(src).equals(fs.readFileSync(dst))) { console.log(`unchanged ${dst}`); return; }
    const backup = `${dst}.aas-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(dst, backup);
  }
  fs.copyFileSync(src, dst);
  console.log(`installed ${dst}`);
}
install(sptDll, path.join(portalDir, "spt.dll"));
install(path.join(portalAgent, "game-config", "spt.vdf"), path.join(portalDir, "addons", "spt.vdf"));
install(path.join(portalAgent, "game-config", "agent_run.cfg"), path.join(portalDir, "cfg", "agent_run.cfg"));
install(path.join(portalAgent, "game-config", "autoexec.cfg"), path.join(portalDir, "cfg", "portal_agent.cfg"));
const autoexec = path.join(portalDir, "cfg", "autoexec.cfg");
const current = fs.existsSync(autoexec) ? fs.readFileSync(autoexec, "utf8") : "";
if (!/^\s*exec\s+portal_agent\s*$/m.test(current)) {
  fs.appendFileSync(autoexec, `${current && !current.endsWith("\n") ? "\n" : ""}exec portal_agent\n`);
  console.log(`added "exec portal_agent" to ${autoexec}`);
} else console.log(`unchanged ${autoexec}`);
for (const f of ["hl2/addons/speedrun_demorecord-2007.dll", "portal/addons/speedrun_demorecord-2007.vdf"]) {
  if (!fs.existsSync(path.join(gameRoot, f))) console.log(`warning: ${f} missing; the unpack's demo recorder is needed for start_run`);
}
console.log("Done. In the game console: exec portal_agent, then start_run (or let `aas run --recorder source-demo` send it).");
