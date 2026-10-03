// The map a Portal run is in comes from the engine's console log (-condebug), not from the campaign order: a reload of
// the map the run is in (a death, a load) is no progress, a level change counts the map the log names, and a loaded
// save tells the chambers it stands in or past (2026-10-02, found by reading the flow). Skipped when portal-agent is
// not checked out (its controller talks to the fake SPT).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeSpt } from "./fake-spt.mjs";
import { mapsInLog } from "../console-maps.mjs";
import { parseDemo, createDemoFollower } from "../demo-track.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const portalAgentDir = resolve(process.env.AAS_PORTAL_AGENT_DIR || join(here, "..", "..", "..", ".local", "portal-agent"));
const available = existsSync(join(portalAgentDir, "controller", "index.mjs"));

test("the console log's level loads are read as the real game prints them", () => {
  // Lines of the real game's console.log, 2026-10-02 02:10: start_run, `map testchmb_a_01`, then a save loaded again.
  const real = [
    "Agent run starting: loading testchmb_a_00 and arming demo autorecord.",
    "Demo recording started",
    "Recording to .\\agent_runs\\2026.10.02-02.10.11\\testchmb_a_00.dem...",
    "Completed demo, recording time 9.8, game frames 652.",
    "Recording to .\\agent_runs\\2026.10.02-02.10.11\\testchmb_a_01.dem...",
    "Loading game from //MOD/SAVE/testchmb_a_01.HL1...",
    "Recording to .\\agent_runs\\2026.10.02-02.10.11\\testchmb_a_01_1.dem...",
  ].join("\r\n");
  const known = ["testchmb_a_00", "testchmb_a_01", "testchmb_a_02"];
  assert.deepEqual(mapsInLog(real, known), ["testchmb_a_00", "testchmb_a_01", "testchmb_a_01"], "the reload is testchmb_a_01 again, not a map called testchmb_a_01_1");
});

async function withPortal(opts, fn) {
  const gameRoot = mkdtempSync(join(tmpdir(), "aas-portal-root-"));
  const spt = await startFakeSpt({ gameRoot, ...opts });
  globalThis.__portalSpt = spt;
  Object.assign(process.env, { AAS_PORTAL_SPT_PORT: String(spt.port), AAS_PORTAL_GAME_ROOT: gameRoot, AAS_PORTAL_AGENT_DIR: portalAgentDir, AAS_RUN_DIR: mkdtempSync(join(tmpdir(), "aas-portal-run-")) });
  const { default: plugin } = await import(`../plugin.mjs?console=${spt.port}`);
  const events = [];
  globalThis.aas = { event: (event, data) => events.push({ event, data }), emitImage() {} };
  try {
    await plugin.prepareRun({ log() {} });
    await fn({ plugin, events, chambers: () => events.filter((e) => e.event === "game.milestone").map((e) => e.data.end) });
  } finally {
    spt.close?.();
    delete process.env.AAS_PORTAL_GAME_ROOT;
  }
}

test("a reload of the map the run is in is no progress; a level change counts the map the log names", { skip: !available && "portal-agent not checked out" }, async () => {
  await withPortal({ reloadAfterTicks: 5 }, async ({ plugin, chambers }) => {
    const portal = await plugin.connect();
    await portal.run([{ ticks: 10, keys: { forward: true } }]);
    assert.deepEqual(chambers(), [], "a death reload of testchmb_a_00 is not chamber 02");
  });
  await withPortal({ transitionAfterTicks: 5, transitionTo: "testchmb_a_01" }, async ({ plugin, chambers }) => {
    const portal = await plugin.connect();
    await portal.run([{ ticks: 10, keys: { forward: true } }]);
    assert.deepEqual(chambers(), ["chamber02"], "the map the log names, testchmb_a_01, begins with chamber 02");
  });
});

test("a save made in a later map tells the chamber it stands in when it is loaded", { skip: !available && "portal-agent not checked out" }, async () => {
  await withPortal({ transitionAfterTicks: 5, transitionTo: "testchmb_a_01" }, async ({ plugin }) => {
    const portal = await plugin.connect();
    await portal.run([{ ticks: 10, keys: { forward: true } }]);
    await plugin.saveState({ name: "in_a01" });
    const r = await plugin.loadState({ name: "in_a01", log() {} });
    assert.equal(r.map, "testchmb_a_01");
    assert.deepEqual(r.reached.map((m) => m.end), ["chamber02"]);
  });
});

