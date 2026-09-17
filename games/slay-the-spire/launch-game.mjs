#!/usr/bin/env node
// Starts Slay the Spire with ModTheSpire (BaseMod + Communication Mod, no
// launcher UI) and waits for the bridge on 127.0.0.1:27183.
// Env: AAS_STS_GAME_ROOT, AAS_STS_WORKSHOP (workshop content folder for app 646570), AAS_STS_PORT.
// Optional, per machine (all off by default): AAS_STS_WINDOW_POS (X,Y: move the window, e.g. to a
// secondary display), AAS_QUIET_AUDIO_DEVICE + AAS_SOUNDVOLUMEVIEW (game audio away from the
// speakers while it starts), AAS_KEEP_DISPLAYS_AWAKE=1.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ensureSteam } from "../../packages/core/src/windows/steam.mjs";
import { listDisplays } from "../../packages/core/src/windows/displays.mjs";
import { beforeGameStart } from "../../packages/core/src/windows/quiet-start.mjs";

const root = process.env.AAS_STS_GAME_ROOT;
if (!root) throw new Error("AAS_STS_GAME_ROOT is not set");
const workshop = process.env.AAS_STS_WORKSHOP ?? path.resolve(root, "..", "..", "workshop", "content", "646570");
const port = Number(process.env.AAS_STS_PORT ?? 27183);
// AAS_STS_WINDOW_POS names the display to record on; the window is then placed on that display's real
// bounds as Windows reports them, not on the typed numbers (a display can shift by a pixel, and then the
// bottom of the window falls off the screen and the taskbar ends up in the recording).
const wanted_pos = process.env.AAS_STS_WINDOW_POS || null;
const display = wanted_pos ? (() => {
  const [wx, wy] = wanted_pos.split(",").map(Number);
  const all = listDisplays();
  return all.find((d) => wx >= d.x && wx < d.x + d.width && wy >= d.y && wy < d.y + d.height)
    ?? all.reduce((best, d) => (Math.hypot(d.x - wx, d.y - wy) < Math.hypot(best.x - wx, best.y - wy) ? d : best), all[0]);
})() : null;
const pos = display ? `${display.x},${display.y}` : null;
const [x, y] = display ? [display.x, display.y] : [null, null];
const mts = path.join(workshop, "1605060445", "ModTheSpire.jar");
const java = path.join(root, "jre", "bin", "java.exe");
for (const f of [mts, java, path.join(root, "mods", "CommunicationMod.jar")]) if (!fs.existsSync(f)) throw new Error(`missing ${f} (Workshop: ModTheSpire 1605060445 + BaseMod 1605833019; npm run sts:install)`);
// The game's own display config (width, height, fps, fullscreen, borderless, vsync per line) and sound
// preference: windowed 1920x1080 for the capture, no muting when the window is not in the foreground.
const displayConfig = path.join(root, "info.displayconfig");
// The game's own DisplayConfig: width, height, fps_limit, isFullscreen, wfs (borderless), vsync.
// The game only enables its own borderless mode when the size equals the desktop mode of the PRIMARY
// display, so on a second display it runs windowed. A titled window of the display's size does not fit on
// that display (its client is pushed past the screen edge and the recording shows the taskbar), so the
// window is made undecorated through LWJGL's own switch below instead.
const wanted = `${process.env.AAS_STS_RESOLUTION ?? (display ? `${display.width}x${display.height}` : "1920x1080")}`.split("x").join("\n") + "\n60\nfalse\nfalse\ntrue\n";
if (!fs.existsSync(displayConfig) || fs.readFileSync(displayConfig, "utf8") !== wanted) { fs.writeFileSync(displayConfig, wanted); console.log(`display: info.displayconfig set to windowed ${wanted.split("\n").slice(0, 2).join("x")}`); }
// The game shows the profile name in its HUD, so it lands in every recording: a neutral name for the
// run (AAS_STS_PLAYER_NAME, default "AAS"); stop-all puts the player's own name back from the backup.
const playerPrefs = path.join(root, "preferences", "STSPlayer");
const runName = process.env.AAS_STS_PLAYER_NAME || "AAS";
if (fs.existsSync(playerPrefs)) {
  const player = JSON.parse(fs.readFileSync(playerPrefs, "utf8"));
  if (player.name !== runName) {
    if (!fs.existsSync(`${playerPrefs}.aas-backup`)) fs.copyFileSync(playerPrefs, `${playerPrefs}.aas-backup`);
    fs.writeFileSync(playerPrefs, JSON.stringify({ ...player, name: runName }, null, 2));
    console.log(`profile: name set to "${runName}" for the recording (backup in STSPlayer.aas-backup; restored by stop-all)`);
  }
}
const soundPrefs = path.join(root, "preferences", "STSSound");
if (fs.existsSync(soundPrefs)) { const snd = JSON.parse(fs.readFileSync(soundPrefs, "utf8")); if (snd["Mute in Bg"] !== "false") { snd["Mute in Bg"] = "false"; fs.writeFileSync(soundPrefs, JSON.stringify(snd, null, 2)); console.log("sound: Mute in Bg -> false (the game runs without focus while the agent plays)"); } }
// Only when the window is moved: the JVM is system-DPI-aware, so Windows rescales its window when
// it moves to a display with another DPI and the game keeps drawing its old size in a corner. The
// per-application "override high DPI scaling" compatibility flag (HKCU, this java.exe only) makes
// the window keep its pixel size across displays.
if (pos) {
  const javaWin = execFileSync("wslpath", ["-w", java], { encoding: "utf8" }).trim();
  const layers = "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers";
  const current = spawnSync("reg.exe", ["query", layers, "/v", javaWin], { encoding: "utf8" }).stdout ?? "";
  if (!/HIGHDPIAWARE/.test(current)) { spawnSync("reg.exe", ["add", layers, "/v", javaWin, "/t", "REG_SZ", "/d", "~ HIGHDPIAWARE", "/f"], { stdio: "ignore" }); console.log(`dpi: high-DPI override set for ${javaWin}`); }
}
const probe = () => new Promise((res) => { const s = net.connect(port, "127.0.0.1"); s.setTimeout(2000); s.on("connect", () => (s.destroy(), res(true))); s.on("error", () => res(false)); s.on("timeout", () => (s.destroy(), res(false))); });
if (await probe()) { console.log(`Slay the Spire is already running (bridge on ${port}).`); process.exit(0); }
console.log(`steam: ${await ensureSteam({ log: console.log })}`);
const quiet = await beforeGameStart({ processName: "java.exe", snapshotFile: path.join(root, "aas-audio-defaults.json") });
// Windows java gets Windows paths; its output goes to <game>/aas-launch.log for diagnosis.
const win = (p) => execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
// -Dorg.lwjgl.opengl.Window.undecorated: LWJGL's own option for a window without title bar or borders.
// The game sets this property itself in its fullscreen and borderless branches but leaves it alone in the
// windowed branch, so setting it here gives a borderless window at the configured size on any display.
const args = ["-Dorg.lwjgl.opengl.Window.undecorated=true", "-jar", win(mts), "--skip-launcher", "--skip-intro", "--mods", "basemod,CommunicationMod"];
console.log(`starting ${java} ${args.join(" ")}`);
const logFd = fs.openSync(path.join(root, "aas-launch.log"), "w");
const child = spawn(java, args, { cwd: root, detached: true, stdio: ["ignore", logFd, logFd] });
child.on("error", (e) => { throw new Error(`could not start java: ${e.message}`); });
child.unref();
const deadline = Date.now() + 180000;
let up = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  if (await probe()) { up = true; break; }
}
quiet.restore();
if (!up) throw new Error("Slay the Spire started but the bridge did not come up within 180 s (see communication_mod_errors.log in the game folder).");
console.log(`Slay the Spire is up; bridge listening on ${port}.`);
// Optionally move the window (title "Slay the Spire"), e.g. to a secondary display.
const ps = pos ? `
Add-Type -Namespace X -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); public struct RECT { public int L,T,R,B; }'
$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*Slay the Spire*' } | Select-Object -First 1
if (-not $p) { 'window not found' } else {
  $h = $p.MainWindowHandle
  # Only move: with the high-DPI override the window keeps its pixel size across displays (the game does not redraw for an external resize).
  [X.W]::SetWindowPos($h, [IntPtr]::Zero, ${x}, ${y}, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010) | Out-Null; Start-Sleep -Milliseconds 300
  $c = New-Object X.W+RECT; [X.W]::GetClientRect($h, [ref]$c) | Out-Null
  'moved ' + $p.MainWindowTitle + ' to ${x},${y}, client ' + ($c.R - $c.L) + 'x' + ($c.B - $c.T)
}` : null;
if (ps) console.log(`window: ${spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).stdout.trim()}`);
quiet.check();
