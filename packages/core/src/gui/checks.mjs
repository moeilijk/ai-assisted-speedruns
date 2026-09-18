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
/** Every game plugin in the repository, playable or not: the GUI names the stubs too, so it is clear what exists
 *  and what a machine would need for it. A stub has no settings and cannot be started. */
export async function allGames() {
  const dir = path.join(REPO, "games");
  const out = [];
  for (const d of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, d, "plugin.mjs");
    if (!exists(file)) continue;
    try {
      const plugin = await loadGamePlugin(file);
      if (plugin.stub || plugin.setup) out.push({ file, dir: d, plugin });
    } catch { /* a plugin that does not load is not offered */ }
  }
  return out;
}

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
    // Every other game the repository knows: named here too, so the list of games is the whole list and it is
    // visible which ones this machine cannot run at all.
    ...(await allGames()).filter(({ plugin }) => plugin.stub).map(({ dir, plugin }) => item("Games", `stub-${plugin.id}`, plugin.name, "info", null, { value: "", doc: `games/${dir}/README.md` })),
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
/**
 * What one row of the Setup tab really establishes.
 *
 * A row is a list of conditions, each with its own outcome. The status is the first condition that fails; passing
 * means every condition in the list held, and that list is the whole of what "checked" means here — whatever is not
 * in it was not established. A row that tries nothing has no status at all. What these rows cannot establish at all
 * is said once, on the tab itself: only a run proves that the programs work together.
 */
