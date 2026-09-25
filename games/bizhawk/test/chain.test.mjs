// BizHawk (nes15) through the whole harness against the fake bizhawk-mcp: a first segment in which the puzzle is not
// solved (the scripted player runs out, the run stops), a resume from its savestate that solves it, the bundle and
// its check (packages/core/test/chain.mjs says what every game must do).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeBizHawk } from "./fake-bizhawk-mcp.mjs";
import { chainThroughHarness } from "../../../packages/core/test/chain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("BizHawk: a stopped first segment, resumed from its savestate to the end, published and checked", { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-chain-bizhawk-"));
  const fake = await startFakeBizHawk();
  let solvable = false;
  fake.onFrame = (s) => { if (solvable && s.framecount >= 100) s.memory["RAM:47"] = 3; };
  Object.assign(process.env, { AAS_BIZHAWK_MCP_URL: fake.url, AAS_BIZHAWK_PROFILE: "nes15", AAS_BIZHAWK_DIR: path.join(dir, "bizhawk") });
  fs.mkdirSync(process.env.AAS_BIZHAWK_DIR, { recursive: true });
  try {
    const r = await chainThroughHarness({
      game: path.join(here, "..", "plugin.mjs"), dir, goal: "solved", resumeGoal: undefined, expectFirst: "stopped",
      beforeResume: () => { solvable = true; },
    });
    const segment2 = r.events.slice(r.events.findLastIndex((e) => e.event === "run.started"));
    assert.ok(!r.events.slice(0, r.events.length - segment2.length).some((e) => e.event === "game.over"), "the first segment ended without a game over");
    assert.ok(segment2.some((e) => e.event === "game.over" && e.data.victory && e.data.goal === "solved"), "the second segment reached the goal");
    assert.ok(r.events.some((e) => e.event === "game.milestone" && e.data.end === "solved"), "the end was reached in the second segment");
  } finally {
    await fake.close();
  }
});
