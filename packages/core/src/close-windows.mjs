// Close Windows programs the way a user would: WM_CLOSE to the main window
// (found by title prefix, also when hidden in the tray), answer a "save?"
// question with a given button, wait for the exit. Nothing is ever killed: a
// process that does not close is reported and left alone.
import { execFileSync } from "node:child_process";

const PS_TYPES = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class WC { public delegate bool EnumProc(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  public static IntPtr TitledWindowOf(uint pid, string prefix) { IntPtr best = IntPtr.Zero; EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p != pid) return true; var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, 512); if (sb.ToString().StartsWith(prefix)) { best = h; return false; } return true; }, IntPtr.Zero); return best; }
  public static IntPtr DialogOf(uint pid, string title) { IntPtr h = FindWindowW("#32770", title); if (h == IntPtr.Zero) return h; uint p; GetWindowThreadProcessId(h, out p); return p == pid ? h : IntPtr.Zero; }
  public static bool PressButton(IntPtr dialog, string caption) { IntPtr b = FindWindowExW(dialog, IntPtr.Zero, "Button", caption); if (b == IntPtr.Zero) return false; PostMessage(b, 0x00F5, IntPtr.Zero, IntPtr.Zero); return true; }
}
'@
function Wait-Exit($name, $seconds) {
  $p = Get-Process $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { return }
  for ($i = 0; $i -lt $seconds -and -not $p.HasExited; $i++) { Start-Sleep 1 }
  if ($p.HasExited) { "$name closed" } else { "$name did not close within $seconds s; left running (close it by hand)" }
}
function Close-Gracefully($name, $titlePrefix, $seconds, $dialogTitle, $dialogButton) {
  $p = Get-Process $name -ErrorAction SilentlyContinue | Where-Object { [WC]::TitledWindowOf([uint32]$_.Id, $titlePrefix) -ne 0 } | Select-Object -First 1
  if (-not $p) { $p = Get-Process $name -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if (-not $p) { return }
  $h = [WC]::TitledWindowOf([uint32]$p.Id, $titlePrefix)
  if ($h -eq 0) { "$($name): main window '$titlePrefix' not found; left running" ; return }
  [WC]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  for ($i = 0; $i -lt $seconds -and -not $p.HasExited; $i++) {
    Start-Sleep 1
    if ($dialogTitle) { $d = [WC]::DialogOf([uint32]$p.Id, $dialogTitle); if ($d -ne 0) { if ([WC]::PressButton($d, $dialogButton)) { "$($name): answered '$dialogTitle' with $dialogButton" } } }
  }
  if ($p.HasExited) { "$name closed" } else { "$name did not close within $seconds s; left running (close it by hand)" }
}
`;
const q = (s) => `'${String(s ?? "").replace(/'/g, "''")}'`;
/**
 * steps: [{ wait: name, seconds }] or [{ name, title, seconds, dialogTitle?, dialogButton? }], in order.
 * Returns the PowerShell output lines.
 */
export function closeWindows(steps, { steam = false, steamExe = process.env.AAS_STEAM_EXE ?? "C:\\Program Files (x86)\\Steam\\steam.exe", report = ["hl2", "LiveSplit", "obs64"] } = {}) {
  const body = steps.map((s) => (s.wait ? `Wait-Exit ${q(s.wait)} ${Number(s.seconds) || 20}` : `Close-Gracefully ${q(s.name)} ${q(s.title)} ${Number(s.seconds) || 15} ${q(s.dialogTitle)} ${q(s.dialogButton)}`)).join("\n");
  const steamStep = steam ? `if (Get-Process steam -ErrorAction SilentlyContinue) { Start-Process -FilePath '${steamExe.replace(/'/g, "''")}' -ArgumentList '-shutdown'; 'steam shutdown requested' }` : "";
  const ps = `${PS_TYPES}\n${body}\n${steamStep}\nStart-Sleep 2\n'still running: ' + ((Get-Process ${report.join(",")} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName) -join ',')`;
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).replace(/\r/g, "").trim();
}

/**
 * Waits up to `seconds` for a known question of a program (a dialog of `processName` titled `title`) and answers it
 * with `button`, the way a user would; returns true when it was answered. For questions a tool asks the same way every
 * time, which this harness has documented and answers itself (BizHawk's movie import: "ROM required to populate hash").
 */
export function answerDialog({ processName, title, button, seconds = 60 }) {
  const ps = `${PS_TYPES}
for ($i = 0; $i -lt ${Number(seconds) || 60}; $i++) {
  $p = Get-Process ${q(processName)} -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p) { $d = [WC]::DialogOf([uint32]$p.Id, ${q(title)}); if ($d -ne 0) { if ([WC]::PressButton($d, ${q(button)})) { 'answered'; exit } } }
  Start-Sleep 1
}
'not asked'`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", cwd: "/mnt/c" });
  return /answered/.test(out);
}
