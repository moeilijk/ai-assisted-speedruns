// Move a game's window to a display, after the game has started.
//
// A launch option is not enough: Portal's engine takes `-x/-y` and still centres its window on the primary display
// (measured 2026-09-19: hl2.exe at 320,1 on the 2560x1440 main display while AAS_PORTAL_WINDOW_POS said -1920,1).
// Slay the Spire's launcher already moved its own window this way; this is that, for every game.
//
// Only the position is set (SWP_NOSIZE): a game that does not redraw for an external resize keeps its pixel size.
import { spawnSync } from "node:child_process";

const SWP = "0x0001 -bor 0x0004 -bor 0x0010"; // NOSIZE | NOZORDER | NOACTIVATE

/**
 * Moves the window of `processName` (or the first window whose title matches `title`) to x,y.
 * Returns what happened, as a sentence, and never throws: a window that cannot be moved is not a reason to stop a run.
 */
export function moveWindow({ processName = null, title = null, pos = null, log = () => {} } = {}) {
  if (!pos) return "no position set";
  const [x, y] = String(pos).split(",").map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return `not a position: ${pos}`;
  const match = processName
    ? `Get-Process -Name '${String(processName).replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1`
    : `Get-Process | Where-Object { $_.MainWindowTitle -like '*${String(title).replace(/'/g, "''")}*' } | Select-Object -First 1`;
  const ps = `
Add-Type -Namespace X -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); public struct RECT { public int L,T,R,B; }'
$p = ${match}
if (-not $p) { 'window not found' } else {
  $h = $p.MainWindowHandle
  [X.W]::SetWindowPos($h, [IntPtr]::Zero, ${x}, ${y}, 0, 0, ${SWP}) | Out-Null; Start-Sleep -Milliseconds 300
  $r = New-Object X.W+RECT; [X.W]::GetWindowRect($h, [ref]$r) | Out-Null
  if ($r.L -eq ${x} -and $r.T -eq ${y}) { 'moved to ' + $r.L + ',' + $r.T } else { 'asked for ${x},${y} but the window is at ' + $r.L + ',' + $r.T }
}`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 20000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").at(-1) ?? "no answer";
  log(`window: ${out}`);
  return out;
}
