// The chain every game plugin goes through in a test, the way a run goes in real use: `aas run` with the game's own
// scripted player until its first end, `aas resume` on to a later end, `aas publish`, and `aas check` on the bundle.
// No recording and no model: the recorder is null and the runtime scripted, and nothing is closed on this machine
// (keep-open), so a test needs only the game's fake. A plugin writer calls this with their game and its fake; what it
// asserts is what every game must do.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTED = path.join(here, "..", "..", "runtime-scripted", "index.mjs");

const events = (runDir) => fs.readFileSync(path.join(runDir, "run.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "event");

/**
 * Runs `game` (a plugin path) through run → resume → publish → check in `dir`. `goal` is the end the first segment
 * plays to, `resumeGoal` the later end the second segment is extended to. Returns what each step gave.
 */
export async function chainThroughHarness({ game, dir, goal, resumeGoal, bot = null, expectFirst = "completed", expectSecond = "completed", beforeResume = null }) {
  const { run } = await import("../src/run.mjs");
  const { resume } = await import("../src/resume.mjs");
  const { publish } = await import("../src/publish.mjs");
  const { checkBundle } = await import("../src/check-run.mjs");
  const { loadGamePlugin } = await import("../src/mcp-client.mjs");
  const plugin = await loadGamePlugin(game);
  const runDir = path.join(dir, "chain-01");
  const quiet = () => {};
  const common = { recorder: "null", "keep-open": true, proof: "off" };

  const first = await run({ runtime: SCRIPTED, game, "run-dir": runDir, bot: bot ?? plugin.setup?.bot, goal, ...common }, { log: quiet });
  assert.equal(first.outcome.status, expectFirst, `first segment: ${first.outcome.status} (${first.outcome.notes})`);
  const ev1 = events(runDir);
  assert.ok(ev1.some((e) => e.event === "run.started" && e.data.goal === goal), "run.started names the goal");
  assert.ok(ev1.some((e) => e.event === "game.saved"), "the game was saved, so the run can be continued");
  assert.ok(ev1.some((e) => e.event === "run.ended"), "the segment ended in the log");

  await beforeResume?.();
  const second = await resume({ "run-dir": runDir, ...(resumeGoal ? { goal: resumeGoal } : {}), ...common }, { log: quiet });
  assert.equal(second.outcome.status, expectSecond, `second segment: ${second.outcome.status} (${second.outcome.notes})`);
  const ev2 = events(runDir);
  assert.ok(ev2.filter((e) => e.event === "run.ended").length >= 2, "both segments ended in the log");

  const outDir = path.join(dir, "public", "chain-01");
  const pub = await publish(runDir, outDir, { log: quiet });
  const zip = `${outDir}.zip`;
  assert.ok(fs.existsSync(zip), "the bundle's zip was made");
  const report = checkBundle(zip);
  // Without a recording the bundle is not a valid AI Assisted Speedrun (recorder null says so); everything else is.
  const invalid = report.results.filter((r) => r.status === "invalid" && !/recording/i.test(`${r.requirement} ${r.detail}`));
  assert.deepEqual(invalid.map((r) => `${r.requirement}: ${r.detail}`), [], "the bundle is valid apart from having no recording");
  return { plugin, runDir, first, second, pub, zip, report, events: ev2 };
}
