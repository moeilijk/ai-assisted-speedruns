// Closes FCEUX the way a user would, so it writes its own settings (fceux.cfg) on the way out. With the bridge loaded
// that is emu.exit, FCEUX's own "close FCEUX" for scripts (lua-engine.cpp); otherwise WM_CLOSE to the game window
// ("FCEUX 2.6.6: <game>"), not to the Lua console, whose close would only stop the script. Both measured on FCEUX
// 2.6.6 win64 on 2026-09-23. Called by the plugin's `close()` and by stop-all.mjs.
import { execFileSync } from "node:child_process";
import { closeWindows } from "../../packages/core/src/close-windows.mjs";
import { afterGameClose, clearAppRoute } from "../../packages/core/src/windows/quiet-start.mjs";
import { call, disconnect, ping } from "./bridge.mjs";

const running = () => execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-Process fceux64 -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: "utf8", cwd: "/mnt/c" }).trim() !== "0";

export async function closeGame({ log = () => {}, seconds = 20 } = {}) {
  let out;
  if (await ping()) {
    await call("emu.exit").catch(() => {});
    disconnect();
    for (let i = 0; i < seconds * 2 && running(); i += 1) await new Promise((r) => setTimeout(r, 500));
    out = running() ? `FCEUX did not close within ${seconds} s after emu.exit; left running` : "FCEUX closed";
  } else {
    out = closeWindows([{ name: "fceux64", title: "FCEUX 2", seconds }], { report: ["fceux64"] });
  }
  // The quiet device as FCEUX's own output (route "app" in the launcher) is cleared once FCEUX has closed.
  for (const l of [afterGameClose(), ...(running() ? [] : [clearAppRoute("fceux64.exe")]), ...out.split("\n")]) if (l?.trim()) log(l.trim());
  return out;
}
