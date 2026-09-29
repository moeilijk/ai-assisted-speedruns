// The GUI's set-up page. `configItems()` is the list as `.env` has it, at once and without checking anything;
// `checkItem(id)` checks one row (version, use, a fix the server knows) and runs in a child process of its own, so
// the rows come in one by one while the page shows them as pending. A row that passes shows only what can be checked
// (a version); text appears when something is wrong.
//
//   node packages/core/src/gui/checks.mjs <id>     the check of one row, as JSON
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as detect from "./detect.mjs";
import { ENV_FILE } from "./env-file.mjs";
import { gameEnvFile, readSettings as readEnv, readSettingsFile } from "../settings.mjs";
import { IS_WSL, ON_WINDOWS, powershell, toLocal, toWindows, windowsFolders } from "./windows-paths.mjs";
import { loadGamePlugin } from "../mcp-client.mjs";
import { setupPlugins } from "./tools.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const rel = (p) => path.relative(REPO, p) || p;

/**
 * A script of this repository as a person would run it: its npm script when it has one, else the node command.
 * The GUI shows the command it is about to run everywhere, so a button never does something unnamed.
 */
export const shownScript = (file) => {
  const name = Object.entries(JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).scripts).find(([, cmd]) => cmd.endsWith(rel(file)))?.[0];
  return name ? `npm run ${name}` : `node ${rel(file)}`;
};
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
// A game plugin reads its settings (a profile, a ROM) when it loads, and the GUI runs for hours while they change.
// So before each load the game's own file (.local/games/<game>.env) is applied to this process, and the plugin is
// imported again when those settings differ from its last load; the CLIs the GUI starts inherit the same values.
const appliedKeys = new Map();
// Where the game plugins are: the repository's games/, or AAS_GAMES_DIR (the tests' own game, so the whole GUI session
// can run in a test without a real game).
const gamesDir = () => process.env.AAS_GAMES_DIR || path.join(REPO, "games");
const loadedPlugins = new Map();
async function loadForGui(file, dir) {
  const values = readSettingsFile(gameEnvFile(dir));
  for (const k of appliedKeys.get(dir) ?? []) if (!(k in values)) delete process.env[k];
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
  appliedKeys.set(dir, Object.keys(values));
  const version = crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 12);
  const hit = loadedPlugins.get(file);
  if (hit?.version === version) return hit.plugin;
  const plugin = await loadGamePlugin(file, { version: loadedPlugins.has(file) ? version : null });
  loadedPlugins.set(file, { version, plugin });
  return plugin;
}

export async function allGames() {
  const dir = gamesDir();
  const out = [];
  for (const d of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, d, "plugin.mjs");
    if (!exists(file)) continue;
    try {
      const plugin = await loadForGui(file, d);
      if (plugin.stub || plugin.setup) out.push({ file, dir: d, plugin });
    } catch { /* a plugin that does not load is not offered */ }
  }
  return out;
}

export async function guiGames() {
  const dir = gamesDir();
  const out = [];
  for (const d of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, d, "plugin.mjs");
    if (!exists(file)) continue;
    try {
      const plugin = await loadForGui(file, d);
      if (!plugin.stub && plugin.setup) out.push({ file, plugin });
    } catch { /* a plugin that does not load is not offered */ }
  }
  return out;
}

/** The folder a game plugin uses when its setting is empty (`setup.settings[].default`, a function), or "". */
export function settingDefault(st) {
  if (typeof st?.default !== "function") return "";
  try { return st.default() || ""; } catch { return ""; }
}

