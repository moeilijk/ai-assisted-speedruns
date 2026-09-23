// The run's goal is an end before the game's last one (smb: World 2 of 8): the plugin takes no input after it, so no
// frame after the goal counts in the game time, whenever the harness gets to declare the victory.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBizHawk } from "./fake-bizhawk-mcp.mjs";

const fake = await startFakeBizHawk({ romHash: "33D23C2F2CFA4C9EFEC87F7BC1321CE3CE6C89BD" });
const runDir = fs.mkdtempSync(join(tmpdir(), "aas-bizhawk-goal-"));
fs.writeFileSync(join(runDir, "brief.json"), JSON.stringify({ category: { game: "bizhawk", goal: "world2" } }));
process.env.AAS_BIZHAWK_MCP_URL = fake.url;
process.env.AAS_BIZHAWK_PROFILE = "smb";
process.env.AAS_RUN_DIR = runDir;
const { default: plugin } = await import("../plugin.mjs");
const events = [];
globalThis.aas = { event: (event, data) => events.push({ event, data }), emitImage: () => {} };
test.after(() => { fs.rmSync(runDir, { recursive: true, force: true }); return fake.close(); });

test("after the goal's end the plugin takes no more input, and leaves the victory to the harness", async () => {
  const emu = await plugin.connect();
  fake.onFrame = (s) => { s.memory["RAM:1887"] = s.framecount >= 1000 ? 2 : s.framecount >= 500 ? 1 : 0; };
  await emu.wait(600);
  assert.deepEqual(events.filter((e) => e.event === "game.milestone").map((e) => e.data.end), ["world1"]);
  await emu.wait(600);
  assert.deepEqual(events.filter((e) => e.event === "game.milestone").map((e) => e.data.end), ["world1", "world2"]);
  assert.ok(!events.some((e) => e.event === "game.over"), "the harness declares the victory for the goal");
  const at = fake.framecount;
  await assert.rejects(emu.press(["Right"], 100), /reached its end/);
  assert.equal(fake.framecount, at, "no frame after the goal");
});
