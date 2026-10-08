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

/**
 * Where a program's windows go on a display: the game's window (`main`, the first whose title matches) at the top
 * left of the display (`align: "right"`: the top right, as LiveSplit next to a game), the program's other windows
 * (FCEUX's Lua Script window with the bridge, BizHawk's tool forms) beside it, in rows that stay inside the display's
 * width. A window wider or taller than the display stays at the display's edge. Pure, so it can be tested without
 * Windows. `windows`: [{ handle, title, width, height }]; returns [{ handle, title, x, y }].
 */
export function layoutWindows(windows, { main = null, display, align = "left", gap = 0 }) {
  const first = main ? windows.find((w) => new RegExp(main).test(w.title)) : windows[0];
  if (!first) return [];
  const order = [first, ...windows.filter((w) => w !== first)];
  const right = display.x + display.width, bottom = display.y + display.height;
  const out = [];
  let x = align === "right" ? right : display.x, y = display.y, rowHeight = 0;
  for (const w of order) {
    if (align === "right") {
      if (x - w.width < display.x && x !== right) { x = right; y += rowHeight + gap; rowHeight = 0; }
      const left = Math.max(display.x, x - w.width);
      out.push({ handle: w.handle, title: w.title, x: left, y: Math.min(y, Math.max(display.y, bottom - w.height)) });
      x = left - gap;
    } else {
      if (x + w.width > right && x !== display.x) { x = display.x; y += rowHeight + gap; rowHeight = 0; }
      out.push({ handle: w.handle, title: w.title, x, y: Math.min(y, Math.max(display.y, bottom - w.height)) });
      x += w.width + gap;
    }
    rowHeight = Math.max(rowHeight, w.height);
  }
  return out;
}

const WINDOWS_PS = `
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class MW { public delegate bool P(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
[StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rr, B; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
public static List<IntPtr> Of(uint pid) { var list = new List<IntPtr>(); EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero); return list; }
public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); } }
"@`;
const powershell = (script) => {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 30000, cwd: "/mnt/c" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\r/g, "").trim();
};

/** The visible, titled windows of a running program: [{ handle, title, width, height }]. */
export function windowsOf(processName) {
  const out = powershell(`${WINDOWS_PS}
$p = Get-Process -Name '${String(processName).replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p) { foreach ($h in [MW]::Of([uint32]$p.Id)) { $t = [MW]::Title($h); if ($t -ne '') { $r = New-Object MW+R; [void][MW]::GetWindowRect($h, [ref]$r); [string]$h + [char]9 + ($r.Rr - $r.L) + [char]9 + ($r.B - $r.T) + [char]9 + $t } } }`);
  return out.split("\n").filter((l) => l.split("\t").length >= 4).map((l) => { const [handle, width, height, ...title] = l.split("\t"); return { handle, width: Number(width), height: Number(height), title: title.join("\t") }; });
}

/**
 * Puts a program's windows on a display (from listDisplays()), laid out by layoutWindows, and says where each one
 * landed. Without a display nothing moves. Never throws: a window that cannot be moved is not a reason to stop a run.
 */
export function placeWindows({ processName, main = null, display, align = "left", log = () => {} }) {
  if (!display) return "no display";
  const wins = windowsOf(processName);
  const plan = layoutWindows(wins, { main, display, align });
  if (!plan.length) { const msg = `${processName}: ${wins.length ? "its game window was not found" : "no window found"}`; log(`windows: ${msg}`); return msg; }
  const out = powershell(`${WINDOWS_PS}
${plan.map((p) => `[void][MW]::SetWindowPos([IntPtr]${Number(p.handle)}, [IntPtr]::Zero, ${p.x}, ${p.y}, 0, 0, ${SWP}); Start-Sleep -Milliseconds 150; $r = New-Object MW+R; [void][MW]::GetWindowRect([IntPtr]${Number(p.handle)}, [ref]$r); "'" + [MW]::Title([IntPtr]${Number(p.handle)}) + "' at " + $r.L + ',' + $r.T`).join("\n")}`);
  const said = out.split("\n").filter(Boolean).join("; ") || "no answer";
  log(`windows on ${display.name ?? "the display"} (${display.width}x${display.height} at ${display.x},${display.y}): ${said}`);
  return said;
}
