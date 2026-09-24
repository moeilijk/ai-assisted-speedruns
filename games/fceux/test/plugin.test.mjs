// The FCEUX plugin against a stand-in for fceux-mcp's bridge: buttons held frame by frame and batched 600 to a call,
// game time from FCEUX's own frame rate, the profile's end read from memory with its save made before the next move,
// the ROM checked by the MD5 FCEUX reports, the screenshot as a PNG, one connection kept open, and the mock's inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBridge } from "./fake-bridge.mjs";

const fake = await startFakeBridge();
const runDir = fs.mkdtempSync(join(tmpdir(), "aas-fceux-"));
fs.writeFileSync(join(runDir, "brief.json"), JSON.stringify({ id: "nes15-test-1", category: { game: "fceux" } }));
process.env.AAS_FCEUX_BRIDGE_PORT = String(fake.port);
process.env.AAS_FCEUX_PROFILE = "nes15";
process.env.AAS_RUN_DIR = runDir;
const { default: plugin, FPS } = await import("../plugin.mjs");
const { disconnect } = await import("../bridge.mjs");
const events = [];
globalThis.aas = { event: (event, data) => events.push({ event, data }), emitImage: () => {} };
test.after(async () => { disconnect(); fs.rmSync(runDir, { recursive: true, force: true }); await fake.close(); });

test("buttons are held frame by frame, and game time is frames at FCEUX's own NTSC rate", async () => {
  events.length = 0;
  const emu = await plugin.connect();
  const r = await emu.press(["A", "Right"], 5);
  assert.equal(r.frames, 5);
  assert.deepEqual(fake.steps.slice(-5).map((s) => s.buttons), Array(5).fill({ A: true, right: true }));
  const end = events.find((e) => e.event === "game.playback" && e.data.phase === "end");
  assert.equal(end.data.frames, 5);
  assert.equal(end.data.seconds, 5 / (1008307711 / 16777216), "IGT from FCEUI_GetDesiredFPS");
  assert.equal(FPS.NES, 1008307711 / 16777216);
  assert.deepEqual(emu.buttons(), ["Up", "Down", "Left", "Right", "Start", "Select", "B", "A"]);
  await assert.rejects(emu.press(["X"], 1), /unknown button "X"/);
  await assert.rejects(emu.wait(40000), /between 1 and 36000/);
});

test("short steps go to FCEUX together, 600 frames a call, over one connection kept open", async () => {
  const emu = await plugin.connect();
  const conns = fake.connections;
  fake.calls.length = 0;
  await emu.sequence(Array.from({ length: 30 }, (_, i) => ({ buttons: i % 2 ? ["Right"] : ["Right", "B"], frames: 10 })));
  assert.deepEqual(fake.calls.filter((c) => c.startsWith("emu.step")), ["emu.step:300"]);
  fake.calls.length = 0;
  await emu.wait(1300);
  assert.deepEqual(fake.calls.filter((c) => c.startsWith("emu.step")), ["emu.step:600", "emu.step:600", "emu.step:100"]);
  assert.equal(fake.connections, conns, "no new connection per call");
});

test("the console's Reset goes to the first frame of its step only", async () => {
  const emu = await plugin.connect();
  const from = fake.framecount;
  await emu.sequence([{ buttons: ["Reset"], frames: 700 }]);
  const played = fake.steps.filter((s) => s.frame >= from);
  assert.equal(played.length, 700);
  assert.deepEqual(played.filter((s) => s.reset).map((s) => s.frame), [from], "one reset, on the first frame, also across two calls");
});

