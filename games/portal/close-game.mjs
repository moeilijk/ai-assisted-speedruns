// Closes Portal the way the game itself allows: `stop_run` and `quit` through its console, handed to the
// running instance by a second hl2.exe (`-hijack`), which needs Steam. Called by the game plugin's `close()`
// (the harness at the end of a run) and by stop-all.mjs (the manual command).
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { closeWindows } from "../../packages/core/src/close-windows.mjs";
import { ensureSteam } from "../../packages/core/src/windows/steam.mjs";
import { afterGameClose } from "../../packages/core/src/windows/quiet-start.mjs";

export async function closeGame({ log = () => {} } = {}) {
  const lines = [];
  const say = (t) => { for (const l of String(t ?? "").split("\n")) if (l.trim()) { lines.push(l); log(l); } };
  const root = process.env.AAS_PORTAL_GAME_ROOT;
  const gameUp = /True/i.test(execFileSync("powershell.exe", ["-NoProfile", "-Command", "[bool](Get-Process hl2 -ErrorAction SilentlyContinue)"], { encoding: "utf8" }));
  if (root && gameUp) {
    await ensureSteam({ log: say });
    spawnSync(path.join(root, "hl2.exe"), ["-game", "portal", "-hijack", "+stop_run"], { cwd: root, stdio: "ignore" });
    spawnSync(path.join(root, "hl2.exe"), ["-game", "portal", "-hijack", "+quit"], { cwd: root, stdio: "ignore" });
  }
  say(afterGameClose());
  say(closeWindows([{ wait: "hl2", seconds: 25 }], { report: ["hl2"] }));
  return lines.join("\n");
}
