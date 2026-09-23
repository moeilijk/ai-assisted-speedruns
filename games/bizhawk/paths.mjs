// Where BizHawk is: AAS_BIZHAWK_DIR, else %LOCALAPPDATA%\aas\BizHawk (the folder the GUI installs its tools into).
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const isWsl = () => process.platform === "linux" && /microsoft/i.test(os.release());
let local = undefined;
function localAppData() {
  if (local !== undefined) return local;
  local = null;
  if (process.platform === "win32") local = process.env.LOCALAPPDATA ?? null;
  else if (isWsl()) {
    const win = (spawnSync("cmd.exe", ["/c", "echo %LOCALAPPDATA%"], { encoding: "utf8", cwd: "/mnt/c" }).stdout ?? "").trim();
    if (win && !win.includes("%")) local = (spawnSync("wslpath", ["-u", win], { encoding: "utf8" }).stdout ?? "").trim() || null;
  }
  return local;
}
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