test("the profile's end is read from memory after a playback: its save first, then the milestone and the victory, and no input after it", async () => {
  events.length = 0;
  const emu = await plugin.connect();
  const solvedAt = fake.framecount + 2000;
  fake.onFrame = (s) => { if (s.framecount >= solvedAt) s.memory[47] = 3; };
  await emu.wait(100);
  assert.ok(!events.some((e) => e.event === "game.over"), "not solved yet");
  await emu.wait(3000);
  const order = events.map((e) => e.event).filter((e) => ["game.saved", "game.milestone", "game.over"].includes(e));
  assert.deepEqual(order, ["game.saved", "game.milestone", "game.over"]);
  const saved = events.find((e) => e.event === "game.saved").data;
  assert.deepEqual({ name: saved.name, file: saved.file, index: saved.index }, { name: "aas_nes15_test_1_solved", file: "saves/aas_nes15_test_1_solved.fc0", index: 1 });
  assert.match(fake.saves.at(-1), /aas_nes15_test_1_solved\.fc0$/);
  const milestone = events.find((e) => e.event === "game.milestone").data;
  assert.deepEqual({ label: milestone.label, end: milestone.end, split: milestone.split }, { label: "Solved", end: "solved", split: "Solved" });
  assert.equal(events.find((e) => e.event === "game.over").data.victory, true);
  await assert.rejects(emu.press(["A"], 1), /reached its end/);
  fake.onFrame = null;
  fake.memory[47] = 0;
});

test("a run starts only on the ROM the profile names, from power-on and paused", async () => {
  const lines = [];
  fake.framecount = 999;
  await plugin.prepareRun({ log: (l) => lines.push(l) });
  assert.equal(fake.framecount, 0, "powered on");
  assert.ok(fake.calls.includes("emu.reload") && !fake.calls.includes("emu.poweron"), "through FCEUX's reload, which leaves no \"Power on\" over the game");
  assert.equal(fake.paused, true);
  fake.md5 = "0".repeat(32);
  await assert.rejects(plugin.prepareRun({}), /is not nes15 .*MD5 0{32}, the profile names F53AF989/);
  fake.md5 = "F53AF989E2C9C37F01D9A276D8AEC04A";
});

test("the screenshot is the emulated frame as a PNG, with no file in between", async () => {
  const emu = await plugin.connect();
  const shot = await emu.screenshot();
  const png = Buffer.from(shot.screenshots[0].url.replace("data:image/png;base64,", ""), "base64");
  assert.deepEqual([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(""), "PNG");
  assert.equal(png.readUInt32BE(16), 2, "width");
  assert.equal(png.readUInt32BE(20), 1, "height");
});

test("a path for FCEUX, worked out without wslpath (the broker may not start programs)", async () => {
  const { hostPath } = await import("../paths.mjs");
  assert.equal(hostPath("/mnt/g/OBS/FCEUX/run-1/saves/a.fc0", { wsl: true }), "G:\\OBS\\FCEUX\\run-1\\saves\\a.fc0");
  assert.equal(hostPath("/home/me/x y/a.fc0", { wsl: true, distro: "Ubuntu" }), "\\\\wsl.localhost\\Ubuntu\\home\\me\\x y\\a.fc0");
});

test("the mock plays the profile's steps, one exec per step", async () => {
  const { createBot } = await import("../bot.mjs");
  const bot = createBot();
  const codes = [];
  for (let s = bot.next(null); s; s = bot.next({})) codes.push(s.code);
  assert.deepEqual(codes, ["return await emu.wait(120)", 'return await emu.press(["A"], 3)', "return await emu.wait(120)", 'return await emu.press(["Select"], 3)', "return await emu.wait(3000)"]);
});

test("an FM2 movie as the mock's input: the reset on frame 0, then the buttons, 600 frames a call", async () => {
  const { movieFrames, steps } = await import("../bot.mjs");
  const file = join(runDir, "t.fm2");
  fs.writeFileSync(file, ["version 3", "|1|........|........||", "|0|........|........||", "|0|R.....B.|........||", "|0|R.....B.|........||", "|0|.......A|........||"].join("\n"));
  assert.deepEqual(movieFrames(file), [["Reset"], [], ["Right", "B"], ["Right", "B"], ["A"]]);
  assert.deepEqual(steps(movieFrames(file)), [{ buttons: ["Reset"], frames: 1 }, { buttons: [], frames: 1 }, { buttons: ["Right", "B"], frames: 2 }, { buttons: ["A"], frames: 1 }]);
});
