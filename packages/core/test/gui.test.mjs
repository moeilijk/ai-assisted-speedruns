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
  const gui = await startGui({ port: 0, open: false, log() {} });
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
  const first = await startGui({ port: 0, open: false, log() {} });
  const url = `http://127.0.0.1:${first.server.address().port}/`;
  try {
    assert.equal(JSON.parse(fs.readFileSync(process.env.AAS_GUI_NOTE, "utf8")).url, url, "the running GUI leaves a note");
    const second = await startGui({ port: 0, open: false, log() {} });
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
  const again = await startGui({ port: 0, open: false, log() {} });
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
  // Since 0.22.0 a game's folder lives in .local/games/<game>.env. The GUI runs a plugin's checks in a process of
  // its own (game-doctor.mjs), and a process that loads only .env reports a game that is set up as one that is not.
  const { execFileSync } = await import("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aas-gamesettings-"));
  const games = path.join(home, "games");
  fs.mkdirSync(games);
  const plugin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aas-g-")), "make-believe");
  fs.mkdirSync(plugin);
  fs.writeFileSync(path.join(plugin, "plugin.mjs"), `export default { id: "make_believe", name: "Make Believe", ends: [{ id: "end", label: "End", final: true }],
  async doctor() { return [{ ok: Boolean(process.env.AAS_MAKE_BELIEVE_ROOT), what: "its folder", detail: process.env.AAS_MAKE_BELIEVE_ROOT ?? "not set" }]; } };
`);
  fs.writeFileSync(path.join(games, "make-believe.env"), "AAS_MAKE_BELIEVE_ROOT=/somewhere\n");
  const doctor = path.join(process.cwd(), "packages", "core", "src", "gui", "game-doctor.mjs");
  const run = (env) => JSON.parse(execFileSync(process.execPath, [doctor, path.join(plugin, "plugin.mjs")], { encoding: "utf8", env: { ...process.env, ...env } }));
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
