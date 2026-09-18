// The GUI's set-up page. `configItems()` is the list as `.env` has it, at once and without checking anything;
// `checkItem(id)` checks one row (version, use, a fix the server knows) and runs in a child process of its own, so
// the rows come in one by one while the page shows them as pending. A row that passes shows only what can be checked
// (a version); text appears when something is wrong.
//
//   node packages/core/src/gui/checks.mjs <id>     the check of one row, as JSON
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as detect from "./detect.mjs";
import { ENV_FILE, readEnv } from "./env-file.mjs";
import { IS_WSL, ON_WINDOWS, powershell, toLocal, toWindows, windowsFolders } from "./windows-paths.mjs";
import { loadGamePlugin } from "../mcp-client.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const exists = (p) => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };
const version = (text) => String(text ?? "").match(/(\d+)\.(\d+)(?:\.(\d+))?/)?.slice(1).map((n) => Number(n ?? 0)) ?? null;
const atLeast = (v, min) => { if (!v) return false; for (let i = 0; i < 3; i += 1) { if ((v[i] ?? 0) !== (min[i] ?? 0)) return (v[i] ?? 0) > (min[i] ?? 0); } return true; };
const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20000 }); return r.status === 0 ? `${r.stdout}${r.stderr}`.trim() : null; };
/** A program on the PATH of the harness (no process started). */
export const onPath = (name) => (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, name)).find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) ?? null;
const fileVersion = (exe) => (exists(exe) ? powershell(`(Get-Item '${toWindows(exe).replace(/'/g, "''")}').VersionInfo.ProductVersion`) : "");
const HARNESS = IS_WSL ? "WSL (the harness)" : "The harness";

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

// The paths the harness uses when a setting is not in .env (the launchers' own defaults).
function defaultPath(key) {
  const f = ON_WINDOWS ? windowsFolders() : {};
  if (key === "AAS_OBS_EXE") return f.ProgramFiles ? path.join(f.ProgramFiles, "obs-studio", "bin", "64bit", "obs64.exe") : null;
  if (key === "AAS_STEAM_EXE") return f["ProgramFiles(x86)"] ? path.join(f["ProgramFiles(x86)"], "Steam", "steam.exe") : null;
  return null;
}

/** The rows as .env has them: values at once, nothing checked. */
export async function configItems() {
  const env = readEnv();
  const games = await guiGames();
  const pathValue = (key) => toWindows(toLocal(env[key] ?? ""));
  const item = (group, id, label, kind, envName, extra = {}) => ({ group, id, label, kind, env: envName, value: envName && (kind === "dir" || kind === "file") ? pathValue(envName) : (env[envName] ?? ""), ...extra });
  const display = games.map((g) => env[g.plugin.setup.displayEnv]).find(Boolean) ?? "";
  const which = (name) => toWindows(onPath(name) ?? "");
  return [
    item("General", "output", "Output location", "dir", "AAS_OUTPUT_DIR"),
    item(HARNESS, "repo", "Repository", "info", null, { value: toWindows(REPO) }),
    item(HARNESS, "node", "Node.js", "info", null, { value: `${toWindows(process.execPath)} (${process.version})` }),
    item(HARNESS, "ffmpeg", "ffmpeg (video cut, length)", "info", null, { value: which("ffmpeg") }),
    item(HARNESS, "claude", "Claude Code", "info", null, { value: which("claude") }),
    item(HARNESS, "codex", "Codex", "info", null, { value: which("codex") }),
    item("Windows tools", "obs", "OBS Studio (recording)", "file", "AAS_OBS_EXE", { expect: "obs64.exe", placeholder: "default: C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe" }),
    item("Windows tools", "livesplit", "LiveSplit (timer)", "file", "AAS_LIVESPLIT_EXE", { expect: "LiveSplit.exe" }),
    item("Windows tools", "steam", "Steam", "file", "AAS_STEAM_EXE", { expect: "steam.exe", placeholder: "default: C:\\Program Files (x86)\\Steam\\steam.exe" }),
    ...(ON_WINDOWS ? [
      item("Screen and sound", "display", "Display for the game", "display", null, { value: display, options: display ? [{ value: display, label: display }] : [] }),
      item("Screen and sound", "svv", "SoundVolumeView (NirSoft)", "file", "AAS_SOUNDVOLUMEVIEW", { expect: "SoundVolumeView.exe" }),
      item("Screen and sound", "quiet", "Sound device for the game", "select", "AAS_QUIET_AUDIO_DEVICE", { options: [{ value: "", label: "Normal (your default device)" }, ...(env.AAS_QUIET_AUDIO_DEVICE ? [{ value: env.AAS_QUIET_AUDIO_DEVICE, label: env.AAS_QUIET_AUDIO_DEVICE }] : [])] }),
      // A plain preference: there is nothing to check, so this row has no check and no status at all.
      item("Screen and sound", "awake", "Keep displays awake during a run", "check", "AAS_KEEP_DISPLAYS_AWAKE", { check: false }),
    ] : []),
    ...games.flatMap(({ plugin }) => plugin.setup.settings.map((st) => item("Games", `game-${plugin.id}`, st.label, st.kind, st.env, { game: plugin.id, expect: st.expect }))),
  ];
}

