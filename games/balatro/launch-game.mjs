#!/usr/bin/env node
// Starts Balatro with Lovely and the mods from <tools>/Mods (Steamodded + balatrobot), starts the bridge
// (games/balatro/bridge.mjs) and waits until the game answers through it. A game that is already up is left
// alone, so tests can run one after another against the same game.
// Env: AAS_BALATRO_GAME_ROOT, AAS_BALATRO_TOOLS_DIR, AAS_BALATRO_PORT (bridge, 12347), AAS_BALATRO_BOT_PORT (balatrobot, 12346),
// AAS_BALATRO_PROFILE (the game's profile slot for the run, 1-3, default 3; the player's own slot is put back by close-game).
// Optional, per machine (all off by default), as for Slay the Spire: AAS_BALATRO_WINDOW_POS (X,Y: the display to play on,
// set through the game's own display setting, borderless), AAS_QUIET_AUDIO_DEVICE + AAS_SOUNDVOLUMEVIEW (game audio
// away from the speakers while it starts), AAS_KEEP_DISPLAYS_AWAKE=1.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { jsonRpcClient } from "../../packages/core/src/json-rpc-http.mjs";
import { ensureSteam } from "../../packages/core/src/windows/steam.mjs";
import { beforeGameStart } from "../../packages/core/src/windows/quiet-start.mjs";
import { BOT_PORT, BRIDGE_PORT, gamePath, readBridgeState } from "./bridge.mjs";
import { toolsDir } from "./plugin.mjs";
import { listDisplays } from "../../packages/core/src/windows/displays.mjs";
import { parkCursor } from "../../packages/core/src/windows/park-cursor.mjs";
import { loadSettings } from "../../packages/core/src/settings.mjs";

