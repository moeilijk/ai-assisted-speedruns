// SMB's ends as a real agent meets them (2026-10-02): a world counts when its castle is beaten (OperMode 2, the
// victory), not only when the next world begins, which an agent that stops after the axe never sees; a save made
// after an end shows it when it is loaded; an end in the run's log is not told again; a game over is a defeat.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBizHawk } from "./fake-bizhawk-mcp.mjs";

const fake = await startFakeBizHawk({ romHash: "33D23C2F2CFA4C9EFEC87F7BC1321CE3CE6C89BD" });
const runDir = fs.mkdtempSync(join(tmpdir(), "aas-bizhawk-ends-"));
fs.writeFileSync(join(runDir, "brief.json"), JSON.stringify({ id: "smb-ends-1", category: { game: "bizhawk", goal: "world2" } }));
process.env.AAS_BIZHAWK_MCP_URL = fake.url;
process.env.AAS_BIZHAWK_PROFILE = "smb";
process.env.AAS_RUN_DIR = runDir;
const { default: plugin } = await import("../plugin.mjs");

const events = [];
globalThis.aas = { event: (event, data) => events.push({ event, data }), emitImage: () => {} };
test.after(() => { fs.rmSync(runDir, { recursive: true, force: true }); return fake.close(); });
const milestones = () => events.filter((e) => e.event === "game.milestone").map((e) => e.data.end);
const reset = () => { events.length = 0; fs.rmSync(join(runDir, "run.jsonl"), { force: true }); fake.onFrame = null; };

test("World 1 counts at the axe of 1-4, while the game is still in world 1", async () => {
  reset();
  const emu = await plugin.connect();
  fake.onFrame = (s) => { s.memory["RAM:1887"] = 0; s.memory["RAM:1904"] = s.framecount >= 300 ? 2 : 1; };
  await emu.wait(400);
  assert.deepEqual(milestones(), ["world1"]);
});

test("a save made after an end shows it when it is loaded", async () => {
  reset();
  fs.mkdirSync(join(runDir, "saves"), { recursive: true });
  fs.writeFileSync(join(runDir, "saves", "after-1-4.State"), JSON.stringify({ framecount: 9000, memory: { "RAM:1887": 0, "RAM:1904": 2 } }));
  const r = await plugin.loadState({ name: "after-1-4", runDir, log() {} });
  assert.deepEqual(r.reached.map((m) => m.end), ["world1"]);
  fs.writeFileSync(join(runDir, "saves", "in-1-2.State"), JSON.stringify({ framecount: 3000, memory: { "RAM:1887": 0, "RAM:1904": 1 } }));
  assert.deepEqual((await plugin.loadState({ name: "in-1-2", runDir, log() {} })).reached, []);
});

test("an end the run's log already holds is not told again", async () => {
  reset();
  fs.writeFileSync(join(runDir, "run.jsonl"), JSON.stringify({ kind: "event", event: "game.milestone", data: { label: "World 1", end: "world1", chapter: true } }) + "\n");
  const emu = await plugin.connect();
  fake.onFrame = (s) => { s.memory["RAM:1887"] = 1; s.memory["RAM:1904"] = 1; };
  await emu.wait(10);
  assert.deepEqual(milestones(), []);
});

test("a game over is a defeat, told once while it lasts", async () => {
  reset();
  const emu = await plugin.connect();
  fake.onFrame = (s) => { s.memory["RAM:1887"] = 0; s.memory["RAM:1904"] = 3; };
  await emu.wait(10);
  await emu.wait(10);
  const over = events.filter((e) => e.event === "game.over");
  assert.equal(over.length, 1);
  assert.equal(over[0].data.victory, false);
});

test("memory is read once a frame: a playback that checks every end, and a script's reads, cost one read of the RAM", async () => {
  reset();
  const emu = await plugin.connect();
  await emu.read(1904, { domain: "RAM" }); // the domain's first read goes to the tool as it is (its endianness)
  fake.memory["RAM:1904"] = 1;
  await emu.wait(1);
  const before = fake.calls.length;
  await emu.wait(1); // a frame: get_info, and the profile's ends and its defeat, some twenty values
  const values = [];
  for (const a of [1904, 1887, 1884, 0x6d, 0x86]) values.push((await emu.read(a, { domain: "RAM", width: 8 })).value);
  const calls = fake.calls.slice(before);
  assert.deepEqual(calls.filter((c) => c === "read_memory"), [], "no read goes to the tool one value at a time");
  assert.equal(calls.filter((c) => c === "read_bulk").length, 1, `one read of the RAM for the frame: ${calls.join(", ")}`);
  assert.deepEqual(values, [1, 0, 0, 0, 0]);
  fake.onFrame = (s) => { s.memory["RAM:1904"] = 3; };
  await emu.wait(1);
  assert.equal((await emu.read(1904, { domain: "RAM" })).value, 3, "the next frame is read afresh");
  assert.deepEqual(Object.keys(await emu.read(1904, { domain: "RAM" })).sort(), ["address", "endianness", "requested", "value"], "the same answer as the tool's");
});

test("one plan per exec call, as Portal plays: a second playback in the same call is refused, the next call plays, and the plan's last frame comes back as a screenshot", async () => {
  reset();
  const images = [];
  globalThis.aas.emitImage = (url) => images.push(url);
  try {
    const emu = await plugin.connect();
    globalThis.aas.exec = 101;
    const r = await emu.tas().hold(["Right", "B"], 30).tap("A").wait(10).run();
    assert.equal(r.frames, 43, "hold 30 + tap 3 + wait 10");
    assert.equal(images.length, 1, "the frame the plan ended on comes back");
    await assert.rejects(emu.press(["A"], 1), /one plan per call/);
    await assert.rejects(emu.wait(1), /one plan per call/);
    assert.equal(typeof (await emu.read(0x0e, { domain: "RAM" })).value, "number", "looking at the memory is allowed after the plan");
    globalThis.aas.exec = 102;
    await emu.wait(5);
    globalThis.aas.exec = 103;
    await assert.rejects(emu.wait(0), /between 1 and 36000/);
    await emu.wait(1);
    assert.throws(() => emu.tas().run(), /the plan is empty/);
    delete globalThis.aas.exec;
    await emu.wait(1);
    await emu.wait(1);
  } finally {
    delete globalThis.aas.exec;
    globalThis.aas.emitImage = () => {};
  }
});
