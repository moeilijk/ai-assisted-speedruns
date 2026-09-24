// The plugin's bridge client over files (AAS_FCEUX_BRIDGE_DIR), as used with FCEUX's win64-QtSDL build, whose Lua
// cannot load LuaSocket: a batch reaches the bridge as one file (FCEUX clears its drawing overlay at the first gui call
// of a new pass, so a batch split over passes would lose its drawings), replies come back in order, a closed client
// frees its place, and a place left behind by a client that is gone is taken again after 10 s.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBridge } from "./fake-bridge.mjs";

const dir = fs.mkdtempSync(join(tmpdir(), "aas-fceux-ipc-"));
process.env.AAS_FCEUX_BRIDGE_DIR = dir;
const fake = await startFakeBridge({ dir });
const { batch, call, ping, disconnect } = await import("../bridge.mjs");

test("a batch goes out as one file and its replies come back in order", async () => {
  assert.equal(await ping(), true);
  const before = fake.inFiles;
  const r = await batch([{ method: "emu.step", params: { frames: 3 } }, { method: "emu.framecount" }, { method: "rom.getfilename" }]);
  assert.deepEqual(r, [3, 3, "nes15-NTSC"]);
  assert.equal(fake.inFiles - before, 1);
});

test("an error from the bridge names the method once", async () => {
  await assert.rejects(call("no.such"), /^Error: no handler for 'no.such'$|no.such: no handler/);
});

test("closing the client frees its place and leaves no files of its own", async () => {
  await call("ping");
  assert.ok(fs.existsSync(join(dir, "client-1")));
  disconnect();
  assert.equal(fs.existsSync(join(dir, "client-1")), false);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => !f.startsWith("client-")), []);
});

test("a place left behind for more than 10 s is taken again", async () => {
  for (let k = 1; k <= 8; k += 1) fs.writeFileSync(join(dir, `client-${k}`), `gone${k}`);
  const old = new Date(Date.now() - 11000);
  fs.utimesSync(join(dir, "client-1"), old, old);
  assert.equal(await call("emu.framecount"), 3);
  assert.notEqual(fs.readFileSync(join(dir, "client-1"), "utf8"), "gone1");
  disconnect();
  for (let k = 2; k <= 8; k += 1) fs.rmSync(join(dir, `client-${k}`));
  await fake.close();
});
