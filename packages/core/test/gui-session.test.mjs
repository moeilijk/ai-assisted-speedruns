// The GUI's whole session, through the real commands a person's Start and Continue run: the game's launcher,
// `aas run`, `aas publish`, then `aas resume` and `aas publish` again, with the tests' own game (test/gui-game) so no
// real program is needed. A step the session calls that the plan no longer has, a bundle that is not made, a result
// the page cannot act on: each fails here (0.33.5 to 0.33.7 made no bundle from the GUI, and no test saw it).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-gui-session-"));
const output = path.join(dir, "output");
fs.mkdirSync(output, { recursive: true });
Object.assign(process.env, {
  AAS_ENV_FILE: path.join(dir, ".env"), AAS_GAME_ENV_DIR: path.join(dir, "games"), AAS_GUI_NOTE: path.join(dir, "gui.json"),
  AAS_GUI_CHECKS: path.join(dir, "gui-checks.json"), XDG_CONFIG_HOME: path.join(dir, "config"), AAS_GAMES_DIR: path.join(here, "gui-game"),
  AAS_PROOF: "off",
  // No key of the person running the tests (an SSH key counts for aas publish --sign): the test makes its own.
  HOME: dir,
});
delete process.env.AAS_LIVESPLIT_EXE;
fs.writeFileSync(process.env.AAS_ENV_FILE, `AAS_OUTPUT_DIR=${output}\nAAS_PROOF=off\n`);

