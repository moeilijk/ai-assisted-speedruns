#!/usr/bin/env node
// Move the LiveSplit window (and optionally the game window) to a display
// corner so a run stays contained on a secondary display. Windows only.
// Usage: node games/portal/place-windows.mjs [--livesplit X,Y] [--game X,Y,W,H]
// Env: AAS_LIVESPLIT_POS (X,Y), AAS_PORTAL_WINDOW_POS + AAS_PORTAL_RESOLUTION for the game.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const ls = opt("--livesplit", process.env.AAS_LIVESPLIT_POS ?? null);
const game = opt("--game", process.env.AAS_PORTAL_WINDOW_POS && process.env.AAS_PORTAL_RESOLUTION ? `${process.env.AAS_PORTAL_WINDOW_POS},${process.env.AAS_PORTAL_RESOLUTION.replace("x", ",")}` : null);
const moves = [];
if (ls) { const [x, y] = ls.split(",").map(Number); moves.push(["LiveSplit", x, y, 0, 0]); }
if (game) { const [x, y, w, h] = game.split(",").map(Number); moves.push(["hl2", x, y, w, h]); }
if (!moves.length) throw new Error("Nothing to place: pass --livesplit X,Y and/or --game X,Y,W,H (or set the env variables).");
const ps = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class WP { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); }
'@
${moves.map(([proc, x, y, w, h]) => `$p = Get-Process ${proc} -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p -and $p.MainWindowHandle -ne 0) { [WP]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, ${x}, ${y}, ${w}, ${h}, ${w && h ? "0x0014" : "0x0015"}) | Out-Null; "${proc}: moved to ${x},${y}${w && h ? ` ${w}x${h}` : ""}" } else { "${proc}: not running" }`).join("\n")}`;
console.log(execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).replace(/\r/g, "").trim());
