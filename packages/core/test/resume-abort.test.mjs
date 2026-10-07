// A resume that cannot start (the recorder refuses after it began recording, or the timer refuses) closes what it
// started and says why in the log, as a run does: nothing keeps recording, and the next resume can go on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/run.mjs";
import { resume } from "../src/resume.mjs";
import { configure } from "../src/configure.mjs";

const here = dirname(fileURLToPath(import.meta.url));
process.env.CODEX_HOME = process.env.CODEX_HOME ?? mkdtempSync(join(tmpdir(), "aas-codex-home-"));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "aas-resume-abort-"));
  const game = join(dir, "game.mjs");
  writeFileSync(game, `import fake from ${JSON.stringify(join(here, "fake-game.mjs"))};
export default { ...fake, instructions: "test", async saveState({ name }) { return { name }; }, async loadState() { return { readyAt: new Date() }; } };
`);
  const calls = join(dir, "calls.txt");
  // A recorder that begins recording and then refuses (the black picture of 2026-10-01), and one that works.
  const recorder = (refuse) => {
    const file = join(dir, refuse ? "refusing-recorder.mjs" : "recorder.mjs");
    writeFileSync(file, `import fs from "node:fs";
const note = (t) => fs.appendFileSync(${JSON.stringify(calls)}, t + "\\n");
export default { id: "test", name: "test", version: "0", async preflight() {},
  async start() { note("recorder.start"); ${refuse ? 'throw new Error("the game window capture shows nothing");' : "return { t0: new Date() };"} },
  async onEvent() {}, async stop() { note("recorder.stop"); return { files: [], t0: new Date(), chapters: [] }; } };
`);
    return file;
  };
  const timer = join(dir, "refusing-timer.mjs");
  writeFileSync(timer, `import fs from "node:fs";
const note = (t) => fs.appendFileSync(${JSON.stringify(calls)}, t + "\\n");
export default { id: "t", name: "t", version: "0", async preflight() {},
  async start() { note("timer.start"); throw new Error("LiveSplit did not take the start"); },
  async onEvent() {}, async stop() { note("timer.stop"); } };
`);
  return { dir, game, calls, recorder, timer };
}

