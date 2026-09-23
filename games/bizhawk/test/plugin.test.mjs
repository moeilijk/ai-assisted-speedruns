// The BizHawk plugin against a stand-in for bizhawk-mcp-native: game time from frames, the profile's end read from
// memory, the ROM checked by its SHA-1, the screenshot as a resource, BizHawk's trust answer, and the mock's inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBizHawk } from "./fake-bizhawk-mcp.mjs";

const fake = await startFakeBizHawk();
process.env.AAS_BIZHAWK_MCP_URL = fake.url;
process.env.AAS_BIZHAWK_PROFILE = "nes15";
const { default: plugin, FPS } = await import("../plugin.mjs");
const events = [];
globalThis.aas = { event: (event, data) => events.push({ event, data }), emitImage: () => {} };
test.after(() => fake.close());

test("buttons are held frame by frame, and game time is frames at the system's own rate", async () => {
  events.length = 0;
  const emu = await plugin.connect();
  const r = await emu.press(["A", "Right"], 5);
  assert.equal(r.frames, 5);
  assert.equal(fake.pressed.slice(-5).length, 5, "the buttons are set before each of the five frames");
  assert.deepEqual(fake.pressed.at(-1).buttons, { A: true, Right: true });
  const end = events.find((e) => e.event === "game.playback" && e.data.phase === "end");
  assert.equal(end.data.frames, 5);
  assert.equal(end.data.seconds, 5 / FPS.NES, "IGT from BizHawk's own NES frame rate");
  const w = await emu.wait(1200);
  assert.equal(w.frames, 1200);
  assert.deepEqual(await emu.buttons(), ["Up", "Down", "Left", "Right", "Start", "Select", "B", "A"]);
  await assert.rejects(emu.wait(40000), /between 1 and 36000/);
});

test("the profile's end is read from memory after a playback: the milestone, the victory, and no input after it", async () => {
  events.length = 0;
  const emu = await plugin.connect();
  fake.onFrame = (s) => { if (s.framecount >= 2000) s.memory["RAM:47"] = 3; };
  await emu.wait(100);
  assert.ok(!events.some((e) => e.event === "game.over"), "not solved yet");
  await emu.wait(3000);
  const milestone = events.find((e) => e.event === "game.milestone");
  assert.deepEqual({ label: milestone.data.label, end: milestone.data.end, split: milestone.data.split }, { label: "Solved", end: "solved", split: "Solved" });
  assert.equal(events.find((e) => e.event === "game.over").data.victory, true);
  await assert.rejects(emu.press(["A"], 1), /reached its end/);
  fake.onFrame = null;
  fake.memory["RAM:47"] = 0;
});

test("a run starts only on the ROM the profile names, from power-on and paused", async () => {
  const lines = [];
  await plugin.prepareRun({ log: (l) => lines.push(l) });
  assert.equal(fake.framecount, 0, "rebooted");
  assert.equal(fake.paused, true);
  // Another dump of the game, or another game: the run does not start.
  fake.romHash = "0".repeat(40);
  await assert.rejects(plugin.prepareRun({}), /is not nes15 .*SHA-1 0{40}, the profile names 8FCC5798/);
  fake.romHash = "8FCC5798252370C63A98E7421131ABF3EB22BFCF";
});

test("the screenshot comes back as the tool's own resource, not through a file", async () => {
  const emu = await plugin.connect();
  const shot = await emu.screenshot();
  assert.equal(shot.screenshots[0].url, `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}`);
});

test("BizHawk's trust answer is read from its own config, per exact DLL", async () => {
  const { trustState } = await import("../trust.mjs");
  const dir = fs.mkdtempSync(join(tmpdir(), "aas-bizhawk-"));
  fs.mkdirSync(join(dir, "ExternalTools"));
  fs.writeFileSync(join(dir, "ExternalTools", "BizHawkMcp.dll"), "one");
  assert.equal(trustState(dir).trusted, false, "no config yet");
  const sum = `SHA512:${createHash("sha512").update("one").digest("hex").toUpperCase()}`;
  fs.writeFileSync(join(dir, "config.ini"), `\uFEFF${JSON.stringify({ TrustedExtTools: { "C:\\x\\ExternalTools\\BizHawkMcp.dll": sum } })}`);
  assert.equal(trustState(dir).trusted, true);
  fs.writeFileSync(join(dir, "ExternalTools", "BizHawkMcp.dll"), "two");
  assert.equal(trustState(dir).trusted, false, "another DLL is asked about again");
});

test("the mock plays the profile's steps, one exec per step", async () => {
  const { createBot } = await import("../bot.mjs");
  const bot = createBot();
  const codes = [];
  for (let s = bot.next(null); s; s = bot.next({})) codes.push(s.code);
  assert.deepEqual(codes, ["return await emu.wait(120)", 'return await emu.press(["A"], 3)', "return await emu.wait(120)", 'return await emu.press(["Select"], 3)', "return await emu.wait(3000)"]);
});
