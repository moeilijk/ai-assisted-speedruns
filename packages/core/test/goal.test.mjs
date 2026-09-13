// The goal is one of the game's ends: no goal means the game's own end; `--goal` picks an earlier one and the
// harness declares the victory when that end's milestone goes by; a resume may extend the goal to a later end,
// and only to a later one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/run.mjs";
import { resume } from "../src/resume.mjs";
import { configure } from "../src/configure.mjs";
import { computeTimeline } from "../src/timeline.mjs";
import { resolveGoal, defaultGoal, goalReached, laterGoal } from "../src/goal.mjs";

const here = dirname(fileURLToPath(import.meta.url));
process.env.CODEX_HOME = process.env.CODEX_HOME ?? mkdtempSync(join(tmpdir(), "aas-codex-home-"));
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aas-goal-cfg-"));

const gameWithEnds = (dir) => {
  const game = join(dir, "game.mjs");
  writeFileSync(game, `import fake from ${JSON.stringify(join(here, "fake-game.mjs"))};
export default { ...fake, instructions: "test",
  async saveState({ name }) { return { name }; }, async loadState() {},
  ends: [{ id: "half", label: "Halfway", split: "Half" }, { id: "end", label: "The end", split: "End", final: true }],
  async connect() { const g = await fake.connect(); return { ...g,
    async half() { globalThis.aas?.event?.("game.milestone", { label: "Halfway", split: "Half", chapter: true }); return { half: true }; },
    async finish() { globalThis.aas?.event?.("game.milestone", { label: "The end", split: "End", chapter: true }); return { done: true }; } }; } };
`);
  return game;
};
const slow = Array(12).fill("await new Promise((r) => setTimeout(r, 150)); return await game.observe()");
const events = (runDir) => readFileSync(join(runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "event");

test("goal resolution: default is the final end, unknown goals are refused, a later goal extends", () => {
  const plugin = { id: "g", ends: [{ id: "a", label: "A", split: "A" }, { id: "b", label: "B", split: "B", final: true }, { id: "c", label: "C", split: "C" }] };
  assert.equal(defaultGoal(plugin), "b");
  assert.equal(resolveGoal(plugin, "").id, "b");
  assert.equal(resolveGoal(plugin, "a").end.split, "A");
  assert.throws(() => resolveGoal(plugin, "x"), /Unknown goal "x"/);
  assert.ok(goalReached(plugin.ends[0], { event: "game.milestone", data: { split: "A" } }));
  assert.ok(goalReached(plugin.ends[0], { event: "game.milestone", data: { end: "a" } }));
  assert.ok(!goalReached(plugin.ends[0], { event: "game.milestone", data: { split: "A", victory: true } }), "the plugin's own victory milestone is left to its game.over");
  assert.ok(laterGoal(plugin, "a", "c") && !laterGoal(plugin, "c", "a") && !laterGoal(plugin, "a", "a"));
  assert.equal(defaultGoal({ id: "p", category: { goal: "credits" } }), "credits", "a game without ends keeps its category goal");
});

test("an earlier end as the goal: the harness declares the victory; a resume may extend the goal to the end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-goal-"));
  const game = gameWithEnds(dir);
  const runDir = join(dir, "run");
  await configure({ runtime: join(here, "stub-runtime.mjs"), game, "run-dir": runDir, goal: "half" }, { log() {} });
  assert.equal(JSON.parse(readFileSync(join(runDir, "brief.json"), "utf8")).category.goal, "half");
  writeFileSync(join(runDir, "stub-codes.json"), JSON.stringify(["return await game.observe()", "return await game.half()", ...slow]));
  const r = await run({ runtime: join(here, "stub-runtime.mjs"), game, recorder: "null", "run-dir": runDir, "keep-open": true }, { log() {} });
  assert.equal(r.outcome.status, "completed");
  const over = events(runDir).find((e) => e.event === "game.over");
  assert.equal(over.data.victory, true);
  assert.equal(over.data.goal, "half");
  assert.equal(computeTimeline(runDir).attempts[0].outcome, "victory");

  await assert.rejects(resume({ "run-dir": runDir, runtime: join(here, "stub-runtime.mjs"), recorder: "null", "keep-open": true }, { log() {} }), /run is over/);
  await assert.rejects(resume({ "run-dir": runDir, runtime: join(here, "stub-runtime.mjs"), recorder: "null", "keep-open": true, goal: "half" }, { log() {} }), /run is over/);
  writeFileSync(join(runDir, "stub-codes-resume.json"), JSON.stringify(["return await game.observe()", "return await game.finish()", ...slow]));
  const r2 = await resume({ "run-dir": runDir, runtime: join(here, "stub-runtime.mjs"), recorder: "null", "keep-open": true, goal: "end" }, { log() {} });
  assert.equal(r2.outcome.status, "completed");
  const ev = events(runDir);
  assert.ok(ev.some((e) => e.event === "game.goal" && e.data.from === "half" && e.data.to === "end"));
  assert.ok(ev.some((e) => e.event === "run.human" && /goal extended/.test(e.data.note)));
  assert.equal(ev.filter((e) => e.event === "game.over" && e.data.victory).length, 2);
  assert.equal(JSON.parse(readFileSync(join(runDir, "brief.json"), "utf8")).category.goal, "end");
  const tl = computeTimeline(runDir);
  assert.equal(tl.attempts.length, 1, "the extended run is still one attempt");
  assert.equal(tl.attempts[0].outcome, "victory");
  await assert.rejects(resume({ "run-dir": runDir, runtime: join(here, "stub-runtime.mjs"), recorder: "null", "keep-open": true, goal: "half" }, { log() {} }), /only be extended to a later end/);
});

test("a game without ends keeps its category goal and its own victory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-goal-plain-"));
  const runDir = join(dir, "run");
  await configure({ runtime: join(here, "stub-runtime.mjs"), game: join(here, "fake-game.mjs"), "run-dir": runDir, instructions: join(here, "fake-game.mjs") }, { log() {} });
  assert.equal(JSON.parse(readFileSync(join(runDir, "brief.json"), "utf8")).category.goal, "");
});
