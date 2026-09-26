// The Windows screensaver, which starts after the idle time set in Windows (15 minutes here, measured) and runs on
// a desktop of its own ("Screen-saver"). While it runs, a window capture of the game in OBS shows black (measured
// 2026-09-26: the game rendered, OBS's Windows Graphics Capture of its window gave black for 20 s and the run did
// not start), and ES_DISPLAY_REQUIRED only keeps it from starting, a synthetic mouse move did not end it. Windows
// ends it on input; a program ends it the way Windows documents: open that desktop and close its windows.
import { execFileSync } from "node:child_process";

const SCRIPT = `
Add-Type -Namespace X -Name S -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, out bool c, uint d);
[DllImport("user32.dll")] public static extern IntPtr OpenDesktop(string n, uint f, bool i, uint a);
[DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
[DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr h, EnumProc cb, IntPtr l);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
public delegate bool EnumProc(IntPtr h, IntPtr l);
public static bool Close(IntPtr h, IntPtr l) { if (IsWindowVisible(h)) PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); return true; }
'@
function Running { $r = $false; [void][X.S]::SystemParametersInfo(0x0072, 0, [ref]$r, 0); $r }
$was = Running
if ($was -and '__END__' -eq 'end') {
  $d = [X.S]::OpenDesktop('Screen-saver', 0, $false, 0xC1)
  if ($d -ne [IntPtr]::Zero) { [void][X.S]::EnumDesktopWindows($d, [X.S+EnumProc]{ param($h,$l) [X.S]::Close($h,$l) }, [IntPtr]::Zero); [void][X.S]::CloseDesktop($d) }
  Start-Sleep -Milliseconds 800
}
'{0} {1}' -f $was, (Running)
`;

/** Runs the script on the Windows side; "True False" means it was running and is not any more. Null when there is no Windows side. */
function runScript(end) {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", SCRIPT.replace("__END__", end ? "end" : "ask")], { encoding: "utf8", cwd: "/mnt/c", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

/** What the script said, as { wasRunning, running }; null when nothing could be asked. */
function parse(out) {
  const m = /^(True|False) (True|False)$/m.exec(out ?? "");
  return m ? { wasRunning: m[1] === "True", running: m[2] === "True" } : null;
}

/** Whether the screensaver runs now (null: no Windows side to ask). */
export function screensaverRunning({ run = runScript } = {}) {
  return parse(run(false))?.running ?? null;
}

/**
 * Ends the screensaver when it runs. Returns a sentence for the log when it did something or could not, null when
 * there was nothing to do.
 */
export function endScreensaver({ run = runScript } = {}) {
  const r = parse(run(true));
  if (!r || !r.wasRunning) return null;
  return r.running ? "screensaver: running, and it did not end when its window was closed; the game window capture will show black" : "screensaver: was running (it starts after Windows's idle time and hides the game from the window capture); ended";
}
