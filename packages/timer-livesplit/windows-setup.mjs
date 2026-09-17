#!/usr/bin/env node
// The Windows side of a LiveSplit install, done once and elevated (one Windows permission prompt), so that LiveSplit
// starts without asking anything:
// - no outbound network for this LiveSplit.exe: its update check (every start, for LiveSplit and every component, no
//   setting to turn it off) then fails quietly; the harness runs the pinned version and needs no network from it;
// - the .lss/.lsl file types point at this LiveSplit.exe, which LiveSplit otherwise asks for at every start
//   (LiveSplit.Register.exe, elevated) when they point elsewhere.
// Its inbound server is left to Windows' own prompt and the user's answer.
//
//   node packages/timer-livesplit/windows-setup.mjs <LiveSplit.exe>        do it (asks Windows permission)
//   node packages/timer-livesplit/windows-setup.mjs --status <LiveSplit.exe>
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RULE = "AAS LiveSplit (no outbound network)";
const win = (p) => (process.platform === "win32" ? p : spawnSync("wslpath", ["-w", p], { encoding: "utf8" }).stdout.trim());
const ps = (script) => (spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", cwd: process.platform === "win32" ? undefined : "/mnt/c" }).stdout ?? "").replace(/\r/g, "").trim();

const SCRIPT = `# Written by aas (packages/timer-livesplit/windows-setup.mjs); run elevated for one LiveSplit.exe.
param([Parameter(Mandatory = $true)][string]$Exe)
$dir = Split-Path $Exe
Get-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue | Where-Object { ($_ | Get-NetFirewallApplicationFilter).Program -eq $Exe } | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName '${RULE}' -Direction Outbound -Action Block -Program $Exe -Profile Any | Out-Null
Start-Process -FilePath (Join-Path $dir 'LiveSplit.Register.exe') -WorkingDirectory $dir -Wait
`;

/** Whether this LiveSplit.exe has its outbound block rule and owns the file types. */
export function windowsSetupStatus(exe) {
  const w = win(exe).replace(/'/g, "''");
  const out = ps(`
$rule = @(Get-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue | Where-Object { ($_ | Get-NetFirewallApplicationFilter).Program -eq '${w}' }).Count -gt 0
$cmd = (Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\\LiveSplit.SplitsFile\\shell\\open\\command' -ErrorAction SilentlyContinue).'(default)'
"$rule|$cmd"`);
  const [rule, cmd] = out.split("|");
  return { outboundBlocked: rule === "True", fileTypes: String(cmd ?? "").toLowerCase().startsWith(`"${win(exe).toLowerCase()}"`) };
}

/** Asks Windows for permission once and applies both; resolves with the status afterwards. */
export function windowsSetup(exe) {
  const dir = path.dirname(exe);
  const scriptFile = path.join(path.dirname(dir), "livesplit-windows.ps1");
  fs.writeFileSync(scriptFile, SCRIPT);
  ps(`Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${win(scriptFile).replace(/'/g, "''")}','-Exe','${win(exe).replace(/'/g, "''")}'`);
  return windowsSetupStatus(exe);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const status = process.argv[2] === "--status";
  const exe = path.resolve(process.argv[status ? 3 : 2] ?? "");
  if (!fs.existsSync(exe)) throw new Error("usage: windows-setup.mjs [--status] <LiveSplit.exe>");
  const r = status ? windowsSetupStatus(exe) : windowsSetup(exe);
  console.log(`outbound network blocked: ${r.outboundBlocked ? "yes" : "no"}; file types point at this LiveSplit: ${r.fileTypes ? "yes" : "no"}`);
  if (!status && !(r.outboundBlocked && r.fileTypes)) process.exitCode = 1;
}
