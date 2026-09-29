// The GUI's plumbing: the .env it edits keeps what it does not touch, paths are shown the Windows way and used the
// harness way, and the page server only answers this machine's own origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-gui-"));
process.env.AAS_ENV_FILE = path.join(dir, ".env");
process.env.AAS_GUI_NOTE = path.join(dir, "gui.json");
process.env.AAS_GUI_CHECKS = path.join(dir, "gui-checks.json");
process.env.AAS_GAME_ENV_DIR = path.join(dir, "games");
const { readEnv, writeEnv } = await import("../src/gui/env-file.mjs");
const { toLocal, toWindows, IS_WSL } = await import("../src/gui/windows-paths.mjs");

test("writeEnv changes a setting in place, appends a new one, removes an emptied one, keeps comments", () => {
  fs.writeFileSync(process.env.AAS_ENV_FILE, "# machine settings\nAAS_OBS_URL=ws://127.0.0.1:4455\n# a comment\nAAS_STS_SEED=23M\n");
  writeEnv({ AAS_OBS_URL: "ws://127.0.0.1:4460", AAS_OUTPUT_DIR: "/mnt/g/OBS", AAS_STS_SEED: "" });
  const text = fs.readFileSync(process.env.AAS_ENV_FILE, "utf8");
  assert.equal(text, "# machine settings\nAAS_OBS_URL=ws://127.0.0.1:4460\n# a comment\n\n# set with aas gui\nAAS_OUTPUT_DIR=/mnt/g/OBS\n");
  assert.deepEqual(readEnv(), { AAS_OBS_URL: "ws://127.0.0.1:4460", AAS_OUTPUT_DIR: "/mnt/g/OBS" });
  assert.equal(process.env.AAS_OUTPUT_DIR, "/mnt/g/OBS");
  assert.throws(() => writeEnv({ "BAD NAME": "x" }), /not a setting name/);
  writeEnv({ AAS_OUTPUT_DIR: "/mnt/h/runs\nAAS_EVIL=1" });
  assert.equal(readEnv().AAS_EVIL, undefined, "a value cannot add a line");
});

test("paths: Windows form for people, local form for the harness", { skip: !IS_WSL && "only under WSL" }, () => {
  assert.equal(toLocal("G:\\OBS\\Balatro"), "/mnt/g/OBS/Balatro");
  assert.equal(toLocal("g:/OBS"), "/mnt/g/OBS");
  assert.equal(toLocal("C:\\"), "/mnt/c");
  assert.equal(toWindows("/mnt/g/OBS/Balatro"), "G:\\OBS\\Balatro");
  assert.equal(toWindows("/mnt/c"), "C:\\");
  assert.equal(toLocal("/mnt/g/OBS"), "/mnt/g/OBS");
});

test("the page server refuses other hosts and cross-origin changes", async () => {
  const { startGui } = await import("../src/gui/server.mjs");
  const gui = await startGui({ port: 0, open: false, checkAtStart: false, log() {} });
  const port = gui.server.address().port;
  const http = await import("node:http");
  const call = (method, p, headers, body) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end(body);
  });
  try {
    assert.equal(await call("GET", "/", { Host: `127.0.0.1:${port}` }), 200);
    assert.equal(await call("GET", "/api/state", { Host: `evil.example:${port}` }), 403);
    assert.equal(await call("POST", "/api/settings", { Host: `127.0.0.1:${port}`, Origin: "http://evil.example", "Content-Type": "application/json" }, "{}"), 403);
  } finally {
    gui.server.close();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
});

