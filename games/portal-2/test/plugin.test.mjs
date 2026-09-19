// The Portal 2 plugin against the fake SAR server: the ends come from SAR's own map table, the controller speaks
// the protocol, and the map a run is in comes from the engine's console log.
//
// What this does NOT prove: anything about the real game. Portal 2 is not installed on the machine this was
// written on, so the launcher, the engine's `jpeg` command and the console log's exact wording are unverified.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeSar } from "./fake-sar.mjs";
import { MAPS, createMapTracker, mapsInLog, consoleLogPath } from "../maps.mjs";

/** Waits for something the other side does, so a test never rests on how fast a socket is drained. */
async function until(ok, what, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`waited ${ms} ms for ${what}`);
}

test("the ends are the campaign, in the order SAR's own table has it", async () => {
  const plugin = (await import("../plugin.mjs")).default;
  assert.equal(plugin.stub, undefined, "not a stub any more");
  assert.equal(MAPS.length, 62, "Portal 2 has 62 single-player maps");
  assert.equal(MAPS[0].map, "sp_a1_intro1");
  assert.equal(MAPS[0].name, "Container Ride");
  // Every map after the first is an end, and the credits are the game's own end: the same shape as Portal.
  assert.equal(plugin.ends.length, MAPS.length, `${MAPS.length - 1} maps after the first, plus the credits`);
  assert.deepEqual(plugin.ends[0], { id: "sp_a1_intro2", label: "Portal Carousel", split: "Portal Carousel" });
  assert.equal(plugin.ends.filter((e) => e.final).length, 1);
  assert.equal(plugin.ends.at(-1).id, "credits");
  // The first end is what a mock run aims at (SPEC §3, the goal of a run no model plays).
  const { resolveGoal } = await import("../../../packages/core/src/goal.mjs");
  assert.equal(resolveGoal(plugin, "", { ai: false }).id, "sp_a1_intro2");
  assert.equal(resolveGoal(plugin, "", { ai: true }).id, "credits");
});

test("the map comes from the engine's own console log, and only forward", () => {
  assert.deepEqual(mapsInLog('Loading map "sp_a1_intro1"\nLoading map "sp_a1_intro2"'), ["sp_a1_intro1", "sp_a1_intro2"]);
  assert.deepEqual(mapsInLog('Loading map "not_a_portal2_map"'), [], "a name the campaign does not have is not a map");
  const dir = mkdtempSync(join(tmpdir(), "aas-p2-log-"));
  mkdirSync(join(dir, "portal2"), { recursive: true });
  const log = consoleLogPath(dir);
  writeFileSync(log, 'Loading map "sp_a1_intro1"\n');
  const tracker = createMapTracker({ logFile: log });
  assert.deepEqual(tracker.read().map((e) => e.map), ["sp_a1_intro1"]);
  assert.deepEqual(tracker.read(), [], "nothing new is nothing to report");
  appendFileSync(log, 'Loading map "sp_a1_intro2"\nLoading map "sp_a1_intro1"\n');
  assert.deepEqual(tracker.read().map((e) => e.name), ["Portal Carousel"], "going back to an earlier map is not progress");
  assert.equal(tracker.current, "sp_a1_intro2");
});

test("the controller speaks SAR's protocol: stepping, scripts and entity info", async () => {
  const fake = await startFakeSar({ location: "portal2/maps/sp_a1_intro1" });
  process.env.AAS_PORTAL2_PORT = String(fake.port);
  const events = [];
  globalThis.aas = { event: (event, data) => events.push({ event, data }) };
  try {
    // Imported after the port is set: the plugin reads it at module load, like every game plugin.
    const plugin = (await import(`../plugin.mjs?port=${fake.port}`)).default;
    const p2 = await plugin.connect({});
    try {
      assert.equal(await p2.advance(3), 3, "three ticks, three answers");
      const observed = await p2.observe(["tick", "playback", "player"]);
      assert.equal(observed.tick, 3);
      assert.deepEqual(observed.player.position, [1, 2, 3]);
      assert.deepEqual(await p2.position(), [1, 2, 3]);
      // A script without a header gets one: `start now` continues from the state the game is in.
      const played = await p2.tas("+0>0 1|0 0|||\n");
      assert.equal(played.slot, 0);
      const sent = fake.received.filter((p) => p.id === 10).at(-1);
      assert.match(sent.script1, /^version \d+\nstart now\n\+0>0 1\|0 0\|\|\|\n$/);
      // A script that brings its own header is sent as it is: a published .p2tas is played unchanged.
      const published = 'version 9\nstart next map sp_a1_intro2\n10>0 1|0 0|J1||\n';
      await p2.tas(published);
      assert.equal(fake.received.filter((p) => p.id === 10).at(-1).script1, published, "a published script is played as published");
      // A state request is not a state: the protocol documents no confirmation, so the controller reports what it
      // asked for and, apart from that, only the last state the game itself sent.
      assert.deepEqual(await p2.pause(), { requested: "paused", playback: "playing" });
      // A request with no answer is only flushed locally when the call resolves, so the server is given a moment.
      await until(() => fake.received.some((p) => p.id === 4), "the pause request to reach the game");
    } finally { p2.close(); }
    // Every step and every script is a playback on the timeline, which is what the timing category rests on.
    assert.deepEqual(events.filter((e) => e.event === "game.playback").map((e) => e.data.phase), ["start", "end", "start", "end", "start", "end"]);
  } finally {
    fake.close();
    delete globalThis.aas;
    delete process.env.AAS_PORTAL2_PORT;
  }
});

