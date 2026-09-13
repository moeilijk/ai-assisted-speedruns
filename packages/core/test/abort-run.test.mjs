// A game that does not come up after the recorder started: `aas run` must stop
// the recording again, discard its file and log the abort, instead of leaving
// OBS recording (, seen: when the game launch was refused).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
process.env.CODEX_HOME = process.env.CODEX_HOME ?? mkdtempSync(join(tmpdir(), "aas-codex-home-"));

test("aas run stops and discards the recording when the game does not start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-abort-"));
  const recordingFile = join(dir, "stray.mp4");
  const game = join(dir, "game.mjs");
  writeFileSync(game, `import fake from ${JSON.stringify(join(here, "fake-game.mjs"))};
export default { ...fake, instructions: "test", async prepareRun() { throw new Error("SPT IPC not reachable"); } };
`);
  const recorder = join(dir, "recorder.mjs");
  writeFileSync(recorder, `import fs from "node:fs";
export default { id: "file", version: "0", async preflight() {}, async start() { fs.writeFileSync(${JSON.stringify(recordingFile)}, "x"); return { t0: new Date() }; },
  async onEvent() {}, async stop() { return { files: [${JSON.stringify(recordingFile)}], t0: new Date(), chapters: [] }; } };
`);
  const runDir = join(dir, "portal-99");
  await assert.rejects(run({ runtime: join(here, "stub-runtime.mjs"), game, recorder, "run-dir": runDir, "keep-open": true }, { log() {} }), /SPT IPC not reachable/);
  assert.equal(existsSync(recordingFile), false, "the stray recording file is deleted");
  const events = readFileSync(join(runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => r.event);
  assert.deepEqual(events.slice(-2), ["recording.stopped", "run.error"]);
  assert.equal(events.includes("run.started"), false);
});
