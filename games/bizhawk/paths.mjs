// Where BizHawk is: AAS_BIZHAWK_DIR, else %LOCALAPPDATA%\aas\BizHawk (the folder the GUI installs its tools into).
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { winEnvPath } from "../../packages/core/src/windows/win-env.mjs";

const isWsl = () => process.platform === "linux" && /microsoft/i.test(os.release());
// %LOCALAPPDATA% is asked of Windows (winEnvPath asks again when the interop call comes back empty, and remembers
// only an answer), so one hiccup does not leave the rest of the run without this folder.
const localAppData = () => winEnvPath("LOCALAPPDATA");
export function bizhawkDir() {
  if (process.env.AAS_BIZHAWK_DIR) return path.resolve(process.env.AAS_BIZHAWK_DIR);
  const l = localAppData();
  return l ? path.join(l, "aas", "BizHawk") : null;
}
/** A path as EmuHawk (a Windows program) needs it. */
export function hostPath(p) {
  if (!isWsl()) return p;
  return (spawnSync("wslpath", ["-m", path.resolve(p)], { encoding: "utf8" }).stdout ?? "").trim() || p;
}
