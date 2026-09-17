// A Steam game started outside the Steam client needs Steam running and logged in: a Source game shows
// "CFileSystem_Steam::Init() failed: failed to find steam interface" without it (also for every `-hijack`
// command), and other games open Steam themselves or refuse. A launcher calls ensureSteam() before it starts the game.
import { execFileSync } from "node:child_process";
import { markSteamStarted } from "../close-all.mjs";

const STEAM_EXE = process.env.AAS_STEAM_EXE ?? "C:\\Program Files (x86)\\Steam\\steam.exe";

export function steamRunning() {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", "[bool](Get-Process steam -ErrorAction SilentlyContinue) -and [bool](Get-Process steamwebhelper -ErrorAction SilentlyContinue)"], { encoding: "utf8" });
  return /True/i.test(out);
}

export async function ensureSteam({ log = () => {}, timeoutMs = 120000 } = {}) {
  if (steamRunning()) return "running";
  log("Steam is not running; starting it (the game needs the Steam interface)");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `if (-not (Get-Process steam -ErrorAction SilentlyContinue)) { Start-Process -FilePath '${STEAM_EXE}' -ArgumentList '-silent' }`]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    if (steamRunning()) {
      await new Promise((r) => setTimeout(r, 20000)); // let the login finish before the game asks for the interface
      markSteamStarted(); // so the close step at the end of the run shuts Steam down again
      return "started";
    }
  }
  throw new Error("Steam did not start within 120 s; start it and log in, then retry.");
}