/** The rows a changed setting affects (checked again after a save). */
export async function affectedBy(keys) {
  const map = { AAS_OUTPUT_DIR: ["output"], AAS_OBS_EXE: ["obs"], AAS_OBS_PASSWORD: ["obs"], AAS_OBS_URL: ["obs"], AAS_LIVESPLIT_EXE: ["livesplit"], AAS_STEAM_EXE: ["steam"], AAS_SOUNDVOLUMEVIEW: ["svv", "quiet"], AAS_QUIET_AUDIO_DEVICE: ["quiet"] };
  for (const { plugin } of await guiGames()) {
    for (const st of plugin.setup.settings) map[st.env] = [...(map[st.env] ?? []), `game-${plugin.id}`];
    if (plugin.setup.displayEnv) map[plugin.setup.displayEnv] = ["display"];
  }
  return [...new Set(keys.flatMap((k) => map[k] ?? []))];
}

/** One row's check: `{ status, detail, fix?, suggest?, suggestSource?, options? }`. */
export async function checkItem(id) {
  const env = readEnv();
  const ok = (detail = "", extra = {}) => ({ status: "ok", detail, ...extra });
  const bad = (status, detail, extra = {}) => ({ status, detail, ...extra });

  if (id === "output") {
    const dir = toLocal(env.AAS_OUTPUT_DIR ?? "");
    let suggest = null;
    try {
      const profiles = path.join(windowsFolders().APPDATA ?? "", "obs-studio", "basic", "profiles");
      for (const p of fs.readdirSync(profiles)) {
        const rec = fs.readFileSync(path.join(profiles, p, "basic.ini"), "utf8").match(/^(?:RecFilePath|FilePath)=(.+)$/m)?.[1]?.replace(/\\\\/g, "\\");
        if (rec) { suggest = toWindows(toLocal(rec)); break; }
      }
    } catch { /* no OBS profile */ }
    const extra = { suggest: suggest && suggest !== toWindows(dir) ? suggest : null, suggestSource: "OBS's recording folder" };
    if (!dir) return bad("missing", "Choose where runs are saved; each run goes to <location>\\<game>\\<run>.", extra);
    if (!exists(dir)) return bad("fail", "This folder does not exist.", extra);
    try { fs.accessSync(dir, fs.constants.W_OK); } catch { return bad("fail", "This folder is not writable.", extra); }
    if (ON_WINDOWS && !/^\/mnt\/[a-z]\//.test(`${dir}/`)) return bad("warn", "Not on a Windows drive: OBS cannot record into it.", extra);
    return ok("", extra);
  }
  if (id === "repo") return exists(path.join(REPO, "package.json")) ? ok() : bad("fail", "The repository is incomplete.");
  if (id === "node") return atLeast(version(process.version), [22]) ? ok() : bad("fail", "Version 22 or newer is needed.");
  if (id === "ffmpeg") {
    const out = run("ffmpeg", ["-version"]);
    const v = out?.match(/ffmpeg version (\S+)/)?.[1];
    if (!out) return bad("fail", `Not installed.${IS_WSL ? " In WSL: sudo apt install ffmpeg" : ""}`);
    if (!run("ffprobe", ["-version"])) return bad("fail", "ffprobe is missing.");
    return atLeast(version(v), [6]) ? ok(`ffmpeg ${v}`) : bad("fail", `ffmpeg ${v}; version 6 or newer is needed.`);
  }
  if (id === "claude") {
    const out = run("claude", ["--version"]);
    if (!out) return bad("missing", "Not installed (only needed for runs with Claude).");
    return atLeast(version(out), [2, 1, 207]) ? ok(out) : bad("warn", `${out}; version 2.1.207 or newer is needed.`);
  }
  if (id === "codex") {
    const out = run("codex", ["--version"]);
    return out ? ok(out) : bad("missing", "Not installed (only needed for runs with Codex).");
  }
  if (id === "obs") {
    const exe = toLocal(env.AAS_OBS_EXE ?? "") || defaultPath("AAS_OBS_EXE");
    const found = !exists(exe) ? detect.obs() : null;
    const extra = { suggest: found && found !== exe ? toWindows(found) : null, suggestSource: "the registry" };
    if (!exists(exe)) return bad("fail", "OBS Studio was not found: install it from obsproject.com, or choose obs64.exe.", extra);
    const v = fileVersion(exe);
    if (!atLeast(version(v), [30])) return bad("fail", `OBS ${v || "?"}; version 30 or newer is needed.`, extra);
    const ws = detect.obsWebsocketConfig();
    if (!ws) return bad("fail", `OBS ${v}. Its WebSocket server was never set up: OBS → Tools → WebSocket Server Settings.`, extra);
    if (!ws.server_enabled) return bad("fail", `OBS ${v}. Its WebSocket server is off: OBS → Tools → WebSocket Server Settings → Enable.`, extra);
    const want = `ws://127.0.0.1:${ws.server_port}`;
    if (ws.auth_required && ws.server_password !== env.AAS_OBS_PASSWORD) return bad("warn", `OBS ${v}. The password in the settings is not the one OBS uses.`, { ...extra, fix: { id: "obs-password", label: "Use OBS's password" } });
    if ((env.AAS_OBS_URL || "ws://127.0.0.1:4455") !== want) return bad("warn", `OBS ${v}. OBS listens on ${want}.`, { ...extra, fix: { id: "obs-password", label: "Use OBS's settings" } });
    return ok(`OBS ${v}, WebSocket port ${ws.server_port}`, extra);
  }
  if (id === "livesplit") {
    const exe = toLocal(env.AAS_LIVESPLIT_EXE ?? "");
    const mine = detect.portableTools().livesplit;
    const extra = { suggest: !exe && mine ? toWindows(mine) : null, suggestSource: "the harness's own install" };
    if (!exists(exe)) return bad("missing", exe ? "LiveSplit.exe is not there." : "LiveSplit shows the timer and the splits in the recording.", { ...extra, fix: { id: "install-livesplit", label: "Install LiveSplit 1.8.37" } });
    const cfg = path.join(path.dirname(exe), "settings.cfg");
    if (!/<ServerStartup>1<\/ServerStartup>/.test(exists(cfg) ? fs.readFileSync(cfg, "utf8") : "")) return bad("warn", "Its server does not start with LiveSplit, so the harness cannot use it.", { ...extra, fix: { id: "livesplit-server", label: "Start the server with LiveSplit" } });
    const pin = detect.aasToolsDir() && exe.startsWith(path.join(detect.aasToolsDir(), "LiveSplit")) ? JSON.parse(fs.readFileSync(path.join(REPO, "packages", "timer-livesplit", "UPSTREAM.json"), "utf8")).livesplit.version : null;
    if (ON_WINDOWS) {
      const { windowsSetupStatus } = await import("../../../timer-livesplit/windows-setup.mjs");
      const w = windowsSetupStatus(exe);
      if (!w.outboundBlocked || !w.fileTypes) return bad("warn", `LiveSplit asks ${[!w.outboundBlocked && "about updates", !w.fileTypes && "for administrator rights"].filter(Boolean).join(" and ")} at every start.`, { ...extra, fix: { id: "livesplit-windows", label: "Stop LiveSplit's questions (Windows asks permission once)" } });
    }
    return ok(pin ? `LiveSplit ${pin}` : "", extra);
  }
  if (id === "steam") {
    const exe = toLocal(env.AAS_STEAM_EXE ?? "") || defaultPath("AAS_STEAM_EXE");
    const found = !exists(exe) ? detect.steam().exe : null;
    const extra = { suggest: found && found !== exe ? toWindows(found) : null, suggestSource: "the registry" };
    return exists(exe) ? ok("", extra) : bad("warn", "Steam was not found; it is needed for Steam games.", extra);
  }
  if (id === "display") {
    const { listDisplays } = await import("../windows/displays.mjs");
    let displays = [];
    try { displays = listDisplays(); } catch { /* not available */ }
    const options = displays.map((d) => ({ value: `${d.x},${d.y}`, label: `${d.width}×${d.height}${d.primary ? " (main display)" : ""} at ${d.x},${d.y}`, width: d.width, height: d.height }));
    const current = (await guiGames()).map((g) => env[g.plugin.setup.displayEnv]).find(Boolean) ?? "";
    if (current && !options.some((o) => o.value === current)) return bad("warn", "This display is not connected now.", { options: [...options, { value: current, label: current }] });
    return ok("", { options });
  }
  if (id === "svv") {
    const exe = toLocal(env.AAS_SOUNDVOLUMEVIEW ?? "");
    const mine = detect.portableTools().soundvolumeview;
    const extra = { suggest: !exe && mine ? toWindows(mine) : null, suggestSource: "the harness's own install" };
    if (!exists(exe)) return bad("missing", exe ? "SoundVolumeView.exe is not there." : "Only needed to keep game sound off your speakers.", { ...extra, fix: { id: "install-svv", label: "Install SoundVolumeView" } });
    return ok(`SoundVolumeView ${fileVersion(exe) || "?"}`, extra);
  }
  if (id === "quiet") {
    const exe = toLocal(env.AAS_SOUNDVOLUMEVIEW ?? "");
    const quiet = env.AAS_QUIET_AUDIO_DEVICE ?? "";
    let devices = [];
    if (exists(exe)) {
      const r = spawnSync(process.execPath, [path.join(REPO, "packages", "core", "src", "gui", "list-audio.mjs")], { encoding: "utf8", timeout: 20000, env: { ...process.env, AAS_SOUNDVOLUMEVIEW: exe, AAS_QUIET_AUDIO_DEVICE: "-" } });
      try { devices = JSON.parse(r.stdout); } catch { devices = []; }
    }
    const options = [{ value: "", label: "Normal (your default device)" }, ...devices.map((d) => ({ value: d, label: d }))];
    if (quiet && !exists(exe)) return bad("warn", "Needs SoundVolumeView.", { options: [...options, { value: quiet, label: quiet }] });
    if (quiet && !devices.includes(quiet)) return bad("warn", "This device is not active now.", { options: [...options, { value: quiet, label: quiet }] });
    return ok("", { options });
  }
  if (id.startsWith("game-")) {
    const g = (await guiGames()).find((x) => `game-${x.plugin.id}` === id);
    if (!g) return bad("fail", "Unknown game.");
    const st = g.plugin.setup.settings[0];
    const current = toLocal(env[st.env] ?? "");
    const found = st.find && ON_WINDOWS ? detect.findGame(st.find) : null;
    const extra = { suggest: found && found.path !== current ? toWindows(found.path) : null, suggestSource: found?.source ?? null };
    const install = g.plugin.setup.install ? { id: `install:${g.plugin.id}`, label: "Install what the game needs" } : null;
    if (!current) return bad("missing", `Choose the folder with ${st.expect ?? "the game"}.`, extra);
    if (!exists(current)) return bad("fail", "This folder does not exist.", extra);
    if (st.expect && !exists(path.join(current, st.expect))) return bad("fail", `${st.expect} is not in this folder.`, extra);
    const r = spawnSync(process.execPath, [path.join(REPO, "packages", "core", "src", "gui", "game-doctor.mjs"), g.file], { encoding: "utf8", timeout: 60000, env: process.env });
    let rows; try { rows = JSON.parse(r.stdout); } catch { rows = [{ ok: false, what: "checks", detail: (r.stderr || "no answer").trim().split("\n").at(-1) }]; }
    const failed = rows.filter((x) => !x.ok);
    if (failed.length) return bad("warn", `Not ready: ${failed.map((x) => x.what).join(", ")}.`, { ...extra, fix: install });
    return ok("", { ...extra, fix: install && { ...install, label: "Install again" } });
  }
  return bad("fail", `Unknown check: ${id}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.loadEnvFile(ENV_FILE); } catch { /* no .env */ }
  try { console.log(JSON.stringify(await checkItem(process.argv[2]))); } catch (e) { console.log(JSON.stringify({ status: "fail", detail: String(e?.message ?? e) })); }
}
