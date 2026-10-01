// The session shared by run and resume (session.mjs): a stop at any moment of the start ends it without an agent
// session, `aas stop` reaches the run while it starts, closing always writes the outcome, the recording segment and
// the proof's end, and an end an earlier session told is not told again to the timer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/run.mjs";
import { resume } from "../src/resume.mjs";
import { configure } from "../src/configure.mjs";
import { session } from "../src/session.mjs";
import { createEventLog } from "../src/events.mjs";
import { resolveGoal } from "../src/goal.mjs";

const here = dirname(fileURLToPath(import.meta.url));
process.env.CODEX_HOME = process.env.CODEX_HOME ?? mkdtempSync(join(tmpdir(), "aas-codex-home-"));
const eventsOf = (runDir) => readFileSync(join(runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "event");
const plugin = { id: "p", ends: [{ id: "end", label: "End", final: true }], async saveState({ name }) { return { name }; } };
const nullRecorder = { id: "null", async onEvent() {}, async stop() { return { files: [], t0: new Date(), chapters: [] }; } };

function bare(runtime) {
  const runDir = mkdtempSync(join(tmpdir(), "aas-session-"));
  writeFileSync(join(runDir, "brief.json"), JSON.stringify({ id: "s" }));
  return { runDir, brief: { id: "s" }, opts: { "keep-open": true }, log() {}, plugin, runtime, recorder: nullRecorder, timer: null, overlay: null, events: createEventLog(runDir), proof: { async end() {} }, goal: resolveGoal(plugin, null), ready: null, t0: new Date() };
}

test("a stop the start already caught means no agent session: the run is stopped and saved", async () => {
  let started = false;
  const ctx = bare({ id: "r", async start() { started = true; return { status: "stopped" }; } });
  const { outcome } = await session({ ...ctx, early: { release: () => "SIGINT" } });
  assert.equal(started, false, "the agent was never started");
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.notes, /before the session started; no agent session/);
  assert.ok(eventsOf(ctx.runDir).some((e) => e.event === "game.saved"), "the session's end is saved, so the run can go on");
});

test("a stop that comes while the runtime starts reaches it: the runtime is asked, and the session ends", async () => {
  let asked = null;
  const ctx = bare({
    id: "r",
    interrupt() {},
    async start(runDir, brief, { stopRequested }) {
      // The stop lands before the runtime's own session exists (it could not be interrupted yet).
      process.emit("SIGINT", "SIGINT");
      asked = stopRequested();
      return { status: "stopped" };
    },
  });
  await session({ ...ctx, early: { release: () => null } });
  assert.match(asked, /stopped by the user \(SIGINT\)/);
});

test("closing writes the outcome, the recording segment and the proof's end, also when the timer and the recorder fail", async () => {
  let proofEnded = false;
  const ctx = bare({ id: "r", async start() { return { status: "stopped", notes: "ok" }; } });
  const timer = { id: "t", async onEvent() {}, async stop() { throw new Error("LiveSplit is gone"); } };
  const recorder = { id: "obs", async onEvent() {}, async stop() { throw new Error("OBS is gone"); } };
  const { outcome } = await session({ ...ctx, timer, recorder, proof: { async end() { proofEnded = true; } }, early: { release: () => null } });
  assert.equal(outcome.status, "stopped");
  assert.deepEqual(outcome.closing, ["timer stop: LiveSplit is gone", "recorder stop: OBS is gone"]);
  assert.ok(existsSync(join(ctx.runDir, "outcome.json")));
  assert.ok(existsSync(join(ctx.runDir, "recording.json")));
  assert.equal(proofEnded, true);
  assert.deepEqual(eventsOf(ctx.runDir).map((e) => e.event).slice(-2), ["run.ended", "recording.stopped"]);
});

test("an end an earlier session told goes to the timer once, and a game that shows it again at a resume does not add it", async () => {
  const ctx = bare({ id: "r", async start() { return { status: "stopped" }; } });
  ctx.events.append("game.milestone", { label: "Boss", end: "boss", chapter: true }); // the earlier session's
  const seen = [];
  const timer = { id: "t", async onEvent(ev) { if (ev.event === "game.milestone") seen.push(ev.data.label); }, async stop() { return {}; } };
  const before = eventsOf(ctx.runDir).length;
  await session({ ...ctx, timer, ready: { reached: [{ label: "Boss", end: "boss", chapter: true }] }, early: { release: () => null } });
  const added = eventsOf(ctx.runDir).slice(before).filter((e) => e.event === "game.milestone" && e.data.end === "boss");
  assert.equal(added.length, 0, "not added to the log a second time");
  assert.deepEqual(seen.filter((l) => l === "Boss"), [], "not split again");
});

