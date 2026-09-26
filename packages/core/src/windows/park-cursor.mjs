// Parks the mouse cursor at the top centre of a program's main window. A game reads where the cursor rests, also
// when nobody moved it: Balatro, started borderless on a display to the left of the cursor, saw it on the deck at the
// bottom right, opened the deck preview and never made its Play and Discard buttons, so every play was refused
// (measured 2026-09-26, three runs out of nine; the cursor moved into the window ended it at once). The top centre of
// the window is empty in Balatro; a caller for another game chooses its own spot with `offset`.
import { execFileSync } from "node:child_process";

/** Moves the cursor; the sentence for the log says from where to where, or null when the window was not found. */
export function parkCursor({ processName, offset = { x: 0.5, y: 40 }, run = runScript } = {}) {
  const out = run(processName, offset);
  const m = /^(-?\d+),(-?\d+) -> (-?\d+),(-?\d+)$/m.exec(out ?? "");
  if (!m) return null;
  return `cursor: parked at ${m[3]},${m[4]}, the top of the ${processName} window (was ${m[1]},${m[2]})`;
}

function runScript(processName, offset) {
  const script = `
Add-Type -Namespace X -Name C -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
[StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }
'@
$p = Get-Process -Name '${String(processName).replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { 'no window'; exit 0 }
$r = New-Object X.C+R; [void][X.C]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$c = New-Object X.C+P; [void][X.C]::GetCursorPos([ref]$c)
$x = [int]($r.L + ($r.Rt - $r.L) * ${Number(offset.x)}); $y = [int]($r.T + ${Number(offset.y)})
[void][X.C]::SetCursorPos($x, $y)
'{0},{1} -> {2},{3}' -f $c.X, $c.Y, $x, $y
`;
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", cwd: "/mnt/c", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}