// This game's own settings, then the machine's: the same two files every command reads (settings.mjs).
loadSettings(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.AAS_BALATRO_GAME_ROOT;
if (!root) throw new Error("AAS_BALATRO_GAME_ROOT is not set");
const tools = toolsDir(path.resolve(root));
const upstream = JSON.parse(fs.readFileSync(path.join(here, "UPSTREAM.json"), "utf8"));
const port = Number(process.env.AAS_BALATRO_PORT || BRIDGE_PORT);
const botPort = Number(process.env.AAS_BALATRO_BOT_PORT || BOT_PORT);
const profile = Number(process.env.AAS_BALATRO_PROFILE || 3);
if (![1, 2, 3].includes(profile)) throw new Error(`AAS_BALATRO_PROFILE must be 1, 2 or 3, not ${process.env.AAS_BALATRO_PROFILE}`);
for (const f of [path.join(root, "Balatro.exe"), path.join(root, "version.dll"), path.join(tools, "Mods", "smods"), path.join(tools, "Mods", "balatrobot", "balatrobot.json")]) {
  if (!fs.existsSync(f)) throw new Error(`missing ${f} (npm run balatro:install)`);
}

const health = async (p, headers = {}) => { try { return (await jsonRpcClient({ port: p, timeoutMs: 3000, headers }).call("health"))?.status === "ok"; } catch { return false; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The bridge: one per machine, started detached; its state file carries the pid and the harness's token.
async function ensureBridge() {
  const state = readBridgeState();
  if (state && state.port === port && alive(state.pid)) return `running (pid ${state.pid})`;
  const log = fs.openSync(path.join(tools, "bridge.log"), "a");
  const child = spawn(process.execPath, [path.join(here, "bridge.mjs"), "--port", String(port), "--bot-port", String(botPort)], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    const s = readBridgeState();
    if (s && s.pid === child.pid) return `started (pid ${child.pid}, port ${port})`;
  }
  throw new Error(`the bridge did not start (see ${path.join(tools, "bridge.log")})`);
}

if (await health(botPort)) {
  console.log(`Balatro is already running (balatrobot on ${botPort}).`);
  console.log(`bridge: ${await ensureBridge()}`);
  process.exit(0);
}

// The game's own settings file (%AppData%/Balatro/settings.jkr, deflate-compressed Lua) names the profile slot it
// opens. The run gets its own slot, so the player's profile (its unlocks, stats and saved run) is not touched.
const text = (cmd, args) => (spawnSync(cmd, args, { encoding: "utf8", cwd: "/mnt/c" }).stdout ?? "").trim();
const appData = text("wslpath", ["-u", text("cmd.exe", ["/c", "echo %APPDATA%"])]);
const settings = path.join(appData, "Balatro", "settings.jkr");
// AAS_BALATRO_WINDOW_POS names the display to play on. The game has its own display setting (Options > Settings >
// Display: monitor and window mode), a number in the order SDL gives the displays: the primary display first, then the
// others in Windows' own order (the display sizes the game stores next to that number do not follow this order). The
// mode is the game's own Borderless, which fills that monitor.
const wantedPos = process.env.AAS_BALATRO_WINDOW_POS || null;
const display = wantedPos ? (() => {
  const [wx, wy] = wantedPos.split(",").map(Number);
  const all = listDisplays();
  const ordered = [...all.filter((d) => d.primary), ...all.filter((d) => !d.primary)];
  const i = ordered.findIndex((d) => wx >= d.x && wx < d.x + d.width && wy >= d.y && wy < d.y + d.height);
  return i < 0 ? null : { ...ordered[i], number: i + 1 };
})() : null;
if (wantedPos && !display) throw new Error(`AAS_BALATRO_WINDOW_POS=${wantedPos} is on no display`);
let version = null;
if (fs.existsSync(settings)) {
  const lua = zlib.inflateRawSync(fs.readFileSync(settings)).toString("utf8");
  version = lua.match(/\["version"\]="([^"]+)"/)?.[1] ?? null;
  let next = lua;
  const current = Number(lua.match(/\["profile"\]=(\d+)/)?.[1] ?? 1);
  if (current !== profile) { next = next.replace(/\["profile"\]=\d+/, `["profile"]=${profile}`); console.log(`profile: slot ${profile} for the run (was ${current})`); }
  if (display) {
    next = next.replace(/\["selected_display"\]=\d+/, `["selected_display"]=${display.number}`).replace(/\["screenmode"\]="[^"]*"/, '["screenmode"]="Borderless"');
    console.log(`display: the game's display ${display.number} (${display.name}, ${display.width}x${display.height} at ${display.x},${display.y}), borderless`);
  }
  if (next !== lua) {
    const backup = `${settings}.aas-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(settings, backup);
    fs.writeFileSync(settings, zlib.deflateRawSync(Buffer.from(next, "utf8")));
    console.log("settings: settings.jkr changed for the run (backup settings.jkr.aas-backup, restored by close-game)");
  }
}
if (version && version !== upstream.balatro.tested_version) console.log(`note: Balatro ${version}; the plugin was tested with ${upstream.balatro.tested_version}`);
fs.writeFileSync(path.join(tools, "launch.json"), JSON.stringify({ version, profile, started_at: new Date().toISOString() }, null, 2));

console.log(`steam: ${await ensureSteam({ log: console.log })}`);
// balatrobot reads its settings from the environment; a Windows program started from WSL gets only the
// variables listed in WSLENV.
const botEnv = { ...upstream.balatrobot.settings, BALATROBOT_HOST: "127.0.0.1", BALATROBOT_PORT: String(botPort) };
const env = { ...process.env, ...botEnv, WSLENV: [process.env.WSLENV, ...Object.keys(botEnv)].filter(Boolean).join(":") };
const quiet = await beforeGameStart({ processName: "Balatro.exe", snapshotFile: path.join(tools, "aas-audio-defaults.json") });
const exe = path.join(root, "Balatro.exe");
const args = ["--mod-dir", gamePath(path.join(tools, "Mods")), "--disable-console"];
console.log(`starting ${exe} ${args.join(" ")}`);
const logFd = fs.openSync(path.join(tools, "game.log"), "w");
const child = spawn(exe, args, { cwd: root, env, detached: true, stdio: ["ignore", logFd, logFd] });
child.on("error", (e) => { throw new Error(`could not start Balatro: ${e.message}`); });
child.unref();
const deadline = Date.now() + 120000;
let up = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  if (await health(botPort)) { up = true; break; }
}
quiet.restore();
if (!up) throw new Error(`Balatro started but balatrobot did not answer on ${botPort} within 120 s (see ${path.join(tools, "Mods", "lovely", "log")})`);
console.log(`Balatro is up; balatrobot on ${botPort}.`);
// The game reads where the cursor rests: to the right of a window on the left display it counts as resting on the
// deck, the deck preview opens and the Play and Discard buttons are never made (measured 2026-09-26).
console.log(parkCursor({ processName: "Balatro" }) ?? "cursor: not moved (no Balatro window found)");
console.log(`bridge: ${await ensureBridge()}`);
const token = readBridgeState()?.token;
if (!(await health(port, { "X-AAS-Token": token }))) throw new Error(`the bridge on ${port} does not reach balatrobot`);
console.log(`bridge answers on ${port}.`);
quiet.check();