test("a second start opens the GUI that is already running instead of failing on the port", async () => {
  const { startGui } = await import("../src/gui/server.mjs");
  const first = await startGui({ port: 0, open: false, checkAtStart: false, log() {} });
  const url = `http://127.0.0.1:${first.server.address().port}/`;
  try {
    assert.equal(JSON.parse(fs.readFileSync(process.env.AAS_GUI_NOTE, "utf8")).url, url, "the running GUI leaves a note");
    const second = await startGui({ port: 0, open: false, checkAtStart: false, log() {} });
    assert.equal(second.already, true, "the second start does not start a second GUI");
    assert.equal(second.url, url, "it points at the one that is running");
    assert.equal(second.server, undefined, "and it holds no server of its own");
  } finally {
    first.server.close();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
  // A GUI that was killed leaves its note behind; the next start must not believe it.
  fs.writeFileSync(process.env.AAS_GUI_NOTE, JSON.stringify({ url, pid: 1 }));
  const again = await startGui({ port: 0, open: false, checkAtStart: false, log() {} });
  try {
    assert.equal(again.already, undefined, "a stale note does not block a start");
    assert.notEqual(`http://127.0.0.1:${again.server.address().port}/`, url);
  } finally {
    again.server.close();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
});

test("the game check reads the game's own settings, not only the machine's", async () => {
  // Since 0.22.0 a game's folder lives in .local/games/<game>.env. The GUI's game row asks `aas doctor --game --json`
  // in a process of its own, and a process that loads only .env reports a game that is set up as one that is not.
  const { spawnSync } = await import("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aas-gamesettings-"));
  const games = path.join(home, "games");
  fs.mkdirSync(games);
  const plugin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aas-g-")), "make-believe");
  fs.mkdirSync(plugin);
  fs.writeFileSync(path.join(plugin, "plugin.mjs"), `export default { id: "make_believe", name: "Make Believe", ends: [{ id: "end", label: "End", final: true }],
  async doctor() { return [{ ok: Boolean(process.env.AAS_MAKE_BELIEVE_ROOT), what: "its folder", detail: process.env.AAS_MAKE_BELIEVE_ROOT ?? "not set" }]; } };
`);
  fs.writeFileSync(path.join(games, "make-believe.env"), "AAS_MAKE_BELIEVE_ROOT=/somewhere\n");
  const cli = path.join(process.cwd(), "packages", "core", "src", "cli.mjs");
  // The exit code says whether every row passed (the fake plugin fails some on purpose); the rows are the answer.
  const run = (env) => JSON.parse(spawnSync(process.execPath, [cli, "doctor", "--game", path.join(plugin, "plugin.mjs"), "--json"], { encoding: "utf8", env: { ...process.env, ...env } }).stdout.trim().split("\n").at(-1)).filter((r) => r.what === "its folder");
  assert.deepEqual(run({ AAS_GAME_ENV_DIR: games, AAS_ENV_FILE: path.join(home, ".env") }), [{ ok: true, what: "its folder", detail: "/somewhere" }]);
  // And without that file the plugin says so itself, instead of the check inventing a reason.
  fs.rmSync(path.join(games, "make-believe.env"));
  assert.deepEqual(run({ AAS_GAME_ENV_DIR: games, AAS_ENV_FILE: path.join(home, ".env") }), [{ ok: false, what: "its folder", detail: "not set" }]);
});

test("Portal's check covers the controller it runs on, not only the game's own files", async () => {
  // portal-agent is not in this repository: without the checkout a run does not start and a bundle cannot be
  // published, so the check has to say so before the run does.
  const plugin = (await import("../../../games/portal/plugin.mjs")).default;
  const previous = process.env.AAS_PORTAL_AGENT_DIR;
  process.env.AAS_PORTAL_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aas-no-agent-"));
  try {
    const fresh = (await import(`../../../games/portal/plugin.mjs?nocheckout=${Date.now()}`)).default;
    const rows = await fresh.doctor();
    const checkout = rows.find((r) => /portal-agent checkout/.test(r.what));
    assert.ok(checkout, "the checkout is one of the conditions");
    assert.equal(checkout.ok, false);
    assert.match(checkout.detail, /npm run portal:fetch/, "and it says what makes it true");
    // What install-game-files.mjs copies from is a condition too: the Setup tab's button fails without it.
    assert.ok(rows.some((r) => r.what === "spt.dll to install from"), "the file the install button needs");
  } finally {
    if (previous === undefined) delete process.env.AAS_PORTAL_AGENT_DIR; else process.env.AAS_PORTAL_AGENT_DIR = previous;
  }
  assert.ok(plugin.doctor, "the plugin still has its checks");
});

test("every folder a game asks for says which folder it is", async () => {
  // "folder" on its own is a question, not an answer: the empty box and the line under the heading both say which
  // folder to pick, and the game plugin is what says it (setup.settings[].what).
  const { guiGames } = await import("../src/gui/checks.mjs");
  for (const g of await guiGames()) {
    for (const st of g.plugin.setup.settings.filter((x) => x.kind === "dir")) {
      assert.equal(typeof st.what, "string", `${g.plugin.id}: ${st.env} does not say which folder it means`);
      assert.ok(st.expect && st.what.includes(st.expect), `${g.plugin.id}: "${st.what}" does not name ${st.expect}, which is how a person recognises the folder`);
      assert.ok(st.what.length > 40, `${g.plugin.id}: "${st.what}" is too short to answer "which folder?"`);
    }
  }
});

test("a button in the Setup tab says what it does and which command it runs", async () => {
  // "Install" on its own can mean the game, the mod, the tooling or the harness. Every game plugin that offers an
  // install script says in one sentence what that script puts where, and the command is shown with the button.
  const { shownScript, guiGames } = await import("../src/gui/checks.mjs");
  const games = await guiGames();
  assert.ok(games.length, "there are games with a plugin");
  for (const g of games) {
    if (!g.plugin.setup.install) continue;
    const says = g.plugin.setup.installs;
    assert.equal(typeof says, "string", `${g.plugin.id}: setup.installs is the sentence its button carries`);
    assert.ok(says.length > 20 && !/^install$/i.test(says), `${g.plugin.id}: "${says}" does not say what it installs`);
    assert.match(shownScript(g.plugin.setup.install), /^(npm run [a-z0-9:_-]+|node .+\.mjs)$/, g.plugin.id);
  }
});

test("a game is set up by its first setting in .env, or by the folder its plugin uses without one", async () => {
  const { settingReady } = await import("../src/gui/server.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "aas-ready-"));
  const setting = { env: "AAS_X_DIR", kind: "dir", expect: "x.exe", default: () => dir };
  assert.equal(settingReady(setting, { AAS_X_DIR: "C:\\X" }), true);
  assert.equal(settingReady(setting, {}), false, "the default folder without the expected file");
  writeFileSync(join(dir, "x.exe"), "");
  assert.equal(settingReady(setting, {}), true, "the default folder with the expected file");
  assert.equal(settingReady({ env: "AAS_Y_ROOT", kind: "dir" }, {}), false, "no value and no default");
});

test("a setting's default is what the plugin uses without a value, and nothing when it fails", async () => {
  const { settingDefault } = await import("../src/gui/checks.mjs");
  assert.equal(settingDefault({ env: "AAS_X", default: () => "/some/folder" }), "/some/folder");
  assert.equal(settingDefault({ env: "AAS_X", default: () => { throw new Error("no"); } }), "");
  assert.equal(settingDefault({ env: "AAS_X" }), "");
});

test("a button's outcome comes back to the page and stands in the log, done or not with the reason", async () => {
  const { startGui } = await import("../src/gui/server.mjs");
  const gui = await startGui({ port: 0, open: false, checkAtStart: false, log() {} });
  const base = `http://127.0.0.1:${gui.server.address().port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  try {
    const ok = await post("/api/proof-answer", { anonymous: true });
    assert.equal(ok.status, 200);
    assert.match(ok.json.message, /anonymously from now on/);
    const bad = await post("/api/archive", { action: "extend", arg: "not-a-ticket" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "Not a ticket.");
    const lines = (await (await fetch(`${base}/api/state`)).json()).lines.map((l) => `${l.kind} ${l.text}`);
    assert.ok(lines.some((l) => /^ok Runs record their proof anonymously/.test(l)), lines.join("\n"));
    assert.ok(lines.includes("err Failed: archive: Not a ticket."), lines.join("\n"));
  } finally {
    gui.server.close();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
});

test("the model and effort chosen on the page go to an AI run's command, never to a mock run's", async () => {
  const { createSession } = await import("../src/gui/session.mjs");
  const s = createSession();
  const runStep = (p) => p.steps.find((x) => x.id === "run").shown;
  const ai = runStep(await s.plan({ game: "balatro", runtime: "claude-code", model: "claude-opus-5-5", effort: "high" }));
  assert.match(ai, /--model claude-opus-5-5/);
  assert.match(ai, /--effort high/);
  const mock = runStep(await s.plan({ game: "balatro", runtime: "scripted", model: "claude-opus-5-5", effort: "high" }));
  assert.doesNotMatch(mock, /--model|--effort/);
  await assert.rejects(s.plan({ game: "balatro", runtime: "claude-code", effort: "hi gh" }), /--effort "hi gh" is not allowed: one word as the AI.s CLI lists them/);
  await assert.rejects(s.plan({ game: "balatro", runtime: "claude-code", model: "x; rm -rf /" }), /--model .* is not allowed/);
});

test("every step a session calls is a step of its plan (a step taken out of the plan is not called any more)", async () => {
  const src = fs.readFileSync(new URL("../src/gui/session.mjs", import.meta.url), "utf8");
  const called = [...new Set([...src.matchAll(/byId\.(\w+)\.args/g)].map((m) => m[1]))];
  const optional = new Set([...src.matchAll(/if \(byId\.(\w+)\)/g)].map((m) => m[1]));
  const { createSession } = await import("../src/gui/session.mjs");
  const ids = (await createSession().plan({ game: "balatro", runtime: "scripted" })).steps.map((x) => x.id);
  for (const id of called) if (!optional.has(id)) assert.ok(ids.includes(id), `the session calls step "${id}", which the plan does not have (${ids.join(", ")})`);
});

test("a game's profile chosen in its settings file is the one the GUI plans with, also after it changed", async () => {
  const { createSession } = await import("../src/gui/session.mjs");
  const { configItems } = await import("../src/gui/checks.mjs");
  const s = createSession();
  const file = path.join(process.env.AAS_GAME_ENV_DIR, "fceux.env");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const goalOf = async () => (await s.plan({ game: "fceux", runtime: "scripted" })).steps.find((x) => x.id === "run").shown.match(/--goal (\S+)/)[1];
  try {
    fs.writeFileSync(file, "AAS_FCEUX_PROFILE=smb\n");
    assert.equal(await goalOf(), "world1", "Super Mario Bros.: a mock run aims at the first end");
    const row = (await configItems()).find((i) => i.env === "AAS_FCEUX_PROFILE");
    assert.equal(row.kind, "select");
    assert.equal(row.value, "smb");
    assert.deepEqual(row.options.map((o) => o.value).sort(), ["nes15", "smb"]);
    fs.writeFileSync(file, "AAS_FCEUX_PROFILE=nes15\n");
    assert.equal(await goalOf(), "solved", "back to nes15 without restarting the GUI");
    fs.rmSync(file);
    assert.equal(await goalOf(), "solved", "no setting: the plugin's default profile");
  } finally {
    fs.rmSync(file, { force: true });
    delete process.env.AAS_FCEUX_PROFILE;
  }
});

test("no button answers with a bare Done, and the page learns when the tooling changed under a running GUI", async () => {
  const page = fs.readFileSync(new URL("../src/gui/page.html", import.meta.url), "utf8");
  assert.doesNotMatch(page, /"Done\."/, "a button says what it did, never only that it is done");
  const acts = [...page.matchAll(/await act\(|\bact\("/g)].length;
  assert.ok(acts >= 8, "the buttons report through act()");
  const { startGui } = await import("../src/gui/server.mjs");
  const gui = await startGui({ port: 0, open: false, checkAtStart: false, log() {} });
  try {
    const g = await (await fetch(`http://127.0.0.1:${gui.server.address().port}/api/gui`)).json();
    assert.equal(g.stale, false, "a GUI that runs the code on disk is not stale");
  } finally {
    gui.server.close();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
});

test("the models and efforts come from the AI's own CLI: claude --help and codex debug models, read as they are", async () => {
  // Nothing in the tooling names a model: models are retired and released faster than releases, so the lists are
  // read from the CLIs each time (owner, 2026-09-29).
  const { parseClaudeHelp } = await import("../../runtime-claude-code/index.mjs");
  const help = `Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
`;
  assert.deepEqual(parseClaudeHelp(help), { efforts: ["low", "medium", "high", "xhigh", "max"], aliases: ["fable", "opus", "sonnet"], example: "claude-fable-5" });
  const { parseCodexCatalog } = await import("../../runtime-codex/index.mjs");
  const catalog = JSON.stringify({ models: [
    { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "gpt-a", display_name: "GPT-A", visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "ultra" }] },
    { slug: "gpt-b", display_name: "gpt-b", visibility: "list", default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high" }] },
  ] });
  assert.deepEqual(parseCodexCatalog(catalog), { models: [
    { id: "gpt-a", label: "gpt-a (GPT-A)", efforts: ["low", "medium", "ultra"], defaultEffort: "medium" },
    { id: "gpt-b", label: "gpt-b", efforts: ["high"], defaultEffort: "high" },
  ], efforts: ["low", "medium", "ultra", "high"] });
  // The core's own check only holds an effort to one word: which words are allowed is the runtime's CLI's to say.
  const { checkEffort } = await import("../src/validate.mjs");
  assert.equal(checkEffort("ultra"), "ultra");
  assert.throws(() => checkEffort('high" x'), /one word as the AI's CLI lists them/);
});

test("the run's options on the page reach the command, each as aas run takes it, and only where it applies", async () => {
  const { createSession } = await import("../src/gui/session.mjs");
  const s = createSession();
  const runStep = (p) => p.steps.find((x) => x.id === "run").shown;
  const instructions = path.join(dir, "my-instructions.md");
  fs.writeFileSync(instructions, "# play well\n");
  const ai = runStep(await s.plan({ game: "balatro", runtime: "claude-code", maxTurns: "40", autosave: "5", keepOpen: "1", prompt: "Reach ante 2.\nSay \"go\".", instructions }));
  assert.match(ai, /--max-turns 40/);
  assert.match(ai, /--autosave-minutes 5/);
  assert.match(ai, /--keep-open/);
  assert.match(ai, /--prompt "Reach ante 2\.\nSay \\"go\\"\."/, "the prompt is one quoted word, its quotes escaped, so the shown line still pastes");
  assert.match(ai, new RegExp(`--instructions ${instructions.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
  const off = runStep(await s.plan({ game: "balatro", runtime: "claude-code", autosave: "off" }));
  assert.match(off, /--no-autosave/);
  assert.doesNotMatch(off, /--autosave-minutes/);
  // A mock plays the game's script: no prompt and no instructions go to it, its limits do.
  const mock = runStep(await s.plan({ game: "balatro", runtime: "scripted", maxTurns: "40", prompt: "x", instructions }));
  assert.match(mock, /--max-turns 40/);
  assert.doesNotMatch(mock, /--prompt|--instructions/);
  await assert.rejects(s.plan({ game: "balatro", runtime: "claude-code", instructions: path.join(dir, "missing.md") }), /is not there/);
  await assert.rejects(s.plan({ game: "balatro", runtime: "claude-code", maxTurns: "0" }), /Turn limit/);
});

test("the bundle is signed when this machine has a key, and the page is told which", async () => {
  // XDG_CONFIG_HOME of this test process holds no key yet; publish.mjs finds the key aas key makes there.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aas-gui-key-"));
  const previous = { xdg: process.env.XDG_CONFIG_HOME, sign: process.env.AAS_SIGN_KEY, ssh: process.env.HOME };
  process.env.XDG_CONFIG_HOME = home;
  delete process.env.AAS_SIGN_KEY;
  process.env.HOME = home; // so an SSH key of the person running the tests does not count
  try {
    const { createSession, signingKey } = await import("../src/gui/session.mjs");
    const s = createSession();
    assert.equal(signingKey(), null, "no key yet");
    let p = await s.plan({ game: "balatro", runtime: "scripted" });
    assert.equal(p.signed, false);
    assert.doesNotMatch(p.steps.find((x) => x.id === "publish").shown, /--sign/);
    const { createKey } = await import("../src/sign.mjs");
    const { AAS_KEY_FILE } = await import("../src/publish.mjs");
    createKey(AAS_KEY_FILE());
    const k = signingKey();
    assert.equal(k.own, true, "the key aas key makes");
    assert.match(k.publicLine, /^ssh-ed25519 /);
    p = await s.plan({ game: "balatro", runtime: "scripted" });
    assert.equal(p.signed, true);
    assert.match(p.steps.find((x) => x.id === "publish").shown, /publish [\s\S]* --sign$/);
    assert.match(p.steps.find((x) => x.id === "publish").title, /signed with your key from aas key/);
  } finally {
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.xdg;
    if (previous.sign !== undefined) process.env.AAS_SIGN_KEY = previous.sign;
    process.env.HOME = previous.ssh;
  }
});

test("who plays is one list: the game's script when it has one, and every AI whose CLI is here", async () => {
  const { startGui } = await import("../src/gui/server.mjs");
  const gui = await startGui({ port: 0, open: false, checkAtStart: false, log() {} });
  try {
    const j = await (await fetch(`http://127.0.0.1:${gui.server.address().port}/api/games`)).json();
    assert.deepEqual(j.runtimes.map((r) => r.id), ["scripted", "claude-code", "codex"], "the run types aas run --runtime knows, in that order");
    assert.equal(j.runtimes[0].present, true, "the script is always here");
    for (const r of j.runtimes.slice(1)) assert.equal(r.present, j.agents.some((a) => a.id === r.id), `${r.id} is offered exactly when its CLI is on the PATH`);
    const page = fs.readFileSync(new URL("../src/gui/page.html", import.meta.url), "utf8");
    assert.doesNotMatch(page, /id="ai"/, "no second list for the AI");
    assert.match(page, /list="models"/, "the model is typed or picked from what the CLI lists");
  } finally {
    gui.server.close();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
});