export async function checkItem(id) {
  const env = readEnv();
  const tests = [];
  /** A condition and its outcome. `level` is the status when it fails; `fix` is the button that repairs it. */
  const t = (what, ok, { level = "fail", detail = "", fix = null } = {}) => { tests.push({ what, ok: Boolean(ok), level, detail, fix }); return Boolean(ok); };
  const done = (extra = {}) => {
    const bad = tests.find((x) => !x.ok);
    return { status: bad ? bad.level : tests.length ? "ok" : "", detail: bad ? bad.detail : "", tests, ...(bad?.fix ? { fix: bad.fix } : {}), ...extra };
  };

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
    if (t("a folder is chosen", dir, { level: "missing", detail: "Choose where runs are saved; each run goes to <location>\\<game>\\<run>." })
      && t("the folder exists", exists(dir), { detail: "This folder does not exist." })) {
      t("the harness can write in it", (() => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } })(), { detail: "This folder is not writable." });
      if (ON_WINDOWS) t("it is on a Windows drive, so OBS can record into it", /^\/mnt\/[a-z]\//.test(`${dir}/`), { level: "warn", detail: "Not on a Windows drive: OBS cannot record into it." });
    }
    return done(extra);
  }
  if (id === "repo") {
    t("package.json is in the repository folder", exists(path.join(REPO, "package.json")), { detail: "The repository is incomplete." });
    return done();
  }
  if (id === "node") {
    t(`Node is 22 or newer (${process.version})`, atLeast(version(process.version), [22]), { detail: "Version 22 or newer is needed." });
    return done();
  }
  if (id === "ffmpeg") {
    const out = run("ffmpeg", ["-version"]);
    const v = out?.match(/ffmpeg version (\S+)/)?.[1];
    if (t("ffmpeg answers --version", Boolean(out), { detail: `Not installed.${IS_WSL ? " In WSL: sudo apt install ffmpeg" : ""}` })) {
      t("ffprobe answers --version", Boolean(run("ffprobe", ["-version"])), { detail: "ffprobe is missing." });
      t(`it is 6 or newer (${v})`, atLeast(version(v), [6]), { detail: `ffmpeg ${v}; version 6 or newer is needed.` });
    }
    return done();
  }
  if (id === "claude") {
    const out = run("claude", ["--version"]);
    if (t("claude answers --version", Boolean(out), { level: "missing", detail: "Not installed (only needed for runs with Claude)." })) {
      t(`it is 2.1.207 or newer (${out})`, atLeast(version(out), [2, 1, 207]), { level: "warn", detail: `${out}; version 2.1.207 or newer is needed.` });
    }
    return done();
  }
  if (id === "codex") {
    const out = run("codex", ["--version"]);
    t(`codex answers --version${out ? ` (${out})` : ""}`, Boolean(out), { level: "missing", detail: "Not installed (only needed for runs with Codex)." });
    return done();
  }
  if (id === "obs") {
    const exe = toLocal(env.AAS_OBS_EXE ?? "") || defaultPath("AAS_OBS_EXE");
    const found = !exists(exe) ? detect.obs() : null;
    const extra = { suggest: found && found !== exe ? toWindows(found) : null, suggestSource: "the registry" };
    if (!t("obs64.exe is where the setting points", exists(exe), { detail: "OBS Studio was not found: install it from obsproject.com, or choose obs64.exe." })) return done(extra);
    const v = fileVersion(exe);
    if (!t(`OBS is 30 or newer (${v || "?"})`, atLeast(version(v), [30]), { detail: `OBS ${v || "?"}; version 30 or newer is needed.` })) return done(extra);
    const ws = detect.obsWebsocketConfig();
    if (!t("its WebSocket server is set up", Boolean(ws), { detail: `OBS ${v}. Its WebSocket server was never set up: OBS → Tools → WebSocket Server Settings.` })) return done(extra);
    if (!t("that server is switched on", ws.server_enabled, { detail: `OBS ${v}. Its WebSocket server is off: OBS → Tools → WebSocket Server Settings → Enable.` })) return done(extra);
    t("the password here is the one OBS uses", !ws.auth_required || ws.server_password === env.AAS_OBS_PASSWORD, { level: "warn", detail: `OBS ${v}. The password in the settings is not the one OBS uses.`, fix: { id: "obs-password", label: "Use OBS's password" } });
    t(`the address here is the one OBS listens on (ws://127.0.0.1:${ws.server_port})`, (env.AAS_OBS_URL || "ws://127.0.0.1:4455") === `ws://127.0.0.1:${ws.server_port}`, { level: "warn", detail: `OBS ${v}. OBS listens on ws://127.0.0.1:${ws.server_port}.`, fix: { id: "obs-password", label: "Use OBS's settings" } });
    return done(extra);
  }
  if (id === "livesplit") {
    const exe = toLocal(env.AAS_LIVESPLIT_EXE ?? "");
    const mine = detect.portableTools().livesplit;
    const extra = { suggest: !exe && mine ? toWindows(mine) : null, suggestSource: "the harness's own install" };
    if (!t("LiveSplit.exe is there", exists(exe), { level: "missing", detail: exe ? "LiveSplit.exe is not there." : "LiveSplit shows the timer and the splits in the recording.", fix: { id: "install-livesplit", label: "Install LiveSplit 1.8.37" } })) return done(extra);
    const cfg = path.join(path.dirname(exe), "settings.cfg");
    if (!t("its server starts with LiveSplit", /<ServerStartup>1<\/ServerStartup>/.test(exists(cfg) ? fs.readFileSync(cfg, "utf8") : ""), { level: "warn", detail: "Its server does not start with LiveSplit, so the harness cannot use it.", fix: { id: "livesplit-server", label: "Start the server with LiveSplit" } })) return done(extra);
    const pin = detect.aasToolsDir() && exe.startsWith(path.join(detect.aasToolsDir(), "LiveSplit")) ? JSON.parse(fs.readFileSync(path.join(REPO, "packages", "timer-livesplit", "UPSTREAM.json"), "utf8")).livesplit.version : null;
    if (ON_WINDOWS) {
      const { windowsSetupStatus } = await import("../../../timer-livesplit/windows-setup.mjs");
      const w = windowsSetupStatus(exe);
      const fix = { id: "livesplit-windows", label: "Stop LiveSplit's questions (Windows asks permission once)" };
      t("it does not check for updates at every start", w.outboundBlocked, { level: "warn", detail: "LiveSplit asks about updates at every start.", fix });
      t("it does not ask for administrator rights at every start", w.fileTypes, { level: "warn", detail: "LiveSplit asks for administrator rights at every start.", fix });
    }
    return done({ ...extra, version: pin });
  }
  if (id === "steam") {
    const exe = toLocal(env.AAS_STEAM_EXE ?? "") || defaultPath("AAS_STEAM_EXE");
    const found = !exists(exe) ? detect.steam().exe : null;
    t("steam.exe is there", exists(exe), { level: "warn", detail: "Steam was not found; it is needed for Steam games." });
    return done({ suggest: found && found !== exe ? toWindows(found) : null, suggestSource: "the registry" });
  }
  if (id === "display") {
    const { listDisplays } = await import("../windows/displays.mjs");
    let displays = [];
    try { displays = listDisplays(); } catch { /* not available */ }
    const options = displays.map((d) => ({ value: `${d.x},${d.y}`, label: `${d.width}×${d.height}${d.primary ? " (main display)" : ""} at ${d.x},${d.y}`, width: d.width, height: d.height }));
    const current = (await guiGames()).map((g) => env[g.plugin.setup.displayEnv]).find(Boolean) ?? "";
    if (!current) return done({ options, detail: "Nothing chosen: Windows decides where the game lands." });
    t(`the chosen display is connected (${current})`, options.some((o) => o.value === current), { level: "warn", detail: "This display is not connected now." });
    return done({ options: options.some((o) => o.value === current) ? options : [...options, { value: current, label: current }] });
  }
  if (id === "svv") {
    const exe = toLocal(env.AAS_SOUNDVOLUMEVIEW ?? "");
    const mine = detect.portableTools().soundvolumeview;
    const extra = { suggest: !exe && mine ? toWindows(mine) : null, suggestSource: "the harness's own install" };
    t(`SoundVolumeView.exe is there${exists(exe) ? ` (${fileVersion(exe) || "?"})` : ""}`, exists(exe), { level: "missing", detail: exe ? "SoundVolumeView.exe is not there." : "Only needed to keep game sound off your speakers.", fix: { id: "install-svv", label: "Install SoundVolumeView" } });
    return done(extra);
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
    if (!quiet) return done({ options, detail: "Nothing chosen: the game plays on your default device." });
    if (!t("SoundVolumeView is there to move the sound", exists(exe), { level: "warn", detail: "Needs SoundVolumeView." })) return done({ options: [...options, { value: quiet, label: quiet }] });
    t("the chosen device is active now", devices.includes(quiet), { level: "warn", detail: "This device is not active now." });
    return done({ options: devices.includes(quiet) ? options : [...options, { value: quiet, label: quiet }] });
  }
  if (id.startsWith("stub-")) {
    // The same row as a game that works, failing on the first condition a working game passes without a word.
    const g = (await allGames()).find((x) => `stub-${x.plugin.id}` === id);
    t("there is a plugin for this game", false, { level: "absent", detail: g ? `not yet; what it would take is in games/${g.dir}/README.md` : "unknown game" });
    return done();
  }
  if (id.startsWith("game-")) {
    // The first condition of every game row; a game that is in the repository as a plugin passes it by being here.
    t("there is a plugin for this game", true);
    const g = (await guiGames()).find((x) => `game-${x.plugin.id}` === id);
    if (!g) { t("the game plugin is known", false, { detail: "Unknown game." }); return done(); }
    const st = g.plugin.setup.settings[0];
    const current = toLocal(env[st.env] ?? "");
    const found = st.find && ON_WINDOWS ? detect.findGame(st.find) : null;
    const extra = { suggest: found && found.path !== current ? toWindows(found.path) : null, suggestSource: found?.source ?? null };
    const install = g.plugin.setup.install ? { id: `install:${g.plugin.id}`, label: "Install what the game needs" } : null;
    if (!t("a folder is chosen", current, { level: "missing", detail: `Choose the folder with ${st.expect ?? "the game"}.`, fix: install })) return done(extra);
    if (!t("the folder exists", exists(current), { detail: "This folder does not exist.", fix: install })) return done(extra);
    if (st.expect && !t(`${st.expect} is in that folder`, exists(path.join(current, st.expect)), { detail: `${st.expect} is not in this folder.`, fix: install })) return done(extra);
    const r = spawnSync(process.execPath, [path.join(REPO, "packages", "core", "src", "gui", "game-doctor.mjs"), g.file], { encoding: "utf8", timeout: 60000, env: process.env });
    let rows; try { rows = JSON.parse(r.stdout); } catch { rows = [{ ok: false, what: "its own checks answered", detail: (r.stderr || "no answer").trim().split("\n").at(-1) }]; }
    for (const row of rows) t(row.what, row.ok, { level: "warn", detail: row.detail ?? `Not ready: ${row.what}.`, fix: install });
    return done({ ...extra, fix: tests.every((x) => x.ok) && install ? { ...install, label: "Install again" } : undefined });
  }
  t("the check is known", false, { detail: `Unknown check: ${id}` });
  return done();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.loadEnvFile(ENV_FILE); } catch { /* no .env */ }
  try { console.log(JSON.stringify(await checkItem(process.argv[2]))); } catch (e) { console.log(JSON.stringify({ status: "fail", detail: String(e?.message ?? e) })); }
}
