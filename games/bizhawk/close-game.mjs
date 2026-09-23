// Closes EmuHawk the way a user would, through its main window, so it writes its own config (and with it the trust
// answer). EmuHawk has more than one window (the external tool has its own form), so it is closed by the window
// Windows names as its main one, not by a title. Called by the plugin's `close()` and by stop-all.mjs.
import { spawnSync } from "node:child_process";
import { afterGameClose } from "../../packages/core/src/windows/quiet-start.mjs";

export async function closeGame({ log = () => {}, seconds = 20 } = {}) {
  const ps = `$p = Get-Process EmuHawk -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { 'EmuHawk was not running'; exit }
[void]$p.CloseMainWindow()
for ($i = 0; $i -lt ${Number(seconds) || 20} -and -not $p.HasExited; $i++) { Start-Sleep 1 }
# The tool's own temporary files (screenshots it rendered) go with it.
if ($p.HasExited) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:TEMP 'bizhawk-mcp'); 'EmuHawk closed' } else { 'EmuHawk did not close within ${Number(seconds) || 20} s; left running (close it by hand)' }`;
  const out = (spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", cwd: "/mnt/c" }).stdout ?? "").trim();
  for (const l of [afterGameClose(), ...out.split("\n")]) if (l?.trim()) log(l.trim());
  return out;
}