test("the credits: in escape_02, the view come to rest far below its play space is the game's end, told once", { skip: !available && "portal-agent not checked out" }, async () => {
  // The positions portal-agent's own run reported (its evidence): the outro moving through core storage (6893, 6895),
  // then at rest (6898, 6900), after which "Still Alive" had begun.
  await withPortal({ transitionAfterTicks: 5, transitionTo: "escape_02" }, async ({ plugin, events }) => {
    const portal = await plugin.connect();
    await portal.run([{ ticks: 10, keys: { forward: true } }]);
    const ends = () => events.filter((e) => e.event === "game.milestone").map((e) => e.data.end);
    const at = (x, y, z) => Object.assign(globalThis.__portalSpt.state, { x, y, z });
    assert.ok(!ends().includes("credits"), "not in escape_02's play space");
    at(-1371.67, -3203.11, -7344.31);
    await portal.run([{ ticks: 100 }]);
    await portal.observe(["position"]);
    assert.ok(!ends().includes("credits"), "the same position again while TAS-paused says nothing");
    at(-649.69, -3505.52, -7376.17);
    await portal.run([{ ticks: 100 }]);
    assert.ok(!ends().includes("credits"), "the outro still moving through core storage");
    at(-766.75, -3080.75, -7345);
    await portal.run([{ ticks: 100 }]);
    assert.ok(!ends().includes("credits"), "first seen at rest");
    await portal.run([{ ticks: 100 }]);
    await portal.run([{ ticks: 100 }]);
    assert.deepEqual(ends().filter((e) => e === "credits"), ["credits"], "at rest after game time played, told once");
    assert.ok(events.some((e) => e.event === "game.over" && e.data.victory && e.data.label === "Credits"));
  });
});

// A Source demo (protocol 3) as portal-agent records one: a header naming the map, then one packet frame per tick whose
// cmdinfo holds the view origin.
function demo(map, points) {
  const head = Buffer.alloc(1072);
  head.write("HL2DEMO\0", 0, "latin1");
  head.writeInt32LE(3, 8);
  head.write(map, 536, "latin1");
  const frames = points.map(([tick, x, y, z]) => {
    const f = Buffer.alloc(1 + 4 + 76 + 8 + 4);
    f[0] = 2;
    f.writeInt32LE(tick, 1);
    f.writeFloatLE(x, 9); f.writeFloatLE(y, 13); f.writeFloatLE(z, 17);
    return f;
  });
  return Buffer.concat([head, ...frames]);
}

test("a demo still being recorded is read up to its last whole frame, and every tick is given once", () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-portal-demos-"));
  const file = join(dir, "testchmb_a_00.dem");
  const whole = demo("testchmb_a_00", [[1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]]);
  writeFileSync(file, whole.subarray(0, whole.length - 10)); // the engine has not written all of tick 3 yet
  assert.deepEqual(parseDemo(file, { partial: true }).samples.map((s) => s.tick), [1, 2]);
  assert.throws(() => parseDemo(file), /cut off/, "a finished demo that is cut off is an error");
  const follower = createDemoFollower(dir);
  assert.deepEqual(follower.read("testchmb_a_00").map((s) => s.tick), [1, 2]);
  assert.deepEqual(follower.read("testchmb_a_01"), [], "a demo of another map waits");
  writeFileSync(file, whole);
  assert.deepEqual(follower.read("testchmb_a_00").map((s) => s.tick), [3], "only the tick that came in since");
});

test("a chamber sign passed halfway through a playback is seen from the demo, and the playback is played as one run", { skip: !available && "portal-agent not checked out" }, async () => {
  await withPortal({}, async ({ plugin, chambers }) => {
    const portal = await plugin.connect();
    const spt = globalThis.__portalSpt;
    const before = spt.seen.filter((m) => m.type === "tas_run").length;
    // The demo shows the view passing chamber 01's sign (-1026, -800, 832) halfway; the playback ends far past it.
    writeFileSync(join(spt.state.demoDir, "testchmb_a_00.dem"), demo("testchmb_a_00", [[10, -900, -700, 830], [20, -1026, -800, 850], [30, -1400, -800, 830]]));
    Object.assign(spt.state, { x: -1400, y: -800, z: 800 });
    await portal.run(Array.from({ length: 12 }, () => ({ ticks: 50, keys: { forward: true } }))); // 600 ticks
    assert.deepEqual(chambers(), ["chamber01"], "the sign at x -1026 was passed halfway");
    assert.equal(spt.seen.filter((m) => m.type === "tas_run").length - before, 1, "one tas_run, as the agent asked");
  });
});
