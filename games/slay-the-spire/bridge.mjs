#!/usr/bin/env node
// The process Communication Mod starts with the game (config key `command`):
// the mod writes one JSON game state per line to our stdin and reads commands
// from our stdout. This bridge exposes that as a TCP line protocol on
// 127.0.0.1:27183 for the AAS game plugin (one client at a time; the latest
// state is sent on connect). Lines starting with `{"aas":` are for the bridge
// itself (screenshot of the game window) and never reach the game.
// Runs under Windows Node (the mod spawns a Windows process); stderr goes to
// communication_mod_errors.log next to the game.
import net from "node:net";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { loadSettings } from "../../packages/core/src/settings.mjs";

// This game's own settings, then the machine's: the same two files every command reads (settings.mjs).
loadSettings(import.meta.url);

const port = Number(process.argv[2] || process.env.AAS_STS_PORT || 27183);
const title = process.env.AAS_STS_WINDOW_TITLE || "Slay the Spire";
let client = null;
let lastState = null;
const log = (t) => process.stderr.write(`[aas sts bridge] ${t}\n`);

// The game window's client area as a PNG (base64), scaled to 960 px wide; PowerShell + System.Drawing.
function screenshot() {
  const ps = `
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace X -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
public struct RECT { public int L,T,R,B; } public struct POINT { public int X,Y; }
'@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like ${JSON.stringify(`*${title}*`)} } | Select-Object -First 1
if (-not $proc) { throw "window '*${title}*' not found" }
$h = $proc.MainWindowHandle
$r = New-Object X.W+RECT; [X.W]::GetClientRect($h, [ref]$r) | Out-Null
$p = New-Object X.W+POINT; [X.W]::ClientToScreen($h, [ref]$p) | Out-Null
$w = $r.R - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($p.X, $p.Y, 0, 0, $bmp.Size); $g.Dispose()
$nh = [int][Math]::Round(960 * $hh / $w)
$small = New-Object System.Drawing.Bitmap($bmp, 960, $nh)
$ms = New-Object System.IO.MemoryStream; $small.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return { error: (r.stderr || "screenshot failed").trim().split("\n")[0] };
  return { png: r.stdout.trim(), width: 960 };
}

// Click at game coordinates (1920x1080 space) with a real mouse event on the game window's client
// area; the cursor is put back afterwards. Used for "Continue" at the main menu, where the mod
// only accepts START and STATE.
function click(gx, gy) {
  const ps = `
Add-Type -Namespace X -Name M -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
public struct RECT { public int L,T,R,B; } public struct POINT { public int X,Y; }
'@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like ${JSON.stringify(`*${title}*`)} } | Select-Object -First 1
if (-not $proc) { throw "window '*${title}*' not found" }
$h = $proc.MainWindowHandle
$r = New-Object X.M+RECT; [X.M]::GetClientRect($h, [ref]$r) | Out-Null
$o = New-Object X.M+POINT; [X.M]::ClientToScreen($h, [ref]$o) | Out-Null
$w = $r.R - $r.L; $hh = $r.B - $r.T
$sx = $o.X + [int]([Math]::Round(${gx} * $w / 1920.0)); $sy = $o.Y + [int]([Math]::Round(${gy} * $hh / 1080.0))
$old = New-Object X.M+POINT; [X.M]::GetCursorPos([ref]$old) | Out-Null
[X.M]::SetCursorPos($sx, $sy) | Out-Null; Start-Sleep -Milliseconds 120
[X.M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60; [X.M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 120; [X.M]::SetCursorPos($old.X, $old.Y) | Out-Null
"clicked at screen $sx,$sy (client $w x $hh)"
`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  if (r.status !== 0) return { error: (r.stderr || "click failed").trim().split("\n")[0] };
  return { ok: true, detail: r.stdout.trim() };
}

const server = net.createServer((sock) => {
  if (client) client.destroy();
  client = sock;
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      if (line.startsWith('{"aas":')) {
        let req = {};
        try { req = JSON.parse(line); } catch { /* ignore */ }
        if (req.aas === "screenshot") sock.write(`${JSON.stringify({ aas: "screenshot", ...screenshot() })}\n`);
        else if (req.aas === "click") sock.write(`${JSON.stringify({ aas: "click", ...click(Number(req.x) || 0, Number(req.y) || 0) })}\n`);
        else if (req.aas === "state") sock.write(`${JSON.stringify({ aas: "state", state: lastState ? JSON.parse(lastState) : null })}\n`);
        continue;
      }
      process.stdout.write(`${line}\n`); // a command for the game
    }
  });
  sock.on("close", () => { if (client === sock) client = null; });
  sock.on("error", () => {});
  sock.write(lastState ? `${lastState}\n` : '{"aas":"hello","state":null}\n');
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write("ready\n"); // Communication Mod's handshake
  log(`listening on 127.0.0.1:${port}`);
});
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  lastState = line;
  if (client) client.write(`${line}\n`);
});
rl.on("close", () => { log("game closed stdin; exiting"); process.exit(0); });