test("aas stop reaches a run while it starts: run.pid is there from the start and gone after", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-pid-"));
  const runDir = join(dir, "run");
  const seenAt = join(dir, "seen.txt");
  const game = join(dir, "game.mjs");
  writeFileSync(game, `import fs from "node:fs"; import path from "node:path"; import fake from ${JSON.stringify(join(here, "fake-game.mjs"))};
export default { ...fake, instructions: "test", async prepareRun({ runDir }) { fs.writeFileSync(${JSON.stringify(seenAt)}, String(fs.existsSync(path.join(runDir, "run.pid")))); return { readyAt: new Date() }; } };
`);
  await configure({ runtime: join(here, "stub-runtime.mjs"), game, "run-dir": runDir }, { log() {} });
  await run({ runtime: join(here, "stub-runtime.mjs"), game, recorder: "null", "run-dir": runDir, "keep-open": true }, { log() {} });
  assert.equal(readFileSync(seenAt, "utf8"), "true", "run.pid exists while the game starts");
  assert.ok(!existsSync(join(runDir, "run.pid")), "and is gone after the run");
});

test("a stop during the start of a run closes what was started and starts no agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-early-"));
  const runDir = join(dir, "run");
  const game = join(dir, "game.mjs");
  writeFileSync(game, `import fake from ${JSON.stringify(join(here, "fake-game.mjs"))};
export default { ...fake, instructions: "test", async prepareRun() { process.emit("SIGINT", "SIGINT"); return { readyAt: new Date() }; } };
`);
  await configure({ runtime: join(here, "stub-runtime.mjs"), game, "run-dir": runDir }, { log() {} });
  await assert.rejects(run({ runtime: join(here, "stub-runtime.mjs"), game, recorder: "null", "run-dir": runDir, "keep-open": true }, { log() {} }), /before the session started/);
  assert.ok(!existsSync(join(runDir, "session.jsonl")), "no agent session");
  assert.ok(!existsSync(join(runDir, "run.pid")));
  assert.equal(eventsOf(runDir).at(-1).event, "run.error");
});

test("a game that shows an end past the goal when it is ready has reached the goal: no agent session", async () => {
  let started = false;
  const p = { id: "p", ends: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "end", label: "End", final: true }], async saveState({ name }) { return { name }; } };
  const ctx = bare({ id: "r", async start() { started = true; return { status: "stopped" }; } });
  const { outcome } = await session({ ...ctx, plugin: p, goal: resolveGoal(p, "a"), ready: { reached: [{ label: "B", end: "b", chapter: true }] }, early: { release: () => null } });
  assert.equal(started, false);
  assert.equal(outcome.status, "completed");
  assert.match(outcome.notes, /already reached when the game was ready/);
  const over = eventsOf(ctx.runDir).find((e) => e.event === "game.over");
  assert.equal(over.data.goal, "a");
  assert.equal(over.data.shown, "b");
});

test("a recording lost while the agent plays ends the session and says why", async () => {
  let interrupted = null;
  const ctx = bare({
    id: "r",
    interrupt(reason) { interrupted = reason; },
    async start() { for (let i = 0; i < 100 && !interrupted; i += 1) await new Promise((r) => setTimeout(r, 10)); return { status: "stopped", notes: interrupted ?? "ran out" }; },
  });
  const recorder = { ...nullRecorder, watch(onLost) { const t = setTimeout(() => onLost("OBS is not recording any more"), 30); return () => clearTimeout(t); } };
  const { outcome } = await session({ ...ctx, recorder, early: { release: () => null } });
  assert.match(interrupted, /the recording was lost: OBS is not recording any more/);
  assert.equal(outcome.status, "stopped");
  assert.ok(eventsOf(ctx.runDir).some((e) => e.event === "recording.lost"));
});