// The paths the harness uses when a setting is not in .env (the launchers' own defaults).
function defaultPath(key) {
  const f = ON_WINDOWS ? windowsFolders() : {};
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
    // Which folder, said before anything is checked: an empty box that says "folder" asks the question instead of
    // answering it. A game's own folder setting says it too, in the game plugin (setup.settings[].what).
    item("General", "output", "Output location", "dir", "AAS_OUTPUT_DIR", { what: "Where your runs are kept. Each run gets its own folder under <this folder>\\<Game>\\<run name>, with its log, its recording and its bundle. Pick a drive with room for video." }),
    item(HARNESS, "repo", "Repository", "info", null, { value: toWindows(REPO) }),
    item(HARNESS, "node", "Node.js", "info", null, { value: `${toWindows(process.execPath)} (${process.version})` }),
    item(HARNESS, "ffmpeg", "ffmpeg (video cut, length)", "info", null, { value: which("ffmpeg") }),
    // Every runtime, recorder and timer with a `setup` of its own: its settings, or one row named after it; the
    // conditions are its own `doctor()` (checkItem, "plugin:<kind>:<id>"). None of them is named here.
    ...(await setupPlugins()).flatMap(({ kind, id, name, setup, plugin }) => {
      const rowId = `plugin:${kind}:${id}`;
      const settings = setup.settings ?? [];
      if (!settings.length) return [item(setup.group ?? "Plugins", rowId, name, "info", null, { value: plugin?.cli ? which(plugin.cli) : "" })];
      const first = settings[0];
      const checkKey = pathValue(first.env) || (settingDefault(first) ? toWindows(settingDefault(first)) : "");
      return settings.map((st, n) => item(setup.group ?? "Plugins", rowId, n === 0 ? name : st.label, st.kind, st.env, { expect: st.expect, what: st.what ?? null, checkKey, ...(settingDefault(st) ? { placeholder: `default: ${toWindows(settingDefault(st))}` } : {}) }));
    }),
    // Steam, only when a game's launcher starts it (setup.steam).
    ...(games.some(({ plugin }) => plugin.setup.steam) ? [item("Windows tools", "steam", "Steam", "file", "AAS_STEAM_EXE", { expect: "steam.exe", placeholder: "default: C:\\Program Files (x86)\\Steam\\steam.exe" })] : []),
    ...(ON_WINDOWS ? [
      item("Screen and sound", "display", "Display for the game", "display", null, { value: display, options: display ? [{ value: display, label: display }] : [] }),
      item("Screen and sound", "svv", "SoundVolumeView (NirSoft)", "file", "AAS_SOUNDVOLUMEVIEW", { expect: "SoundVolumeView.exe" }),
      item("Screen and sound", "quiet", "Sound device for the game", "select", "AAS_QUIET_AUDIO_DEVICE", { options: [{ value: "", label: "Normal (your default device)" }, ...(env.AAS_QUIET_AUDIO_DEVICE ? [{ value: env.AAS_QUIET_AUDIO_DEVICE, label: env.AAS_QUIET_AUDIO_DEVICE }] : [])] }),
      // A plain preference: there is nothing to check, so this row has no check and no status at all.
      item("Screen and sound", "awake", "Keep displays awake during a run", "check", "AAS_KEEP_DISPLAYS_AWAKE", { check: false }),
    ] : []),
    // All rows of a game share one check, the game's, which starts from its first setting: its value, or the default
    // it falls back to, is what a result belongs to (checkKey), for every row of the game.
    ...games.flatMap(({ plugin }) => {
      const first = plugin.setup.settings[0];
      const checkKey = (first && (pathValue(first.env) || (settingDefault(first) ? toWindows(settingDefault(first)) : ""))) || "";
      return plugin.setup.settings.map((st) => item("Games", `game-${plugin.id}`, st.label, st.kind, st.env, { game: plugin.id, expect: st.expect, what: st.what ?? null, checkKey, ...(settingDefault(st) ? { placeholder: `default: ${toWindows(settingDefault(st))}` } : {}),
        // A choice (a game's profile): its options, and the one in use when the setting is empty.
        ...(st.kind === "select" ? { options: typeof st.options === "function" ? st.options() : st.options ?? [], value: env[st.env] || st.value || "" } : {}) }));
    }),
    // Every other game the repository knows: named here too, so the list of games is the whole list and it is
    // visible which ones this machine cannot run at all.
    ...(await allGames()).filter(({ plugin }) => plugin.stub).map(({ dir, plugin }) => item("Games", `stub-${plugin.id}`, plugin.name, "info", null, { value: "", doc: `games/${dir}/README.md` })),
  ];
}