test("a run can be configured: the plugin brings everything aas run asks a game for", async () => {
  // The test that was missing when this was called finished: a plugin that cannot be configured is not a plugin
  // you can run, whatever else it has.
  const { configure } = await import("../../../packages/core/src/configure.mjs");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const os = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "aas-p2-configure-"));
  const runDir = join(dir, "run");
  const plugin = (await import("../plugin.mjs")).default;
  await configure({ runtime: join(process.cwd(), "packages", "core", "test", "stub-runtime.mjs"), game: join(process.cwd(), "games", "portal-2", "plugin.mjs"), "run-dir": runDir }, { log() {} });
  const brief = JSON.parse(readFileSync(join(runDir, "brief.json"), "utf8"));
  // A run no model plays aims at the campaign's first end (SPEC §3), and the prompt names that chamber.
  assert.equal(brief.category.goal, "sp_a1_intro2");
  assert.match(brief.goalPrompt, /Portal Carousel/);
  assert.equal(brief.instructions, plugin.instructions);
  assert.match(brief.instructions, /portal_2_exec/, "the model is told which tool it has");
  // Everything `aas run` reaches for on a game plugin.
  for (const hook of ["prepareRun", "saveState", "loadState", "endRun", "close", "connect", "doctor", "build"]) {
    assert.equal(typeof plugin[hook], "function", `plugin.${hook}`);
  }
  for (const key of ["install", "launch", "stop", "splits", "recorders"]) {
    assert.ok(plugin.setup[key], `setup.${key}`);
  }
  assert.ok(existsSync(plugin.setup.splits[brief.category.goal]), "the splits file of that goal is there");
});

test("prepareRun, save and load speak SAR's own script forms", async () => {
  const fake = await startFakeSar({ location: "portal2/maps/sp_a1_intro1" });
  process.env.AAS_PORTAL2_PORT = String(fake.port);
  try {
    const plugin = (await import(`../plugin.mjs?hooks=${fake.port}`)).default;
    const ready = await plugin.prepareRun({});
    assert.equal(ready.map, "sp_a1_intro1", "a run begins on the campaign's first map");
    assert.deepEqual(ready.position, [1, 2, 3]);
    const scripts = () => fake.received.filter((p) => p.id === 10).map((p) => p.script1);
    // `start map <name>` is SAR's own way to begin a script on a map (docs/p2tas.md); the script does nothing
    // else, so what it leaves is a loaded, standing-still game.
    assert.match(scripts().at(-1), /^version \d+\nstart map sp_a1_intro1\n\+0>\|\|\|\|\n$/);
    // The engine's own save, through the only channel the protocol has for a console command.
    await plugin.saveState({ name: "aas_p2_001" });
    assert.match(scripts().at(-1), /^version \d+\nstart now\n\+0>\|\|\|save aas_p2_001\|\n$/);
    const loaded = await plugin.loadState({ name: "aas_p2_001" });
    assert.match(scripts().at(-1), /^version \d+\nstart save aas_p2_001\n\+0>\|\|\|\|\n$/);
    assert.deepEqual(loaded.position, [1, 2, 3]);
    // The end of a session stops whatever is still playing, so the game is not left running a TAS.
    await plugin.endRun();
    await until(() => fake.received.some((p) => p.id === 1), "the stop to reach the game");
  } finally {
    fake.close();
    delete process.env.AAS_PORTAL2_PORT;
  }
});
