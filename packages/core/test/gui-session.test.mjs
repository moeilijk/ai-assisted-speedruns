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
    const start = await post("/api/start", { game: "gui_fake", runtime: "scripted", recorder: "null" });
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
    const zip = path.join(output, "GuiFake", "public", `${s.state.run}.zip`);
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
