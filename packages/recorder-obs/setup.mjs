// What `aas gui` needs from OBS, kept with the recorder instead of in the GUI: where OBS is, its version, its
// WebSocket settings as OBS itself stores them, and the folder OBS records into. Read-only; nothing here starts OBS.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { powershell, toLocal, toWindows, windowsFolders, ON_WINDOWS } from "../core/src/gui/windows-paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const exists = (p) => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };
const version = (text) => String(text ?? "").match(/(\d+)\.(\d+)(?:\.(\d+))?/)?.slice(1).map((n) => Number(n ?? 0)) ?? null;

/** OBS Studio: its install folder from the registry, else the default install folder. */
// The registry is read once per process: a PowerShell start costs about 0.3 s, and the GUI asks for this default
// with every list of its rows. Whether the file is there is looked at every time.
let installFolder;
export function obsExe() {
  if (!ON_WINDOWS) return null;
  installFolder ??= powershell("(Get-ItemProperty 'HKLM:\\SOFTWARE\\OBS Studio' -ErrorAction SilentlyContinue).'(default)'");
  const reg = installFolder;
  const f = windowsFolders();
  return [reg && path.join(toLocal(reg), "bin", "64bit", "obs64.exe"), f.ProgramFiles && path.join(f.ProgramFiles, "obs-studio", "bin", "64bit", "obs64.exe")].find(exists) ?? null;
}

/** obs-websocket's own settings (enabled, port, password), from OBS's config folder. */
export function obsWebsocketConfig() {
  const file = path.join(windowsFolders().APPDATA ?? "", "obs-studio", "plugin_config", "obs-websocket", "config.json");
  try { return { file, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { return null; }
}

/** The folder OBS records into, from its first profile; not a run's own recording folder, which OBS points at during a run. */
export function obsRecordingFolder() {
  try {
    const profiles = path.join(windowsFolders().APPDATA ?? "", "obs-studio", "basic", "profiles");
    for (const p of fs.readdirSync(profiles)) {
      const rec = fs.readFileSync(path.join(profiles, p, "basic.ini"), "utf8").match(/^(?:RecFilePath|FilePath)=(.+)$/m)?.[1]?.replace(/\\\\/g, "\\");
      if (rec && !/[\\/]recording[\\/]?$/.test(rec)) return toWindows(toLocal(rec));
    }
  } catch { /* no OBS profile */ }
  return null;
}

/** The settings and buttons of the Setup tab (types.d.ts, ToolSetup). */
export const setup = {
  group: "Windows tools",
  settings: [{ env: "AAS_OBS_EXE", label: "OBS Studio", kind: "file", expect: "obs64.exe", default: obsExe }],
  fixes: { websocket: { label: "Use OBS's WebSocket settings", script: path.join(here, "use-websocket-settings.mjs") } },
  /** Offered for the output location: where OBS already records. */
  outputFolder: obsRecordingFolder,
};

/** The Setup tab's conditions for OBS, before any run: the program, its version, its WebSocket server and the settings here. */
export function setupRows({ env = process.env } = {}) {
  const rows = [];
  const exe = toLocal(env.AAS_OBS_EXE ?? "") || obsExe();
  // `detail` says what is wrong, so a row that holds carries none.
  const add = (ok, what, detail = "", extra = {}) => { rows.push({ ok: Boolean(ok), what, detail: ok ? "" : detail, ...extra }); return Boolean(ok); };
  if (!add(exists(exe), "obs64.exe is there", exe ? `${toWindows(exe)} is not there` : "OBS Studio was not found: install it from obsproject.com, or choose obs64.exe.", { level: "missing" })) return rows;
  const v = ON_WINDOWS ? powershell(`(Get-Item '${toWindows(exe).replace(/'/g, "''")}').VersionInfo.ProductVersion`) : "";
  const n = version(v);
  if (!add(n && (n[0] > 30 || n[0] === 30), `OBS is 30 or newer (${v || "?"})`, `OBS ${v || "?"}; version 30 or newer is needed.`)) return rows;
  const ws = obsWebsocketConfig();
  if (!add(ws, "its WebSocket server is set up", "OBS → Tools → WebSocket Server Settings.")) return rows;
  if (!add(ws.server_enabled, "that server is switched on", "OBS → Tools → WebSocket Server Settings → Enable.")) return rows;
  add(!ws.auth_required || ws.server_password === env.AAS_OBS_PASSWORD, "the password here is the one OBS uses", "AAS_OBS_PASSWORD is not the password OBS uses.", { level: "warn", fix: "websocket" });
  add((env.AAS_OBS_URL || "ws://127.0.0.1:4455") === `ws://127.0.0.1:${ws.server_port}`, `the address here is the one OBS listens on (ws://127.0.0.1:${ws.server_port})`, `OBS listens on ws://127.0.0.1:${ws.server_port}.`, { level: "warn", fix: "websocket" });
  return rows;
}