/** The game a setting belongs to, by the plugin that declares it: {AAS_PORTAL_GAME_ROOT: "portal", ...}. */
export async function settingOwners() {
  const owners = {};
  for (const { dir, plugin } of await allGames()) {
    for (const key of [...(plugin.env ?? []), ...(plugin.setup?.settings ?? []).map((x) => x.env), plugin.setup?.displayEnv, plugin.setup?.resolutionEnv].filter(Boolean)) owners[key] = dir;
  }
  return owners;
}

/** The rows a changed setting affects (checked again after a save). */
export async function affectedBy(keys) {
  const map = { AAS_OUTPUT_DIR: ["output"], AAS_STEAM_EXE: ["steam"], AAS_SOUNDVOLUMEVIEW: ["svv", "quiet"], AAS_QUIET_AUDIO_DEVICE: ["quiet"] };
  // A plugin's own settings belong to its row.
  for (const { kind, id, setup } of await setupPlugins()) for (const st of setup.settings ?? []) map[st.env] = [...(map[st.env] ?? []), `plugin:${kind}:${id}`];
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
    // A recorder may know where its program already records (setup.outputFolder): offered, never chosen for you.
    let suggest = null, suggestSource = null;
    for (const { name, setup } of await setupPlugins()) {
      if (typeof setup.outputFolder !== "function") continue;
      try { suggest = setup.outputFolder(); } catch { suggest = null; }
      if (suggest) { suggestSource = `${name}'s recording folder`; break; }
    }
    const extra = { suggest: suggest && suggest !== toWindows(dir) ? suggest : null, suggestSource };
    if (t("a folder is chosen", dir, { level: "missing", detail: "Choose where runs are saved; each run goes to <location>\\<game>\\<run>." })
      && t("the folder exists", exists(dir), { detail: "This folder does not exist." })) {
      t("the harness can write in it", (() => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } })(), { detail: "This folder is not writable." });
      if (ON_WINDOWS) t("it is on a Windows drive, so a recorder on Windows can write into it", /^\/mnt\/[a-z]\//.test(`${dir}/`), { level: "warn", detail: "Not on a Windows drive: a recorder on Windows cannot write into it." });
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
  if (id.startsWith("plugin:")) {
    // A runtime's, recorder's or timer's row: the conditions its own doctor() gives, asked of `aas doctor --<kind>
    // <id> --json`, so the row and the command line measure the same thing; the command stands under the row.
    const [, kind, pluginId] = id.split(":");
    const plug = (await setupPlugins()).find((x) => x.kind === kind && x.id === pluginId);
    if (!plug) { t("the plugin is known", false, { detail: `Unknown: ${id}` }); return done(); }
    const via = ["doctor", `--${kind}`, pluginId, "--json"];
    const r = spawnSync(process.execPath, [path.join(REPO, "packages", "core", "src", "cli.mjs"), ...via], { encoding: "utf8", timeout: 120000, env: process.env });
    let rows; try { rows = JSON.parse(r.stdout.trim().split("\n").at(-1)).filter((x) => x.source === kind); } catch { rows = [{ ok: false, what: "aas doctor answered", detail: (r.stderr || r.stdout || "no answer").trim().split("\n").at(-1) }]; }
    const fixOf = (f) => { const a = f && plug.setup.fixes?.[f]; return a ? { id: `plugin:${kind}:${pluginId}:${f}`, label: a.label, command: a.script ? shownScript(a.script) : a.command.join(" ") } : null; };
    for (const row of rows) {
      // A condition only a running program establishes (its server, its endpoint) is listed, not judged, here.
      if (row.when === "run") { t(`${row.what} (checked when a run starts${row.ok ? "" : `; now: ${row.detail}`})`, true); continue; }
      t(row.what, row.ok, { level: row.level ?? "fail", detail: row.detail || `Not ready: ${row.what}.`, fix: fixOf(row.fix) });
    }
    return done({ via: `node packages/core/src/cli.mjs ${via.join(" ")}` });
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
    // The folder the plugin uses without a setting (setup.settings[].default, e.g. an emulator's install folder).
    const current = toLocal(env[st.env] ?? "") || settingDefault(st);
    const found = st.find && ON_WINDOWS ? detect.findGame(st.find) : null;
    const extra = { suggest: found && found.path !== current ? toWindows(found.path) : null, suggestSource: found?.source ?? null };
    // The button says what it does and which command it runs. "Install" on its own can mean the game, the mod, the
    // tooling or the harness; the plugin says which of them in one sentence (setup.installs) and the command is
    // shown with it, the way the Run tab shows every command it would run.
    const install = g.plugin.setup.install
      ? { id: `install:${g.plugin.id}`, label: g.plugin.setup.installs ?? `Run this game's install script`, command: shownScript(g.plugin.setup.install) }
      : null;
    // Every condition is the thing that has to be true, named in full: read on its own it still says which folder
    // and what has to be in it, so the list is the whole answer and the heading above it is only a heading.
    const folder = (st.label ?? "the game folder").replace(/^the /i, "");
    if (!t(`the ${folder} is chosen`, current, { level: "missing", detail: `Choose the folder with ${st.expect ?? "the game"}.`, fix: install })) return done(extra);
    if (!t(`the ${folder} exists`, exists(current), { detail: "This folder does not exist.", fix: install })) return done(extra);
    if (st.expect && !t(`${st.expect} is in the ${folder}`, exists(path.join(current, st.expect)), { detail: `${st.expect} is not in this folder.`, fix: install })) return done(extra);
    // The rest is what `aas doctor --game` establishes, asked of the command itself (--json), so the row and the
    // command line measure the same thing; the command stands under the row.
    const via = ["doctor", "--game", g.file, "--json"];
    const r = spawnSync(process.execPath, [path.join(REPO, "packages", "core", "src", "cli.mjs"), ...via], { encoding: "utf8", timeout: 90000, env: process.env });
    let rows; try { rows = JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch { rows = [{ ok: false, what: "aas doctor answered", detail: (r.stderr || r.stdout || "no answer").trim().split("\n").at(-1) }]; }
    // A check may name a fix of its own (setup.fixes): a step of the game's set-up other than the install.
    const ownFix = (id) => { const f = g.plugin.setup.fixes?.[id]; return f ? { id: `fix:${g.plugin.id}:${id}`, label: f.label, command: shownScript(f.script) } : null; };
    for (const row of rows) {
      // The game's endpoint is only there while the game runs; at set-up time that is nothing to fix, so it is
      // listed as what it is: a condition a run establishes when it starts the game.
      const endpoint = /^game endpoint /.test(row.what);
      t(row.what, row.ok || endpoint, { level: "warn", detail: row.detail ?? `Not ready: ${row.what}.`, fix: (row.fix && ownFix(row.fix)) || install });
      if (endpoint && !row.ok) tests.at(-1).what = `${row.what} (checked when a run starts the game; now: ${row.detail})`;
    }
    // Everything passed, so the same action is offered again rather than needed: the sentence stays, "again" says why.
    return done({ ...extra, via: `node packages/core/src/cli.mjs ${via.map((a) => (a === g.file ? rel(a) : a)).join(" ")}`, fix: tests.every((x) => x.ok) && install ? { ...install, label: `${install.label} (again)` } : undefined });
  }
  t("the check is known", false, { detail: `Unknown check: ${id}` });
  return done();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.loadEnvFile(ENV_FILE); } catch { /* no .env */ }
  try { console.log(JSON.stringify(await checkItem(process.argv[2]))); } catch (e) { console.log(JSON.stringify({ status: "fail", detail: String(e?.message ?? e) })); }
}
