// Closes EmuHawk the way a user would, through its game window, so it writes its own config (and with it the trust
// answer). EmuHawk has several windows (the tool's form, the Lua Console), and Windows may name any of them its "main"
// window: closing the Lua Console that way leaves EmuHawk running (measured 2026-09-23). So the window closed is the
// one whose title ends with "BizHawk" ("<game> [<system>] - BizHawk", or "BizHawk" with no game), by WM_CLOSE.
// Called by the plugin's `close()` and by stop-all.mjs.
import { spawnSync } from "node:child_process";
import { afterGameClose } from "../../packages/core/src/windows/quiet-start.mjs";

const PS = (seconds) => `Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class BH { public delegate bool P(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
public static IntPtr GameWindow(uint pid) { IntPtr found = IntPtr.Zero; EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p != pid || !IsWindowVisible(h)) return true; var s = new StringBuilder(512); GetWindowText(h, s, 512); var t = s.ToString(); if (t == "BizHawk" || t.EndsWith(" - BizHawk")) { found = h; return false; } return true; }, IntPtr.Zero); return found; } }
"@
$p = Get-Process EmuHawk -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { 'EmuHawk was not running'; exit }
$h = [BH]::GameWindow([uint32]$p.Id)
if ($h -eq [IntPtr]::Zero) { 'EmuHawk: its game window was not found; left running'; exit }
[void][BH]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
for ($i = 0; $i -lt ${Number(seconds) || 20} -and -not $p.HasExited; $i++) { Start-Sleep 1 }
# The tool's own temporary files (screenshots it rendered) go with it.
if ($p.HasExited) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:TEMP 'bizhawk-mcp'); 'EmuHawk closed' } else { 'EmuHawk did not close within ${Number(seconds) || 20} s; left running' }`;

export async function closeGame({ log = () => {}, seconds = 20 } = {}) {
  const out = (spawnSync("powershell.exe", ["-NoProfile", "-Command", PS(seconds)], { encoding: "utf8", cwd: "/mnt/c" }).stdout ?? "").trim();
  for (const l of [afterGameClose(), ...out.split("\n")]) if (l?.trim()) log(l.trim());
  return out;
}
