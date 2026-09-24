// Where FCEUX is: AAS_FCEUX_DIR, else %LOCALAPPDATA%\aas\FCEUX (the folder the GUI installs its tools into).
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
export function fceuxDir() {
  if (process.env.AAS_FCEUX_DIR) return path.resolve(process.env.AAS_FCEUX_DIR);
  const l = localAppData();
  return l ? path.join(l, "aas", "FCEUX") : null;
}
/**
 * A path as FCEUX (a Windows program) needs it: absolute, with backslashes. Worked out from the path itself, without
 * wslpath, because the broker runs under node --permission and may not start programs: /mnt/g/OBS → G:\OBS, any other
 * WSL path → \\wsl.localhost\<distro>\….
 */
export function hostPath(p, { wsl = isWsl(), distro = process.env.WSL_DISTRO_NAME } = {}) {
  const abs = path.posix.resolve(p);
  if (!wsl) return path.resolve(p);
  const drive = abs.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (drive) return `${drive[1].toUpperCase()}:\\${(drive[2] ?? "").replaceAll("/", "\\")}`;
  if (!distro) throw new Error(`no Windows path for ${abs}: WSL_DISTRO_NAME is not set`);
  return `\\\\wsl.localhost\\${distro}${abs.replaceAll("/", "\\")}`;
}
