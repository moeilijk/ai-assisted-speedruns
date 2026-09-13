#!/usr/bin/env node
// Installs what the Slay the Spire plugin needs on the Windows side:
//   <game>/mods/CommunicationMod.jar  (pinned release, sha256 checked; ModTheSpire + BaseMod come from the Workshop)
//   <tools>/bridge.mjs                (a copy of games/slay-the-spire/bridge.mjs for Windows Node; the mod spawns it)
//   %LOCALAPPDATA%/ModTheSpire/CommunicationMod/config.properties  (command=<node> <bridge> <port>, runAtGameStart=true)
// Env: AAS_STS_GAME_ROOT (the game folder), AAS_STS_TOOLS_DIR (where the bridge copy goes; default <game>/aas), AAS_STS_PORT
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.env.AAS_STS_GAME_ROOT;
if (!root) throw new Error("AAS_STS_GAME_ROOT is not set (the Slay the Spire folder)");
const tools = process.env.AAS_STS_TOOLS_DIR ?? path.join(root, "aas");
const port = Number(process.env.AAS_STS_PORT ?? 27183);
const here = path.dirname(new URL(import.meta.url).pathname);
const upstream = JSON.parse(fs.readFileSync(path.join(here, "UPSTREAM.json"), "utf8")).communication_mod;
const win = (p) => execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
const ps = (cmd) => execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).replace(/\r/g, "").trim();

// 1. the mod jar
fs.mkdirSync(path.join(root, "mods"), { recursive: true });
const jar = path.join(root, "mods", "CommunicationMod.jar");
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
if (!fs.existsSync(jar) || sha(jar) !== upstream.sha256) {
  console.log(`downloading Communication Mod ${upstream.version}`);
  const res = await fetch(upstream.jar);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== upstream.sha256) throw new Error(`sha256 mismatch for CommunicationMod.jar: ${got}`);
  fs.writeFileSync(jar, buf);
}
console.log(`mod: ${jar} (sha256 ok, ${upstream.version})`);
// BaseMod next to it: ModTheSpire resolves --mods from <game>/mods first, so the run does not
// depend on its Workshop query (which needs a Steam connection the launcher does not always have).
const workshop = process.env.AAS_STS_WORKSHOP ?? path.resolve(root, "..", "..", "workshop", "content", "646570");
const baseModSrc = path.join(workshop, "1605833019", "BaseMod.jar");
if (!fs.existsSync(baseModSrc)) throw new Error(`BaseMod.jar not found at ${baseModSrc}: subscribe to BaseMod (Workshop 1605833019) in Steam`);
fs.copyFileSync(baseModSrc, path.join(root, "mods", "BaseMod.jar"));
console.log(`basemod: ${path.join(root, "mods", "BaseMod.jar")} (copied from the Workshop)`);

// 2. the bridge, on a Windows path (Windows Node cannot be trusted with \\wsl.localhost paths)
fs.mkdirSync(tools, { recursive: true });
const bridge = path.join(tools, "bridge.mjs");
fs.copyFileSync(path.join(here, "bridge.mjs"), bridge);
console.log(`bridge: ${bridge}`);

// 3. the mod's config: Java Properties, so backslashes and colons are escaped; node's 8.3 path has no spaces
const nodeExe = ps("(Get-Command node.exe).Source");
const shortNode = ps(`(New-Object -ComObject Scripting.FileSystemObject).GetFile('${nodeExe}').ShortPath`);
const configDir = ps("Join-Path $env:LOCALAPPDATA 'ModTheSpire\\CommunicationMod'");
ps(`New-Item -ItemType Directory -Force -Path '${configDir}' | Out-Null`);
const configFile = execFileSync("wslpath", ["-u", `${configDir}\\config.properties`], { encoding: "utf8" }).trim();
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/=/g, "\\=");
const command = `${shortNode} ${win(bridge)} ${port}`;
fs.writeFileSync(configFile, `# written by aas (games/slay-the-spire/install-mod.mjs)\ncommand=${esc(command)}\nrunAtGameStart=true\nverbose=false\nmaxInitializationTimeout=30\n`);
console.log(`config: ${configFile}\n  command=${command}`);
