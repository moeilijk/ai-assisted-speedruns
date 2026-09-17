// The GUI's set-up page: every tool and game setting with its value from .env, a suggestion from detect.mjs, and a
// check of version and use. Each check says what it found, in words, and what to do; `fix` names a one-click fix the
// server knows (install LiveSplit, take OBS's password, turn on LiveSplit's server).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as detect from "./detect.mjs";
import { readEnv } from "./env-file.mjs";
import { ON_WINDOWS, powershell, toLocal, toWindows, windowsFolders } from "./windows-paths.mjs";
import { listDisplays } from "../windows/displays.mjs";
import { loadGamePlugin } from "../mcp-client.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const exists = (p) => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };
const version = (text) => String(text ?? "").match(/(\d+)\.(\d+)(?:\.(\d+))?/)?.slice(1).map((n) => Number(n ?? 0)) ?? null;
const atLeast = (v, min) => { if (!v) return false; for (let i = 0; i < 3; i += 1) { if ((v[i] ?? 0) !== (min[i] ?? 0)) return (v[i] ?? 0) > (min[i] ?? 0); } return true; };
const cli = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000 }); return r.status === 0 ? `${r.stdout}${r.stderr}`.trim() : null; };

/** The game plugins that have a GUI set-up (games/<id>/plugin.mjs with `setup`, not stubs). */
export async function guiGames() {
  const dir = path.join(REPO, "games");
  const out = [];
  for (const d of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, d, "plugin.mjs");
    if (!exists(file)) continue;
    try {
      const plugin = await loadGamePlugin(file);
      if (!plugin.stub && plugin.setup) out.push({ file, plugin });
    } catch { /* a plugin that does not load is not offered */ }
  }
  return out;
}

function fileVersions(exes) {
  const list = exes.filter(exists);
  if (!list.length) return {};
  const out = powershell(list.map((p) => `'${toWindows(p).replace(/'/g, "''")}' | ForEach-Object { $_ + '|' + (Get-Item $_).VersionInfo.ProductVersion }`).join("\n"));
  const map = {};
  for (const line of out.split("\n")) { const [p, v] = line.split("|"); if (p) map[toLocal(p)] = v ?? ""; }
  return map;
}

/** The settings as .env has them, without checking anything (fast): what the Setup page shows before a check. */
export async function configModel() {
  const env = readEnv();
  const item = (group, id, label, kind, envName, extra = {}) => ({ group, id, label, kind, env: envName, value: envName && (kind === "dir" || kind === "file") ? toWindows(toLocal(env[envName] ?? "")) : (env[envName] ?? ""), status: "unchecked", detail: "", ...extra });
  const games = await guiGames();
  const display = games.map((g) => env[g.plugin.setup.displayEnv]).find(Boolean) ?? "";
  const items = [
    item("General", "output", "Output location", "dir", "AAS_OUTPUT_DIR"),
    item("General", "node", "Node.js", "info", null, { value: process.version }),
    item("Tools", "obs", "OBS Studio (recording)", "file", "AAS_OBS_EXE", { expect: "obs64.exe" }),
    item("Tools", "livesplit", "LiveSplit (timer)", "file", "AAS_LIVESPLIT_EXE", { expect: "LiveSplit.exe" }),
    item("Tools", "steam", "Steam", "file", "AAS_STEAM_EXE", { expect: "steam.exe" }),
    item("Tools", "ffmpeg", "ffmpeg (video cut, length)", "info", null),
    item("Agents", "claude", "Claude Code", "info", null),
    item("Agents", "codex", "Codex", "info", null),
    ...(ON_WINDOWS ? [
      item("Screen and sound", "display", "Display for the game", "display", null, { value: display, options: display ? [{ value: display, label: display }] : [] }),
      item("Screen and sound", "svv", "SoundVolumeView (NirSoft)", "file", "AAS_SOUNDVOLUMEVIEW", { expect: "SoundVolumeView.exe" }),
      item("Screen and sound", "quiet", "Sound device for the game", "select", "AAS_QUIET_AUDIO_DEVICE", { options: [{ value: "", label: "Normal (your default device)" }, ...(env.AAS_QUIET_AUDIO_DEVICE ? [{ value: env.AAS_QUIET_AUDIO_DEVICE, label: env.AAS_QUIET_AUDIO_DEVICE }] : [])] }),
      item("Screen and sound", "awake", "Keep displays awake during a run", "check", "AAS_KEEP_DISPLAYS_AWAKE"),
    ] : []),
    ...games.flatMap(({ file, plugin }) => plugin.setup.settings.map((st) => item("Games", `game-${plugin.id}`, st.label, st.kind, st.env, { game: plugin.id, expect: st.expect, file }))),
  ];
  const configured = ["AAS_OUTPUT_DIR", "AAS_OBS_EXE", "AAS_LIVESPLIT_EXE"].some((k) => env[k]) || games.some(({ plugin }) => env[plugin.setup.settings[0]?.env]);
  return { items, checked: false, configured };
}

