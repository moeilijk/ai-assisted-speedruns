// Paths as people see them (C:\Program Files\...) and as the harness uses them. In the tested layout the harness runs
// in WSL and every Windows drive is /mnt/<letter>; in a Windows-only layout both are the same.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";

export const IS_WSL = process.platform === "linux" && (() => { try { return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8")); } catch { return false; } })();
export const ON_WINDOWS = IS_WSL || process.platform === "win32";

/** A path for display: /mnt/g/OBS -> G:\OBS; other WSL paths -> \\wsl.localhost\<distro>\...; anything else as it is. */
export function toWindows(p) {
  if (!p || !IS_WSL) return p ?? "";
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:${(m[2] ?? "\\").replace(/\//g, "\\")}`;
  try { return execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim(); } catch { return p; }
}

/** A path the harness can open: G:\OBS -> /mnt/g/OBS (under WSL); a WSL path stays as it is. */
export function toLocal(p) {
  const s = String(p ?? "").trim().replace(/^"(.*)"$/, "$1");
  if (!s || !IS_WSL) return s;
  const m = /^([a-zA-Z]):[\\/]*(.*)$/.exec(s);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`.replace(/\/+$/, "") || `/mnt/${m[1].toLowerCase()}`;
  if (s.startsWith("\\\\")) { try { return execFileSync("wslpath", ["-u", s], { encoding: "utf8" }).trim(); } catch { return s; } }
  return s;
}

/** Runs a PowerShell script on Windows and returns its output (empty when not on Windows or on failure). */
export function powershell(script, { timeout = 20000 } = {}) {
  if (!ON_WINDOWS) return "";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout, cwd: IS_WSL ? "/mnt/c" : undefined });
  return (r.stdout ?? "").replace(/\r/g, "").trim();
}

/** Environment folders of the Windows user (APPDATA, LOCALAPPDATA, ProgramData, ...), as local paths. */
let folders = null;
export function windowsFolders() {
  if (folders) return folders;
  folders = {};
  const out = powershell("'APPDATA','LOCALAPPDATA','ProgramData','ProgramFiles','ProgramFiles(x86)','USERPROFILE','TEMP' | ForEach-Object { $_ + '=' + [Environment]::GetEnvironmentVariable($_) }");
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && line.slice(at + 1)) folders[line.slice(0, at)] = toLocal(line.slice(at + 1));
  }
  return folders;
}

/** The drives Windows has, as local paths. */
export function drives() {
  if (IS_WSL) return fs.readdirSync("/mnt").filter((d) => /^[a-z]$/.test(d)).map((d) => `/mnt/${d}`).filter((d) => { try { fs.readdirSync(d); return true; } catch { return false; } });
  if (process.platform === "win32") return "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`).filter((d) => fs.existsSync(d));
  return ["/"];
}
