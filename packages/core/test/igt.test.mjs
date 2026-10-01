// One in-game time for the timer, the timeline and a resume (igt.mjs): the plugin's own seconds first, else Source
// ticks at 15 ms. Portal 2 runs at 60 ticks a second and reports both; its time was counted 10% short, and a resume of
// a game that reports seconds only (Slay the Spire, Balatro, the emulators) restarted LiveSplit's game time at 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { playbackSeconds } from "../src/igt.mjs";
import { configure } from "../src/configure.mjs";
import { run } from "../src/run.mjs";
import { resume } from "../src/resume.mjs";

const here = dirname(fileURLToPath(import.meta.url));
process.env.CODEX_HOME = process.env.CODEX_HOME ?? mkdtempSync(join(tmpdir(), "aas-codex-home-"));

test("a playback's game time: the plugin's seconds first, else ticks at 15 ms", () => {
  assert.equal(playbackSeconds({ ticks: 60, seconds: 1 }), 1, "Portal 2: 60 ticks are one second, not 0.9");
  assert.equal(playbackSeconds({ ticks: 200 }), 3);
  assert.equal(playbackSeconds({ seconds: 2.4567 }), 2.457);
  assert.equal(playbackSeconds({}), 0);
});

test("a resume continues LiveSplit's game time from playbacks that report seconds only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-igt-"));
  const game = join(dir, "game.mjs");
  writeFileSync(game, `import fake from ${JSON.stringify(join(here, "fake-game.mjs"))};
export default { ...fake, instructions: "test", async saveState({ name }) { return { name }; }, async loadState() { return { readyAt: new Date() }; },
  async connect() { const g = await fake.connect(); return { ...g, async play() { globalThis.aas?.event?.("game.playback", { phase: "start", index: 1 }); globalThis.aas?.event?.("game.playback", { phase: "end", index: 1, seconds: 2.5 }); return { ok: true }; } }; } };
`);
  const started = join(dir, "igt.txt");
  const timer = join(dir, "timer.mjs");
  writeFileSync(timer, `import fs from "node:fs";
export default { id: "t", name: "t", version: "0", async preflight() {}, async start(brief, opts) { fs.writeFileSync(${JSON.stringify(started)}, String(opts?.igt ?? "none")); }, async onEvent() {}, async stop() { return {}; } };
`);
  const runDir = join(dir, "run");
  await configure({ runtime: join(here, "stub-runtime.mjs"), game, "run-dir": runDir }, { log() {} });
  writeFileSync(join(runDir, "stub-codes.json"), JSON.stringify(["return await game.play()", "return await game.play()"]));
  await run({ runtime: join(here, "stub-runtime.mjs"), game, recorder: "null", timer, "run-dir": runDir, "keep-open": true }, { log() {} });
  await resume({ "run-dir": runDir, runtime: join(here, "stub-runtime.mjs"), recorder: "null", timer, "keep-open": true }, { log() {} });
  const { readFileSync } = await import("node:fs");
  assert.equal(Number(readFileSync(started, "utf8")), 5, "two playbacks of 2.5 s before the resume");
});