async function stoppedRun(s, name) {
  const runDir = join(s.dir, name);
  await configure({ runtime: join(here, "stub-runtime.mjs"), game: s.game, "run-dir": runDir }, { log() {} });
  writeFileSync(join(runDir, "stub-codes.json"), JSON.stringify(["return await game.observe()"]));
  const r = await run({ runtime: join(here, "stub-runtime.mjs"), game: s.game, recorder: s.recorder(false), "run-dir": runDir, "keep-open": true }, { log() {} });
  assert.equal(r.outcome.status, "stopped");
  return runDir;
}
const eventsOf = (runDir) => readFileSync(join(runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "event");

test("a resume whose recorder refuses after it began recording stops the recording and logs why", async () => {
  const s = setup();
  const runDir = await stoppedRun(s, "rec");
  writeFileSync(s.calls, "");
  await assert.rejects(resume({ "run-dir": runDir, runtime: join(here, "stub-runtime.mjs"), recorder: s.recorder(true), "keep-open": true }, { log() {} }), /capture shows nothing/);
  assert.deepEqual(readFileSync(s.calls, "utf8").trim().split("\n"), ["recorder.start", "recorder.stop"], "what began recording is stopped");
  const tail = eventsOf(runDir).slice(-2).map((e) => e.event);
  assert.deepEqual(tail, ["recording.stopped", "run.error"]);
  assert.match(eventsOf(runDir).at(-1).data.message, /recording start failed/);
});

test("a resume whose timer refuses stops the recording it began and logs why", async () => {
  const s = setup();
  const runDir = await stoppedRun(s, "timer");
  writeFileSync(s.calls, "");
  await assert.rejects(resume({ "run-dir": runDir, runtime: join(here, "stub-runtime.mjs"), recorder: s.recorder(false), timer: s.timer, "keep-open": true }, { log() {} }), /did not take the start/);
  const calls = readFileSync(s.calls, "utf8").trim().split("\n");
  assert.ok(calls.includes("recorder.stop"), `the recording is stopped: ${calls.join(", ")}`);
  const ev = eventsOf(runDir);
  assert.equal(ev.at(-1).event, "run.error");
  assert.ok(ev.some((e) => e.event === "recording.stopped" && e.data.aborted), "the stop is in the log, with the reason");
  assert.ok(!existsSync(join(runDir, "run.pid")), "no session left behind");
});

test("a run whose recorder refuses after it began recording, or whose timer refuses, stops the recording and logs why", async () => {
  const s = setup();
  for (const [name, opts, why] of [["rec", { recorder: s.recorder(true) }, /recording start failed/], ["timer", { recorder: s.recorder(false), timer: s.timer }, /game start failed/]]) {
    const runDir = join(s.dir, `run-${name}`);
    await configure({ runtime: join(here, "stub-runtime.mjs"), game: s.game, "run-dir": runDir }, { log() {} });
    writeFileSync(s.calls, "");
    await assert.rejects(run({ runtime: join(here, "stub-runtime.mjs"), game: s.game, "run-dir": runDir, "keep-open": true, ...opts }, { log() {} }));
    assert.ok(readFileSync(s.calls, "utf8").includes("recorder.stop"), `${name}: the recording is stopped`);
    assert.match(eventsOf(runDir).at(-1).data.message, why);
    assert.ok(!existsSync(join(runDir, "session.jsonl")), `${name}: the agent was never started`);
  }
});

test("a run refused by its plan budget starts no session and leaves the directory for another try", async () => {
  const s = setup();
  const runDir = join(s.dir, "budget");
  const runtime = join(s.dir, "budget-runtime.mjs");
  writeFileSync(runtime, `import stub from ${JSON.stringify(join(here, "stub-runtime.mjs"))};
export default { ...stub, async budget() { return { ok: false, detail: "week 71% used of the plan, limit 70%", percent: 71, max: 70 }; } };
`);
  await configure({ runtime, game: s.game, "run-dir": runDir }, { log() {} });
  await assert.rejects(run({ runtime, game: s.game, recorder: s.recorder(false), "run-dir": runDir, "keep-open": true }, { log() {} }), /plan budget reached/);
  assert.ok(!existsSync(join(runDir, "session.jsonl")), "no agent session");
  assert.ok(!existsSync(join(runDir, "run.pid")));
  const again = await run({ runtime, game: s.game, recorder: s.recorder(false), "run-dir": runDir, "keep-open": true, "ignore-budget": true }, { log() {} });
  assert.equal(again.outcome.status, "stopped", "the directory could be used again");
});

test("a run or resume whose game does not answer stops before the proof ticket and the recording", async () => {
  const s = setup();
  // A local port that is closed: a server takes one and lets it go again.
  const { createServer } = await import("node:net");
  const port = await new Promise((res) => { const srv = createServer().listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => res(p)); }); });
  const game = join(s.dir, "game-down.mjs");
  writeFileSync(game, `import fake from ${JSON.stringify(join(here, "fake-game.mjs"))};
export default { ...fake, instructions: "test", async saveState({ name }) { return { name }; }, async loadState() { return { readyAt: new Date() }; },
  get endpoints() { return process.env.AAS_TEST_GAME_DOWN ? [{ host: "127.0.0.1", port: ${port} }] : []; } };
`);
  const runDir = join(s.dir, "down");
  await configure({ runtime: join(here, "stub-runtime.mjs"), game, "run-dir": runDir }, { log() {} });
  writeFileSync(join(runDir, "stub-codes.json"), JSON.stringify(["return await game.observe()"]));
  process.env.AAS_TEST_GAME_DOWN = "1";
  try {
    writeFileSync(s.calls, "");
    await assert.rejects(run({ runtime: join(here, "stub-runtime.mjs"), game, recorder: s.recorder(false), "run-dir": runDir, "keep-open": true }, { log() {} }), new RegExp(`does not answer at 127\\.0\\.0\\.1:${port}.*start the game first`));
    assert.equal(readFileSync(s.calls, "utf8"), "", "nothing was recorded");
    assert.ok(!existsSync(join(runDir, "run.jsonl")) || !eventsOf(runDir).some((e) => e.event.startsWith("proof.")), "no proof ticket was taken");
    delete process.env.AAS_TEST_GAME_DOWN;
    const r = await run({ runtime: join(here, "stub-runtime.mjs"), game, recorder: s.recorder(false), "run-dir": runDir, "keep-open": true }, { log() {} });
    assert.equal(r.outcome.status, "stopped");
    process.env.AAS_TEST_GAME_DOWN = "1";
    writeFileSync(s.calls, "");
    await assert.rejects(resume({ "run-dir": runDir, runtime: join(here, "stub-runtime.mjs"), recorder: s.recorder(false), "keep-open": true }, { log() {} }), /does not answer.*start the game first/);
    assert.equal(readFileSync(s.calls, "utf8"), "", "the resume recorded nothing");
  } finally {
    delete process.env.AAS_TEST_GAME_DOWN;
  }
});
