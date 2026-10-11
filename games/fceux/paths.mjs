// Where FCEUX is: AAS_FCEUX_DIR, else %LOCALAPPDATA%\aas\FCEUX (the folder the GUI installs its tools into).
import os from "node:os";
import path from "node:path";
import { winEnvPath } from "../../packages/core/src/windows/win-env.mjs";

const isWsl = () => process.platform === "linux" && /microsoft/i.test(os.release());
// %LOCALAPPDATA% is asked of Windows (winEnvPath asks again when the interop call comes back empty, and remembers
// only an answer), so one hiccup does not leave the rest of the run without this folder.
const localAppData = () => winEnvPath("LOCALAPPDATA");
export function fceuxDir() {
  if (process.env.AAS_FCEUX_DIR) return path.resolve(process.env.AAS_FCEUX_DIR);
  const l = localAppData();
  return l ? path.join(l, "aas", "FCEUX") : null;
}
/**
 * A path as FCEUX (a Windows program) needs it: absolute, with backslashes. Worked out from the path itself, without
 * wslpath, because the broker runs under node --permission and may not start programs: /mnt/d/Runs → D:\Runs, any other
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
