// FCEUX (nes15) through the whole harness against the fake bridge: a first segment in which the puzzle is not solved
// (the scripted player runs out, the run stops), a resume from FCEUX's savestate that solves it, the bundle and its
// check (packages/core/test/chain.mjs says what every game must do).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeBridge } from "./fake-bridge.mjs";
import { chainThroughHarness } from "../../../packages/core/test/chain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("FCEUX: a stopped first segment, resumed from its savestate to the end, published and checked", { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-chain-fceux-"));
  const fake = await startFakeBridge();
  let solvable = false;
  fake.onFrame = (s) => { if (solvable && s.framecount >= 100) s.memory[47] = 3; };
  Object.assign(process.env, { AAS_FCEUX_BRIDGE_PORT: String(fake.port), AAS_FCEUX_PROFILE: "nes15", AAS_FCEUX_DIR: path.join(dir, "fceux") });
  fs.mkdirSync(process.env.AAS_FCEUX_DIR, { recursive: true });
  try {
    const r = await chainThroughHarness({ game: path.join(here, "..", "plugin.mjs"), dir, goal: "solved", expectFirst: "stopped", beforeResume: () => { solvable = true; } });
    const segment2 = r.events.slice(r.events.findLastIndex((e) => e.event === "run.started"));
    assert.ok(!r.events.slice(0, r.events.length - segment2.length).some((e) => e.event === "game.over"), "the first segment ended without a game over");
    assert.ok(segment2.some((e) => e.event === "game.over" && e.data.victory && e.data.goal === "solved"), "the second segment reached the goal");
  } finally {
    await fake.close();
  }
});
