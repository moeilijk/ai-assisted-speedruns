// The map a Portal run is in comes from the engine's console log (-condebug), not from the campaign order: a reload of
// the map the run is in (a death, a load) is no progress, a level change counts the map the log names, and a loaded
// save tells the chambers it stands in or past (2026-10-02, found by reading the flow). Skipped when portal-agent is
// not checked out (its controller talks to the fake SPT).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeSpt } from "./fake-spt.mjs";
import { mapsInLog } from "../console-maps.mjs";

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

test("the credits: in escape_02, the player taken to the outro scene far below its play space is the game's end, told once", { skip: !available && "portal-agent not checked out" }, async () => {
  // The position portal-agent's own run reached when "Still Alive" began (its evidence, around sequence 6880).
  await withPortal({ transitionAfterTicks: 5, transitionTo: "escape_02" }, async ({ plugin, events }) => {
    const portal = await plugin.connect();
    await portal.run([{ ticks: 10, keys: { forward: true } }]);
    const ends = () => events.filter((e) => e.event === "game.milestone").map((e) => e.data.end);
    assert.ok(!ends().includes("credits"), "not in escape_02's play space");
    globalThis.__portalSpt.state.z = -7344.31;
    await portal.observe(["position"]);
    await portal.observe(["position"]);
    assert.deepEqual(ends().filter((e) => e === "credits"), ["credits"], "told once");
    assert.ok(events.some((e) => e.event === "game.over" && e.data.victory && e.data.label === "Credits"));
  });
});
