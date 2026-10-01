// `game.over` from the game plugin: a victory ends the session (runtime interrupted, status
// completed, resume refused); a death does not (the session goes on, deaths are counted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/run.mjs";
import { resume } from "../src/resume.mjs";
import { configure } from "../src/configure.mjs";

const here = dirname(fileURLToPath(import.meta.url));
process.env.CODEX_HOME = process.env.CODEX_HOME ?? mkdtempSync(join(tmpdir(), "aas-codex-home-"));
const slow = Array(20).fill("await new Promise((r) => setTimeout(r, 200)); return await game.observe()");

async function runWith(dir, name, game, codes) {
  const runDir = join(dir, name);
  await configure({ runtime: join(here, "stub-runtime.mjs"), game, "run-dir": runDir }, { log() {} });
  writeFileSync(join(runDir, "stub-codes.json"), JSON.stringify(codes));
  const r = await run({ runtime: join(here, "stub-runtime.mjs"), game, recorder: "null", "run-dir": runDir, "keep-open": true }, { log() {} });
  const events = readFileSync(join(runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "event");
  const calls = readFileSync(join(runDir, "session.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.type === "assistant" && r.message.content.some((c) => c.type === "tool_use")).length;
  return { runDir, outcome: r.outcome, events, calls };
}

test("victory ends the session; a death does not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-over-"));
  const game = join(dir, "game.mjs");
  writeFileSync(game, `import fake from ${JSON.stringify(join(here, "fake-game.mjs"))};
export default { ...fake, instructions: "test", async connect() { const g = await fake.connect(); return { ...g,
  async die() { globalThis.aas?.event?.("game.over", { victory: false, label: "Defeat", deaths: 1 }); return { dead: true }; },
  async win() { globalThis.aas?.event?.("game.milestone", { label: "Victory", chapter: true }); globalThis.aas?.event?.("game.over", { victory: true, label: "Victory" }); return { won: true }; } }; } };
`);
  const died = await runWith(dir, "run-death", game, ["return await game.observe()", "return await game.die()", ...slow]);
  assert.equal(died.outcome.status, "stopped", "a death is not the end of the run");
  assert.equal(died.outcome.deaths, 1);
  assert.equal(died.calls, 22, "the session was not interrupted");

  const won = await runWith(dir, "run-win", game, ["return await game.observe()", "return await game.win()", ...slow]);
  assert.equal(won.outcome.status, "completed");
  assert.equal(won.outcome.over.victory, true);
  assert.match(won.outcome.notes, /game over: Victory/);
  assert.ok(won.events.findIndex((e) => e.event === "game.over") < won.events.findIndex((e) => e.event === "run.ended"));
  assert.ok(won.calls < 22, `the session was interrupted after the victory (${won.calls} tool calls of 22)`);
  await assert.rejects(resume({ "run-dir": won.runDir, runtime: join(here, "stub-runtime.mjs"), recorder: "null", "keep-open": true }, { log() {} }), /run is over \(Victory\)/);
});

test("a goal the game already shows when it is ready starts no agent session, at a start or a resume", async () => {
  // 2026-10-02: a live run was saved on the reward screen of the boss it had to beat. Continuing it must reach the
  // goal from the game's own state, without a turn of the agent (tokens are the person's, not the tooling's to spend).
  const dir = mkdtempSync(join(tmpdir(), "aas-ready-goal-"));
  const game = join(dir, "game.mjs");
  writeFileSync(game, `import fake from ${JSON.stringify(join(here, "fake-game.mjs"))};
export default { ...fake, instructions: "test", ends: [{ id: "boss", label: "The boss" }, { id: "end", label: "The end", final: true }],
  async prepareRun({ resume = false } = {}) { return this.ready(resume); },
  async saveState({ name }) { return { name }; },
  async loadState() { return this.ready(true); },
  ready(resume) {
    const shown = process.env.AAS_TEST_SHOWN === "boss" || (resume && process.env.AAS_TEST_SHOWN === "boss-on-resume");
    return { readyAt: new Date(), reached: shown ? [{ label: "The boss", end: "boss", chapter: true }] : [] };
  } };
`);
  const sessionLines = (runDir) => { try { return readFileSync(join(runDir, "session.jsonl"), "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  const eventsOf = (runDir) => readFileSync(join(runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "event");
  // At a start.
  process.env.AAS_TEST_SHOWN = "boss";
  const startDir = join(dir, "start");
  await configure({ runtime: join(here, "stub-runtime.mjs"), game, "run-dir": startDir, goal: "boss" }, { log() {} });
  writeFileSync(join(startDir, "stub-codes.json"), JSON.stringify(slow));
  const started = await run({ runtime: join(here, "stub-runtime.mjs"), game, recorder: "null", "run-dir": startDir, "keep-open": true }, { log() {} });
  assert.equal(started.outcome.status, "completed");
  assert.equal(started.outcome.over.victory, true);
  assert.match(started.outcome.notes, /already reached when the game was ready/);
  assert.equal(sessionLines(startDir), 0, "the agent was never started");
  assert.ok(eventsOf(startDir).some((e) => e.event === "game.over" && e.data.goal === "boss"));
  // At a resume: the first session stops short of the goal, the save is continued past it.
  process.env.AAS_TEST_SHOWN = "boss-on-resume";
  const resumeDir = join(dir, "resume");
  await configure({ runtime: join(here, "stub-runtime.mjs"), game, "run-dir": resumeDir, goal: "boss" }, { log() {} });
  writeFileSync(join(resumeDir, "stub-codes.json"), JSON.stringify(["return await game.observe()"]));
  const first = await run({ runtime: join(here, "stub-runtime.mjs"), game, recorder: "null", "run-dir": resumeDir, "keep-open": true }, { log() {} });
  assert.equal(first.outcome.status, "stopped");
  const before = sessionLines(resumeDir);
  assert.ok(before > 0, "the first session did play");
  const resumed = await resume({ "run-dir": resumeDir, runtime: join(here, "stub-runtime.mjs"), recorder: "null", "keep-open": true }, { log() {} });
  assert.equal(resumed.outcome?.status ?? resumed.status, "completed");
  assert.equal(sessionLines(resumeDir), before, "the resume started no agent session");
  assert.ok(eventsOf(resumeDir).some((e) => e.event === "game.over" && e.data.goal === "boss"));
  delete process.env.AAS_TEST_SHOWN;
});
