// The run's goal is an end before the game's last one (smb: World 2 of 8): the plugin takes no input after it, so no
// frame after the goal counts in the game time, whenever the harness gets to declare the victory.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBridge } from "./fake-bridge.mjs";

const fake = await startFakeBridge({ md5: "8E3630186E35D477231BF8FD50E54CDD" });
const runDir = fs.mkdtempSync(join(tmpdir(), "aas-fceux-goal-"));
fs.writeFileSync(join(runDir, "brief.json"), JSON.stringify({ id: "smb-goal-1", category: { game: "fceux", goal: "world2" } }));
process.env.AAS_FCEUX_BRIDGE_PORT = String(fake.port);
process.env.AAS_FCEUX_PROFILE = "smb";
process.env.AAS_RUN_DIR = runDir;
const { default: plugin } = await import("../plugin.mjs");
const { disconnect } = await import("../bridge.mjs");
const events = [];
globalThis.aas = { event: (event, data) => events.push({ event, data }), emitImage: () => {} };
test.after(async () => { disconnect(); fs.rmSync(runDir, { recursive: true, force: true }); await fake.close(); });

test("after the goal's end the plugin takes no more input, and leaves the victory to the harness", async () => {
  const emu = await plugin.connect();
  fake.onFrame = (s) => { s.memory[1887] = s.framecount >= 1000 ? 2 : s.framecount >= 500 ? 1 : 0; };
  await emu.wait(600);
  assert.deepEqual(events.filter((e) => e.event === "game.milestone").map((e) => e.data.end), ["world1"]);
  await emu.wait(600);
  assert.deepEqual(events.filter((e) => e.event === "game.milestone").map((e) => e.data.end), ["world1", "world2"]);
  assert.deepEqual(events.filter((e) => e.event === "game.saved").map((e) => e.data.name), ["aas_smb_goal_1_world1", "aas_smb_goal_1_world2"]);
  assert.ok(!events.some((e) => e.event === "game.over"), "the harness declares the victory for the goal");
  const at = fake.framecount;
  await assert.rejects(emu.press(["Right"], 100), /reached its end/);
  assert.equal(fake.framecount, at, "no frame after the goal");
});