export async function setupModel() {
  const env = readEnv();
  const steamInfo = ON_WINDOWS ? detect.steam() : { exe: null, libraries: [], app: () => null };
  const portable = ON_WINDOWS ? detect.portableTools() : {};
  const obsExe = env.AAS_OBS_EXE ? toLocal(env.AAS_OBS_EXE) : (ON_WINDOWS ? detect.obs() : null);
  const lsExe = env.AAS_LIVESPLIT_EXE || portable.livesplit;
  const svvExe = env.AAS_SOUNDVOLUMEVIEW || portable.soundvolumeview;
  const versions = fileVersions([obsExe, svvExe].filter(Boolean));
  const items = [];
  const add = (item) => items.push({ status: "ok", detail: "", ...item });

  // Output location
  {
    const value = env.AAS_OUTPUT_DIR ?? "";
    let suggest = null;
    try {
      const f = windowsFolders();
      const profiles = path.join(f.APPDATA ?? "", "obs-studio", "basic", "profiles");
      for (const p of fs.readdirSync(profiles)) {
        const ini = fs.readFileSync(path.join(profiles, p, "basic.ini"), "utf8");
        const rec = ini.match(/^(?:RecFilePath|FilePath)=(.+)$/m)?.[1]?.replace(/\\\\/g, "\\");
        if (rec) { let d = toLocal(rec); if (/\/recording$/.test(d)) d = path.dirname(path.dirname(path.dirname(d))); suggest = d; break; }
      }
    } catch { /* no OBS profile */ }
    const dir = toLocal(value);
    let status = "missing"; let detail = "Choose where runs are saved; each run goes to <location>\\<game>\\<run>.";
    if (value) {
      if (!exists(dir)) { status = "fail"; detail = "This folder does not exist."; }
      else {
        try { fs.accessSync(dir, fs.constants.W_OK); status = "ok"; detail = ""; } catch { status = "fail"; detail = "This folder is not writable."; }
        if (status === "ok" && ON_WINDOWS && !/^\/mnt\/[a-z]\//.test(`${dir}/`)) { status = "warn"; detail = "Not on a Windows drive: OBS cannot record into it."; }
      }
    }
    add({ group: "General", id: "output", env: "AAS_OUTPUT_DIR", label: "Output location", kind: "dir", value: toWindows(dir), suggest: suggest && suggest !== dir ? toWindows(suggest) : null, status, detail });
  }

  // Node
  {
    const v = version(process.version);
    add({ group: "General", id: "node", label: "Node.js", kind: "info", value: process.version, status: atLeast(v, [22]) ? "ok" : "fail", detail: atLeast(v, [22]) ? "" : "Version 22 or newer is needed." });
  }

  // OBS
  {
    const v = version(versions[obsExe]);
    const ws = ON_WINDOWS ? detect.obsWebsocketConfig() : null;
    let status = "ok"; const notes = [];
    if (!exists(obsExe)) { status = "fail"; notes.push("OBS Studio not found; install it from obsproject.com or choose obs64.exe."); }
    else if (!atLeast(v, [30])) { status = "fail"; notes.push(`OBS ${versions[obsExe] || "?"}; version 30 or newer is needed.`); }
    else notes.push(`OBS ${versions[obsExe]}`);
    let fix = null;
    if (exists(obsExe)) {
      if (!ws) { status = "fail"; notes.push("Its WebSocket server was never set up: OBS → Tools → WebSocket Server Settings."); }
      else if (!ws.server_enabled) { status = "fail"; notes.push("Its WebSocket server is off: OBS → Tools → WebSocket Server Settings → Enable."); }
      else {
        notes[notes.length - 1] += `, WebSocket port ${ws.server_port}.`;
        const want = `ws://127.0.0.1:${ws.server_port}`;
        if (ws.auth_required && ws.server_password !== env.AAS_OBS_PASSWORD) { status = status === "ok" ? "warn" : status; notes.push("The password in the settings is not the one OBS uses."); fix = { id: "obs-password", label: "Use OBS's password" }; }
        else if ((env.AAS_OBS_URL || "ws://127.0.0.1:4455") !== want) { status = status === "ok" ? "warn" : status; notes.push(`The address should be ${want}.`); fix = { id: "obs-password", label: "Use OBS's settings" }; }
      }
    }
    add({ group: "Tools", id: "obs", env: "AAS_OBS_EXE", label: "OBS Studio (recording)", kind: "file", expect: "obs64.exe", value: toWindows(obsExe ?? ""), status, detail: notes.join(" "), fix });
  }

  // LiveSplit
  {
    const exe = toLocal(lsExe ?? "");
    let status = "ok"; let detail; let fix = null;
    if (!exists(exe)) { status = "missing"; detail = "LiveSplit shows the timer and the splits in the recording."; fix = { id: "install-livesplit", label: "Install LiveSplit 1.8.37" }; }
    else {
      const cfg = path.join(path.dirname(exe), "settings.cfg");
      const text = exists(cfg) ? fs.readFileSync(cfg, "utf8") : "";
      const server = /<ServerStartup>1<\/ServerStartup>/.test(text);
      const pinned = detect.aasToolsDir() && exe.startsWith(path.join(detect.aasToolsDir(), "LiveSplit")) ? JSON.parse(fs.readFileSync(path.join(REPO, "packages", "timer-livesplit", "UPSTREAM.json"), "utf8")).livesplit.version : null;
      detail = server ? (pinned ? `LiveSplit ${pinned}` : "") : "Its server does not start with LiveSplit, so the harness cannot use it.";
      if (!server) { status = "warn"; fix = { id: "livesplit-server", label: "Start the server with LiveSplit" }; }
      else if (ON_WINDOWS) {
        const { windowsSetupStatus } = await import("../../../timer-livesplit/windows-setup.mjs");
        const w = windowsSetupStatus(exe);
        if (!w.outboundBlocked || !w.fileTypes) {
          status = "warn";
          detail = `LiveSplit asks ${[!w.outboundBlocked && "about updates", !w.fileTypes && "for administrator rights"].filter(Boolean).join(" and ")} at every start.`;
          fix = { id: "livesplit-windows", label: "Stop LiveSplit's questions (Windows asks permission once)" };
        }
      }
    }
    add({ group: "Tools", id: "livesplit", env: "AAS_LIVESPLIT_EXE", label: "LiveSplit (timer)", kind: "file", expect: "LiveSplit.exe", value: toWindows(exe), suggest: !env.AAS_LIVESPLIT_EXE && exists(exe) ? toWindows(exe) : null, status, detail, fix });
  }

  // Steam
  {
    const exe = env.AAS_STEAM_EXE ? toLocal(env.AAS_STEAM_EXE) : steamInfo.exe;
    add({ group: "Tools", id: "steam", env: "AAS_STEAM_EXE", label: "Steam", kind: "file", expect: "steam.exe", value: toWindows(exe ?? ""), status: exists(exe) ? "ok" : "warn", detail: exists(exe) ? "" : "Not found; needed for Steam games." });
  }

  // ffmpeg
  {
    const out = cli("ffmpeg", ["-version"]);
    const probe = cli("ffprobe", ["-version"]);
    const v = version(out?.match(/ffmpeg version (\S+)/)?.[1]);
    add({ group: "Tools", id: "ffmpeg", label: "ffmpeg (video cut, length)", kind: "info", value: out ? `ffmpeg ${out.match(/ffmpeg version (\S+)/)?.[1]}` : "", status: out && probe && atLeast(v, [6]) ? "ok" : "fail", detail: out ? (probe ? (atLeast(v, [6]) ? "" : "Version 6 or newer is needed.") : "ffprobe is missing.") : "Not found. In WSL: sudo apt install ffmpeg" });
  }

  // Agents
  {
    const claude = cli("claude", ["--version"]);
    const cv = version(claude);
    add({ group: "Agents", id: "claude", label: "Claude Code", kind: "info", value: claude ?? "", status: claude ? (atLeast(cv, [2, 1, 207]) ? "ok" : "warn") : "missing", detail: claude ? (atLeast(cv, [2, 1, 207]) ? "" : "Version 2.1.207 or newer is needed.") : "Not installed (only needed for runs with Claude)." });
    const codex = cli("codex", ["--version"]);
    add({ group: "Agents", id: "codex", label: "Codex", kind: "info", value: codex ?? "", status: codex ? "ok" : "missing", detail: codex ? "" : "Not installed (only needed for runs with Codex)." });
  }

  // Display and audio (optional)
  if (ON_WINDOWS) {
    let displays = [];
    try { displays = listDisplays(); } catch { /* not available */ }
    const games = await guiGames();
    const current = games.map((g) => env[g.plugin.setup.displayEnv]).find(Boolean) ?? "";
    add({ group: "Screen and sound", id: "display", label: "Display for the game", kind: "display", value: current, options: displays.map((d) => ({ value: `${d.x},${d.y}`, label: `${d.width}×${d.height}${d.primary ? " (main display)" : ""} at ${d.x},${d.y}`, width: d.width, height: d.height })), status: "ok", detail: "" });
    const svv = toLocal(svvExe ?? "");
    const v = versions[svv];
    add({ group: "Screen and sound", id: "svv", env: "AAS_SOUNDVOLUMEVIEW", label: "SoundVolumeView (NirSoft)", kind: "file", expect: "SoundVolumeView.exe", value: toWindows(svv), suggest: !env.AAS_SOUNDVOLUMEVIEW && exists(svv) ? toWindows(svv) : null, status: exists(svv) ? "ok" : "missing", detail: exists(svv) ? `SoundVolumeView ${v || "?"}` : "Only needed to keep game sound off your speakers.", fix: exists(svv) ? null : { id: "install-svv", label: "Install SoundVolumeView" } });
    let devices = [];
    if (exists(svv)) {
      const r = spawnSync(process.execPath, [path.join(REPO, "packages", "core", "src", "gui", "list-audio.mjs")], { encoding: "utf8", timeout: 20000, env: { ...process.env, AAS_SOUNDVOLUMEVIEW: svv, AAS_QUIET_AUDIO_DEVICE: "-" } });
      try { devices = JSON.parse(r.stdout); } catch { devices = []; }
    }
    const quiet = env.AAS_QUIET_AUDIO_DEVICE ?? "";
    add({ group: "Screen and sound", id: "quiet", env: "AAS_QUIET_AUDIO_DEVICE", label: "Sound device for the game", kind: "select", value: quiet, options: [{ value: "", label: "Normal (your default device)" }, ...devices.map((d) => ({ value: d, label: d }))], status: quiet && !devices.includes(quiet) && exists(svv) ? "warn" : "ok", detail: quiet && exists(svv) && !devices.includes(quiet) ? "This device is not active now." : "" });
    add({ group: "Screen and sound", id: "awake", env: "AAS_KEEP_DISPLAYS_AWAKE", label: "Keep displays awake during a run", kind: "check", value: env.AAS_KEEP_DISPLAYS_AWAKE === "1" ? "1" : "", status: "ok", detail: "" });
  }

  // Games
  for (const { file, plugin } of await guiGames()) {
    for (const s of plugin.setup.settings) {
      const current = env[s.env] ? toLocal(env[s.env]) : "";
      const found = s.find && ON_WINDOWS ? detect.findGame(s.find, steamInfo) : null;
      let status = "missing"; let detail = `Choose the folder with ${s.expect ?? "the game"}.`;
      if (current) {
        if (!exists(current)) { status = "fail"; detail = "This folder does not exist."; }
        else if (s.expect && !exists(path.join(current, s.expect))) { status = "fail"; detail = `${s.expect} is not in this folder.`; }
        else {
          const rows = (await plugin.doctor?.({}).catch((e) => [{ ok: false, what: "checks", detail: e.message }])) ?? [];
          const bad = rows.filter((r) => !r.ok);
          status = bad.length ? "warn" : "ok";
          detail = bad.length ? `Not ready: ${bad.map((r) => r.what).join(", ")}.` : "";
        }
      }
      add({ group: "Games", id: `game-${plugin.id}`, game: plugin.id, env: s.env, label: s.label, kind: s.kind, expect: s.expect, value: toWindows(current), suggest: found && found.path !== current ? `${toWindows(found.path)}` : null, suggestSource: found?.source ?? null, status, detail, fix: plugin.setup.install && current && exists(current) ? { id: `install:${plugin.id}`, label: status === "ok" ? "Install again" : "Install what the game needs" } : null, file });
    }
  }
  return { items, checked: true, configured: true, at: new Date().toTimeString().slice(0, 8) };
}
