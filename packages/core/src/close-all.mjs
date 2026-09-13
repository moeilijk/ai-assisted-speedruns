// The end of a run closes what the run needed: the game (through the game plugin), LiveSplit when the
// timer used it, OBS when the recorder used it, and Steam when a launcher of this harness started it.
// `aas run` and `aas resume` call this when they are done, also when the game failed to start, so that
// nothing is left open on the machine after a run unless `--keep-open` says so. The manual command
// (`npm run sts:stop`, `npm run portal:stop`) goes through the same function.
//
// Everything closes the way a user would close it: a WM_CLOSE to the window, a "save?" dialog answered,
// a wait for the exit. Nothing is ever killed; what does not close is reported and left alone.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { closeWindows } from "./close-windows.mjs";

/** Windows, or WSL with Windows next to it: the only places where there are windows to close. */
export function hasWindowsDesktop() {
  return process.platform === "win32" || /microsoft/i.test(os.release());
}

/** The marker a launcher writes when it started Steam itself, so the close step shuts Steam down again. */
export function steamMarkerFile() {
  if (process.platform === "win32") return `${process.env.TEMP}\\aas-started-steam.flag`;
  const winTemp = execFileSync("cmd.exe", ["/c", "echo %TEMP%"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  return execFileSync("wslpath", ["-u", `${winTemp}\\aas-started-steam.flag`], { encoding: "utf8" }).trim();
}
export function markSteamStarted() { fs.writeFileSync(steamMarkerFile(), new Date().toISOString()); }
export function steamStartedByUs() { try { return fs.existsSync(steamMarkerFile()); } catch { return false; } }
export function clearSteamMarker() { try { fs.rmSync(steamMarkerFile(), { force: true }); } catch { /* no marker */ } }

/**
 * Closes the game (plugin.close), then the timer's and the recorder's programs (their close()), then Steam when a
 * launcher started it (`steam: "auto"`) or when asked (`steam: true`). Returns the lines reported, the last
 * one the fresh measurement of what is still running.
 */
export async function closeAll({ plugin, recorder = null, timer = null, steam = "auto", log = () => {}, closer = closeWindows } = {}) {
  const lines = [];
  const say = (t) => { for (const l of String(t ?? "").split("\n")) if (l.trim()) { lines.push(l); log(`close: ${l}`); } };
  if (!hasWindowsDesktop()) { say("no Windows desktop here; nothing to close"); return lines; }
  if (plugin?.close) {
    // The plugin reports through the log as it goes; what it returns is the same text, so it is not repeated.
    try { await plugin.close({ log: (t) => say(t) }); } catch (e) { say(`the game did not close cleanly: ${e.message}`); }
  }
  // The timer and the recorder close their own programs; the core knows neither by name.
  for (const p of [timer, recorder]) {
    if (!p?.close) continue;
    try { say(await p.close()); } catch (e) { say(`${p.id} did not close cleanly: ${e.message}`); }
  }
  const shutSteam = steam === true || (steam === "auto" && steamStartedByUs());
  const report = [...(plugin?.processNames ?? (plugin?.processName ? [plugin.processName.replace(/\.exe$/i, "")] : [])), ...(timer?.processName ? [timer.processName] : []), ...(recorder?.processName ? [recorder.processName] : []), ...(shutSteam ? ["steam"] : [])];
  if (shutSteam) say(closer([], { steam: true, report }));
  else say(`still running: ${measure(report)}`);
  if (shutSteam) clearSteamMarker();
  return lines;
}

/** A fresh list of the given processes that are running now (empty string = none). */
export function measure(names) {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process ${names.join(",")} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName) -join ','`], { encoding: "utf8" }).trim();
  } catch (e) {
    return `measurement failed: ${e.message.split("\n")[0]}`;
  }
}
