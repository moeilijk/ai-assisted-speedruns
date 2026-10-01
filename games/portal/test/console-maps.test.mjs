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

test("the console log's level loads are read as the SPT build prints them", () => {
  assert.deepEqual(mapsInLog("x\nspt_pause_on_portal_start: level init testchmb_a_01\nLoading map \"testchmb_a_02\"\n"), ["testchmb_a_01", "testchmb_a_02"]);
});

async function withPortal(opts, fn) {
  const gameRoot = mkdtempSync(join(tmpdir(), "aas-portal-root-"));
  const spt = await startFakeSpt({ gameRoot, ...opts });
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

test("a save made in a later map tells the chambers up to the one it stands in when it is loaded", { skip: !available && "portal-agent not checked out" }, async () => {
  await withPortal({ transitionAfterTicks: 5, transitionTo: "testchmb_a_01" }, async ({ plugin }) => {
    const portal = await plugin.connect();
    await portal.run([{ ticks: 10, keys: { forward: true } }]);
    await plugin.saveState({ name: "in_a01" });
    const r = await plugin.loadState({ name: "in_a01", log() {} });
    assert.equal(r.map, "testchmb_a_01");
    assert.deepEqual(r.reached.map((m) => m.end), ["chamber01", "chamber02"]);
  });
});
