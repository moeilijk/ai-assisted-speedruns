// Autosave: a save after every chapter milestone, unless the plugin saves its own milestones from the broker
// (savesAtMilestones); the end of the session is always saved by the harness, and the numbering counts every
// game.saved in the log, the plugin's own included.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAutosave } from "../src/run.mjs";
import { createEventLog } from "../src/events.mjs";

function setup(plugin) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-autosave-"));
  const events = createEventLog(runDir);
  const autosave = createAutosave({ plugin, runDir, brief: { id: "t-1" }, events, log: () => {}, autosaveMinutes: 60 });
  return { runDir, events, autosave };
}

test("a milestone is saved by the harness", async () => {
  const names = [];
  const { autosave } = setup({ saveState: async ({ name }) => { names.push(name); return {}; } });
  await autosave.onEvent({ event: "game.milestone", data: { chapter: true, label: "World 1", end: "world1" } });
  autosave.stop();
  assert.deepEqual(names, ["aas_t_1_001"]);
});

test("a plugin that saves its own milestones: the harness leaves them, saves the session's end, and numbers after them", async () => {
  const names = [];
  const { autosave, events } = setup({ savesAtMilestones: true, saveState: async ({ name }) => { names.push(name); return {}; } });
  // The plugin's own save, from the broker.
  events.append("game.saved", { name: "aas_t_1_world1", index: 1, reason: "milestone World 1", file: "saves/aas_t_1_world1.fc0" });
  await autosave.onEvent({ event: "game.milestone", data: { chapter: true, label: "World 1", end: "world1" } });
  assert.deepEqual(names, []);
  await autosave.onEvent({ event: "game.milestone", data: { chapter: true, label: "end of session" } });
  autosave.stop();
  assert.deepEqual(names, ["aas_t_1_002"]);
});
