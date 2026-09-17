#!/usr/bin/env node
// Keep the displays awake during a run (opt-in: AAS_KEEP_DISPLAYS_AWAKE=1, the
// launchers call this). Needed when the quiet audio device is a display's HDMI
// audio endpoint, which disappears while that display sleeps. A detached
// PowerShell holds ES_DISPLAY_REQUIRED (and wakes the display with a zero-length
// mouse move) as long as the flag file exists and still carries this start's
// token, so there is at most one live helper: a new start replaces the old one,
// stop from any game ends it. The flag lives in the Windows temp folder.
//   node packages/core/src/windows/keep-display-awake.mjs start | stop | status
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const winTemp = execFileSync("cmd.exe", ["/c", "echo %TEMP%"], { encoding: "utf8", cwd: "/mnt/c", stdio: ["ignore", "pipe", "ignore"] }).trim();
const flagWin = `${winTemp}\\aas-keep-awake.flag`;
const flag = execFileSync("wslpath", ["-u", flagWin], { encoding: "utf8" }).trim();
const cmd = process.argv[2] ?? "status";

const helper = (token) => `
Add-Type -Namespace X -Name P -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);
[DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int s);
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
'@
$in = New-Object X.P+INPUT; $in.type = 0; $in.mi.flags = 0x0001   # MOUSEEVENTF_MOVE, dx = dy = 0: wakes the display, moves nothing
[X.P]::SendInput(1, @($in), [System.Runtime.InteropServices.Marshal]::SizeOf($in)) | Out-Null
while ((Test-Path '${flagWin}') -and ((Get-Content '${flagWin}' -Raw -ErrorAction SilentlyContinue) -eq '${token}')) { [X.P]::SetThreadExecutionState(0x80000000 -bor 0x00000002 -bor 0x00000001) | Out-Null; Start-Sleep 30 }
[X.P]::SetThreadExecutionState(0x80000000) | Out-Null
`;

if (cmd === "start") {
  const token = `${new Date().toISOString()} ${process.pid}`;
  fs.writeFileSync(flag, token);
  const child = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", helper(token)], { detached: true, stdio: "ignore" });
  child.unref();
  console.log(`keep-awake: started (display wake sent; ES_DISPLAY_REQUIRED held while ${flagWin} carries this token)`);
} else if (cmd === "stop") {
  fs.rmSync(flag, { force: true });
  console.log("keep-awake: stopped (flag removed; the helper exits within 30 s)");
} else {
  console.log(`keep-awake: ${fs.existsSync(flag) ? `active since ${fs.readFileSync(flag, "utf8").split(" ")[0]}` : "not active"}`);
}
