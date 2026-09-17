// Closes Balatro the way a user would, stops the bridge and the keep-awake helper, and puts the player's own settings
// file back (profile slot, display). Called by the game plugin's `close()` (the harness at the end of a run) and by stop-all.mjs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { closeWindows } from "../../packages/core/src/close-windows.mjs";
import { afterGameClose } from "../../packages/core/src/windows/quiet-start.mjs";
import { readBridgeState } from "./bridge.mjs";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function stopBridge() {
  const state = readBridgeState();
  if (!state || !alive(state.pid)) return null;
  process.kill(state.pid, "SIGTERM");
  for (let i = 0; i < 20 && alive(state.pid); i += 1) await new Promise((r) => setTimeout(r, 100));
  return alive(state.pid) ? `bridge (pid ${state.pid}) did not stop; left running` : "bridge stopped";
}

/** The profile slot the player had before the launcher changed it; only once the game has closed (it writes its settings on exit). */
export function restoreProfile() {
  const text = (cmd, args) => (spawnSync(cmd, args, { encoding: "utf8", cwd: "/mnt/c" }).stdout ?? "").trim();
  const appData = text("wslpath", ["-u", text("cmd.exe", ["/c", "echo %APPDATA%"])]);
  const settings = path.join(appData, "Balatro", "settings.jkr");
  const backup = `${settings}.aas-backup`;
  if (!fs.existsSync(backup)) return null;
  if (/True/.test(text("powershell.exe", ["-NoProfile", "-Command", "[bool](Get-Process Balatro -ErrorAction SilentlyContinue)"]))) return "profile: Balatro is still running; the player's settings stay in settings.jkr.aas-backup";
  fs.copyFileSync(backup, settings);
  fs.rmSync(backup, { force: true });
  return "profile: the player's own settings.jkr restored";
}

export async function closeGame({ log = () => {} } = {}) {
  const lines = [];
  const say = (t) => { for (const l of String(t ?? "").split("\n")) if (l.trim()) { lines.push(l); log(l); } };
  say(afterGameClose());
  say(closeWindows([{ name: "Balatro", title: "Balatro", seconds: 20 }], { report: ["Balatro"] }));
  say(await stopBridge());
  say(restoreProfile());
  return lines.join("\n");
}