test("Start runs the game, the run and the bundle; Continue runs the next segment and a new revision", { timeout: 180000 }, async () => {
  const { startGui } = await import("../src/gui/server.mjs");
  const gui = await startGui({ port: 0, open: false, checkAtStart: false, log() {} });
  const base = `http://127.0.0.1:${gui.server.address().port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const state = async () => (await fetch(`${base}/api/state`)).json();
  const untilIdle = async () => {
    for (let i = 0; i < 600; i += 1) {
      const s = await state();
      if (s.state.phase === "idle" && s.state.result) return s;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("the session did not end");
  };
  try {
    const games = await (await fetch(`${base}/api/games`)).json();
    assert.deepEqual(games.games.map((g) => g.id), ["gui_fake"], "the GUI offers the tests' game");
    const start = await post("/api/start", { game: "gui_fake", runtime: "scripted", recorder: "null", timer: "none" });
    assert.equal(start.status, 200, JSON.stringify(start.json));
    let s = await untilIdle();
    const lines = s.lines.map((l) => `${l.kind} ${l.text}`);
    const joined = lines.join("\n");
    assert.match(joined, /cmd \$ node .*launch\.mjs/, "the game was started");
    assert.match(joined, /cmd \$ node packages\/core\/src\/cli\.mjs run/, "aas run ran");
    assert.match(joined, /cmd \$ node packages\/core\/src\/cli\.mjs publish/, "aas publish ran");
    assert.doesNotMatch(joined, /^err /m, `no step failed:\n${lines.filter((l) => l.startsWith("err")).join("\n")}`);
    const first = s.state.result;
    assert.equal(first.status, "stopped", "the scripted player was done without reaching the end, so the run can go on");
    assert.ok(first.bundle, "the session made a bundle");
    const localRun = path.join(output, "GuiFake", s.state.run);
    const zip = path.join(output, "GuiFake", "public", `${s.state.run}-upload.zip`);
    assert.ok(fs.existsSync(zip), `${zip} exists`);
    assert.ok(fs.existsSync(path.join(localRun, "run.jsonl")));

    const cont = await post("/api/continue", { runDir: first.runDir });
    assert.equal(cont.status, 200, JSON.stringify(cont.json));
    s = await untilIdle();
    const again = s.lines.map((l) => `${l.kind} ${l.text}`).join("\n");
    assert.match(again, /cmd \$ node packages\/core\/src\/cli\.mjs resume/, "Continue ran aas resume");
    assert.ok(s.state.result.bundle, "Continue made the bundle again");
    const revision = JSON.parse(fs.readFileSync(path.join(localRun, "publish-revision.json"), "utf8")).revision;
    assert.equal(revision, 2, "the bundle is the run's second revision");
    const segments = fs.readFileSync(path.join(localRun, "run.jsonl"), "utf8").split("\n").filter((l) => l.includes('"run.started"') || l.includes('"run.resumed"')).length;
    assert.ok(segments >= 2, "the run log holds both segments");

    // Stop with nothing running closes what the game's own stop script closes, and says so.
    const stop = await post("/api/stop", { game: "gui_fake" });
    assert.equal(stop.status, 200);
    await untilIdle();
    assert.match((await state()).lines.map((l) => l.text).join("\n"), /close: GUI Fake closed/);
  } finally {
    gui.server.close();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
});

test("the tools around a run, Continue's choices and the checks before a run, each through the CLI's own command", { timeout: 180000 }, async () => {
  const { startGui } = await import("../src/gui/server.mjs");
  const gui = await startGui({ port: 0, open: false, checkAtStart: false, log() {} });
  const base = `http://127.0.0.1:${gui.server.address().port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const get = async (p) => (await fetch(base + p)).json();
  const state = async () => get("/api/state");
  const untilIdle = async () => {
    for (let i = 0; i < 600; i += 1) {
      const s = await state();
      if (s.state.phase === "idle" && s.state.result) return s;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("the session did not end");
  };
  const logText = async (from = 0) => (await state()).lines.slice(from).map((l) => `${l.kind} ${l.text}`).join("\n");
  try {
    // A key first (aas key, in this test's own XDG_CONFIG_HOME): from now on the bundle is signed.
    assert.equal((await get("/api/key")).key, null, "no key yet");
    const made = await post("/api/key", { action: "create" });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.match(made.json.message, /created: .*signing\.pem; bundles are signed with it from now on/);
    assert.equal((await get("/api/key")).key.own, true);
    const claim = await post("/api/key", { action: "claim", identities: ["https://example.org/me", "mailto:me@example.org"] });
    assert.equal(claim.status, 200, JSON.stringify(claim.json));
    assert.match(claim.json.claim, /aas-key-claim v1/);
    assert.match(claim.json.claim, /https:\/\/example\.org\/me/);
    assert.equal((await post("/api/key", { action: "claim", identities: ["ftp://x"] })).status, 400, "an identity is https or mailto");

    // The checks before a run: aas doctor for the choices, and the connection with the game started and closed.
    const doc = await post("/api/tool", { action: "doctor", game: "gui_fake", recorder: "null", timer: "none", runtime: "scripted" });
    assert.equal(doc.status, 200, JSON.stringify(doc.json));
    assert.match(doc.json.message, /^Checks done: All checks passed\.$/);
    assert.ok(doc.json.lines.some((l) => /PASS\s+game plugin gui_fake/.test(l)), doc.json.lines.join("\n"));
    assert.match(await logText(), /cmd \$ node packages\/core\/src\/cli\.mjs doctor --game .*gui-game\/fake\/plugin\.mjs --recorder null/);
    const con = await post("/api/tool", { action: "connection", game: "gui_fake" });
    assert.equal(con.status, 200, JSON.stringify(con.json));
    assert.match(con.json.message, /Connection check passed/);
    const conLog = await logText();
    assert.match(conLog, /cmd \$ node packages\/core\/src\/cli\.mjs check-connection --game .* --run-dir .*connection-check --exercise/);
    assert.match(conLog, /close: GUI Fake closed/, "the game was closed again");

    // The autosave every 5 minutes: a run without autosave (autosave "off", --no-autosave) has no save to go on from.
    const start = await post("/api/start", { game: "gui_fake", runtime: "scripted", recorder: "null", timer: "none", maxTurns: "5", autosave: "5" });
    assert.equal(start.status, 200, JSON.stringify(start.json));
    let s = await untilIdle();
    const joined = s.lines.map((l) => `${l.kind} ${l.text}`).join("\n");
    // A long command is logged one option per line, as it is shown.
    assert.match(joined, /^cmd\s+--max-turns 5( \\)?$/m, "the options went to aas run");
    assert.match(joined, /^cmd\s+--autosave-minutes 5( \\)?$/m);
    assert.match(joined, /cli\.mjs publish \\\n(cmd\s+\S.*\n){2}cmd\s+--sign$/m, "the bundle was signed (the publish command, its two paths, then --sign)");
    // The one refused button above (ftp://x) is the only error line: no step of the session failed.
    assert.deepEqual(joined.split("\n").filter((l) => l.startsWith("err") && !/ftp:\/\/x/.test(l)), []);
    const first = s.state.result;
    const localRun = path.join(output, "GuiFake", s.state.run);
    assert.ok(fs.existsSync(path.join(output, "GuiFake", "public", s.state.run, "signature.json")), "the bundle carries its signature");

    // After the run: check the bundle, the YouTube text, and the cut (which this run cannot have: no video).
    const check = await post("/api/tool", { action: "check", path: first.bundle });
    assert.equal(check.status, 200, JSON.stringify(check.json));
    assert.match(check.json.message, /^Checked: Result: /, "the check's verdict is the answer, also when the bundle does not conform (a mock's never does)");
    assert.ok(check.json.lines.some((l) => /signature|proof|schema/i.test(l)), check.json.lines.join("\n"));
    const sheet = await post("/api/tool", { action: "sheet", runDir: first.runDir });
    assert.equal(sheet.status, 200, JSON.stringify(sheet.json));
    assert.match(sheet.json.made ?? "", /UPLOAD\.txt$/);
    const render = await post("/api/tool", { action: "render", runDir: first.runDir });
    assert.equal(render.status, 400);
    assert.match(render.json.error, /No video recording/);
    assert.equal((await post("/api/tool", { action: "check", path: "/etc/passwd" })).status, 400, "only what is in the output location");

    // Continue's choices come from the run: its ends and its saves; the ones chosen go to aas resume.
    const info = await get(`/api/run-info?runDir=${encodeURIComponent(first.runDir)}`);
    assert.equal(info.goal, "end");
    assert.ok(info.saves.length >= 1, "the run has a save to go on from");
    assert.equal(info.ai, false);
    const from = (await state()).lines.length;
    const cont = await post("/api/continue", { runDir: first.runDir, save: info.lastSave, maxTurns: "3", maxMinutes: "2" });
    assert.equal(cont.status, 200, JSON.stringify(cont.json));
    s = await untilIdle();
    const again = await logText(from);
    assert.match(again, new RegExp(`cli\\.mjs resume .*--save ${info.lastSave} --max-minutes 2 --max-turns 3`), again.split("\n").filter((l) => l.startsWith("cmd")).join("\n"));
    assert.match(again, /cli\.mjs publish .* --sign$/m);
    assert.ok(s.state.result.bundle, "Continue made the bundle again");
    assert.equal((await post("/api/continue", { runDir: first.runDir, goal: "nowhere" })).status, 400, "a goal the game does not have is refused");
    assert.ok(fs.existsSync(path.join(localRun, "run.jsonl")));
  } finally {
    gui.server.close();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
});
