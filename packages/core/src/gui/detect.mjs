// Where the tools and games are installed by default, to prefill the GUI: the registry, the standard install folders,
// and the stores' own records (Steam's library folders and app manifests, Epic's install manifests, GOG's registry
// keys). Drives and user folders are never searched (privacy): what is not in a standard place is chosen by the user.
// Nothing is written; every result is a suggestion.
import fs from "node:fs";
import path from "node:path";
import { powershell, toLocal, windowsFolders } from "./windows-paths.mjs";

const exists = (p) => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };
const first = (...paths) => paths.find(exists) ?? null;

/** Steam: the client, its library folders, and per app id the install folder. */
export function steam() {
  const reg = powershell("$k = Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue; if ($k) { $k.SteamExe; $k.SteamPath }").split("\n").filter(Boolean);
  const f = windowsFolders();
  const exe = first(toLocal(reg[0]), reg[1] && path.join(toLocal(reg[1]), "steam.exe"), f["ProgramFiles(x86)"] && path.join(f["ProgramFiles(x86)"], "Steam", "steam.exe"));
  const root = exe ? path.dirname(exe) : null;
  const libraries = new Set(root ? [root] : []);
  try {
    const vdf = fs.readFileSync(path.join(root, "steamapps", "libraryfolders.vdf"), "utf8");
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(toLocal(m[1].replace(/\\\\/g, "\\")));
  } catch { /* no Steam or no libraries file */ }
  return {
    exe,
    libraries: [...libraries],
    /** The install folder of a Steam app, or null. */
    app(appId) {
      for (const lib of libraries) {
        try {
          const acf = fs.readFileSync(path.join(lib, "steamapps", `appmanifest_${appId}.acf`), "utf8");
          const dir = acf.match(/"installdir"\s+"([^"]+)"/)?.[1];
          const full = dir && path.join(lib, "steamapps", "common", dir);
          if (exists(full)) return full;
        } catch { /* not in this library */ }
      }
      return null;
    },
  };
}

/** Epic Games Store: install folder by display name. */
export function epicGame(displayName) {
  const dir = path.join(windowsFolders().ProgramData ?? "", "Epic", "EpicGamesLauncher", "Data", "Manifests");
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".item"))) {
      const item = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (String(item.DisplayName).toLowerCase() === String(displayName).toLowerCase() && exists(toLocal(item.InstallLocation))) return toLocal(item.InstallLocation);
    }
  } catch { /* no Epic launcher */ }
  return null;
}

/** GOG Galaxy / GOG installers: install folder by game id. */
export function gogGame(gameId) {
  const p = powershell(`(Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\${String(gameId).replace(/[^0-9A-Za-z]/g, "")}' -ErrorAction SilentlyContinue).path`);
  return p && exists(toLocal(p)) ? toLocal(p) : null;
}

/** A game folder from the stores named in a plugin setting's `find`. */
export function findGame(find = {}, steamInfo = null) {
  if (find.steam) { const p = (steamInfo ?? steam()).app(find.steam); if (p) return { path: p, source: "Steam" }; }
  if (find.epic) { const p = epicGame(find.epic); if (p) return { path: p, source: "Epic Games" }; }
  if (find.gog) { const p = gogGame(find.gog); if (p) return { path: p, source: "GOG" }; }
  return null;
}

/** Where the harness installs tools itself (LiveSplit: install-livesplit.mjs from the GUI). */
export function aasToolsDir() {
  const local = windowsFolders().LOCALAPPDATA;
  return local ? path.join(local, "aas") : null;
}

/** Portable tools have no installer and no registry entry: only the folder the GUI installs them to is looked at.
 *  Anything elsewhere is chosen by the user; drives are never searched. */
export function portableTools() {
  const dir = aasToolsDir();
  return {
    livesplit: dir && exists(path.join(dir, "LiveSplit", "LiveSplit.exe")) ? path.join(dir, "LiveSplit", "LiveSplit.exe") : null,
    soundvolumeview: dir && exists(path.join(dir, "SoundVolumeView", "SoundVolumeView.exe")) ? path.join(dir, "SoundVolumeView", "SoundVolumeView.exe") : null,
  };
}

/** OBS Studio: its install folder from the registry, else the default. */
export function obs() {
  const reg = powershell("(Get-ItemProperty 'HKLM:\\SOFTWARE\\OBS Studio' -ErrorAction SilentlyContinue).'(default)'");
  const f = windowsFolders();
  return first(reg && path.join(toLocal(reg), "bin", "64bit", "obs64.exe"), f.ProgramFiles && path.join(f.ProgramFiles, "obs-studio", "bin", "64bit", "obs64.exe"));
}

/** obs-websocket's own settings (enabled, port, password), from OBS's config folder. */
export function obsWebsocketConfig() {
  const file = path.join(windowsFolders().APPDATA ?? "", "obs-studio", "plugin_config", "obs-websocket", "config.json");
  try { return { file, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { return null; }
}
