#!/usr/bin/env node
// Start LiveSplit for a run (Windows): with the given splits file, its server up, its window where
// AAS_LIVESPLIT_POS says. LiveSplit opens the last entry of its recent splits at start, so a LiveSplit that is
// running with other splits is closed first, the way a user would (its "Save Splits?" answered with No).
//
//   node packages/timer-livesplit/launch-livesplit.mjs [games/<game>/splits/<file>.lss]
// Env: AAS_LIVESPLIT_EXE (required), AAS_LIVESPLIT_HOST, AAS_LIVESPLIT_PORT, AAS_LIVESPLIT_POS (X,Y; optional).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectLiveSplit, createLiveSplitTimer } from "./index.mjs";
import { selectSplits } from "./select-splits.mjs";

const exe = process.env.AAS_LIVESPLIT_EXE;
if (!exe || !fs.existsSync(exe)) throw new Error(`AAS_LIVESPLIT_EXE does not point at LiveSplit.exe (${exe ?? "not set"})`);
const host = process.env.AAS_LIVESPLIT_HOST ?? "127.0.0.1";
const port = Number(process.env.AAS_LIVESPLIT_PORT ?? 16834);
const splits = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (splits && !fs.existsSync(splits)) throw new Error(`splits file not found: ${splits}`);
const ps = (script) => execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", cwd: "/mnt/c" }).replace(/\r/g, "").trim();
const running = () => /True/.test(ps("[bool](Get-Process LiveSplit -ErrorAction SilentlyContinue)"));
const settingsFile = path.join(path.dirname(exe), "settings.cfg");
const toWin = (p) => execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
const lastSplits = () => [...fs.readFileSync(settingsFile, "utf8").matchAll(/<SplitsFile[^>]*>([^<]*)<\/SplitsFile>/g)].at(-1)?.[1] ?? null;
const reachable = async () => { try { (await connectLiveSplit({ host, port })).close(); return true; } catch { return false; } };

if (running() && splits && lastSplits() !== toWin(splits)) {
  console.log("LiveSplit runs with other splits; closing it first");
  console.log(await createLiveSplitTimer({ host, port }).close());
}
if (splits) {
  const r = selectSplits(splits, { settingsFile });
  console.log(`splits: ${r.game}, ${r.category}`);
}
if (!running()) {
  const winExe = toWin(exe);
  ps(`Start-Process -FilePath '${winExe.replace(/'/g, "''")}' -WorkingDirectory '${path.win32.dirname(winExe).replace(/'/g, "''")}'`);
  console.log("LiveSplit started");
} else {
  console.log("LiveSplit is already running with these splits");
}
let up = false;
for (let i = 0; i < 15 && !up; i += 1) { up = await reachable(); if (!up) await new Promise((r) => setTimeout(r, 2000)); }
if (!up) throw new Error(`LiveSplit Server does not answer on ${host}:${port} after 30 s (settings.cfg: ServerStartup=1, or right-click → Control → Start Server)`);
console.log(`LiveSplit Server answers on ${host}:${port}`);
const pos = process.env.AAS_LIVESPLIT_POS;
if (pos) {
  const [x, y] = pos.split(",").map(Number);
  console.log(ps(`
Add-Type -Namespace X -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);'
$p = Get-Process LiveSplit -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) { [X.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, ${x}, ${y}, 0, 0, 0x0015) | Out-Null; 'window: moved to ${x},${y}' } else { 'window: not found' }`));
}
